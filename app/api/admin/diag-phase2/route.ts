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
  PHASE2_TRIGGER_SETTINGS_COLLECTION,
  PHASE2_TRIGGER_SETTINGS_SINGLETON_ID,
  type Phase2TriggerSettingsDoc,
} from "@/lib/phase2-trigger-settings";

/**
 * GET /api/admin/diag-phase2?hours=24
 * Authorization: Bearer ${CRON_SECRET}
 *
 * Phase 2 が「動いていない」ように見える時に、Vercel Logs を読まずに
 * 原因を一発で切り分けるための診断エンドポイント。
 *
 * 出力する情報:
 *   1. env: PHASE2_TRIGGERS_ENABLED の値
 *   2. settings: phase2_trigger_settings singleton の有無 + 各 event_type の
 *      enabled_global / 国別 ON 件数 / template_id 設定済み件数
 *   3. queue (event_triggered_messages): status 内訳、最新 N 件のサンプル
 *      (status / event_type / shop_id / order_sn / last_error / due_at)
 *   4. send_log (event_triggered_send_log): 件数 + 最新 N 件
 *   5. observation (webhook_observation_log) の Phase 2 関連だけを切り出し:
 *      - code 3 / 4 の signature_valid=true vs false の件数
 *      - code 3 / 4 で missed enqueue 候補 (signature_valid=true なのに status が
 *        Phase 2 が拾わない値だったもの)
 *      - 最近の signature_invalid サンプル (reason 別)
 *      - 最近の signature_valid な code 3 サンプル (status 値の生分布)
 *      - 最近の signature_valid な code 4 サンプル (tracking_no の有無)
 *
 * 認証は他の admin endpoint と統一: Authorization: Bearer ${CRON_SECRET}。
 */

export const maxDuration = 60;

type ObsDoc = {
  received_at: Date;
  code: number;
  shop_id?: number;
  signature_valid: boolean;
  processed: boolean;
  note?: string;
  raw_payload?: Record<string, unknown>;
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

  const url = new URL(request.url);
  const hours = Math.max(1, Math.min(720, Number(url.searchParams.get("hours") ?? 24)));
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const queueCol = await getCollection<EventTriggeredMessageDoc>(
    EVENT_TRIGGERED_MESSAGES_COLLECTION
  );
  const logCol = await getCollection<EventTriggeredSendLogDoc>(
    EVENT_TRIGGERED_SEND_LOG_COLLECTION
  );
  const obsCol = await getCollection<ObsDoc>(WEBHOOK_OBSERVATION_LOG_COLLECTION);
  const settingsCol = await getCollection<Phase2TriggerSettingsDoc>(
    PHASE2_TRIGGER_SETTINGS_COLLECTION
  );

  // ---- 1. env ----
  const phase2_enabled_env = String(
    process.env.PHASE2_TRIGGERS_ENABLED ?? ""
  ).toLowerCase();

  // ---- 2. settings singleton ----
  const settingsDoc = await settingsCol.findOne({
    _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID,
  });
  const settingsSummary: Record<string, unknown> = {
    exists: Boolean(settingsDoc),
    updated_at: settingsDoc?.updated_at?.toISOString?.() ?? null,
  };
  if (settingsDoc) {
    const triggers = (settingsDoc.triggers ?? {}) as Record<
      string,
      { enabled_global?: boolean; countries?: Record<string, { enabled?: boolean; template_id?: string }> }
    >;
    const perEvent: Record<string, unknown> = {};
    for (const [et, cfg] of Object.entries(triggers)) {
      const countries = cfg.countries ?? {};
      const onCountries: string[] = [];
      const onWithTemplate: string[] = [];
      for (const [c, v] of Object.entries(countries)) {
        if (v?.enabled) {
          onCountries.push(c);
          if (typeof v.template_id === "string" && v.template_id.length > 0) {
            onWithTemplate.push(c);
          }
        }
      }
      perEvent[et] = {
        enabled_global: Boolean(cfg.enabled_global),
        on_countries: onCountries,
        on_countries_with_template: onWithTemplate,
      };
    }
    settingsSummary.triggers = perEvent;
  }

  // ---- 3. queue ----
  const queueByStatusAgg = await queueCol
    .aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const queue_by_status: Record<string, number> = {};
  for (const r of queueByStatusAgg)
    queue_by_status[String(r._id ?? "unknown")] = Number(r.count);

  const queueByStatusInPeriod = await queueCol
    .aggregate([
      { $match: { created_at: { $gte: since } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const queue_by_status_in_period: Record<string, number> = {};
  for (const r of queueByStatusInPeriod)
    queue_by_status_in_period[String(r._id ?? "unknown")] = Number(r.count);

  type QueueSampleOut = {
    status: string;
    event_type: string;
    shop_id: number;
    order_sn: string;
    template_id: string | null;
    last_error: string | null;
    due_at: string | null;
    sent_at: string | null;
    created_at: string | null;
    retry_count: number;
  };
  const sampleQueue = (docs: EventTriggeredMessageDoc[]): QueueSampleOut[] =>
    docs.map((d) => ({
      status: String(d.status),
      event_type: String(d.event_type),
      shop_id: Number(d.shop_id),
      order_sn: String(d.order_sn),
      template_id: d.template_id || null,
      last_error: d.last_error ?? null,
      due_at: d.due_at instanceof Date ? d.due_at.toISOString() : null,
      sent_at: d.sent_at instanceof Date ? d.sent_at.toISOString() : null,
      created_at:
        d.created_at instanceof Date ? d.created_at.toISOString() : null,
      retry_count: Number(d.retry_count ?? 0),
    }));

  const recent_pending = await queueCol
    .find({ status: "pending" })
    .sort({ created_at: -1 })
    .limit(10)
    .toArray();
  const recent_cancelled = await queueCol
    .find({ status: "cancelled" })
    .sort({ updated_at: -1 })
    .limit(10)
    .toArray();
  const recent_failed = await queueCol
    .find({ status: "failed" })
    .sort({ updated_at: -1 })
    .limit(10)
    .toArray();
  const recent_sent = await queueCol
    .find({ status: "sent" })
    .sort({ sent_at: -1 })
    .limit(10)
    .toArray();

  // ---- 4. send_log ----
  const send_log_total = await logCol.countDocuments({});
  const send_log_in_period = await logCol.countDocuments({
    sent_at: { $gte: since },
  });
  const recent_send_log = await logCol
    .find({})
    .sort({ sent_at: -1 })
    .limit(10)
    .toArray();

  // ---- 5. observations: code 3 / 4 を Phase 2 視点で再集計 ----
  const code3InPeriod = { code: 3, received_at: { $gte: since } };
  const code4InPeriod = { code: 4, received_at: { $gte: since } };

  const code3_total = await obsCol.countDocuments(code3InPeriod);
  const code3_signature_valid = await obsCol.countDocuments({
    ...code3InPeriod,
    signature_valid: true,
  });
  const code3_signature_invalid = code3_total - code3_signature_valid;

  const code4_total = await obsCol.countDocuments(code4InPeriod);
  const code4_signature_valid = await obsCol.countDocuments({
    ...code4InPeriod,
    signature_valid: true,
  });
  const code4_signature_invalid = code4_total - code4_signature_valid;

  // signature 失敗時の reason 分布 (code 3 / 4 全部まとめて)
  const sigInvalidByReasonAgg = await obsCol
    .aggregate([
      {
        $match: {
          received_at: { $gte: since },
          code: { $in: [3, 4] },
          signature_valid: false,
        },
      },
      { $group: { _id: "$note", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const signature_invalid_by_reason: Record<string, number> = {};
  for (const r of sigInvalidByReasonAgg)
    signature_invalid_by_reason[String(r._id ?? "")] = Number(r.count);

  // code 3: signatureValid=true で観察された status の生分布
  const code3StatusAgg = await obsCol
    .aggregate([
      { ...{ $match: { ...code3InPeriod, signature_valid: true } } },
      {
        $project: {
          status: {
            $ifNull: [
              "$raw_payload.data.status",
              { $ifNull: ["$raw_payload.data.order_status", null] },
            ],
          },
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const code3_status_distribution_signed: Record<string, number> = {};
  for (const r of code3StatusAgg)
    code3_status_distribution_signed[String(r._id ?? "null")] = Number(r.count);

  // code 4: signatureValid=true で tracking_no が来ている / 来ていない の比率
  const code4TrackingAgg = await obsCol
    .aggregate([
      { $match: { ...code4InPeriod, signature_valid: true } },
      {
        $project: {
          has_tracking: {
            $cond: [
              {
                $and: [
                  {
                    $ne: [
                      { $type: "$raw_payload.data.tracking_no" },
                      "missing",
                    ],
                  },
                  { $ne: ["$raw_payload.data.tracking_no", ""] },
                ],
              },
              true,
              false,
            ],
          },
        },
      },
      { $group: { _id: "$has_tracking", count: { $sum: 1 } } },
    ])
    .toArray();
  const code4_tracking_no_signed: Record<string, number> = {};
  for (const r of code4TrackingAgg)
    code4_tracking_no_signed[String(r._id ?? "null")] = Number(r.count);

  // 最近の signed code 3 / 4 サンプル
  type ObsSample = {
    received_at: string;
    code: number;
    shop_id: number | null;
    note: string | null;
    status: string | null;
    ordersn: string | null;
    tracking_no: string | null;
    signature_valid: boolean;
  };
  const summarizeObs = (e: ObsDoc): ObsSample => {
    const data =
      ((e.raw_payload?.data ?? {}) as Record<string, unknown>) ?? {};
    const status = data.status ?? data.order_status;
    const ordersn = data.ordersn ?? data.order_sn;
    const tracking = data.tracking_no ?? data.tracking_number;
    return {
      received_at: e.received_at.toISOString(),
      code: Number(e.code),
      shop_id: e.shop_id ?? null,
      note: e.note ?? null,
      status: status != null ? String(status) : null,
      ordersn: ordersn != null ? String(ordersn) : null,
      tracking_no: tracking != null ? String(tracking) : null,
      signature_valid: Boolean(e.signature_valid),
    };
  };

  const code3SignedRecent = (
    await obsCol
      .find({ ...code3InPeriod, signature_valid: true })
      .sort({ received_at: -1 })
      .limit(15)
      .toArray()
  ).map(summarizeObs);

  const code4SignedRecent = (
    await obsCol
      .find({ ...code4InPeriod, signature_valid: true })
      .sort({ received_at: -1 })
      .limit(15)
      .toArray()
  ).map(summarizeObs);

  const code34UnsignedRecent = (
    await obsCol
      .find({
        received_at: { $gte: since },
        code: { $in: [3, 4] },
        signature_valid: false,
      })
      .sort({ received_at: -1 })
      .limit(10)
      .toArray()
  ).map(summarizeObs);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    period_hours: hours,
    since: since.toISOString(),
    env: {
      PHASE2_TRIGGERS_ENABLED: phase2_enabled_env,
      isEnabled: phase2_enabled_env === "true",
    },
    settings: settingsSummary,
    queue: {
      total_by_status_all_time: queue_by_status,
      created_in_period_by_status: queue_by_status_in_period,
      recent_pending: sampleQueue(recent_pending),
      recent_cancelled: sampleQueue(recent_cancelled),
      recent_failed: sampleQueue(recent_failed),
      recent_sent: sampleQueue(recent_sent),
    },
    send_log: {
      total_all_time: send_log_total,
      total_in_period: send_log_in_period,
      recent: recent_send_log.map((d) => ({
        sent_at: d.sent_at instanceof Date ? d.sent_at.toISOString() : null,
        shop_id: Number(d.shop_id),
        order_sn: String(d.order_sn),
        event_type: String(d.event_type),
        message_id: d.message_id ? String(d.message_id) : null,
      })),
    },
    observations: {
      code3: {
        total: code3_total,
        signature_valid: code3_signature_valid,
        signature_invalid: code3_signature_invalid,
        status_distribution_signed: code3_status_distribution_signed,
        recent_signed: code3SignedRecent,
      },
      code4: {
        total: code4_total,
        signature_valid: code4_signature_valid,
        signature_invalid: code4_signature_invalid,
        tracking_no_present_signed: code4_tracking_no_signed,
        recent_signed: code4SignedRecent,
      },
      signature_invalid_by_reason_code3_4: signature_invalid_by_reason,
      recent_unsigned_code3_4: code34UnsignedRecent,
    },
  });
}
