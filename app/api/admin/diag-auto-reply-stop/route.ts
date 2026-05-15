import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * GET /api/admin/diag-auto-reply-stop
 *
 * Emergency diagnostic for "auto-reply 完全停止" investigation (2026-05-15).
 *
 * Read-only. Does NOT mutate any document. Designed to answer:
 *   1. Is auto_reply_pending set on enough docs? Or is the queue empty?
 *   2. Are docs overdue (due_at <= now)? How long?
 *   3. Has anything been sent recently (last_auto_reply_at)?
 *   4. Are there structural issues (missing customer_id, null due_at)?
 *   5. Are tokens still valid per shop?
 *   6. Is auto-reply enabled per country in settings?
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * TO BE DELETED after investigation completes (cf. diag-customer-state pattern).
 */

export const maxDuration = 60;

type ConvDoc = {
  conversation_id: string;
  shop_id: number;
  country?: string;
  customer_id?: number | null;
  customer_name?: string;
  chat_type?: string;
  auto_reply_pending?: boolean;
  auto_reply_due_at?: Date | null;
  last_auto_reply_at?: Date | null;
  last_message_time?: Date | null;
  staff_message_kind_log?: { id: string; kind: string }[];
  handling_status?: string;
};

type TokenDoc = {
  shop_id: number;
  country?: string;
  expires_at?: Date;
  refresh_token?: string;
  updated_at?: Date;
};

type AutoReplyCountryCfg = {
  enabled: boolean;
  triggerHour: number;
  template_id: string;
};

type SettingsDoc = {
  _id: string;
  countries?: Record<string, AutoReplyCountryCfg>;
};

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

  const now = new Date();
  const nowMs = now.getTime();
  const h12 = 12 * 3600 * 1000;
  const h24 = 24 * 3600 * 1000;
  const h72 = 72 * 3600 * 1000;
  const d7 = 7 * 24 * 3600 * 1000;

  const convCol = await getCollection<ConvDoc>("shopee_conversations");
  const tokenCol = await getCollection<TokenDoc>("shopee_tokens");
  const settingsCol = await getCollection<SettingsDoc>("auto_reply_settings");

  // ---- pending counts ----
  const pending_total = await convCol.countDocuments({
    auto_reply_pending: true,
  });
  const overdue_total = await convCol.countDocuments({
    auto_reply_pending: true,
    auto_reply_due_at: { $lte: now },
  });
  const overdue_12h_total = await convCol.countDocuments({
    auto_reply_pending: true,
    auto_reply_due_at: { $lte: new Date(nowMs - h12) },
  });
  const pending_no_due_at = await convCol.countDocuments({
    auto_reply_pending: true,
    $or: [{ auto_reply_due_at: null }, { auto_reply_due_at: { $exists: false } }],
  });
  const pending_no_customer_id = await convCol.countDocuments({
    auto_reply_pending: true,
    $or: [
      { customer_id: { $exists: false } },
      { customer_id: null },
      { customer_id: 0 },
    ],
  });
  const pending_notification_chat_type = await convCol.countDocuments({
    auto_reply_pending: true,
    chat_type: "notification",
  });

  // ---- pending by shop / country ----
  const pendingByShopAgg = await convCol
    .aggregate([
      { $match: { auto_reply_pending: true } },
      { $group: { _id: "$shop_id", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const pending_by_shop: Record<string, number> = {};
  for (const r of pendingByShopAgg)
    pending_by_shop[String(r._id ?? "unknown")] = Number(r.count);

  const pendingByCountryAgg = await convCol
    .aggregate([
      { $match: { auto_reply_pending: true } },
      { $group: { _id: "$country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const pending_by_country: Record<string, number> = {};
  for (const r of pendingByCountryAgg)
    pending_by_country[String(r._id ?? "unknown")] = Number(r.count);

  // ---- top oldest overdue (sample for inspection) ----
  const oldestOverdueDocs = await convCol
    .find({
      auto_reply_pending: true,
      auto_reply_due_at: { $lte: now },
    })
    .sort({ auto_reply_due_at: 1 })
    .limit(10)
    .toArray();

  const oldest_overdue_top = oldestOverdueDocs.map((d) => ({
    conversation_id: String(d.conversation_id),
    shop_id: Number(d.shop_id),
    country: d.country ?? null,
    customer_id: d.customer_id ?? null,
    customer_name: d.customer_name ?? null,
    chat_type: d.chat_type ?? null,
    handling_status: d.handling_status ?? null,
    auto_reply_due_at:
      d.auto_reply_due_at instanceof Date
        ? d.auto_reply_due_at.toISOString()
        : null,
    overdue_hours:
      d.auto_reply_due_at instanceof Date
        ? Math.round(
            ((nowMs - d.auto_reply_due_at.getTime()) / 3600000) * 10
          ) / 10
        : null,
    last_message_time:
      d.last_message_time instanceof Date
        ? d.last_message_time.toISOString()
        : null,
    last_auto_reply_at:
      d.last_auto_reply_at instanceof Date
        ? d.last_auto_reply_at.toISOString()
        : null,
    staff_message_kind_log_size: d.staff_message_kind_log?.length ?? 0,
  }));

  // ---- recent send activity (last_auto_reply_at) ----
  const sent_last_24h = await convCol.countDocuments({
    last_auto_reply_at: { $gte: new Date(nowMs - h24) },
  });
  const sent_last_72h = await convCol.countDocuments({
    last_auto_reply_at: { $gte: new Date(nowMs - h72) },
  });

  const sentByDayAgg = await convCol
    .aggregate([
      { $match: { last_auto_reply_at: { $gte: new Date(nowMs - d7) } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$last_auto_reply_at",
              timezone: "Asia/Tokyo",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const sent_by_day_jst_7d: Record<string, number> = {};
  for (const r of sentByDayAgg)
    sent_by_day_jst_7d[String(r._id ?? "")] = Number(r.count);

  // overall most-recent send (any time)
  const mostRecentSent = await convCol
    .find({ last_auto_reply_at: { $exists: true, $ne: null } })
    .sort({ last_auto_reply_at: -1 })
    .limit(1)
    .project<{ last_auto_reply_at: Date; conversation_id: string; shop_id: number }>({
      last_auto_reply_at: 1,
      conversation_id: 1,
      shop_id: 1,
    })
    .next();

  // ---- collection sanity ----
  const total_conversations = await convCol.countDocuments({});
  const total_with_due_at = await convCol.countDocuments({
    auto_reply_due_at: { $exists: true, $ne: null },
  });

  // ---- tokens ----
  const tokens = await tokenCol.find({}).toArray();
  const tokens_per_shop = tokens.map((t) => {
    const expMs =
      t.expires_at instanceof Date ? t.expires_at.getTime() : null;
    return {
      shop_id: Number(t.shop_id),
      country: t.country ?? null,
      expires_at: t.expires_at instanceof Date ? t.expires_at.toISOString() : null,
      expires_in_min:
        typeof expMs === "number"
          ? Math.round((expMs - nowMs) / 60000)
          : null,
      has_refresh_token: !!t.refresh_token,
      updated_at:
        t.updated_at instanceof Date ? t.updated_at.toISOString() : null,
    };
  });

  // ---- settings ----
  const settingsDoc = await settingsCol.findOne({ _id: "singleton" });
  const auto_reply_settings: Record<
    string,
    {
      enabled: boolean;
      triggerHour: number;
      has_template_id: boolean;
      template_id_preview: string | null;
    }
  > = {};
  if (settingsDoc?.countries) {
    for (const [k, v] of Object.entries(settingsDoc.countries)) {
      auto_reply_settings[k] = {
        enabled: !!v?.enabled,
        triggerHour: Number(v?.triggerHour ?? 0),
        has_template_id: !!v?.template_id?.trim(),
        template_id_preview: v?.template_id
          ? `${v.template_id.slice(0, 6)}…${v.template_id.slice(-4)}`
          : null,
      };
    }
  }

  return NextResponse.json({
    generated_at: now.toISOString(),
    queue: {
      pending_total,
      overdue_total,
      overdue_12h_total,
      pending_no_due_at,
      pending_no_customer_id,
      pending_notification_chat_type,
      pending_by_shop,
      pending_by_country,
      oldest_overdue_top,
    },
    sends: {
      sent_last_24h,
      sent_last_72h,
      sent_by_day_jst_7d,
      most_recent_sent: mostRecentSent
        ? {
            conversation_id: String(mostRecentSent.conversation_id),
            shop_id: Number(mostRecentSent.shop_id),
            last_auto_reply_at:
              mostRecentSent.last_auto_reply_at instanceof Date
                ? mostRecentSent.last_auto_reply_at.toISOString()
                : null,
            ago_hours:
              mostRecentSent.last_auto_reply_at instanceof Date
                ? Math.round(
                    ((nowMs -
                      mostRecentSent.last_auto_reply_at.getTime()) /
                      3600000) *
                      10
                  ) / 10
                : null,
          }
        : null,
    },
    sanity: {
      total_conversations,
      total_with_due_at,
    },
    tokens_per_shop,
    auto_reply_settings,
  });
}
