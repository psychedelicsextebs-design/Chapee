import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  EVENT_TRIGGERED_MESSAGES_COLLECTION,
  EVENT_TRIGGERED_SEND_LOG_COLLECTION,
  type EventTriggeredMessageDoc,
  type EventTriggeredSendLogDoc,
} from "@/lib/event-triggered-messages";
import { WEBHOOK_OBSERVATION_LOG_COLLECTION } from "@/lib/webhook-observation-log";
import {
  SHOPEE_CHAT_MESSAGES_COLLECTION,
  type ShopeeChatMessageDoc,
} from "@/lib/shopee-conversation-db-sync";
import {
  displayFromShopeeChatMessage,
  shopeeMessageTimeToMs,
} from "@/lib/shopee-conversation-utils";

/**
 * GET /api/admin/diag-conversation?name=alexsmiths&hours=720
 * Authorization: Bearer ${CRON_SECRET}
 *
 * 特定バイヤーの会話と、それに紐づく Phase 2 (event-triggered) の発火状況を
 * 突合して返す read-only 診断エンドポイント。
 *
 * **絶対に書き込みを行わない** (find / aggregate / listIndexes / countDocuments のみ)。
 *
 * 目的: 「同じ通知が複数回」「発送済の後に『これから発送準備』」といった
 * Phase 2 誤発火の構造原因 (index 未作成 / status 再 push / 別 order_sn) を
 * 実データで切り分ける。
 *
 * パラメータ:
 *   - name        : customer_name 部分一致 (case-insensitive)。 例: alexsmiths
 *   - conversation: conversation_id 完全一致 (name より優先)
 *   - order_sn    : 明示的に追う order_sn (カンマ区切り可)
 *   - hours       : webhook 観察ログの遡及期間 (デフォルト 720h = 30日, 最大 2160h)
 *
 * 返すもの:
 *   1. matched conversations (customer_id / shop_id / country / handling_status /
 *      timestamps / staff_message_kind_log のサマリ)
 *   2. 会話の保存済みチャットから抽出した order_sn 一覧 (order カード由来)
 *   3. event_triggered_messages (queue): 対象 shop の最新 N 件 + order_sn マッチ印
 *   4. event_triggered_send_log: 対象 shop の最新 N 件 + order_sn マッチ印
 *   5. webhook_observation_log の code 3 / 4: 対象 shop の最新 N 件
 *      (ordersn / status / tracking_no / received_at / signature_valid)
 *   6. send_log / queue の現行 index 構成 (unique index が本番にあるかの確認)
 */

export const maxDuration = 60;

type ConvDoc = {
  conversation_id: string;
  shop_id: number;
  country?: string;
  customer_id?: number;
  customer_name?: string;
  unread_count?: number;
  handling_status?: string;
  last_message?: string;
  last_message_time?: Date;
  last_buyer_message_time?: Date;
  staff_message_kind_log?: { id: string; kind: string }[];
};

function isoOrNull(d: unknown): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 未設定のため実行できません" },
      { status: 500 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  const conversationParam = (url.searchParams.get("conversation") ?? "").trim();
  const orderSnParam = (url.searchParams.get("order_sn") ?? "").trim();
  const hours = Math.max(
    1,
    Math.min(2160, Number(url.searchParams.get("hours") ?? 720))
  );
  const since = new Date(Date.now() - hours * 3600 * 1000);

  if (!name && !conversationParam && !orderSnParam) {
    return NextResponse.json(
      { error: "name / conversation / order_sn のいずれかを指定してください" },
      { status: 400 }
    );
  }

  const convCol = await getCollection<ConvDoc>("shopee_conversations");
  const queueCol = await getCollection<EventTriggeredMessageDoc>(
    EVENT_TRIGGERED_MESSAGES_COLLECTION
  );
  const logCol = await getCollection<EventTriggeredSendLogDoc>(
    EVENT_TRIGGERED_SEND_LOG_COLLECTION
  );
  const obsCol = await getCollection<{
    received_at: Date;
    code: number;
    shop_id?: number;
    signature_valid: boolean;
    note?: string;
    raw_payload?: Record<string, unknown>;
  }>(WEBHOOK_OBSERVATION_LOG_COLLECTION);
  const msgCol = await getCollection<ShopeeChatMessageDoc>(
    SHOPEE_CHAT_MESSAGES_COLLECTION
  );

  // ---- 1. 会話を特定 ----
  const convFilter: Record<string, unknown> = {};
  if (conversationParam) {
    convFilter.conversation_id = conversationParam;
  } else if (name) {
    // 正規表現メタ文字をエスケープしてから部分一致
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    convFilter.customer_name = { $regex: safe, $options: "i" };
  }

  const convs =
    Object.keys(convFilter).length > 0
      ? await convCol.find(convFilter).limit(10).toArray()
      : [];

  // ---- 2. order_sn 集合を構築 ----
  const orderSnSet = new Set<string>();
  for (const s of orderSnParam.split(",").map((x) => x.trim())) {
    if (s) orderSnSet.add(s);
  }

  const shopIds = new Set<number>();
  const convSummaries: Record<string, unknown>[] = [];

  for (const c of convs) {
    if (Number.isFinite(c.shop_id)) shopIds.add(Number(c.shop_id));

    // 会話の保存済みチャット → order カードから order_sn 抽出
    const stored = await msgCol
      .find({ conversation_id: c.conversation_id, shop_id: c.shop_id })
      .sort({ timestamp_ms: 1 })
      .limit(500)
      .toArray();

    const orderSnsFromChat = new Set<string>();
    const messageTimeline: Record<string, unknown>[] = [];
    for (const row of stored) {
      const disp = displayFromShopeeChatMessage(row.raw);
      const osn = disp.order?.order_sn?.trim();
      if (osn) {
        orderSnsFromChat.add(osn);
        orderSnSet.add(osn);
      }
      const fromId = Number(row.raw.from_id ?? row.raw.from_user_id ?? 0);
      messageTimeline.push({
        ts: new Date(row.timestamp_ms).toISOString(),
        from_id: fromId,
        kind: disp.kind,
        order_sn: osn ?? null,
        summary: disp.summary?.slice(0, 80) ?? "",
      });
    }

    const log = c.staff_message_kind_log ?? [];
    convSummaries.push({
      conversation_id: c.conversation_id,
      shop_id: c.shop_id,
      country: c.country ?? null,
      customer_id: c.customer_id ?? null,
      customer_name: c.customer_name ?? null,
      unread_count: c.unread_count ?? null,
      handling_status: c.handling_status ?? null,
      last_message: c.last_message?.slice(0, 80) ?? null,
      last_message_time: isoOrNull(c.last_message_time),
      last_buyer_message_time: isoOrNull(c.last_buyer_message_time),
      staff_message_kind_log_count: log.length,
      staff_message_kind_log_last: log.length ? log[log.length - 1] : null,
      order_sns_from_chat: Array.from(orderSnsFromChat),
      message_timeline_tail: messageTimeline.slice(-30),
    });
  }

  const orderSns = Array.from(orderSnSet);

  // ---- 3. queue (event_triggered_messages) ----
  const queueByOrder =
    orderSns.length > 0
      ? await queueCol
          .find({ order_sn: { $in: orderSns } })
          .sort({ created_at: -1 })
          .limit(200)
          .toArray()
      : [];

  const queueByShop =
    shopIds.size > 0
      ? await queueCol
          .find({ shop_id: { $in: Array.from(shopIds) } })
          .sort({ created_at: -1 })
          .limit(50)
          .toArray()
      : [];

  const sampleQueue = (d: EventTriggeredMessageDoc) => ({
    order_sn: d.order_sn,
    event_type: d.event_type,
    status: d.status,
    shop_id: d.shop_id,
    customer_id: d.customer_id ?? null,
    tracking_no: d.tracking_no ?? null,
    template_id: d.template_id || null,
    retry_count: d.retry_count ?? 0,
    last_error: d.last_error ?? null,
    due_at: isoOrNull(d.due_at),
    sent_at: isoOrNull(d.sent_at),
    created_at: isoOrNull(d.created_at),
    updated_at: isoOrNull(d.updated_at),
    matches_order: orderSnSet.has(d.order_sn),
  });

  // ---- 4. send_log ----
  const sendLogByOrder =
    orderSns.length > 0
      ? await logCol
          .find({ order_sn: { $in: orderSns } })
          .sort({ sent_at: -1 })
          .limit(200)
          .toArray()
      : [];

  const sendLogByShop =
    shopIds.size > 0
      ? await logCol
          .find({ shop_id: { $in: Array.from(shopIds) } })
          .sort({ sent_at: -1 })
          .limit(50)
          .toArray()
      : [];

  const sampleLog = (d: EventTriggeredSendLogDoc) => ({
    order_sn: d.order_sn,
    event_type: d.event_type,
    shop_id: d.shop_id,
    message_id: d.message_id || null,
    sent_at: isoOrNull(d.sent_at),
    matches_order: orderSnSet.has(d.order_sn),
  });

  // ---- 5. webhook_observation_log code 3 / 4 ----
  const obsFilter: Record<string, unknown> = {
    code: { $in: [3, 4] },
    received_at: { $gte: since },
  };
  if (shopIds.size > 0) {
    obsFilter.shop_id = { $in: Array.from(shopIds) };
  }
  const obs = await obsCol
    .find(obsFilter)
    .sort({ received_at: -1 })
    .limit(200)
    .toArray();

  const obsSamples = obs.map((e) => {
    const data = ((e.raw_payload?.data ?? {}) as Record<string, unknown>) ?? {};
    const ordersn = String(data.ordersn ?? data.order_sn ?? "");
    const status = data.status ?? data.order_status;
    const tracking = data.tracking_no ?? data.tracking_number;
    return {
      received_at: isoOrNull(e.received_at),
      code: Number(e.code),
      shop_id: e.shop_id ?? null,
      ordersn: ordersn || null,
      status: status != null ? String(status) : null,
      tracking_no: tracking != null ? String(tracking) : null,
      signature_valid: Boolean(e.signature_valid),
      note: e.note ?? null,
      matches_order: ordersn ? orderSnSet.has(ordersn) : false,
    };
  });

  // 対象 order_sn ごとに code 3 status の出現回数を集計 (重複 push の可視化)
  const obsStatusCountByOrder: Record<string, Record<string, number>> = {};
  for (const s of obsSamples) {
    if (!s.ordersn || s.code !== 3) continue;
    const key = s.ordersn;
    const st = s.status ?? "null";
    obsStatusCountByOrder[key] ??= {};
    obsStatusCountByOrder[key][st] = (obsStatusCountByOrder[key][st] ?? 0) + 1;
  }

  // ---- 6. index 構成 ----
  let sendLogIndexes: unknown = null;
  let queueIndexes: unknown = null;
  try {
    sendLogIndexes = await logCol.listIndexes().toArray();
  } catch (e) {
    sendLogIndexes = { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    queueIndexes = await queueCol.listIndexes().toArray();
  } catch (e) {
    queueIndexes = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    query: {
      name: name || null,
      conversation: conversationParam || null,
      order_sn: orderSnParam || null,
      hours,
      since: since.toISOString(),
    },
    matched_conversation_count: convs.length,
    shop_ids: Array.from(shopIds),
    order_sns_resolved: orderSns,
    conversations: convSummaries,
    queue: {
      by_order_sn: queueByOrder.map(sampleQueue),
      recent_by_shop: queueByShop.map(sampleQueue),
    },
    send_log: {
      by_order_sn: sendLogByOrder.map(sampleLog),
      recent_by_shop: sendLogByShop.map(sampleLog),
    },
    observations_code3_4: {
      samples: obsSamples,
      code3_status_count_by_order: obsStatusCountByOrder,
    },
    indexes: {
      event_triggered_send_log: sendLogIndexes,
      event_triggered_messages: queueIndexes,
    },
  });
}
