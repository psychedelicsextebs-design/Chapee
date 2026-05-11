import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { sendMessage, sendOrderMessage } from "@/lib/shopee-api";
import { getValidToken, resolveCountryForShop } from "@/lib/shopee-token";

/**
 * POST /api/buyers/cold-start-send — バイヤーへメッセージ送信 (会話有無自動判定)
 *
 * body:
 *   {
 *     shop_id: number,
 *     buyer_user_id: number,
 *     order_sn: string,    // 会話なしの場合に注文カード送信用 (会話あり時も記録に使う)
 *     text: string
 *   }
 *
 * フロー:
 *   1. shopee_conversations を user_id + customer_id で lookup → has_conversation 判定
 *   2. has_conversation=true → sendMessage 直接
 *      has_conversation=false → sendOrderMessage で会話確立 → sendMessage
 *      (sendMessage 失敗時は phase2-triggers パターンで 1 回 retry)
 *   3. 結果を構造化 audit ログ (console.log JSON) として記録
 *
 * audit_log 注: Chapee に audit_log collection / lib は未実装のため、 構造化
 * console.log で代用 (将来 BayCom から backport 予定、 STEP 5 レポート参照)。
 */

type RequestBody = {
  shop_id?: unknown;
  buyer_user_id?: unknown;
  order_sn?: unknown;
  text?: unknown;
};

function writeAuditLog(entry: {
  action: string;
  shop_id: number;
  buyer_user_id: number;
  buyer_username: string | null;
  order_sn: string;
  text_length: number;
  has_conversation_before: boolean;
  result: "success" | "failed";
  error_message: string | null;
}) {
  console.log(
    JSON.stringify({
      type: "audit",
      timestamp: new Date().toISOString(),
      ...entry,
    }),
  );
}

export async function POST(request: NextRequest) {
  let parsedShopId = 0;
  let parsedBuyerId = 0;
  let parsedOrderSn = "";
  let parsedText = "";
  let hasConvBefore = false;
  let buyerUsername: string | null = null;

  try {
    const body = (await request.json()) as RequestBody;
    parsedShopId = Number(body.shop_id);
    parsedBuyerId = Number(body.buyer_user_id);
    parsedOrderSn = String(body.order_sn ?? "").trim();
    parsedText = String(body.text ?? "").trim();

    // ===== バリデーション =====
    if (!Number.isFinite(parsedShopId) || parsedShopId <= 0) {
      return NextResponse.json(
        { error: "shop_id が不正です" },
        { status: 400 },
      );
    }
    if (!Number.isFinite(parsedBuyerId) || parsedBuyerId <= 0) {
      return NextResponse.json(
        { error: "buyer_user_id が不正です" },
        { status: 400 },
      );
    }
    if (!parsedOrderSn) {
      return NextResponse.json(
        { error: "order_sn が必要です" },
        { status: 400 },
      );
    }
    if (!parsedText || parsedText.length === 0) {
      return NextResponse.json(
        { error: "本文が空です" },
        { status: 400 },
      );
    }

    // ===== 既存会話判定 (server-side が信頼ソース、 client supply は信頼しない) =====
    const convCol = await getCollection<{
      conversation_id: string;
      shop_id: number;
      customer_id: number;
      customer_name?: string;
    }>("shopee_conversations");
    const existingConv = await convCol.findOne({
      shop_id: parsedShopId,
      customer_id: parsedBuyerId,
    });
    hasConvBefore = !!existingConv;
    buyerUsername = existingConv?.customer_name ?? null;

    // ===== Token / country =====
    const accessToken = await getValidToken(parsedShopId);
    const country = await resolveCountryForShop(parsedShopId);
    const countryOpt = { country };

    // ===== 送信フロー =====
    // 会話なし → 注文カード送信で会話確立 → テキスト送信 (1 回 retry まで)
    if (!hasConvBefore) {
      await sendOrderMessage(
        accessToken,
        parsedShopId,
        parsedBuyerId,
        parsedOrderSn,
        countryOpt,
      );
    }

    // テキスト送信 (1 回 retry)
    let lastErr: unknown = null;
    let textOk = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sendMessage(
          accessToken,
          parsedShopId,
          parsedBuyerId,
          parsedText,
          countryOpt,
        );
        textOk = true;
        break;
      } catch (e) {
        lastErr = e;
        // 1 回目失敗時は短い待機後 retry
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    if (!textOk) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr ?? "テキスト送信に失敗しました"));
    }

    writeAuditLog({
      action: "cold_start_send",
      shop_id: parsedShopId,
      buyer_user_id: parsedBuyerId,
      buyer_username: buyerUsername,
      order_sn: parsedOrderSn,
      text_length: parsedText.length,
      has_conversation_before: hasConvBefore,
      result: "success",
      error_message: null,
    });

    return NextResponse.json({
      success: true,
      has_conversation_before: hasConvBefore,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    writeAuditLog({
      action: "cold_start_send",
      shop_id: parsedShopId,
      buyer_user_id: parsedBuyerId,
      buyer_username: buyerUsername,
      order_sn: parsedOrderSn,
      text_length: parsedText.length,
      has_conversation_before: hasConvBefore,
      result: "failed",
      error_message: errMsg,
    });
    console.error("[buyers/cold-start-send]", e);
    return NextResponse.json(
      { error: errMsg },
      { status: 500 },
    );
  }
}
