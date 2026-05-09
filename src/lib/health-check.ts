import { getCollection } from "@/lib/mongodb";

/**
 * Auto-reply ヘルスチェック (read-only)
 *
 * 目的: auto-reply が漏れている可能性のある会話を、Shopee の Overdue 警告
 *       (= triggerHour 経過) が出る前に検知する。 sunrainsky 級の事故
 *       (11 時間後にペナルティ発動) を再発させないための監視レイヤ。
 *
 * 設計書 (2026-05-09):
 *   - chat_type !== "notification"
 *   - customer_id > 0
 *   - last_message_time が直近 N 時間以内 (N = triggerHour - 2)
 *   - auto_reply_pending !== true
 *   - last_auto_reply_at が無い OR last_auto_reply_at < last_message_time
 *   - status (= handling_status) !== "completed"
 *
 * 実装方針:
 *   - DB 書き込み禁止 (read-only)
 *   - Shopee API は叩かない (Mongo クエリのみ)
 *   - 1 回の find でまとめて取得 (N+1 禁止)
 *   - 最大 100 件で打ち切り
 *   - 国別 triggerHour は auto_reply_settings.singleton.countries から取得
 *     triggerHour 設定がない国は scan 対象外
 *
 * 注意:
 *   - 設計書の `status !== "resolved"` は実 schema (HandlingStatus =
 *     "unreplied" | "auto_replied_pending" | "in_progress" | "completed")
 *     と整合しないため、対応完了を除外する設計意図を尊重して
 *     `handling_status !== "completed"` で実装している。
 */

const HOUR_MS = 60 * 60 * 1000;
export const HEALTH_CHECK_MAX_SCAN = 100;
/** N = triggerHour - WINDOW_MARGIN_HOURS (= 2h before Overdue). */
const WINDOW_MARGIN_HOURS = 2;

export type AutoReplyCountryCfg = {
  enabled?: boolean;
  triggerHour?: number;
  template_id?: string;
};

export type MissedConversation = {
  conversation_id: string;
  customer_name: string;
  shop_id: number;
  country: string;
  last_message_time: string;
  elapsed_hours: number;
  trigger_hour: number;
  expected_due_at: string;
  last_message_type: string;
};

export type HealthCheckResult = {
  scanned_at: string;
  total_conversations_checked: number;
  missed_count: number;
  missed_conversations: MissedConversation[];
};

type ConvDoc = {
  conversation_id: string;
  shop_id: number;
  country?: string;
  chat_type?: string;
  customer_id?: number;
  customer_name?: string;
  last_message_time?: Date;
  auto_reply_pending?: boolean;
  last_auto_reply_at?: Date | null;
  handling_status?: string;
  last_message_type?: string;
  latest_message_type?: string;
};

type SettingsDoc = {
  _id: string;
  countries?: Record<string, AutoReplyCountryCfg>;
};

/** triggerHour > 0 の国だけ抽出し、key は大文字に正規化。 */
function buildEligibleCountries(
  countries: Record<string, AutoReplyCountryCfg> | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!countries) return out;
  for (const [key, cfg] of Object.entries(countries)) {
    const th = Number(cfg?.triggerHour);
    if (Number.isFinite(th) && th > 0) {
      out[String(key).toUpperCase()] = th;
    }
  }
  return out;
}

export async function findMissedConversations(
  nowMs: number = Date.now()
): Promise<HealthCheckResult> {
  const settingsCol = await getCollection<SettingsDoc>("auto_reply_settings");
  const settings = await settingsCol.findOne({ _id: "singleton" });
  const eligibleCountries = buildEligibleCountries(settings?.countries);
  const eligibleKeys = Object.keys(eligibleCountries);

  if (eligibleKeys.length === 0) {
    return {
      scanned_at: new Date(nowMs).toISOString(),
      total_conversations_checked: 0,
      missed_count: 0,
      missed_conversations: [],
    };
  }

  // 粗フィルタ用 cutoff: 「最大の triggerHour - 2h」以内のメッセージのみ取得。
  // 国別 N は後段で再フィルタする。
  const maxTrigger = Math.max(...Object.values(eligibleCountries));
  const maxWindowH = Math.max(0, maxTrigger - WINDOW_MARGIN_HOURS);
  const cutoff = new Date(nowMs - maxWindowH * HOUR_MS);

  const col = await getCollection<ConvDoc>("shopee_conversations");
  const docs = await col
    .find({
      chat_type: { $ne: "notification" },
      customer_id: { $gt: 0 },
      last_message_time: { $gte: cutoff },
      auto_reply_pending: { $ne: true },
      handling_status: { $ne: "completed" },
      country: { $in: eligibleKeys },
    })
    .sort({ last_message_time: -1 })
    .limit(HEALTH_CHECK_MAX_SCAN)
    .toArray();

  const missed: MissedConversation[] = [];
  for (const doc of docs) {
    const country = String(doc.country ?? "").toUpperCase();
    const triggerHour = eligibleCountries[country];
    if (!Number.isFinite(triggerHour) || triggerHour <= 0) continue;

    const lmt = doc.last_message_time;
    if (!(lmt instanceof Date)) continue;
    const lmtMs = lmt.getTime();

    const elapsedMs = nowMs - lmtMs;
    if (elapsedMs < 0) continue; // 未来時刻は無視 (時計ズレ等)

    // 国別 N で精フィルタ
    const windowMs = Math.max(0, triggerHour - WINDOW_MARGIN_HOURS) * HOUR_MS;
    if (elapsedMs > windowMs) continue;

    // 既に自動返信済み (last_auto_reply_at >= last_message_time) は対象外
    const lar = doc.last_auto_reply_at;
    if (lar instanceof Date && lar.getTime() >= lmtMs) continue;

    missed.push({
      conversation_id: String(doc.conversation_id),
      customer_name: String(doc.customer_name ?? ""),
      shop_id: Number(doc.shop_id ?? 0),
      country,
      last_message_time: lmt.toISOString(),
      elapsed_hours: Math.round((elapsedMs / HOUR_MS) * 10) / 10,
      trigger_hour: triggerHour,
      expected_due_at: new Date(lmtMs + triggerHour * HOUR_MS).toISOString(),
      last_message_type: String(
        doc.latest_message_type ?? doc.last_message_type ?? ""
      ),
    });
  }

  return {
    scanned_at: new Date(nowMs).toISOString(),
    total_conversations_checked: docs.length,
    missed_count: missed.length,
    missed_conversations: missed,
  };
}
