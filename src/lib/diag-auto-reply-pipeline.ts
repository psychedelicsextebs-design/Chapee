import type { Filter } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { computeTemplateResolveDiag } from "@/lib/diag-template-resolve";
import { WEBHOOK_OBSERVATION_LOG_COLLECTION } from "@/lib/webhook-observation-log";

/**
 * Temporary end-to-end diagnostic for "auto-reply sent:0 / rescue scanned:0 /
 * processed:0 across all shops" investigation (2026-05-21).
 *
 * 目的: 「バイヤー着信 → Shopee 送信」の全経路のうち、 どの段階で会話が脱落して
 * sent:0 になっているのかを、 1 回の Vercel Logs 出力で確定させる。 これまでの
 * 部分修正の積み重ねを止め、 データで 1 つのボトルネックを特定するための土台。
 *
 * 完全 read-only。 mutation ゼロ。 root cause 確定後に
 * `app/api/admin/diag-auto-reply-pipeline/route.ts` と cron piggyback と共に削除する
 * (cf. diag-template-resolve パターン)。
 *
 * 出力構成:
 *   - per_shop: shopee_conversations を shop_id で group し、 各ガード条件を満たす
 *     件数を集計 (customer_id>0 / last_message_time が Date / 24h 窓内 / pending /
 *     pending かつ due)。 「窓外で 0」「customer_id 未同期で 0」等の切り分け用。
 *   - rescue_query / process_query: 本番と完全同一の filter で件数 + サンプルを取得。
 *   - target_trace: 既知の 1 会話 (デフォルト wmfahmi) を name 部分一致で引き、
 *     rescue / process 各条件を JS で再評価し pass/fail を 1 件分フルトレース。
 *   - settings: 国別 enabled / template 解決可否 (computeTemplateResolveDiag 流用)。
 *   - recent_code10_webhooks: webchat_push (code 10) の生 payload。 conversation_id が
 *     実際にどのキーに入っているか (= webhook 経路が死んでいる真因) を確認する。
 */

const RESCUE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type ConvDoc = {
  conversation_id: string;
  shop_id: number;
  country?: string;
  customer_id?: number;
  customer_name?: string;
  chat_type?: string;
  auto_reply_pending?: boolean;
  auto_reply_due_at?: Date | null;
  last_auto_reply_at?: Date | null;
  last_message_time?: Date | null;
  staff_message_kind_log?: { id: string; kind: string }[];
  rescue_at?: Date | null;
};

function ageHours(d: Date | null | undefined, now: number): number | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return Math.round(((now - d.getTime()) / 3_600_000) * 10) / 10;
}

function iso(d: Date | null | undefined): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

/** 本番 rescueUnflaggedAutoReplies と完全同一の filter (cutoff は呼び出し側で確定) */
function rescueFilter(cutoff: Date): Filter<ConvDoc> {
  return {
    chat_type: { $ne: "notification" },
    customer_id: { $gt: 0 },
    last_message_time: { $gte: cutoff },
    auto_reply_pending: { $ne: true },
    $or: [
      { last_auto_reply_at: { $exists: false } },
      { last_auto_reply_at: null },
      { $expr: { $lt: ["$last_auto_reply_at", "$last_message_time"] } },
    ],
  };
}

/** 本番 processDueAutoReplies と完全同一の filter */
function processFilter(now: Date): Filter<ConvDoc> {
  return {
    auto_reply_pending: true,
    auto_reply_due_at: { $lte: now },
  };
}

/** 1 会話に対し rescue 各条件を JS で再評価 (どの条件で落ちるかを可視化) */
function evalRescueConditions(doc: ConvDoc, cutoff: number) {
  const lmt = doc.last_message_time;
  const lar = doc.last_auto_reply_at;
  const lmtIsDate = lmt instanceof Date && !Number.isNaN(lmt.getTime());
  return {
    not_notification: doc.chat_type !== "notification",
    customer_id_gt0: Number(doc.customer_id ?? 0) > 0,
    last_message_time_is_date: lmtIsDate,
    last_message_time_within_24h: lmtIsDate && (lmt as Date).getTime() >= cutoff,
    not_pending: doc.auto_reply_pending !== true,
    not_already_replied:
      !(lar instanceof Date) ||
      !lmtIsDate ||
      lar.getTime() < (lmt as Date).getTime(),
  };
}

function evalProcessConditions(doc: ConvDoc, now: number) {
  const due = doc.auto_reply_due_at;
  return {
    pending_true: doc.auto_reply_pending === true,
    due_at_is_date: due instanceof Date && !Number.isNaN(due.getTime()),
    due_at_lte_now:
      due instanceof Date && !Number.isNaN(due.getTime()) && due.getTime() <= now,
  };
}

export type AutoReplyPipelineDiag = {
  now: string;
  rescue_cutoff: string;
  lookback_hours: number;
  conversations_total: number;
  per_shop: Array<{
    shop_id: number;
    total: number;
    customer_id_gt0: number;
    last_message_time_is_date: number;
    last_message_time_within_24h: number;
    newest_last_message_time: string | null;
    newest_lmt_age_hours: number | null;
    pending_true: number;
    pending_and_due: number;
  }>;
  rescue_query: { count: number; sample: unknown[] };
  process_query: { count: number; sample: unknown[] };
  target_trace: {
    name_query: string;
    matches: number;
    docs: Array<{
      conversation_id: string;
      shop_id: number;
      country: string | null;
      customer_id: number | null;
      customer_name: string | null;
      chat_type: string | null;
      last_message_time: string | null;
      last_message_time_age_hours: number | null;
      auto_reply_pending: boolean | null;
      auto_reply_due_at: string | null;
      last_auto_reply_at: string | null;
      rescue_at: string | null;
      staff_message_kind_log_len: number;
      rescue_conditions: ReturnType<typeof evalRescueConditions>;
      rescue_would_match: boolean;
      process_conditions: ReturnType<typeof evalProcessConditions>;
      process_would_match: boolean;
    }>;
  };
  settings_countries_analysis: unknown;
  recent_code10_webhooks: Array<{
    received_at: string | null;
    note: string | null;
    shop_id: number | null;
    raw_payload_keys: string[];
    data_keys: string[];
    raw_payload: unknown;
  }>;
};

export async function computeAutoReplyPipelineDiag(
  nameQuery = "wmfahmi"
): Promise<AutoReplyPipelineDiag> {
  const col = await getCollection<ConvDoc>("shopee_conversations");
  const now = new Date();
  const nowMs = now.getTime();
  const cutoff = new Date(nowMs - RESCUE_LOOKBACK_MS);
  const cutoffMs = cutoff.getTime();

  const conversationsTotal = await col.countDocuments({});

  // ---- per-shop aggregate ----
  const aggRaw = await col
    .aggregate<{
      _id: number;
      total: number;
      customer_id_gt0: number;
      lmt_is_date: number;
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
          lmt_is_date: {
            $sum: {
              $cond: [
                { $eq: [{ $type: "$last_message_time" }, "date"] },
                1,
                0,
              ],
            },
          },
          lmt_within_24h: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: [{ $type: "$last_message_time" }, "date"] },
                    { $gte: ["$last_message_time", cutoff] },
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

  const perShop = aggRaw.map((r) => ({
    shop_id: r._id,
    total: r.total,
    customer_id_gt0: r.customer_id_gt0,
    last_message_time_is_date: r.lmt_is_date,
    last_message_time_within_24h: r.lmt_within_24h,
    newest_last_message_time: iso(r.newest_lmt),
    newest_lmt_age_hours: ageHours(r.newest_lmt, nowMs),
    pending_true: r.pending_true,
    pending_and_due: r.pending_and_due,
  }));

  // ---- exact production queries ----
  const rescueFil = rescueFilter(cutoff);
  const processFil = processFilter(now);

  const rescueCount = await col.countDocuments(rescueFil);
  const rescueSample = await col
    .find(rescueFil)
    .limit(5)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_id: 1,
      customer_name: 1,
      last_message_time: 1,
      auto_reply_pending: 1,
    })
    .toArray();

  const processCount = await col.countDocuments(processFil);
  const processSample = await col
    .find(processFil)
    .limit(5)
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_id: 1,
      auto_reply_due_at: 1,
    })
    .toArray();

  // ---- target conversation full trace ----
  const targetDocs = await col
    .find({ customer_name: { $regex: nameQuery, $options: "i" } })
    .limit(10)
    .toArray();

  const targetTrace = targetDocs.map((doc) => {
    const rescueConditions = evalRescueConditions(doc, cutoffMs);
    const processConditions = evalProcessConditions(doc, nowMs);
    return {
      conversation_id: String(doc.conversation_id),
      shop_id: Number(doc.shop_id),
      country: doc.country ?? null,
      customer_id: doc.customer_id ?? null,
      customer_name: doc.customer_name ?? null,
      chat_type: doc.chat_type ?? null,
      last_message_time: iso(doc.last_message_time),
      last_message_time_age_hours: ageHours(doc.last_message_time, nowMs),
      auto_reply_pending: doc.auto_reply_pending ?? null,
      auto_reply_due_at: iso(doc.auto_reply_due_at),
      last_auto_reply_at: iso(doc.last_auto_reply_at),
      rescue_at: iso(doc.rescue_at),
      staff_message_kind_log_len: (doc.staff_message_kind_log ?? []).length,
      rescue_conditions: rescueConditions,
      rescue_would_match: Object.values(rescueConditions).every(Boolean),
      process_conditions: processConditions,
      process_would_match: Object.values(processConditions).every(Boolean),
    };
  });

  // ---- settings sanity (reuse existing template-resolve diag) ----
  let settingsCountriesAnalysis: unknown = null;
  try {
    const tpl = await computeTemplateResolveDiag();
    settingsCountriesAnalysis = tpl.countries_analysis;
  } catch (e) {
    settingsCountriesAnalysis = {
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // ---- recent code-10 webhook raw payloads ----
  const obsCol = await getCollection<{
    received_at?: Date;
    note?: string;
    shop_id?: number;
    raw_payload?: Record<string, unknown>;
  }>(WEBHOOK_OBSERVATION_LOG_COLLECTION);
  const code10 = await obsCol
    .find({ code: 10 })
    .sort({ received_at: -1 })
    .limit(10)
    .toArray();

  const recentCode10 = code10.map((d) => {
    const rp = d.raw_payload ?? {};
    const inner =
      rp && typeof rp._data === "object" && rp._data !== null
        ? (rp._data as Record<string, unknown>)
        : rp;
    return {
      received_at: iso(d.received_at),
      note: d.note ?? null,
      shop_id: d.shop_id ?? null,
      raw_payload_keys: Object.keys(rp),
      data_keys: Object.keys(inner ?? {}),
      raw_payload: rp,
    };
  });

  return {
    now: now.toISOString(),
    rescue_cutoff: cutoff.toISOString(),
    lookback_hours: RESCUE_LOOKBACK_MS / 3_600_000,
    conversations_total: conversationsTotal,
    per_shop: perShop,
    rescue_query: { count: rescueCount, sample: rescueSample },
    process_query: { count: processCount, sample: processSample },
    target_trace: {
      name_query: nameQuery,
      matches: targetDocs.length,
      docs: targetTrace,
    },
    settings_countries_analysis: settingsCountriesAnalysis,
    recent_code10_webhooks: recentCode10,
  };
}

/**
 * 結果を console.log に構造化出力する (curl 不要・ Vercel Logs で読む)。
 * auto-reply cron から `logAutoReplyPipelineDiag("cron")` で呼ぶ。
 */
export async function logAutoReplyPipelineDiag(label: string): Promise<void> {
  try {
    const result = await computeAutoReplyPipelineDiag();
    console.log(
      `[diag-pipeline/${label}] full result`,
      JSON.stringify(result, null, 2)
    );
  } catch (e) {
    console.error(`[diag-pipeline/${label}] failed`, e);
  }
}
