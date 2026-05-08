import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  EVENT_TRIGGERED_MESSAGES_COLLECTION,
  type EventTriggeredMessageDoc,
  type EventType,
} from "@/lib/event-triggered-messages";

/**
 * POST /api/admin/phase2-retry-failed
 * Authorization: Bearer ${CRON_SECRET}
 *
 * 過去に failed で締められた event_triggered_messages を pending に戻して
 * 再試行する管理 API。 「修正コード (例: 新しい sendOrderMessage 経路) を
 * 実購入を待たずに既存 failed で検証する」用途。
 *
 * Body (任意, 全部省略可):
 *   {
 *     "shop_id": 1704031241,        // 単一 shop に絞る
 *     "event_type": "order_confirmed", // 単一 event_type に絞る
 *     "order_sns": ["260508TJP0EVUK", "260503EU0D688B"],  // 注文番号リスト
 *     "dry_run": true               // true なら matched 件数だけ返して更新しない
 *   }
 *
 * 実装上の注意:
 * - `event_triggered_messages` には partial unique index
 *   (shop_id, order_sn, event_type) partial: status="pending" がある。
 *   同じ key で別途 pending な doc が既に存在する場合、failed を pending に戻すと
 *   unique 違反になる。 doc 単位で先に check して、競合があれば skip する。
 * - retry_count は減算しない (履歴保持)。 due_at は now にして次の cron で即処理。
 * - send_log に既に成功エントリが居るかどうかは check しない。 send 時点で
 *   send_log の unique index が再送信を弾く (cancelled として締められる) ので
 *   ここで二重に check しても無駄。
 */

export const maxDuration = 60;

type RetryBody = {
  shop_id?: number;
  event_type?: string;
  order_sns?: string[];
  dry_run?: boolean;
};

const KNOWN_EVENT_TYPES: EventType[] = [
  "order_confirmed",
  "tracking_registered",
  "delivered_plus_3d",
];

export async function POST(request: NextRequest) {
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

  let body: RetryBody = {};
  try {
    body = (await request.json()) as RetryBody;
  } catch {
    // body なし or 不正 JSON は空 body として扱う
    body = {};
  }

  const filter: Record<string, unknown> = { status: "failed" };
  if (typeof body.shop_id === "number" && Number.isFinite(body.shop_id)) {
    filter.shop_id = body.shop_id;
  }
  if (
    typeof body.event_type === "string" &&
    (KNOWN_EVENT_TYPES as string[]).includes(body.event_type)
  ) {
    filter.event_type = body.event_type;
  }
  if (Array.isArray(body.order_sns) && body.order_sns.length > 0) {
    const sns = body.order_sns.filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    if (sns.length > 0) {
      filter.order_sn = { $in: sns };
    }
  }

  const queueCol = await getCollection<EventTriggeredMessageDoc>(
    EVENT_TRIGGERED_MESSAGES_COLLECTION
  );

  const failedDocs = await queueCol.find(filter).toArray();

  if (body.dry_run === true) {
    return NextResponse.json({
      dry_run: true,
      filter,
      matched: failedDocs.length,
      preview: failedDocs.slice(0, 50).map((d) => ({
        shop_id: d.shop_id,
        order_sn: d.order_sn,
        event_type: d.event_type,
        last_error: d.last_error ?? null,
        retry_count: Number(d.retry_count ?? 0),
        updated_at:
          d.updated_at instanceof Date ? d.updated_at.toISOString() : null,
      })),
    });
  }

  const now = new Date();
  const restored: {
    shop_id: number;
    order_sn: string;
    event_type: string;
    prev_error: string | null;
  }[] = [];
  const skipped: {
    shop_id: number;
    order_sn: string;
    event_type: string;
    reason: string;
  }[] = [];

  for (const doc of failedDocs) {
    // 同じ key で別 pending が既にある場合は skip (unique 違反回避)
    const competingPending = await queueCol.findOne({
      shop_id: doc.shop_id,
      order_sn: doc.order_sn,
      event_type: doc.event_type,
      status: "pending",
      _id: { $ne: doc._id },
    });
    if (competingPending) {
      skipped.push({
        shop_id: doc.shop_id,
        order_sn: doc.order_sn,
        event_type: doc.event_type,
        reason: "another pending already exists for same key",
      });
      continue;
    }

    try {
      await queueCol.updateOne(
        { _id: doc._id, status: "failed" },
        {
          $set: {
            status: "pending",
            last_error: null,
            due_at: now,
            updated_at: now,
          },
        }
      );
      restored.push({
        shop_id: doc.shop_id,
        order_sn: doc.order_sn,
        event_type: doc.event_type,
        prev_error: doc.last_error ?? null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      skipped.push({
        shop_id: doc.shop_id,
        order_sn: doc.order_sn,
        event_type: doc.event_type,
        reason: msg.slice(0, 200),
      });
    }
  }

  return NextResponse.json({
    success: true,
    filter,
    matched: failedDocs.length,
    restored: restored.length,
    skipped: skipped.length,
    restored_keys: restored,
    skipped_keys: skipped,
  });
}
