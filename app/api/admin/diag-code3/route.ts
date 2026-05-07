import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { WEBHOOK_OBSERVATION_LOG_COLLECTION } from "@/lib/webhook-observation-log";

/**
 * GET /api/admin/diag-code3?days=9
 *
 * Phase 2 着手前の最終確認。 webhook_observation_log の code 3 (order_status_push)
 * を data.status / data.completed_scenario で分解し、 READY_TO_SHIP と COMPLETED が
 * 観測されているかを一発判定する。
 *
 * Phase 2 設計の前提:
 *   - order_confirmed トリガー: status = "READY_TO_SHIP" (確認済 ✅)
 *   - delivered_plus_3d トリガー: status = "COMPLETED" (要確認 ← この endpoint の主目的)
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 */

export const maxDuration = 60;

type ObsDoc = {
  received_at: Date;
  code: number;
  shop_id?: number;
  raw_payload?: Record<string, unknown>;
  note?: string;
};

function bucketKey(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return v;
  return String(v);
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
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get("days") ?? 9)));
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  const since = new Date(sinceMs);

  const obsCol = await getCollection<ObsDoc>(WEBHOOK_OBSERVATION_LOG_COLLECTION);
  const baseFilter = { code: 3, received_at: { $gte: since } } as const;

  // total
  const total = await obsCol.countDocuments(baseFilter);

  // by status
  const byStatusAgg = await obsCol
    .aggregate([
      { $match: baseFilter },
      { $group: { _id: "$raw_payload.data.status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const by_status: Record<string, number> = {};
  for (const r of byStatusAgg) by_status[bucketKey(r._id)] = Number(r.count);

  // by completed_scenario
  const byScenarioAgg = await obsCol
    .aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: "$raw_payload.data.completed_scenario",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const by_completed_scenario: Record<string, number> = {};
  for (const r of byScenarioAgg)
    by_completed_scenario[bucketKey(r._id)] = Number(r.count);

  // status x completed_scenario
  const byStatusScenarioAgg = await obsCol
    .aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: {
            status: "$raw_payload.data.status",
            scenario: "$raw_payload.data.completed_scenario",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const by_status_scenario = byStatusScenarioAgg.map((r) => {
    const id = (r._id ?? {}) as { status?: unknown; scenario?: unknown };
    return {
      status: bucketKey(id.status),
      completed_scenario: bucketKey(id.scenario),
      count: Number(r.count),
    };
  });

  // by day x status (JST)
  const byDayStatusAgg = await obsCol
    .aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: {
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$received_at",
                timezone: "Asia/Tokyo",
              },
            },
            status: "$raw_payload.data.status",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.date": 1, count: -1 } },
    ])
    .toArray();
  const by_day_status_jst: Record<string, Record<string, number>> = {};
  for (const r of byDayStatusAgg) {
    const id = (r._id ?? {}) as { date?: unknown; status?: unknown };
    const d = bucketKey(id.date);
    const s = bucketKey(id.status);
    by_day_status_jst[d] = by_day_status_jst[d] ?? {};
    by_day_status_jst[d][s] = Number(r.count);
  }

  // distinct order_sn (= ordersn) count
  const distinctOrdersnRaw = await obsCol.distinct(
    "raw_payload.data.ordersn",
    baseFilter
  );
  const distinct_order_count = distinctOrdersnRaw.filter(
    (v) => v != null && String(v).length > 0
  ).length;

  // samples per status (最大 2 件ずつ)
  const samples_by_status: Record<
    string,
    {
      received_at: string;
      shop_id: number | null;
      ordersn: string | null;
      status: unknown;
      completed_scenario: unknown;
      update_time: unknown;
      items_count: number | null;
    }[]
  > = {};
  for (const statusKey of Object.keys(by_status)) {
    if (statusKey === "null") continue;
    // dot-notation の filter を find() に渡すと strict TS に引っかかるため
    // aggregation pipeline で代用 ($match は任意キーを許容)
    const docs = await obsCol
      .aggregate([
        {
          $match: {
            ...baseFilter,
            "raw_payload.data.status": statusKey,
          },
        },
        { $sort: { received_at: -1 } },
        { $limit: 2 },
      ])
      .toArray();
    samples_by_status[statusKey] = docs.map((doc) => {
      const d = doc as unknown as ObsDoc;
      const raw = (d.raw_payload ?? {}) as Record<string, unknown>;
      const data = (raw.data ?? {}) as Record<string, unknown>;
      const ordersn =
        typeof data.ordersn === "string"
          ? data.ordersn
          : data.ordersn != null
            ? String(data.ordersn)
            : null;
      return {
        received_at: d.received_at.toISOString(),
        shop_id: typeof d.shop_id === "number" ? d.shop_id : null,
        ordersn,
        status: data.status ?? null,
        completed_scenario: data.completed_scenario ?? null,
        update_time: data.update_time ?? null,
        items_count: Array.isArray(data.items) ? data.items.length : null,
      };
    });
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    period_days: days,
    since: since.toISOString(),
    timezone: "Asia/Tokyo",
    total_code3_events: total,
    distinct_order_count,
    by_status,
    by_completed_scenario,
    by_status_scenario,
    by_day_status_jst,
    samples_by_status,
    phase2_targets: {
      order_confirmed_status: "READY_TO_SHIP",
      delivered_status: "COMPLETED",
      observed: {
        READY_TO_SHIP_count: by_status["READY_TO_SHIP"] ?? 0,
        COMPLETED_count: by_status["COMPLETED"] ?? 0,
      },
      verdict: {
        order_confirmed_ready: (by_status["READY_TO_SHIP"] ?? 0) > 0,
        delivered_plus_3d_ready: (by_status["COMPLETED"] ?? 0) > 0,
      },
    },
  });
}
