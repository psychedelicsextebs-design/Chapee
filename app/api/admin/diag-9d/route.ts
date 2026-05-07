import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { WEBHOOK_OBSERVATION_LOG_COLLECTION } from "@/lib/webhook-observation-log";
import { SHOPEE_CHAT_MESSAGES_COLLECTION } from "@/lib/shopee-conversation-db-sync";

/**
 * GET /api/admin/diag-9d?days=9
 *
 * 4/27〜28 にデプロイした 5 連発パッチ (39b39cb, 9606c72, a72e984, 06b2238, 8316aa4)
 * の効果検証を、Vercel Logs に頼らず Mongo データから実施するための診断エンドポイント。
 *
 * 主に:
 *   - 9606c72 (webhook shop_id 多層フォールバック) の効果
 *     → webhook_observation_log の note=webchat_push_missing_shop_id を集計
 *   - a72e984+06b2238 (sync 安定化) の間接指標
 *     → shopee_chat_messages の取り込み量推移 (sync が止まれば落ちる)
 *   - Phase 1 観察データの全体像
 *     → code 3 / 4 / 10 / その他の受信内訳
 *     → 国/shop 別の messages 流量
 *
 * 39b39cb (auto-reply 誤発火) は既存の /api/admin/find-auto-reply-victims を別に叩く。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
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

type MsgDoc = {
  conversation_id: string;
  shop_id: number;
  message_id: string;
  timestamp_ms: number;
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
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get("days") ?? 9)));
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  const since = new Date(sinceMs);

  const obsCol = await getCollection<ObsDoc>(WEBHOOK_OBSERVATION_LOG_COLLECTION);
  const msgCol = await getCollection<MsgDoc>(SHOPEE_CHAT_MESSAGES_COLLECTION);

  // ---- webhook_observation_log: 全体集計 ----
  const obsTotal = await obsCol.countDocuments({ received_at: { $gte: since } });

  const byCodeAgg = await obsCol
    .aggregate([
      { $match: { received_at: { $gte: since } } },
      { $group: { _id: "$code", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const by_code: Record<string, number> = {};
  for (const r of byCodeAgg) by_code[String(r._id ?? "null")] = Number(r.count);

  const byNoteAgg = await obsCol
    .aggregate([
      { $match: { received_at: { $gte: since }, note: { $exists: true } } },
      { $group: { _id: "$note", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const by_note: Record<string, number> = {};
  for (const r of byNoteAgg) by_note[String(r._id ?? "null")] = Number(r.count);

  // 日別 × code 内訳 (JST)
  const byDayAgg = await obsCol
    .aggregate([
      { $match: { received_at: { $gte: since } } },
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
            code: "$code",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.date": 1, "_id.code": 1 } },
    ])
    .toArray();
  const by_day_jst: Record<string, Record<string, number>> = {};
  for (const r of byDayAgg) {
    const d = String((r._id as { date: string }).date);
    const c = String((r._id as { code: number | null }).code ?? "null");
    by_day_jst[d] = by_day_jst[d] ?? {};
    by_day_jst[d][c] = Number(r.count);
  }

  // 署名失敗内訳 (note は "unverified:no_partner_key" など)
  const sigInvalidTotal = await obsCol.countDocuments({
    received_at: { $gte: since },
    signature_valid: false,
  });
  const sigInvalidByReasonAgg = await obsCol
    .aggregate([
      {
        $match: {
          received_at: { $gte: since },
          signature_valid: false,
          note: { $exists: true },
        },
      },
      { $group: { _id: "$note", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const sig_invalid_by_reason: Record<string, number> = {};
  for (const r of sigInvalidByReasonAgg)
    sig_invalid_by_reason[String(r._id ?? "")] = Number(r.count);

  // 9606c72 検証ターゲット: missing shop_id 件数 + サンプル
  const missingShopIdFilter = {
    received_at: { $gte: since },
    note: "webchat_push_missing_shop_id",
  } as const;
  const missingShopIdCount = await obsCol.countDocuments(missingShopIdFilter);
  const missingShopIdSamples = await obsCol
    .find(missingShopIdFilter)
    .sort({ received_at: -1 })
    .limit(20)
    .toArray();

  type RawWebchatPayload = {
    _data?: Record<string, unknown>;
    _fallback_shop_id?: number | null;
  };

  const missing_shop_id_samples = missingShopIdSamples.map((e) => {
    const raw = (e.raw_payload ?? {}) as RawWebchatPayload;
    const data = (raw._data ?? {}) as Record<string, unknown>;
    return {
      received_at: e.received_at.toISOString(),
      fallback_shop_id: raw._fallback_shop_id ?? null,
      data_keys: Object.keys(data),
      conversation_id:
        typeof data.conversation_id === "string"
          ? data.conversation_id
          : data.conversation_id != null
            ? String(data.conversation_id)
            : null,
    };
  });

  // missing conv_id (別系) も併記
  const missingConvIdCount = await obsCol.countDocuments({
    received_at: { $gte: since },
    note: "webchat_push_missing_conv_id",
  });

  // ---- shopee_chat_messages: 流量 (webhook 由来キャッシュの健康度) ----
  //
  // 注意: このコレクションは webhook (code 10) が書き込む「フォールバックキャッシュ」。
  // ダッシュボードの会話一覧は shopee_conversations 由来で別物。
  // 期間フィルタは synced_at (Date) を使用 — Date 比較なので webhook_observation と
  // 同じパス。timestamp_ms (number) は最新メッセージ時刻の参照と _debug 用に残す。

  const msgTotal = await msgCol.countDocuments({
    synced_at: { $gte: since },
  });

  const msgByShopAgg = await msgCol
    .aggregate([
      { $match: { synced_at: { $gte: since } } },
      { $group: { _id: "$shop_id", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  const messages_by_shop: Record<string, number> = {};
  for (const r of msgByShopAgg)
    messages_by_shop[String(r._id ?? "unknown")] = Number(r.count);

  const msgByDayAgg = await msgCol
    .aggregate([
      { $match: { synced_at: { $gte: since } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$synced_at",
              timezone: "Asia/Tokyo",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const messages_by_day_jst: Record<string, number> = {};
  for (const r of msgByDayAgg)
    messages_by_day_jst[String(r._id ?? "")] = Number(r.count);

  // shop ごとの最新 message timestamp (受信が止まっていないか)
  const recentByShopAgg = await msgCol
    .aggregate([
      { $sort: { timestamp_ms: -1 } },
      { $group: { _id: "$shop_id", last_ms: { $first: "$timestamp_ms" } } },
    ])
    .toArray();
  const messages_most_recent_per_shop: Record<string, string> = {};
  for (const r of recentByShopAgg) {
    const lastMs = Number((r as { last_ms?: number }).last_ms ?? 0);
    if (!Number.isFinite(lastMs) || lastMs <= 0) continue;
    messages_most_recent_per_shop[String(r._id ?? "unknown")] =
      new Date(lastMs).toISOString();
  }

  // ---- _debug: messages_volume が空に見えた件の切り分け用診断 ----
  // 5/7 報告: 旧版 (timestamp_ms フィルタ) で messages_volume がほぼ空。
  // 原因候補を一発で特定できる情報を出す。次回安定後に削除可能。
  const msgCollectionTotal = await msgCol.countDocuments({});
  const msgWithTimestampMs = await msgCol.countDocuments({
    timestamp_ms: {
      $exists: true,
      $type: ["int", "long", "double", "decimal"],
    },
  });
  const msgWithSyncedAt = await msgCol.countDocuments({
    synced_at: { $exists: true },
  });
  const msgViaTimestampMsCount = await msgCol.countDocuments({
    timestamp_ms: { $gte: sinceMs },
  });
  const msgSampleDocs = await msgCol
    .find({})
    .sort({ synced_at: -1 })
    .limit(2)
    .toArray();
  const msgSampleFields = msgSampleDocs.map((d) => {
    const obj = d as unknown as Record<string, unknown>;
    return {
      keys: Object.keys(obj),
      timestamp_ms_type: typeof obj.timestamp_ms,
      timestamp_ms_value: obj.timestamp_ms ?? null,
      synced_at_type:
        obj.synced_at instanceof Date ? "Date" : typeof obj.synced_at,
      synced_at_value:
        obj.synced_at instanceof Date
          ? obj.synced_at.toISOString()
          : (obj.synced_at ?? null),
      shop_id: obj.shop_id ?? null,
    };
  });

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    period_days: days,
    since: since.toISOString(),
    timezone: "Asia/Tokyo",
    webhook_observation: {
      total: obsTotal,
      by_code,
      by_note,
      by_day_jst,
      signature: {
        invalid_total: sigInvalidTotal,
        invalid_by_reason: sig_invalid_by_reason,
      },
      missing_shop_id_code10: {
        count: missingShopIdCount,
        sample_recent: missing_shop_id_samples,
      },
      missing_conv_id_code10: {
        count: missingConvIdCount,
      },
    },
    messages_volume: {
      filter_basis: "synced_at",
      total_in_period: msgTotal,
      by_shop: messages_by_shop,
      by_day_jst: messages_by_day_jst,
      most_recent_per_shop: messages_most_recent_per_shop,
      _debug: {
        collection_total: msgCollectionTotal,
        with_timestamp_ms_field_numeric: msgWithTimestampMs,
        with_synced_at_field: msgWithSyncedAt,
        count_via_timestamp_ms_filter: msgViaTimestampMsCount,
        sample_docs: msgSampleFields,
      },
    },
  });
}
