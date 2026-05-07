import { NextRequest, NextResponse } from "next/server";
import {
  EVENT_TRIGGERED_MESSAGES_COLLECTION,
  EVENT_TRIGGERED_SEND_LOG_COLLECTION,
} from "@/lib/event-triggered-messages";
import { getCollection } from "@/lib/mongodb";

/**
 * POST /api/admin/init-event-triggered-indexes
 *
 * Phase 2 で必要な MongoDB index を一括作成する一時 endpoint。
 * 1 度叩いて成功確認したら delete commit して構わない (idempotent なので
 * 何回叩いても害はないが、 production の admin surface はミニマムに保つ)。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * 作成する index:
 *   1. event_triggered_messages
 *      - (shop_id, order_sn, event_type) unique, partial: status="pending"
 *        → 同じ pending を 2 回作れない。 sent / cancelled / failed は同 key で
 *          別 doc を許容 (再試行や履歴のため)。
 *      - (status, due_at)
 *        → cron の drain クエリ高速化。
 *
 *   2. event_triggered_send_log
 *      - (shop_id, order_sn, event_type) unique
 *        → 構造的に 1 トリガーにつき 1 メッセージしか送れない真実の源。
 */

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 未設定" },
      { status: 500 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const created: { collection: string; index: string; result: string }[] = [];

  // ---- event_triggered_messages ----
  const queueCol = await getCollection(EVENT_TRIGGERED_MESSAGES_COLLECTION);

  const queueUniqueIdx = await queueCol.createIndex(
    { shop_id: 1, order_sn: 1, event_type: 1 },
    {
      name: "shop_order_event_pending_unique",
      unique: true,
      partialFilterExpression: { status: "pending" },
    }
  );
  created.push({
    collection: EVENT_TRIGGERED_MESSAGES_COLLECTION,
    index: "shop_order_event_pending_unique",
    result: queueUniqueIdx,
  });

  const queueDueIdx = await queueCol.createIndex(
    { status: 1, due_at: 1 },
    { name: "status_due_at" }
  );
  created.push({
    collection: EVENT_TRIGGERED_MESSAGES_COLLECTION,
    index: "status_due_at",
    result: queueDueIdx,
  });

  // ---- event_triggered_send_log ----
  const logCol = await getCollection(EVENT_TRIGGERED_SEND_LOG_COLLECTION);

  const logUniqueIdx = await logCol.createIndex(
    { shop_id: 1, order_sn: 1, event_type: 1 },
    {
      name: "shop_order_event_unique",
      unique: true,
    }
  );
  created.push({
    collection: EVENT_TRIGGERED_SEND_LOG_COLLECTION,
    index: "shop_order_event_unique",
    result: logUniqueIdx,
  });

  return NextResponse.json({
    success: true,
    created,
  });
}
