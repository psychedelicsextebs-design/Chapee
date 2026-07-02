import type { Filter } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 *
 * auto-reply が再び停止した RCA 用の使い捨て admin diag。
 * URL token (git 履歴に残る) で保護し、真因確定後に必ず削除 commit を積む。
 * Read-only。 auto-reply 本体 (src/lib/auto-reply.ts / cron route) は変更しない。
 *
 * 直接必要な集計だけを 60s 以内に返せるよう最小化 (旧版は既存 pipeline diag を
 * まるごと呼んでいて Vercel Function タイムアウトで 500 空 body を返した)。
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// URL token (使い捨て、削除 commit で数分後に無意味化)
const TOKEN =
  "k7qN9pR3tY8xW2vLbH5jFmC4dE6sA1uZgIoMTQBnPa2rSs4uVvXwYy0zZAcCeE";

const HOUR = 3600_000;

function iso(d?: Date | null): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toISOString()
    : null;
}
function ageHours(d: Date | null | undefined, now: number): number | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return Math.round(((now - d.getTime()) / HOUR) * 10) / 10;
}

type ConvDoc = {
  conversation_id: string;
  shop_id: number;
  customer_id?: number;
  customer_name?: string;
  chat_type?: string;
  handling_status?: string;
  last_message_time?: Date | null;
  last_buyer_message_time?: Date | null;
  auto_reply_pending?: boolean;
  auto_reply_due_at?: Date | null;
  last_auto_reply_at?: Date | null;
  unread_count?: number;
  updated_at?: Date | null;
  staff_message_kind_log?: { id: string; kind: string }[];
};

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const nowMs = now.getTime();
  const cutoff24 = new Date(nowMs - 24 * HOUR);
  const cutoff24Ms = cutoff24.getTime();
  const cutoff7d = new Date(nowMs - 7 * 24 * HOUR);

  const convCol = await getCollection<ConvDoc>("shopee_conversations");

  // 1) per-shop 集計 (auto-reply pipeline diag と同一)
  const perShopRaw = await convCol
    .aggregate<{
      _id: number;
      total: number;
      customer_id_gt0: number;
      lmt_within_24h: number;
      newest_lmt: Date | null;
      pending_true: number;
      pending_and_due: number;
    }>([
      {
        $group: {
          _id: "$shop_id",
          total: { $sum: 1 },
          customer_id_gt0: {
            $sum: { $cond: [{ $gt: ["$customer_id", 0] }, 1, 0] },
          },
          lmt_within_24h: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: [{ $type: "$last_message_time" }, "date"] },
                    { $gte: ["$last_message_time", cutoff24] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          newest_lmt: { $max: "$last_message_time" },
          pending_true: {
            $sum: { $cond: [{ $eq: ["$auto_reply_pending", true] }, 1, 0] },
          },
          pending_and_due: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$auto_reply_pending", true] },
                    { $lte: ["$auto_reply_due_at", now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  const perShop = perShopRaw.map((r) => ({
    shop_id: r._id,
    total: r.total,
    customer_id_gt0: r.customer_id_gt0,
    lmt_within_24h: r.lmt_within_24h,
    newest_lmt: iso(r.newest_lmt),
    newest_lmt_age_hours: ageHours(r.newest_lmt, nowMs),
    pending_true: r.pending_true,
    pending_and_due: r.pending_and_due,
  }));

  // 2) 本番 rescue / process と完全同一 filter
  const rescueFilter: Filter<ConvDoc> = {
    chat_type: { $ne: "notification" },
    customer_id: { $gt: 0 },
    last_message_time: { $gte: cutoff24 },
    auto_reply_pending: { $ne: true },
    $or: [
      { last_auto_reply_at: { $exists: false } },
      { last_auto_reply_at: null },
      { $expr: { $lt: ["$last_auto_reply_at", "$last_message_time"] } },
    ],
  };
  const processFilter: Filter<ConvDoc> = {
    auto_reply_pending: true,
    auto_reply_due_at: { $lte: now },
  };

  const rescueCount = await convCol.countDocuments(rescueFilter);
  const rescueSample = await convCol
    .find(rescueFilter)
    .limit(5)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_id: 1,
      customer_name: 1,
      last_message_time: 1,
    })
    .toArray();

  const processCount = await convCol.countDocuments(processFilter);
  const processSample = await convCol
    .find(processFilter)
    .limit(5)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_name: 1,
      auto_reply_due_at: 1,
    })
    .toArray();

  // 3) tokens
  const tokenCol = await getCollection<{
    shop_id: number;
    country?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: Date;
    updated_at?: Date;
  }>("shopee_tokens");
  const tokens = await tokenCol.find({}).toArray();
  const tokensStatus = tokens.map((t) => ({
    shop_id: t.shop_id,
    country: t.country ?? null,
    has_access_token: !!t.access_token,
    has_refresh_token: !!t.refresh_token,
    expires_at: iso(t.expires_at ?? null),
    expires_in_hours: t.expires_at
      ? Math.round(((t.expires_at.getTime() - nowMs) / HOUR) * 10) / 10
      : null,
    expired: t.expires_at ? t.expires_at.getTime() <= nowMs : null,
    updated_at: iso(t.updated_at ?? null),
  }));

  // 4) 直近 24h の buyer 活動 (rescue に何故マッチしないか)
  const recentBuyers = await convCol
    .find({
      chat_type: { $ne: "notification" },
      customer_id: { $gt: 0 },
      last_message_time: { $gte: cutoff24 },
    })
    .sort({ last_message_time: -1 })
    .limit(20)
    .toArray();

  const buyerDropouts = recentBuyers.map((doc) => {
    const lmt = doc.last_message_time;
    const lar = doc.last_auto_reply_at;
    const due = doc.auto_reply_due_at;
    const lmtIsDate = lmt instanceof Date && !Number.isNaN(lmt.getTime());
    const rescueConds = {
      not_notification: doc.chat_type !== "notification",
      customer_id_gt0: (doc.customer_id ?? 0) > 0,
      lmt_within_24h: lmtIsDate && (lmt as Date).getTime() >= cutoff24Ms,
      not_pending: doc.auto_reply_pending !== true,
      not_already_replied:
        !(lar instanceof Date) ||
        !lmtIsDate ||
        lar.getTime() < (lmt as Date).getTime(),
    };
    const processConds = {
      pending_true: doc.auto_reply_pending === true,
      due_at_lte_now:
        due instanceof Date &&
        !Number.isNaN(due.getTime()) &&
        due.getTime() <= nowMs,
    };
    const kindLog = doc.staff_message_kind_log ?? [];
    return {
      conversation_id: doc.conversation_id,
      shop_id: doc.shop_id,
      customer_id: doc.customer_id ?? null,
      customer_name: doc.customer_name ?? null,
      chat_type: doc.chat_type ?? null,
      handling_status: doc.handling_status ?? null,
      unread_count: doc.unread_count ?? 0,
      last_message_time: iso(lmt ?? null),
      lmt_age_hours: ageHours(lmt ?? null, nowMs),
      last_buyer_message_time: iso(doc.last_buyer_message_time ?? null),
      auto_reply_pending: doc.auto_reply_pending ?? null,
      auto_reply_due_at: iso(due ?? null),
      due_age_hours: ageHours(due ?? null, nowMs),
      last_auto_reply_at: iso(lar ?? null),
      updated_at: iso(doc.updated_at ?? null),
      staff_kind_log_len: kindLog.length,
      recent_staff_kinds: kindLog.slice(-5).map((k) => k.kind),
      rescue_conditions: rescueConds,
      rescue_would_match: Object.values(rescueConds).every(Boolean),
      process_conditions: processConds,
      process_would_match:
        processConds.pending_true && processConds.due_at_lte_now,
    };
  });

  // 5) 過去 7日 の auto-reply 実発火
  const firingsRaw = await convCol
    .find({ last_auto_reply_at: { $gte: cutoff7d } })
    .sort({ last_auto_reply_at: -1 })
    .limit(20)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_name: 1,
      last_auto_reply_at: 1,
      last_message_time: 1,
    })
    .toArray();
  const firings7d = firingsRaw.map((d) => ({
    conversation_id: d.conversation_id,
    shop_id: d.shop_id,
    customer_name: d.customer_name,
    last_auto_reply_at: iso(d.last_auto_reply_at ?? null),
    last_auto_reply_age_hours: ageHours(d.last_auto_reply_at ?? null, nowMs),
    last_message_time: iso(d.last_message_time ?? null),
  }));

  // 6) auto_reply_settings 生値
  const settingsCol = await getCollection<{
    _id: string;
    countries?: Record<string, unknown>;
    template_fix_applied?: boolean;
    updated_at?: Date;
  }>("auto_reply_settings");
  const settingsDoc = await settingsCol.findOne({ _id: "singleton" });

  // 7) 直近 24h に completed 化された会話 (bulk-complete/PATCH 副作用検証)
  const completedCount = await convCol.countDocuments({
    handling_status: "completed",
    updated_at: { $gte: cutoff24 },
  });
  const completedSample = await convCol
    .find({
      handling_status: "completed",
      updated_at: { $gte: cutoff24 },
    })
    .sort({ updated_at: -1 })
    .limit(10)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_name: 1,
      updated_at: 1,
      last_message_time: 1,
      last_auto_reply_at: 1,
      auto_reply_pending: 1,
    })
    .toArray();

  return NextResponse.json({
    _note: "temporary diag; will be removed after RCA",
    now: now.toISOString(),
    cutoff_24h: cutoff24.toISOString(),
    per_shop: perShop,
    rescue_query: { count: rescueCount, sample: rescueSample },
    process_query: { count: processCount, sample: processSample },
    tokens_status: tokensStatus,
    recent_buyer_dropouts: buyerDropouts,
    recent_auto_reply_firings_7d: firings7d,
    auto_reply_settings_raw: settingsDoc,
    recent_completed_24h: {
      count: completedCount,
      sample: completedSample.map((d) => ({
        conversation_id: d.conversation_id,
        shop_id: d.shop_id,
        customer_name: d.customer_name,
        updated_at: iso(d.updated_at ?? null),
        last_message_time: iso(d.last_message_time ?? null),
        last_auto_reply_at: iso(d.last_auto_reply_at ?? null),
        auto_reply_pending: d.auto_reply_pending ?? null,
      })),
    },
  });
}
