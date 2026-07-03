import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 * STEP TIMELINE: 症状発生時期の物証取得 (DB 読取のみ)。
 * - webhook_observation_log の受信履歴（Shopee 側 push が来続けているか）
 * - shopee_conversations の updated_at / last_message_time 分布
 * - staff_message_kind_log から最後の "manual" 送信時刻
 * - shopee_tokens の updated_at 再確認
 * URL token 保護、DB 書込なし、次 commit で削除。
 */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TOKEN =
  "T5xQ8pW9vLb2hF3jN4kR7tYcE1oD6uA0zGiSoIpMkBnPa3rSs5uVvXwYy2zZAcCe";

function iso(d?: Date | null): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toISOString()
    : null;
}
function ageDays(d?: Date | null, nowMs = Date.now()): number | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return Math.round(((nowMs - d.getTime()) / (24 * 3600_000)) * 10) / 10;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    const nowMs = now.getTime();

    // 1) webhook 受信履歴
    let webhookTotal = 0;
    let webhookLatest: Array<Record<string, unknown>> = [];
    let webhookOldestReceivedAt: string | null = null;
    let webhookNewestReceivedAt: string | null = null;
    let webhookNewestAgeDays: number | null = null;
    try {
      const wCol = await getCollection<{
        received_at?: Date;
        code?: number;
        shop_id?: number;
        note?: string;
      }>("webhook_observation_log");
      webhookTotal = await wCol.countDocuments({});
      const newest = await wCol
        .find({})
        .sort({ received_at: -1 })
        .limit(1)
        .toArray();
      const oldest = await wCol
        .find({})
        .sort({ received_at: 1 })
        .limit(1)
        .toArray();
      if (newest[0]?.received_at instanceof Date) {
        webhookNewestReceivedAt = iso(newest[0].received_at);
        webhookNewestAgeDays = ageDays(newest[0].received_at, nowMs);
      }
      if (oldest[0]?.received_at instanceof Date) {
        webhookOldestReceivedAt = iso(oldest[0].received_at);
      }
      const rows = await wCol
        .find({})
        .sort({ received_at: -1 })
        .limit(10)
        .project({ received_at: 1, code: 1, shop_id: 1, note: 1 })
        .toArray();
      webhookLatest = rows.map((r) => ({
        received_at: iso(r.received_at ?? null),
        code: r.code ?? null,
        shop_id: r.shop_id ?? null,
        note: r.note ?? null,
        age_days: ageDays(r.received_at ?? null, nowMs),
      }));
    } catch (e) {
      webhookLatest = [
        { error: e instanceof Error ? e.message : String(e) },
      ];
    }

    // 2) shopee_conversations の updated_at / last_message_time 分布
    const convCol = await getCollection<{
      shop_id: number;
      last_message_time?: Date | null;
      updated_at?: Date | null;
      staff_message_kind_log?: { id: string; kind: string }[];
      last_staff_send_at?: Date | null;
    }>("shopee_conversations");
    const convTotal = await convCol.countDocuments({});
    const perShop = await convCol
      .aggregate<{
        _id: number;
        total: number;
        newest_lmt: Date | null;
        newest_updated: Date | null;
      }>([
        {
          $group: {
            _id: "$shop_id",
            total: { $sum: 1 },
            newest_lmt: { $max: "$last_message_time" },
            newest_updated: { $max: "$updated_at" },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    const perShopFormatted = perShop.map((r) => ({
      shop_id: r._id,
      total: r.total,
      newest_last_message_time: iso(r.newest_lmt),
      newest_last_message_time_age_days: ageDays(r.newest_lmt, nowMs),
      newest_updated_at: iso(r.newest_updated),
      newest_updated_at_age_days: ageDays(r.newest_updated, nowMs),
    }));

    // 3) staff_message_kind_log から最後の "manual" 送信時刻を推定
    //    (staff_message_kind_log は array of {id,kind} で timestamp を持たないので
    //     kind が manual を含む会話の updated_at max を代替として使う)
    let lastManualStaffAt: string | null = null;
    let lastManualStaffAgeDays: number | null = null;
    let manualConvsSample: Array<Record<string, unknown>> = [];
    try {
      const q = await convCol
        .aggregate<{
          _id: string;
          shop_id: number;
          updated_at: Date | null;
          last_message_time: Date | null;
          last_manual_kind_present: boolean;
        }>([
          { $match: { "staff_message_kind_log.kind": "manual" } },
          { $sort: { updated_at: -1 } },
          { $limit: 5 },
          {
            $project: {
              _id: "$conversation_id",
              shop_id: 1,
              updated_at: 1,
              last_message_time: 1,
              last_manual_kind_present: { $literal: true },
            },
          },
        ])
        .toArray();
      manualConvsSample = q.map((c) => ({
        conversation_id: c._id,
        shop_id: c.shop_id,
        updated_at: iso(c.updated_at ?? null),
        last_message_time: iso(c.last_message_time ?? null),
      }));
      if (q[0]?.updated_at instanceof Date) {
        lastManualStaffAt = iso(q[0].updated_at);
        lastManualStaffAgeDays = ageDays(q[0].updated_at, nowMs);
      }
    } catch {
      /* ignore */
    }

    // 4) shopee_tokens の updated_at
    const tokenCol = await getCollection<{
      shop_id: number;
      country?: string;
      updated_at?: Date;
      expires_at?: Date;
    }>("shopee_tokens");
    const tokens = await tokenCol.find({}).toArray();
    const tokensStatus = tokens.map((t) => ({
      shop_id: t.shop_id,
      country: t.country ?? null,
      updated_at: iso(t.updated_at ?? null),
      updated_at_age_days: ageDays(t.updated_at ?? null, nowMs),
      expires_at: iso(t.expires_at ?? null),
    }));

    return NextResponse.json({
      _note: "temporary timeline diag; will be removed",
      now: now.toISOString(),
      webhook_observation_log: {
        total_count: webhookTotal,
        oldest_received_at: webhookOldestReceivedAt,
        newest_received_at: webhookNewestReceivedAt,
        newest_received_age_days: webhookNewestAgeDays,
        latest_10: webhookLatest,
      },
      conversations: {
        total: convTotal,
        per_shop: perShopFormatted,
      },
      last_manual_staff_send: {
        derived_from: "shopee_conversations.staff_message_kind_log.kind=='manual' sorted by updated_at desc",
        last_updated_at: lastManualStaffAt,
        last_updated_age_days: lastManualStaffAgeDays,
        sample_convs: manualConvsSample,
      },
      tokens_status: tokensStatus,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
