import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { EVENT_TYPES, type EventType } from "@/lib/event-triggered-messages";
import { SHOPEE_MARKET_CODES } from "@/lib/shopee-markets";

/**
 * Phase 2 イベント駆動メッセージの「どの event_type を、どの国で、どのテンプレートで送るか」
 * をまとめた singleton 設定。
 *
 * 既存の `auto_reply_settings` (バイヤー無返答 → 時限テンプレ送信) とは概念が別物のため
 * 別コレクションとして持つ。
 *
 * 解決ルート: shop_id → country (resolveCountryForShop) → settings.triggers[event].countries[country]
 *  - enabled_global = false                        → 送らない (cancelled)
 *  - countries[country].enabled = false            → 送らない (cancelled)
 *  - countries[country].template_id が空 / 不正    → 送らない (cancelled)
 *  - reply_templates から content が取れない        → 送らない (cancelled)
 *
 * 「未設定なら送らない」が公式方針 (誤送信 > 送信漏れ)。
 */

export const PHASE2_TRIGGER_SETTINGS_COLLECTION = "phase2_trigger_settings";
export const PHASE2_TRIGGER_SETTINGS_SINGLETON_ID = "singleton";

export type Phase2CountryCfg = {
  enabled: boolean;
  /** `reply_templates._id` の文字列。空文字 = 未設定 = 送らない。 */
  template_id: string;
};

export type Phase2EventCfg = {
  enabled_global: boolean;
  countries: Record<string, Phase2CountryCfg>;
};

export type Phase2TriggerSettingsDoc = {
  _id: string;
  triggers: Record<EventType, Phase2EventCfg>;
  created_at: Date;
  updated_at: Date;
};

export type Phase2TriggerSettings = {
  triggers: Record<EventType, Phase2EventCfg>;
  updated_at: Date | null;
};

function makeDefaultCountryMap(): Record<string, Phase2CountryCfg> {
  const map: Record<string, Phase2CountryCfg> = {};
  for (const c of SHOPEE_MARKET_CODES) {
    map[c] = { enabled: false, template_id: "" };
  }
  return map;
}

export function makeDefaultTriggers(): Record<EventType, Phase2EventCfg> {
  const out: Partial<Record<EventType, Phase2EventCfg>> = {};
  for (const et of EVENT_TYPES) {
    out[et] = {
      enabled_global: false,
      countries: makeDefaultCountryMap(),
    };
  }
  return out as Record<EventType, Phase2EventCfg>;
}

/**
 * 受信した triggers payload を、確定型 + 既知の event_type / country だけに正規化する。
 * 古い settings に未知の event_type が紛れていても無視。 新しい event_type が増えた場合は
 * デフォルト (enabled_global=false / 全国 disabled) で埋める。
 */
function normalizeTriggers(
  raw: Record<string, unknown>
): Record<EventType, Phase2EventCfg> {
  const out: Partial<Record<EventType, Phase2EventCfg>> = {};
  for (const et of EVENT_TYPES) {
    const cfg = raw?.[et] as Phase2EventCfg | undefined;
    const countries = makeDefaultCountryMap();
    const incomingCountries =
      (cfg as { countries?: Record<string, unknown> } | undefined)?.countries ??
      {};
    for (const code of SHOPEE_MARKET_CODES) {
      const v = incomingCountries[code] as
        | { enabled?: unknown; template_id?: unknown }
        | undefined;
      if (v && typeof v === "object") {
        countries[code] = {
          enabled: Boolean(v.enabled),
          template_id:
            typeof v.template_id === "string" ? v.template_id : "",
        };
      }
    }
    out[et] = {
      enabled_global: Boolean(cfg?.enabled_global),
      countries,
    };
  }
  return out as Record<EventType, Phase2EventCfg>;
}

/**
 * GET 時に呼ぶ: singleton がなければ default を投入してから返す。
 * 並行 GET で同時 insert が起きても E11000 を握りつぶして読み直す。
 */
export async function loadOrSeedPhase2TriggerSettings(): Promise<Phase2TriggerSettings> {
  const col = await getCollection<Phase2TriggerSettingsDoc>(
    PHASE2_TRIGGER_SETTINGS_COLLECTION
  );
  let doc = await col.findOne({ _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID });
  if (!doc) {
    const now = new Date();
    const fresh: Phase2TriggerSettingsDoc = {
      _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID,
      triggers: makeDefaultTriggers(),
      created_at: now,
      updated_at: now,
    };
    try {
      await col.insertOne(fresh);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("E11000")) throw e;
    }
    doc = await col.findOne({ _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID });
  }
  return {
    triggers: normalizeTriggers(
      (doc?.triggers as unknown as Record<string, unknown>) ?? {}
    ),
    updated_at: doc?.updated_at ?? null,
  };
}

/**
 * cron / sender が呼ぶ: seed しない (singleton 未投入なら null)。
 * 未投入時は「設定なし → 何も送らない」で安全に倒す。
 */
export async function getPhase2TriggerSettings(): Promise<Phase2TriggerSettings | null> {
  const col = await getCollection<Phase2TriggerSettingsDoc>(
    PHASE2_TRIGGER_SETTINGS_COLLECTION
  );
  const doc = await col.findOne({ _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID });
  if (!doc) return null;
  return {
    triggers: normalizeTriggers(
      (doc.triggers as unknown as Record<string, unknown>) ?? {}
    ),
    updated_at: doc.updated_at ?? null,
  };
}

/** PUT 用: payload を sanitize して上書き保存。 */
export async function savePhase2TriggerSettings(
  payload: { triggers?: Record<string, unknown> }
): Promise<Phase2TriggerSettings> {
  const triggers = normalizeTriggers(payload.triggers ?? {});
  const col = await getCollection<Phase2TriggerSettingsDoc>(
    PHASE2_TRIGGER_SETTINGS_COLLECTION
  );
  const now = new Date();
  await col.updateOne(
    { _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID },
    {
      $set: {
        triggers,
        updated_at: now,
      },
      $setOnInsert: {
        _id: PHASE2_TRIGGER_SETTINGS_SINGLETON_ID,
        created_at: now,
      },
    },
    { upsert: true }
  );
  return { triggers, updated_at: now };
}

/**
 * `reply_templates._id` から content を取得。
 * - 不正 ObjectId / 該当なし / content 空 → null
 * 既存の auto-reply 側 resolver と挙動を合わせている (本文 trim 後に空なら null)。
 */
export async function resolvePhase2TemplateContent(
  templateId: string
): Promise<string | null> {
  if (
    !templateId ||
    typeof templateId !== "string" ||
    !ObjectId.isValid(templateId)
  ) {
    return null;
  }
  const col = await getCollection<{ _id: ObjectId; content: string }>(
    "reply_templates"
  );
  const doc = await col.findOne({ _id: new ObjectId(templateId) });
  const text = doc?.content?.trim();
  return text || null;
}
