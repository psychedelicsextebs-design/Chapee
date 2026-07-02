import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { computeAutoReplyPipelineDiag } from "@/lib/diag-auto-reply-pipeline";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 *
 * auto-reply が再び停止した RCA 用の使い捨て admin diag。
 * URL token (git 履歴に残る) で保護し、真因確定後に必ず削除 commit を積む。
 *
 * 出力は既存 logAutoReplyPipelineDiag と同等 + tokens_status + 直近 24h の
 * バイヤー活動の rescue マッチ落ち理由 + 過去 7日の auto-reply 実発火履歴 +
 * settings 生値 + 直近 24h に completed 化された会話 (bulk-complete 副作用検証)。
 *
 * Read-only。 auto-reply 本体 (src/lib/auto-reply.ts / cron route) は変更しない。
 */

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

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const nowMs = now.getTime();
  const cutoff24 = new Date(nowMs - 24 * HOUR);
  const cutoff7d = new Date(nowMs - 7 * 24 * HOUR);

  // 1) Full pipeline diag (cron piggyback と完全同一)
  const pipeline = await computeAutoReplyPipelineDiag();

  // 2) shopee_tokens の expire 状況
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
    updated_age_hours: ageHours(t.updated_at ?? null, nowMs),
  }));

  // 3) 直近 24h の バイヤー活動 (rescue にマッチしない理由の内訳)
  const convCol = await getCollection<{
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
  }>("shopee_conversations");

  const recentBuyers = await convCol
    .find({
      chat_type: { $ne: "notification" },
      customer_id: { $gt: 0 },
      last_message_time: { $gte: cutoff24 },
    })
    .sort({ last_message_time: -1 })
    .limit(25)
    .toArray();

  const cutoff24Ms = cutoff24.getTime();
  const buyerDropouts = recentBuyers.map((doc) => {
    const lmt = doc.last_message_time;
    const lar = doc.last_auto_reply_at;
    const due = doc.auto_reply_due_at;
    const lmtIsDate = lmt instanceof Date && !Number.isNaN(lmt.getTime());
    const rescueConditions = {
      not_notification: doc.chat_type !== "notification",
      customer_id_gt0: (doc.customer_id ?? 0) > 0,
      lmt_within_24h: lmtIsDate && (lmt as Date).getTime() >= cutoff24Ms,
      not_pending: doc.auto_reply_pending !== true,
      not_already_replied:
        !(lar instanceof Date) ||
        !lmtIsDate ||
        lar.getTime() < (lmt as Date).getTime(),
    };
    const processConditions = {
      pending_true: doc.auto_reply_pending === true,
      due_at_is_date: due instanceof Date && !Number.isNaN(due.getTime()),
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
      rescue_conditions: rescueConditions,
      rescue_would_match: Object.values(rescueConditions).every(Boolean),
      process_conditions: processConditions,
      process_would_match: Object.values(processConditions).every(Boolean),
    };
  });

  // 4) 過去 7日の auto-reply 実発火 (last_auto_reply_at)
  const recentFirings = await convCol
    .find({ last_auto_reply_at: { $gte: cutoff7d } })
    .sort({ last_auto_reply_at: -1 })
    .limit(30)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_name: 1,
      last_auto_reply_at: 1,
      last_message_time: 1,
    })
    .toArray();
  const firings7d = recentFirings.map((d) => ({
    conversation_id: d.conversation_id,
    shop_id: d.shop_id,
    customer_name: d.customer_name,
    last_auto_reply_at: iso(d.last_auto_reply_at ?? null),
    last_message_time: iso(d.last_message_time ?? null),
    last_auto_reply_age_hours: ageHours(d.last_auto_reply_at ?? null, nowMs),
  }));

  // 5) auto_reply_settings の生値
  const settingsCol = await getCollection<{
    _id: string;
    countries?: Record<string, unknown>;
    template_fix_applied?: boolean;
    updated_at?: Date;
  }>("auto_reply_settings");
  const settingsDoc = await settingsCol.findOne({ _id: "singleton" });

  // 6) 直近 24h に completed 化された会話 (bulk-complete/PATCH の副作用可視化)
  const recentCompletedCount = await convCol.countDocuments({
    handling_status: "completed",
    updated_at: { $gte: cutoff24 },
  });
  const recentCompletedSample = await convCol
    .find({
      handling_status: "completed",
      updated_at: { $gte: cutoff24 },
    })
    .sort({ updated_at: -1 })
    .limit(15)
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
    pipeline,
    tokens_status: tokensStatus,
    recent_buyer_activity_dropouts: buyerDropouts,
    recent_auto_reply_firings_7d: firings7d,
    auto_reply_settings_raw: settingsDoc,
    recent_completed_24h: {
      count: recentCompletedCount,
      sample: recentCompletedSample.map((d) => ({
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
