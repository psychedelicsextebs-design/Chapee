import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { syncWebhookConversationFull } from "@/lib/shopee-conversation-db-sync";
import {
  resolveShopeeWebhookUrl,
  verifyShopeeWebhookSignature,
} from "@/lib/shopee-webhook-auth";
import { recordWebhookObservation } from "@/lib/webhook-observation-log";

/**
 * Shopee Webhook Receiver
 * POST /api/shopee/webhook
 *
 * Shopee Open Platform の Live Push「Push Code」（公式の数値）と payload.code が対応します。
 * 例（抜粋・ドキュメント準拠）:
 * - 1  shop_authorization_push
 * - 2  shop_authorization_canceled_push
 * - 3  order_status_push
 * - 4  order_trackingno_push
 * - 10 webchat_push（チャット／Webchat）
 * - 12 open_api_authorization_expiry
 * … ほかは Developer Console の Push 一覧を参照。
 *
 * 認証:
 *   Shopee は Authorization ヘッダに `HMAC_SHA256(url|raw_body, partner_key)` を設定する。
 *   `SHOPEE_PARTNER_KEY` が設定されている場合は必ず検証し、失敗は 401 を返す。
 *   未設定時（開発環境など）のみ検証スキップ。
 *
 * 注意: 旧コメントの「1=新着メッセージ」は誤り。チャットは通常 code 10。
 * 実際の body は必ずログで確認し、data の形に合わせてハンドラを書くこと。
 *
 * Configure webhook URL in Shopee Open Platform:
 * https://yourdomain.com/api/shopee/webhook
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const authHeader = request.headers.get("authorization");

    // --- 署名検証 ---
    // Shopee Open Platform console の「Verify」テスト push は署名を付けずに送ってくる
    // 場合があるため、「署名なし/不一致」でも 200 を返して reachability 確認を通す。
    // 代わりに、実処理は必ず signatureValid === true のブロックでのみ行う。
    //
    // Live Push 受信の署名検証は、Shopee Open Platform が別途発行する
    // "Live Push Partner Key" を使うのが仕様。これは SHOPEE_PARTNER_KEY
    // (アプリ全体のマスターキー = API 呼び出し署名用) とは別物。
    // 未設定時は後方互換として SHOPEE_PARTNER_KEY にフォールバックする
    // (まだ Live Push を有効化していない dev/preview 環境のため)。
    const partnerKey =
      process.env.SHOPEE_LIVE_PUSH_PARTNER_KEY?.trim() ||
      process.env.SHOPEE_PARTNER_KEY?.trim() ||
      "";
    const verifyUrl = resolveShopeeWebhookUrl(request.url);
    let signatureValid = false;
    let verifyReason:
      | "ok"
      | "no_partner_key"
      | "no_auth_header"
      | "signature_mismatch" = "no_partner_key";

    if (partnerKey && authHeader) {
      signatureValid = verifyShopeeWebhookSignature({
        url: verifyUrl,
        rawBody,
        authorizationHeader: authHeader,
        partnerKey,
      });
      verifyReason = signatureValid ? "ok" : "signature_mismatch";
    } else if (partnerKey && !authHeader) {
      verifyReason = "no_auth_header";
    }

    // 署名が通らない場合は、観察ログだけ残して 200 を返す(絶対に処理しない)
    if (!signatureValid) {
      let expectedPrefix = "";
      if (partnerKey) {
        try {
          expectedPrefix = crypto
            .createHmac("sha256", partnerKey)
            .update(`${verifyUrl}|${rawBody}`)
            .digest("hex")
            .slice(0, 8);
        } catch {
          /* ignore — 診断用のプレフィックス計算なので失敗しても続行 */
        }
      }
      const receivedPrefix = authHeader
        ? authHeader.trim().toLowerCase().slice(0, 8)
        : "(none)";
      console.warn(
        `[Webhook] sig check FAILED reason=${verifyReason} verifyUrl=${verifyUrl} ` +
          `bodyLen=${rawBody.length} expectedPrefix=${expectedPrefix} ` +
          `receivedPrefix=${receivedPrefix} bodyHead=${JSON.stringify(
            rawBody.slice(0, 200)
          )}`
      );

      let parsedForObs: Record<string, unknown> = {};
      try {
        parsedForObs = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        parsedForObs = { _raw_head: rawBody.slice(0, 200) };
      }
      const codeForObs =
        Number((parsedForObs as { code?: unknown }).code ?? 0) || 0;
      await recordWebhookObservation({
        code: codeForObs,
        shop_id: undefined,
        raw_payload: parsedForObs,
        signature_valid: false,
        processed: false,
        note: `unverified:${verifyReason}`,
      });

      return NextResponse.json({ message: "OK (unverified)" }, { status: 200 });
    }

    // --- 以下、signatureValid === true のパスのみ通る ---

    let payload: { code?: number; shop_id?: number; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      console.error("[Webhook] JSON parse failed:", e);
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const pushCode = Number(payload.code ?? 0);
    const shopId = Number(
      payload.shop_id ??
        (payload.data as Record<string, unknown> | undefined)?.shop_id ??
        0
    );

    // Handle different webhook events（Push Code は Shopee コンソールの表に従う）
    switch (pushCode) {
      case 10: // webchat_push
        // shop_id は payload top-level / data 双方をフォールバック対象にする。
        // 4/27 ログで data.shop_id 欠落 → handleNewMessage 全件スキップ事故が発生したため、
        // 上位で extract 済みの shopId をフォールバックとして必ず渡す。
        await handleNewMessage(payload.data ?? {}, {
          fallbackShopId: Number.isFinite(shopId) && shopId > 0 ? shopId : 0,
        });
        break;

      case 1: // shop_authorization_push
        console.log("[Webhook] Shop authorization");
        break;

      case 3: // order_status_push → Phase 1 observation-only
        await handleOrderStatusPushObserveOnly(payload, signatureValid);
        break;

      case 4: // order_trackingno_push → Phase 1 observation-only
        await handleOrderTrackingNoPushObserveOnly(payload, signatureValid);
        break;

      default:
        // 未対応 code も観察ログに残す（Shopee が将来追加する push を把握するため）
        console.log("[Webhook] Unhandled event code:", pushCode);
        await recordWebhookObservation({
          code: pushCode,
          shop_id: Number.isFinite(shopId) && shopId > 0 ? shopId : undefined,
          raw_payload: payload as unknown as Record<string, unknown>,
          signature_valid: signatureValid,
          processed: false,
          note: "unhandled_code",
        });
    }

    return NextResponse.json({ message: "OK" }, { status: 200 });
  } catch (error) {
    console.error("[Webhook] Error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}

/**
 * Phase 1 observation-only: order_status_push の実 payload 構造を採取する。
 *
 * このハンドラは **絶対に** 以下を行わない:
 *   - event_triggered_messages への書き込み
 *   - メッセージ送信
 *   - 既存 auto-reply の state 変更
 *
 * 純粋に実 payload を webhook_observation_log に保存 + console.log で垂れ流すだけ。
 * Phase 2 でこの観察データを元に消費ロジックを書く。
 */
async function handleOrderStatusPushObserveOnly(
  payload: Record<string, unknown>,
  signatureValid: boolean
): Promise<void> {
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const shopId = Number(
    payload.shop_id ?? data.shop_id ?? 0
  );
  const ordersn = String(data.ordersn ?? data.order_sn ?? "");
  const status = String(data.status ?? data.order_status ?? "");

  console.log(
    `[Webhook][observe][order_status_push] shop=${shopId} ordersn=${ordersn} status=${status}`,
    JSON.stringify(payload)
  );

  await recordWebhookObservation({
    code: 3,
    shop_id: Number.isFinite(shopId) && shopId > 0 ? shopId : undefined,
    raw_payload: payload,
    signature_valid: signatureValid,
    processed: false,
    note: "order_status_push",
  });
}

/**
 * Phase 1 observation-only: order_trackingno_push の実 payload 構造を採取する。
 * 特に `tracking_no` フィールドが payload に含まれているかを確認したい
 * （Shopee docs と実配信がずれるケースがある）。
 */
async function handleOrderTrackingNoPushObserveOnly(
  payload: Record<string, unknown>,
  signatureValid: boolean
): Promise<void> {
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const shopId = Number(
    payload.shop_id ?? data.shop_id ?? 0
  );
  const ordersn = String(data.ordersn ?? data.order_sn ?? "");
  const trackingNo = String(
    data.tracking_no ?? data.tracking_number ?? ""
  );

  console.log(
    `[Webhook][observe][order_trackingno_push] shop=${shopId} ordersn=${ordersn} tracking_no=${trackingNo || "<missing>"}`,
    JSON.stringify(payload)
  );

  await recordWebhookObservation({
    code: 4,
    shop_id: Number.isFinite(shopId) && shopId > 0 ? shopId : undefined,
    raw_payload: payload,
    signature_valid: signatureValid,
    processed: false,
    note: trackingNo ? "trackingno_push_with_no" : "trackingno_push_missing_no",
  });
}

function numU(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strU(v: unknown): string {
  return typeof v === "string" ? v : v != null ? String(v) : "";
}

/**
 * webchat_push（code 10）: Webhook の data は欠損しがちなため、
 * Shopee API で全メッセージ + get_one_conversation を取り、DB に同期してから自動返信を予約する。
 */
async function handleNewMessage(
  data: Record<string, unknown>,
  opts?: { fallbackShopId?: number }
) {
  try {
    const conversationId = strU(data.conversation_id).trim();

    // shop_id 解決の優先順位 (多層フォールバック):
    //   1. data.shop_id / data.shopId  (Shopee 公式 docs の場所)
    //   2. payload top-level の shop_id  (4/27 観察: 実配信はこちらが多い)
    //   3. shopee_conversations から conversation_id で逆引き (既存会話なら必ず取れる)
    //
    // 4/27 ログで「[Webhook] handleNewMessage: missing shop_id」が 1〜2 分間隔で頻発し
    // 新着メッセージが DB 同期されず、auto-reply の last_buyer_message_time が
    // 古いまま → 誤発火の真因になっていた可能性がある。
    let shopId = numU(data.shop_id ?? data.shopId);
    let shopIdSource: "data" | "payload_top" | "db_lookup" | "none" =
      shopId > 0 ? "data" : "none";

    if (!shopId && opts?.fallbackShopId && opts.fallbackShopId > 0) {
      shopId = opts.fallbackShopId;
      shopIdSource = "payload_top";
    }

    if (!shopId && conversationId) {
      try {
        const convCol = await getCollection<{ shop_id: number }>(
          "shopee_conversations"
        );
        const row = await convCol.findOne({ conversation_id: conversationId });
        if (row?.shop_id && Number(row.shop_id) > 0) {
          shopId = Number(row.shop_id);
          shopIdSource = "db_lookup";
        }
      } catch (lookupErr) {
        console.warn(
          "[Webhook] handleNewMessage: db lookup for shop_id failed:",
          lookupErr
        );
      }
    }

    if (!shopId || !conversationId) {
      console.error(
        "[Webhook] handleNewMessage: missing shop_id or conversation_id",
        {
          dataKeys: Object.keys(data),
          fallbackShopId: opts?.fallbackShopId ?? null,
          conversationId: conversationId || null,
          shopId: shopId || null,
          data,
        }
      );
      // Phase 1 観察ログにも残し、Shopee の実配信スキーマを後追いできるようにする
      await recordWebhookObservation({
        code: 10,
        shop_id:
          opts?.fallbackShopId && opts.fallbackShopId > 0
            ? opts.fallbackShopId
            : undefined,
        raw_payload: {
          _data: data,
          _fallback_shop_id: opts?.fallbackShopId ?? null,
        },
        signature_valid: true,
        processed: false,
        note: !shopId
          ? "webchat_push_missing_shop_id"
          : "webchat_push_missing_conv_id",
      });
      return;
    }

    if (shopIdSource !== "data") {
      // 通常パスから外れたときだけログを出す（毎回出すとノイズになる）
      console.warn(
        `[Webhook] webchat_push: shop_id resolved via ${shopIdSource} (data に shop_id なし) ` +
          `conv=${conversationId} shop=${shopId}`
      );
    }

    console.log(`[Webhook] webchat_push conversation=${conversationId} shop=${shopId}`);

    const sync = await syncWebhookConversationFull(shopId, conversationId);
    if (!sync.ok) {
      console.error("[Webhook] syncWebhookConversationFull failed:", sync.error);
      return;
    }

    console.log(
      `[Webhook] DB synced ${sync.messageCount} messages for ${conversationId}`
    );
    // Auto-reply schedule is reviewed inside syncWebhookConversationFull
    // using actual message timestamps, so no separate scheduling call is needed.
  } catch (error) {
    console.error("[Webhook] handleNewMessage error:", error);
  }
}

/**
 * Handle conversation update (pin/unpin)
 */
async function handleConversationUpdate(data: {
  shop_id: number;
  conversation_id: string;
  pinned?: boolean;
}) {
  try {
    const { shop_id, conversation_id, pinned } = data;

    console.log(
      `[Webhook] Conversation ${conversation_id} ${pinned ? "pinned" : "unpinned"}`
    );

    const col = await getCollection("shopee_conversations");
    await col.updateOne(
      { conversation_id, shop_id },
      {
        $set: {
          pinned: pinned || false,
          updated_at: new Date(),
        },
      }
    );
  } catch (error) {
    console.error("[Webhook] handleConversationUpdate error:", error);
  }
}

/**
 * GET /api/shopee/webhook - Webhook verification (if required by Shopee)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const challenge = searchParams.get("challenge");

  if (challenge) {
    // Return challenge for webhook verification
    return NextResponse.json({ challenge });
  }

  return NextResponse.json({
    message: "Shopee Webhook Endpoint",
    status: "active",
  });
}
