import type { Filter } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 * Mongo 認証復旧後の auto-reply 状態確認用。トークン期限、pending 数、直近発火を取る。
 * URL token 保護。次 commit で削除。
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const TOKEN =
  "R4pV7xNq2wZ8bK5cH3jF9mL6aE1sD0uT9yPo3iBn2gCvXhQrMkWlOpZaSbUcVdKe";

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
  last_message_time?: Date | null;
  auto_reply_pending?: boolean;
  auto_reply_due_at?: Date | null;
  last_auto_reply_at?: Date | null;
};

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const stepsDone: string[] = [];
  try {
    return await runDiag(stepsDone);
  } catch (e) {
    return NextResponse.json(
      {
        error: "diag crashed",
        crashed_at: stepsDone[stepsDone.length - 1] ?? "<none>",
        steps_done: stepsDone,
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}

async function runDiag(stepsDone: string[]) {
  const now = new Date();
  const nowMs = now.getTime();
  const cutoff24 = new Date(nowMs - 24 * HOUR);
  const cutoff7d = new Date(nowMs - 7 * 24 * HOUR);

  stepsDone.push("get shopee_tokens");
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
    access_token_expires_at: iso(t.expires_at ?? null),
    access_token_expires_in_hours: t.expires_at
      ? Math.round(((t.expires_at.getTime() - nowMs) / HOUR) * 10) / 10
      : null,
    access_token_expired: t.expires_at
      ? t.expires_at.getTime() <= nowMs
      : null,
    updated_at: iso(t.updated_at ?? null),
    updated_age_hours: ageHours(t.updated_at ?? null, nowMs),
  }));

  stepsDone.push("get shopee_conversations");
  const convCol = await getCollection<ConvDoc>("shopee_conversations");

  stepsDone.push("per-shop aggregate");
  const perShopRaw = await convCol
    .aggregate<{
      _id: number;
      total: number;
      lmt_within_24h: number;
      newest_lmt: Date | null;
      pending_true: number;
      pending_and_due: number;
    }>([
      {
        $group: {
          _id: "$shop_id",
          total: { $sum: 1 },
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
    lmt_within_24h: r.lmt_within_24h,
    newest_lmt: iso(r.newest_lmt),
    newest_lmt_age_hours: ageHours(r.newest_lmt, nowMs),
    pending_true: r.pending_true,
    pending_and_due: r.pending_and_due,
  }));

  stepsDone.push("rescue+process filters");
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
  const processCount = await convCol.countDocuments(processFilter);
  const processSample = await convCol
    .find(processFilter)
    .sort({ auto_reply_due_at: 1 })
    .limit(10)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_name: 1,
      auto_reply_due_at: 1,
      last_message_time: 1,
    })
    .toArray();

  stepsDone.push("recent auto-reply firings");
  const firings = await convCol
    .find({ last_auto_reply_at: { $gte: cutoff7d } })
    .sort({ last_auto_reply_at: -1 })
    .limit(20)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_name: 1,
      last_auto_reply_at: 1,
    })
    .toArray();
  const firingsSummary = firings.map((d) => ({
    conversation_id: d.conversation_id,
    shop_id: d.shop_id,
    customer_name: d.customer_name,
    last_auto_reply_at: iso(d.last_auto_reply_at ?? null),
    age_hours: ageHours(d.last_auto_reply_at ?? null, nowMs),
  }));

  stepsDone.push("settings");
  const settingsCol = await getCollection<{
    _id: string;
    countries?: Record<
      string,
      { enabled?: boolean; triggerHour?: number; template_id?: string }
    >;
    template_fix_applied?: boolean;
  }>("auto_reply_settings");
  const settingsDoc = await settingsCol.findOne({ _id: "singleton" });
  const settingsSummary = {
    template_fix_applied: settingsDoc?.template_fix_applied ?? null,
    countries: settingsDoc?.countries
      ? Object.entries(settingsDoc.countries).map(([k, v]) => ({
          country: k,
          enabled: v?.enabled ?? null,
          triggerHour: v?.triggerHour ?? null,
          template_id_set: !!v?.template_id,
          template_id_length: v?.template_id?.length ?? 0,
        }))
      : [],
  };

  return NextResponse.json({
    _note: "temporary post-recovery diag; will be removed",
    now: now.toISOString(),
    tokens_status: tokensStatus,
    per_shop_conversations: perShop,
    rescue_query_count: rescueCount,
    process_query_count: processCount,
    process_query_sample: processSample.map((d) => ({
      conversation_id: d.conversation_id,
      shop_id: d.shop_id,
      customer_name: d.customer_name,
      due_at: iso(d.auto_reply_due_at ?? null),
      due_age_hours: ageHours(d.auto_reply_due_at ?? null, nowMs),
      last_message_time: iso(d.last_message_time ?? null),
    })),
    recent_auto_reply_firings_7d: firingsSummary,
    auto_reply_settings: settingsSummary,
  });
}
