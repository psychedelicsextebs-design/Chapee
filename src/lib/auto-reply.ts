import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { fetchAllConversationMessages, sendMessage } from "@/lib/shopee-api";
import { getShopCountry, getValidToken, resolveCountryForShop } from "@/lib/shopee-token";
import {
  extractMessageIdFromSendResponse,
  recordStaffMessageKind,
} from "@/lib/staff-message-kind";
import { shopeeMessageTimeToMs } from "@/lib/shopee-conversation-utils";

/**
 * Pure helper (testable): classify a single Shopee chat message as buyer vs. staff.
 *
 * Why not just `from_id === shop_id`:
 *   Shopee Seller Center (sub-accounts / mobile app / CS agents) sends with
 *   `from_id = staff user_id`, NOT `shop_id`. The old check mis-labelled those
 *   as buyer messages and the auto-reply fired 11h after a staff reply.
 *
 * The only reliable signal we always have is `customer_id` (the buyer's Shopee
 * user id, persisted on the conversation doc). Any message whose `from_id`
 * does NOT equal `customer_id` is therefore a shop-side (staff) message.
 *
 * Patch A (to_id fallback):
 *   Shopee の sticker / 一部のメッセージ種別では `from_id=0` で配信される
 *   ことがある (4/22 09:10 の sabara2722 / dareraru 誤発火の根本原因)。
 *   from_id が 0 でも、`to_id === customer_id` なら「buyer 宛」=「staff 送信」と
 *   断定できる。 buyer 宛だけを確定処理し、それ以外の不明ケースは "unknown" のまま。
 *
 * Patch D (shop 宛 = buyer 発信):
 *   商品カード問い合わせ (message_type=item) 等は from_id=0 で配信されるが、
 *   to_id には shop_id が入る。 shopId が判明していれば to_id === shopId のとき
 *   「shop 宛」=「buyer 発信」と断定できる (5/7 sunrainsky 案件の構造的弱点対応)。
 *   shopId は optional — 未指定なら従来挙動 (Patch A/B のみ) を維持する。
 *
 * Patch B (unknown default 維持):
 *   from_id=0 かつ to_id でも向きが特定できない場合は引き続き "unknown" を返す。
 *   呼び出し側は "unknown" を buyer/staff いずれの最終時刻にも採用しないため、
 *   Patch C (pre-send cooldown) で「分類不能だが直近活動あり」として安全側に倒す。
 */
export function classifyShopeeMessageSender(
  msg: Record<string, unknown>,
  customerId: number,
  shopId?: number
): "buyer" | "staff" | "unknown" {
  const fromId = Number(msg.from_id ?? msg.from_user_id ?? 0);
  const buyer = Number(customerId);
  const shop = Number(shopId ?? 0);

  if (Number.isFinite(fromId) && fromId > 0) {
    if (Number.isFinite(buyer) && buyer > 0 && fromId === buyer) return "buyer";
    return "staff";
  }

  // Patch A: from_id=0 — sticker / system card 等。to_id で向きを推定する。
  const toId = Number(msg.to_id ?? msg.to_user_id ?? 0);
  if (Number.isFinite(toId) && toId > 0) {
    if (Number.isFinite(buyer) && buyer > 0 && toId === buyer) {
      // 「buyer 宛」が確定した → 送信者は staff 側 (shop or sub-account)。
      return "staff";
    }
    // Patch D: 「shop 宛」が確定した → 送信者は buyer 側 (商品カード問い合わせ等)。
    if (Number.isFinite(shop) && shop > 0 && toId === shop) {
      return "buyer";
    }
  }

  // Patch B: それ以外 (to_id 不明 / 0 / customer_id 不明) は "unknown" のまま。
  return "unknown";
}

/**
 * Pure helper (testable): walk raw messages and return the latest buyer/staff
 * timestamps (ms since epoch, 0 if none).
 */
export function computeBuyerStaffLastMs(
  rawMessages: Record<string, unknown>[],
  customerId: number,
  shopId?: number
): { lastBuyerMs: number; lastStaffMs: number } {
  let lastBuyerMs = 0;
  let lastStaffMs = 0;
  for (const msg of rawMessages) {
    const kind = classifyShopeeMessageSender(msg, customerId, shopId);
    if (kind === "unknown") continue;
    const ts = shopeeMessageTimeToMs(
      msg.timestamp ?? msg.created_timestamp ?? msg.time
    );
    if (kind === "buyer") {
      if (ts > lastBuyerMs) lastBuyerMs = ts;
    } else {
      if (ts > lastStaffMs) lastStaffMs = ts;
    }
  }
  return { lastBuyerMs, lastStaffMs };
}

/**
 * Pure helper (testable): return the latest message timestamp (ms) regardless
 * of sender classification.
 *
 * Patch C 用: 「from_id=0 / to_id 0 で sender が "unknown" になったメッセージ」
 * も含めた最終時刻を取得する。 pre-send guard で「最後に分類できた buyer
 * メッセージより新しい未分類活動があれば送らない」二重防衛に使用する。
 */
export function computeLastAnyMessageMs(
  rawMessages: Record<string, unknown>[]
): number {
  let last = 0;
  for (const msg of rawMessages) {
    const ts = shopeeMessageTimeToMs(
      msg.timestamp ?? msg.created_timestamp ?? msg.time
    );
    if (ts > last) last = ts;
  }
  return last;
}

/** Mirrors `AutoReplyCountryStored` in settings API */
type AutoReplyCountryCfg = {
  enabled: boolean;
  triggerHour: number;
  template_id: string;
  subAccounts?: { id: string; name: string; enabled: boolean }[];
};

async function getSingletonAutoReplyCountries(): Promise<
  Record<string, AutoReplyCountryCfg>
> {
  const col = await getCollection<{
    _id: string;
    countries: Record<string, AutoReplyCountryCfg>;
  }>("auto_reply_settings");
  const doc = await col.findOne({ _id: "singleton" });
  return doc?.countries ?? {};
}

/**
 * テンプレ ID で本文を解決する。 ID が壊れている / テンプレが削除済み /
 * content が空、のいずれでも auto-reply を止めないよう、 autoReply=true で
 * 最新の updated_at を持つテンプレに自動 fallback する (レイヤー 3 防御)。
 *
 * 設計欠陥対応 (2026-05-19): UI からテンプレを編集・削除しても
 * auto_reply_settings は古い template_id を参照し続けるため、 ID 不整合の
 * たびに「template content empty/missing」で本番 auto-reply が skipped になる
 * 問題への耐性層。 fallback 発火時は console.warn で監視可能にする。
 *
 * 呼び出し側 (processDueAutoReplies) は cfg.enabled と cfg.template_id 非空を
 * 既にガードしているため、 fallback が「設定されていないのに勝手に送る」状況
 * にはならない。
 */
async function resolveTemplateContent(
  templateId: string
): Promise<string | null> {
  const col = await getCollection<{
    _id: ObjectId;
    content?: string;
    autoReply?: boolean;
    name?: string;
    updated_at?: Date;
  }>("reply_templates");

  if (templateId && ObjectId.isValid(templateId)) {
    const doc = await col.findOne({ _id: new ObjectId(templateId) });
    const text = doc?.content?.trim();
    if (text) return text;
  }

  const fb = await col
    .find({ autoReply: true })
    .sort({ updated_at: -1 })
    .limit(1)
    .next();
  const fbText = fb?.content?.trim();
  if (fbText && fb) {
    console.warn(
      `[auto-reply] resolveTemplateContent: fallback to autoReply=true template ` +
        `id=${fb._id.toHexString()} name=${fb.name ?? "?"} ` +
        `(requested template_id=${templateId || "(empty)"})`
    );
    return fbText;
  }
  return null;
}

/**
 * /api/shopee/sync のフォールバック用。
 *
 * 未読会話 ID リストを受け取り、 `last_message_time` が `(triggerHour - 1h)` 以内の
 * 会話のみ生メッセージを Shopee API から取得して reviewAutoReplySchedule に委譲する。
 *
 * 設計:
 *   - 判定ロジックは review / webhook / chats-messages と完全に同一
 *     （「M_latest 以降にスタッフ(手動/自動/テンプレ/スタンプ/商品カード)応答があれば
 *       auto-reply しない」）。これにより metadata 推定による誤射（22:30 バースト）を
 *     根本的に止める。
 *   - API コスト削減のため、カバレッジ窓 = max(1, triggerHour - 1) 時間より古い
 *     会話は raw fetch しない。新規バイヤー活動があれば last_message_time が
 *     更新されて窓内に戻るため、活動再開時は正常に発火する。
 *   - customer_id / template / enabled などの各種ガードは review 側に集約済み。
 *     この関数では disabled のときに fetch 自体を省略する早期リターンのみ行う。
 */
export async function scheduleAutoReplyForUnread(
  shopId: number,
  conversationIds: string[]
): Promise<void> {
  if (!conversationIds.length) return;

  const country = (await getShopCountry(shopId)) ?? "SG";
  const countryKey = String(country).toUpperCase();
  const countries = await getSingletonAutoReplyCountries();
  const cfg = countries[countryKey];

  if (
    !cfg?.enabled ||
    !cfg.template_id?.trim() ||
    !ObjectId.isValid(cfg.template_id.trim())
  ) {
    return;
  }

  const triggerHour = Math.max(1, Number(cfg.triggerHour) || 1);
  const coverageMs = Math.max(1, triggerHour - 1) * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - coverageMs);

  const col = await getCollection<{
    conversation_id: string;
    shop_id: number;
    last_message_time?: Date;
  }>("shopee_conversations");

  const candidates = await col
    .find({
      conversation_id: { $in: conversationIds },
      shop_id: shopId,
      last_message_time: { $gte: cutoff },
    })
    .toArray();

  if (!candidates.length) return;

  let accessToken: string;
  try {
    accessToken = await getValidToken(shopId);
  } catch (e) {
    console.warn(
      `[auto-reply] sync-fallback: token fetch failed shop=${shopId}:`,
      e
    );
    return;
  }

  for (const doc of candidates) {
    const convId = String(doc.conversation_id);
    try {
      const rawList = (await fetchAllConversationMessages(
        accessToken,
        shopId,
        convId,
        { country }
      )) as Record<string, unknown>[];
      await reviewAutoReplySchedule(rawList, shopId, convId);
    } catch (e) {
      console.warn(
        `[auto-reply] sync-fallback: review failed conv=${convId} shop=${shopId}:`,
        e
      );
    }
  }
}

/** スタッフ送信後・手動送信後に保留中の自動返信をキャンセル */
export async function clearAutoReplySchedule(
  conversationId: string,
  shopId: number
): Promise<void> {
  const col = await getCollection("shopee_conversations");
  await col.updateOne(
    { conversation_id: String(conversationId), shop_id: shopId },
    {
      $set: {
        auto_reply_pending: false,
        auto_reply_due_at: null,
        updated_at: new Date(),
      },
    }
  );
}

/**
 * Review and correct the auto-reply schedule based on **actual message timestamps**.
 *
 * Called whenever the full raw message list is available:
 *   - Inside syncWebhookConversationFull (covers missed/delayed webhooks)
 *   - Inside GET /api/chats/[id]/messages (covers manual page refreshes)
 *
 * Outcomes:
 *   - Staff replied after last buyer message  → cancel any pending schedule.
 *   - Buyer message unanswered               → (re-)schedule due_at = lastBuyerTime + triggerHour.
 *   - Already overdue                         → due_at = now (fires on next cron tick).
 *   - Auto-reply already sent after that msg  → no-op (won't double-send).
 *   - Auto-reply disabled / no template       → clear pending and return.
 */
export async function reviewAutoReplySchedule(
  rawMessages: Record<string, unknown>[],
  shopId: number,
  conversationId: string,
): Promise<void> {
  const convId = String(conversationId);
  try {
    const col = await getCollection<{
      conversation_id: string;
      shop_id: number;
      country?: string;
      customer_id?: number;
      chat_type?: string;
      auto_reply_pending?: boolean;
      auto_reply_due_at?: Date | null;
      last_auto_reply_at?: Date | null;
      last_message_time?: Date | null;
      staff_message_kind_log?: { id: string; kind: string }[];
      rescue_at?: Date | null;
    }>("shopee_conversations");

    const existing = await col.findOne({ conversation_id: convId, shop_id: shopId });
    if (!existing) return;
    if (existing.chat_type === "notification") return;

    // 安全ガード: customer_id が未同期なら誰が買い手か判定できない → 送らない
    // (誤送信 > 送信漏れ の方針で保守的に倒す)
    const customerId = Number(existing.customer_id ?? 0);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      if (existing.auto_reply_pending) {
        await clearAutoReplySchedule(convId, shopId);
      }
      console.warn(
        `[auto-reply] review: skipped (customer_id 未同期) conv=${convId} shop=${shopId}`
      );
      return;
    }

    const country = (await getShopCountry(shopId)) ?? existing.country ?? "SG";
    const countryKey = String(country).toUpperCase();
    const countries = await getSingletonAutoReplyCountries();
    const cfg = countries[countryKey];

    if (!cfg?.enabled || !cfg.template_id?.trim() || !ObjectId.isValid(cfg.template_id.trim())) {
      if (existing.auto_reply_pending) {
        await clearAutoReplySchedule(convId, shopId);
      }
      return;
    }

    const triggerHour = Math.max(1, Number(cfg.triggerHour) || 1);

    // Determine last buyer / last staff timestamps from the raw list.
    // Staff detection is NOT just `from_id === shop_id` — Shopee Seller Center
    // sub-account / mobile / CS-agent messages arrive with the staff's personal
    // user_id. Anything that isn't from customer_id is staff-side.
    const classified = computeBuyerStaffLastMs(
      rawMessages,
      customerId,
      shopId
    );
    let lastBuyerMs = classified.lastBuyerMs;
    const lastStaffMs = classified.lastStaffMs;

    /**
     * 商品カード問い合わせ救済 (2026-05-11 / gg.ah.goh.goh / shopaholic138 案件)
     * + rescue 経由 pending の silent-clear 抑止 (2026-05-19 / 拡張):
     *
     * 元々は webhook が空応答 (Shopee API の race / 新規会話直後の hiccup) で
     * 着地して rawMessages.length===0 になったケースの救済だった。
     *
     * 2026-05-19 拡張: rawMessages が非空でも classifyShopeeMessageSender が
     * buyer/staff いずれも特定できない (lastBuyerMs===0 かつ lastStaffMs===0)
     * ケースを同じ経路に流す。 これは rescue scan が `last_message_time` で
     * pending を立てた直後、 review() がここで silent に pending=false に
     * 戻して全件 skipped になっていた症状 (Vercel Logs 2026-05-19 01:45 tick)
     * の根本対処。 system message / unknown sticker しか分類できない場合の
     * 「とりあえず last_message_time を buyer 時刻として採用」フォールバック。
     *
     * 安全ガード (誤発火回避、 staff 応答が見えた場合は適用しない):
     *   - lastStaffMs === 0 (= rawList から staff 信号がゼロ。 1 件でも staff
     *     が検出されれば後段の lastStaffMs >= lastBuyerMs で正しくキャンセルされる)
     *   - existing.last_message_time が存在 (conv-list sync で埋まっている)
     *   - last_auto_reply_at が無い or < last_message_time (再送防止)
     *   - staff_message_kind_log が空 (我々のシステムから何も送っていない)
     *
     * 後段の pre-send guard も同じ拡張を持っているので、 Shopee API が staff
     * メッセージを返したタイミングで自動キャンセルされる。
     */
    if (
      lastBuyerMs === 0 &&
      lastStaffMs === 0 &&
      existing.last_message_time instanceof Date
    ) {
      const lmt = existing.last_message_time;
      const lar = existing.last_auto_reply_at;
      const staffLog = existing.staff_message_kind_log ?? [];
      const alreadyReplied =
        lar instanceof Date && lar.getTime() >= lmt.getTime();
      if (!alreadyReplied && staffLog.length === 0) {
        lastBuyerMs = lmt.getTime();
        console.log(
          `[auto-reply] review: no-signal fallback (using last_message_time) ` +
            `conv=${convId} shop=${shopId} ` +
            `rawListLen=${rawMessages.length} ` +
            `lmt=${lmt.toISOString()}`
        );
      }
    }

    if (lastBuyerMs === 0) {
      // No buyer activity at all → nothing to auto-reply to.
      if (existing.auto_reply_pending) {
        const staffLogLen = (existing.staff_message_kind_log ?? []).length;
        await clearAutoReplySchedule(convId, shopId);
        console.log(
          `[auto-reply] review: cleared (no buyer activity in rawList) ` +
            `conv=${convId} shop=${shopId} ` +
            `rawListLen=${rawMessages.length} ` +
            `lastStaffMs=${lastStaffMs} ` +
            `lmt=${existing.last_message_time?.toISOString?.() ?? "none"} ` +
            `lar=${existing.last_auto_reply_at?.toISOString?.() ?? "none"} ` +
            `staffLog=${staffLogLen} ` +
            `rescue_at=${existing.rescue_at?.toISOString?.() ?? "none"}`
        );
      }
      return;
    }

    // Staff has already replied after the last buyer message → cancel
    if (lastStaffMs >= lastBuyerMs) {
      if (existing.auto_reply_pending) {
        await clearAutoReplySchedule(convId, shopId);
        console.log(
          `[auto-reply] review: cleared (staff replied) conv=${convId} ` +
            `lastBuyer=${new Date(lastBuyerMs).toISOString()} ` +
            `lastStaff=${new Date(lastStaffMs).toISOString()} ` +
            `rescue_at=${existing.rescue_at?.toISOString?.() ?? "none"}`
        );
      }
      return;
    }

    // Auto-reply was already sent after this buyer message → no-op
    const lastAutoAt = existing.last_auto_reply_at;
    if (lastAutoAt instanceof Date && lastAutoAt.getTime() >= lastBuyerMs) return;

    // Compute correct due time from the actual buyer message timestamp
    const dueMs = lastBuyerMs + triggerHour * 60 * 60 * 1000;
    const now = Date.now();
    // Note: 過去 due を now に丸める挙動は歴史的経緯で残している。
    // pre-send guard (スタッフ応答の再検証) で誤送信は止まるため実害なし。
    // 将来的に、新規予約のみ時刻を保持する形にリファクタすべき。
    const due = new Date(dueMs > now ? dueMs : now);

    // Skip write if already scheduled with the same due time (±1 min tolerance)
    const existingDue = existing.auto_reply_due_at?.getTime?.();
    if (
      existing.auto_reply_pending === true &&
      typeof existingDue === "number" &&
      Math.abs(existingDue - due.getTime()) < 60_000
    ) {
      return;
    }

    await col.updateOne(
      { conversation_id: convId, shop_id: shopId },
      { $set: { auto_reply_pending: true, auto_reply_due_at: due, updated_at: new Date() } }
    );

    console.log(
      `[auto-reply] review: (re-)scheduled conv=${convId} shop=${shopId} due=${due.toISOString()} (${triggerHour}h from last buyer msg)`
    );
  } catch (e) {
    console.warn(`[auto-reply] reviewAutoReplySchedule failed conv=${convId}:`, e);
  }
}

type WebhookMsg = {
  shop_id: number;
  conversation_id: string;
  to_id: number;
  to_name: string;
  from_id: number;
  /** DB sync returns a Date; webhook data may supply a raw ms number. */
  last_buyer_message_time?: Date | number;
};

/**
 * Webhook: バイヤーからのメッセージで自動返信を予約、店舗からならキャンセル。
 *
 * スタッフ判定は `from_id === shop_id` では不十分（セラーセンターのサブアカウント
 * 等は `from_id = 個人user_id`）。 DB に保存済みの `customer_id` と `from_id` が
 * 一致したときだけバイヤーからの着信として扱い、それ以外はスタッフ送信と判定する。
 */
export async function handleAutoReplyOnWebhookMessage(
  data: WebhookMsg
): Promise<void> {
  const { shop_id, conversation_id, from_id } = data;
  const convId = String(conversation_id);

  const col = await getCollection<{
    conversation_id: string;
    shop_id: number;
    country?: string;
    customer_id?: number;
    chat_type?: string;
    customer_name?: string;
    last_auto_reply_at?: Date;
  }>("shopee_conversations");

  const existing = await col.findOne({ conversation_id: convId, shop_id });
  if (existing?.chat_type === "notification") return;

  const customerId = Number(existing?.customer_id ?? 0);
  const fromIdNum = Number(from_id);

  // customer_id が未同期 → 判定不能なので保守的に送らない（pending もクリア）
  if (!Number.isFinite(customerId) || customerId <= 0) {
    await clearAutoReplySchedule(convId, shop_id);
    console.warn(
      `[auto-reply] webhook: skipped (customer_id 未同期) conv=${convId} shop=${shop_id}`
    );
    return;
  }

  // バイヤー以外（shop 本体でもサブアカウントでも）の送信ならスケジュールをキャンセル
  const isBuyerMessage =
    Number.isFinite(fromIdNum) && fromIdNum > 0 && fromIdNum === customerId;
  if (!isBuyerMessage) {
    await clearAutoReplySchedule(convId, shop_id);
    return;
  }

  const existingCountry = existing?.country;
  const country =
    (await getShopCountry(shop_id)) ?? existingCountry ?? "SG";
  const countryKey = String(country).toUpperCase();

  const countries = await getSingletonAutoReplyCountries();
  const cfg = countries[countryKey];
  if (!cfg?.enabled || !cfg.template_id?.trim()) return;
  if (!ObjectId.isValid(cfg.template_id.trim())) return;

  const triggerHour = Math.max(1, Number(cfg.triggerHour) || 1);
  const due = new Date(Date.now() + triggerHour * 60 * 60 * 1000);

  await col.updateOne(
    { conversation_id: convId, shop_id },
    {
      $set: {
        auto_reply_pending: true,
        auto_reply_due_at: due,
        updated_at: new Date(),
      },
    }
  );

  console.log(
    `[auto-reply] Scheduled for ${convId} shop=${shop_id} due=${due.toISOString()} (${triggerHour}h)`
  );
}

export type ProcessAutoReplyResult = {
  processed: number;
  sent: number;
  skipped: number;
  errors: { conversation_id: string; error: string }[];
};

export type RescueAutoReplyResult = {
  scanned: number;
  rescued: number;
  skipped: number;
};

const MAX_BATCH = 30;
const RESCUE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RESCUE_MAX_BATCH = 100;

/**
 * 一回限りの緊急テンプレID修正 (2026-05-19 / template content empty/missing 復旧)。
 *
 * 「テンプレ削除/編集のたびに auto_reply_settings の template_id が orphan に
 * なる」構造欠陥を、レイヤー 3 の resolveTemplateContent fallback で耐性付与
 * したのに加え、 既存の壊れた template_id 自体も復元するための one-shot 処理。
 *
 * 動作:
 *   - auto_reply_settings.template_fix_applied が true なら no-op (idempotent)
 *   - false / 未設定なら全カ国 template_id を営業時間外テンプレ
 *     (69fd937436d074c27df37548) に強制統一し、 template_fix_applied: true を立てる
 *
 * 次回 cron 以降は冒頭で早期 return するため、 本コードを残したまま放置しても
 * パフォーマンス影響はほぼゼロ (findOne 1 回)。 落ち着いたら別 commit で削除予定。
 */
const TEMPLATE_FIX_TARGET_ID = "69fd937436d074c27df37548";

async function applyOneShotTemplateFix(): Promise<void> {
  try {
    const col = await getCollection<{
      _id: string;
      countries?: Record<string, AutoReplyCountryCfg>;
      template_fix_applied?: boolean;
      updated_at?: Date;
    }>("auto_reply_settings");

    const doc = await col.findOne({ _id: "singleton" });
    if (!doc) return;
    if (doc.template_fix_applied === true) return;

    const countries = doc.countries ?? {};
    const countriesUpdated = Object.keys(countries);

    const $set: Record<string, unknown> = {
      template_fix_applied: true,
      updated_at: new Date(),
    };
    for (const country of countriesUpdated) {
      $set[`countries.${country}.template_id`] = TEMPLATE_FIX_TARGET_ID;
    }

    await col.updateOne({ _id: "singleton" }, { $set });

    console.log(
      `[auto-reply] template_fix: applied target=${TEMPLATE_FIX_TARGET_ID} ` +
        `countries=${JSON.stringify(countriesUpdated)}`
    );
  } catch (e) {
    console.error("[auto-reply] template_fix: failed (non-fatal)", e);
  }
}

/**
 * フラグに依存しない救済スキャン (auto-reply 漏れ防止セーフティネット)。
 *
 * 通常は webhook (handleAutoReplyOnWebhookMessage) / sync (scheduleAutoReplyForUnread) /
 * chats-messages の review が `auto_reply_pending=true` をセットするが、 3 経路が
 * 何らかの理由で空振りすると DB に処理対象が存在せず cron は永遠に空回りする
 * (2026-05-15 観察 — pending_total=0 で cron が processed=0 を返し続ける状態)。
 *
 * 本スキャンは最後の砦として直近 24h の buyer 着信を網羅的に拾い、 staff 応答
 * 等の検証は processDueAutoReplies の pre-send guard (Shopee API 経由の
 * staff 応答確認 + Patch C cooldown) に委ねる。 mutation は最小限
 * (auto_reply_pending と auto_reply_due_at のみ)。
 *
 * 副作用 (いずれも誤発火を生まない):
 *   - staff が手動返信済みでも DB の last_auto_reply_at が未更新なら一旦
 *     pending=true になる → pre-send guard で staff 応答が検知され
 *     clearAutoReplySchedule される。
 *   - last_message_time が staff 由来 (sticker 等で bump) でも一旦 pending →
 *     同じく pre-send guard で取消し。
 */
export async function rescueUnflaggedAutoReplies(): Promise<RescueAutoReplyResult> {
  const result: RescueAutoReplyResult = { scanned: 0, rescued: 0, skipped: 0 };

  const col = await getCollection<{
    conversation_id: string;
    shop_id: number;
    country?: string;
    customer_id?: number;
    chat_type?: string;
    last_message_time?: Date | null;
    last_auto_reply_at?: Date | null;
    auto_reply_pending?: boolean;
  }>("shopee_conversations");

  const countries = await getSingletonAutoReplyCountries();
  const cutoff = new Date(Date.now() - RESCUE_LOOKBACK_MS);

  // pending=true でも due が誤って未来に書かれた「スタック」状態を自己修復するため
  // `auto_reply_pending: {$ne: true}` の除外は入れない。 for-loop 内 updateOne は
  // idempotent (pending=true 上書き、 due=max(lmt+trigger, now) で再計算) なので、
  // 正常に予約済みの会話には実害なし、 スタック救済のみ効く。
  const candidates = await col
    .find({
      chat_type: { $ne: "notification" },
      customer_id: { $gt: 0 },
      last_message_time: { $gte: cutoff },
      $or: [
        { last_auto_reply_at: { $exists: false } },
        { last_auto_reply_at: null },
        { $expr: { $lt: ["$last_auto_reply_at", "$last_message_time"] } },
      ],
    })
    .limit(RESCUE_MAX_BATCH)
    .toArray();

  for (const doc of candidates) {
    result.scanned++;

    const lmt = doc.last_message_time;
    if (!(lmt instanceof Date)) {
      result.skipped++;
      continue;
    }

    const country = (await getShopCountry(doc.shop_id)) ?? doc.country ?? "SG";
    const countryKey = String(country).toUpperCase();
    const cfg = countries[countryKey];
    if (
      !cfg?.enabled ||
      !cfg.template_id?.trim() ||
      !ObjectId.isValid(cfg.template_id.trim())
    ) {
      result.skipped++;
      continue;
    }

    const triggerHour = Math.max(1, Number(cfg.triggerHour) || 1);
    const dueMs = lmt.getTime() + triggerHour * 60 * 60 * 1000;
    const nowMs = Date.now();
    const due = new Date(dueMs > nowMs ? dueMs : nowMs);

    await col.updateOne(
      { conversation_id: doc.conversation_id, shop_id: doc.shop_id },
      {
        $set: {
          auto_reply_pending: true,
          auto_reply_due_at: due,
          rescue_at: new Date(),
          updated_at: new Date(),
        },
      }
    );

    result.rescued++;
    console.log(
      `[auto-reply] rescue: flagged conv=${doc.conversation_id} shop=${doc.shop_id} ` +
        `lmt=${lmt.toISOString()} due=${due.toISOString()}`
    );
  }

  return result;
}

/**
 * 期限到来の会話にテンプレートを送信（cron 用）
 */
export async function processDueAutoReplies(): Promise<ProcessAutoReplyResult> {
  // one-shot 緊急テンプレID修正 (2026-05-19)。 idempotent; 適用済みなら即 return。
  await applyOneShotTemplateFix();

  // [TEMP DIAG 2026-05-19] one-shot fix と template_id の現状確認。
  // 真因確定後に削除する。
  try {
    const settingsCol = await getCollection<{
      _id: string;
      countries?: Record<string, AutoReplyCountryCfg>;
      template_fix_applied?: boolean;
      updated_at?: Date;
    }>("auto_reply_settings");
    const settingsDoc = await settingsCol.findOne({ _id: "singleton" });
    console.log(
      "[auto-reply] settings-dump",
      JSON.stringify(
        {
          template_fix_applied: settingsDoc?.template_fix_applied ?? null,
          countries: settingsDoc?.countries ?? null,
          updated_at: settingsDoc?.updated_at ?? null,
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error("[auto-reply] settings-dump failed (non-fatal)", e);
  }

  const result: ProcessAutoReplyResult = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: [],
  };

  const col = await getCollection<{
    conversation_id: string;
    shop_id: number;
    country?: string;
    customer_id: number;
    auto_reply_pending?: boolean;
    auto_reply_due_at?: Date | null;
    last_auto_reply_at?: Date | null;
    chat_type?: string;
    last_message_time?: Date | null;
    staff_message_kind_log?: { id: string; kind: string }[];
    rescue_at?: Date | null;
  }>("shopee_conversations");

  const now = new Date();
  const countries = await getSingletonAutoReplyCountries();

  const due = await col
    .find({
      auto_reply_pending: true,
      auto_reply_due_at: { $lte: now },
    })
    .limit(MAX_BATCH)
    .toArray();

  for (const doc of due) {
    result.processed++;
    const convId = String(doc.conversation_id);
    const shopId = doc.shop_id;

    if (doc.chat_type === "notification") {
      await clearAutoReplySchedule(convId, shopId);
      result.skipped++;
      continue;
    }

    // customer_id が未同期 → 判定不能なので送らない
    const customerIdNum = Number(doc.customer_id ?? 0);
    if (!Number.isFinite(customerIdNum) || customerIdNum <= 0) {
      await clearAutoReplySchedule(convId, shopId);
      console.warn(
        `[auto-reply] pre-send: skipped (customer_id 未同期) conv=${convId} shop=${shopId}`
      );
      result.skipped++;
      continue;
    }

    /**
     * Shopee 側で手動返信済みなのに DB に予約が残っているケースを防ぐ:
     * 送信直前に生メッセージを取得し reviewAutoReplySchedule でキャンセル・再計算する。
     *
     * L1-C: verify 失敗は silent skip せず errors に記録し、auto_reply_pending は維持する
     * （＝次回 cron で再試行される）。Shopee API の一時障害で送信機会を失わないため。
     */
    let accessToken: string;
    let countryKey: string;
    let rawList: Record<string, unknown>[] = [];
    try {
      accessToken = await getValidToken(shopId);
      const countryResolved = await resolveCountryForShop(shopId, doc.country);
      countryKey = String(countryResolved).toUpperCase();
      rawList = (await fetchAllConversationMessages(
        accessToken,
        shopId,
        convId,
        { country: countryResolved }
      )) as Record<string, unknown>[];
      await reviewAutoReplySchedule(rawList, shopId, convId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[auto-reply] pre-send verify failed conv=${convId} (pending preserved for retry):`,
        msg
      );
      result.errors.push({
        conversation_id: convId,
        error: `pre-send verify failed: ${msg}`,
      });
      // auto_reply_pending / auto_reply_due_at は変更せず次回 cron で再試行させる
      continue;
    }

    const afterReview = await col.findOne({
      conversation_id: convId,
      shop_id: shopId,
    });
    const nowSend = new Date();
    if (!afterReview?.auto_reply_pending) {
      console.log(
        `[auto-reply] pre-send: skipped (post-review pending=false) ` +
          `conv=${convId} shop=${shopId}`
      );
      result.skipped++;
      continue;
    }
    if (!(afterReview.auto_reply_due_at instanceof Date)) {
      console.log(
        `[auto-reply] pre-send: skipped (post-review due_at missing) ` +
          `conv=${convId} shop=${shopId}`
      );
      result.skipped++;
      continue;
    }
    if (afterReview.auto_reply_due_at.getTime() > nowSend.getTime()) {
      console.log(
        `[auto-reply] pre-send: skipped (post-review due_at rescheduled to future) ` +
          `conv=${convId} shop=${shopId} ` +
          `due=${afterReview.auto_reply_due_at.toISOString()} ` +
          `now=${nowSend.toISOString()}`
      );
      result.skipped++;
      continue;
    }

    /**
     * 送信直前の最終ガード（防御多重化）:
     * review ロジックに将来バグが入っても誤送信が発生しないよう、ここで独立に
     * 「最新メッセージが buyer からの送信であること」を直接検査する。
     * buyer ではない（= スタッフ側からの送信）なら送らずキャンセル。
     *
     * 商品カード問い合わせ救済 (2026-05-11): rawList が完全に空 (Shopee fetch
     * hiccup) なら、 buyer/staff いずれも確証できない → pending を温存して
     * 次回 cron に retry させる。 schedule 側のフォールバックで pending は
     * conv-list の last_message_time から立っているため、 Shopee 側が回復した
     * 時点で buyer / staff のどちらかに確定し、 正しくキャンセル or 発火する。
     * 誤発火 (送ってはいけないものを送る) はゼロのまま、 漏れだけ減らす。
     */
    if (rawList.length === 0) {
      console.log(
        `[auto-reply] pre-send: empty rawList, preserving pending for retry ` +
          `conv=${convId} shop=${shopId}`
      );
      result.skipped++;
      continue;
    }

    const { lastBuyerMs: guardBuyerMs, lastStaffMs: guardStaffMs } =
      computeBuyerStaffLastMs(rawList, customerIdNum, shopId);

    /**
     * no-signal fallback (2026-05-19): rawList が非空でも classifyShopeeMessageSender が
     * buyer/staff いずれも分類できないケースで、 review() と同じ条件で last_message_time を
     * buyer 時刻として採用する。 review() の同様 fallback で pending=true のまま到達した
     * conversation が、ここで silent に再キャンセルされないようにする (2026-05-19 01:45 tick
     * の「全件 post-review pending=false 直後の pre-send guard cancel」症状対策)。
     *
     * 安全側: guardStaffMs > 0 なら staff 信号が見えているので適用しない (= 後段ガードで
     * 通常通りキャンセル)。 staff_message_kind_log 非空 / alreadyReplied も適用外。
     */
    let effectiveBuyerMs = guardBuyerMs;
    if (guardBuyerMs === 0 && guardStaffMs === 0) {
      const lmt = afterReview.last_message_time;
      const lar = afterReview.last_auto_reply_at;
      const staffLog = afterReview.staff_message_kind_log ?? [];
      const alreadyReplied =
        lar instanceof Date && lmt instanceof Date && lar.getTime() >= lmt.getTime();
      if (lmt instanceof Date && !alreadyReplied && staffLog.length === 0) {
        effectiveBuyerMs = lmt.getTime();
        console.log(
          `[auto-reply] pre-send guard: no-signal fallback (using last_message_time) ` +
            `conv=${convId} shop=${shopId} ` +
            `rawListLen=${rawList.length} ` +
            `lmt=${lmt.toISOString()} ` +
            `rescue_at=${afterReview.rescue_at?.toISOString?.() ?? "none"}`
        );
      }
    }

    if (effectiveBuyerMs === 0 || guardStaffMs >= effectiveBuyerMs) {
      const staffLogLen = (afterReview.staff_message_kind_log ?? []).length;
      await clearAutoReplySchedule(convId, shopId);
      console.log(
        `[auto-reply] pre-send guard: cancelled (latest is staff or no buyer msg) ` +
          `conv=${convId} shop=${shopId} ` +
          `guardBuyerMs=${guardBuyerMs} guardStaffMs=${guardStaffMs} ` +
          `effectiveBuyerMs=${effectiveBuyerMs} ` +
          `staffLog=${staffLogLen} ` +
          `rescue_at=${afterReview.rescue_at?.toISOString?.() ?? "none"}`
      );
      result.skipped++;
      continue;
    }

    /**
     * Patch C: 送信直前の時刻ベース二重防衛 cooldown
     *
     * classifyShopeeMessageSender が「buyer 宛」と特定できなかったメッセージ
     * (from_id=0 かつ to_id でも判定不能 → "unknown") は computeBuyerStaffLastMs
     * で完全に無視される。 staff が送った sticker / 特殊メッセージがこれに該当した
     * 場合、guardStaffMs が 0 のままで上のガードを通過してしまう。
     *
     * 二重防衛として「最後に判定できた buyer メッセージより新しい raw メッセージが
     * 1 件でも存在するなら、未分類でも何らかの直近活動があるとみなして送信を見送る」。
     * 4/22 09:10 の sabara2722 / dareraru 誤発火パターンに対する最終セーフティネット。
     *
     * 副作用: 真の system card (from_id=0 to_id=0) が buyer の後に挟まると
     * 不必要にスキップする可能性がある。だが「誤送信 > 送信漏れ」の方針に沿う。
     *
     * no-signal fallback (2026-05-19) と組み合わせる時は effectiveBuyerMs を基準にする。
     * fallback で last_message_time を採用した場合でも、 rawList に新しい未分類活動が
     * あれば Patch C で再度シャットダウンされるため誤発火しない。
     */
    const lastAnyMs = computeLastAnyMessageMs(rawList);
    if (lastAnyMs > effectiveBuyerMs) {
      await clearAutoReplySchedule(convId, shopId);
      console.log(
        `[auto-reply] pre-send guard (Patch C): cancelled (unclassified activity after lastBuyer) ` +
          `conv=${convId} shop=${shopId} ` +
          `lastAny=${new Date(lastAnyMs).toISOString()} ` +
          `effectiveBuyer=${new Date(effectiveBuyerMs).toISOString()}`
      );
      result.skipped++;
      continue;
    }

    const claimed = await col.findOneAndUpdate(
      {
        conversation_id: convId,
        shop_id: shopId,
        auto_reply_pending: true,
        auto_reply_due_at: { $lte: nowSend },
      },
      {
        $set: {
          auto_reply_pending: false,
          auto_reply_due_at: null,
          updated_at: new Date(),
        },
      },
      { returnDocument: "before" }
    );

    if (!claimed) {
      console.log(
        `[auto-reply] pre-send: skipped (claim race — another worker took it) ` +
          `conv=${convId} shop=${shopId}`
      );
      result.skipped++;
      continue;
    }

    try {
      const cfg = countries[countryKey];
      if (!cfg?.enabled || !cfg.template_id?.trim()) {
        console.log(
          `[auto-reply] pre-send: skipped (cfg disabled or template_id empty) ` +
            `conv=${convId} shop=${shopId} country=${countryKey} ` +
            `enabled=${cfg?.enabled ?? "undef"} ` +
            `template_id=${cfg?.template_id?.trim() ? "set" : "empty"}`
        );
        result.skipped++;
        continue;
      }

      const content = await resolveTemplateContent(cfg.template_id);
      if (!content) {
        console.log(
          `[auto-reply] pre-send: skipped (template content empty/missing) ` +
            `conv=${convId} shop=${shopId} country=${countryKey} ` +
            `template_id=${cfg.template_id}`
        );
        result.skipped++;
        continue;
      }

      const buyerId = Number(doc.customer_id);
      if (!Number.isFinite(buyerId) || buyerId <= 0) {
        console.log(
          `[auto-reply] pre-send: skipped (buyerId invalid post-claim) ` +
            `conv=${convId} shop=${shopId} customer_id=${doc.customer_id}`
        );
        result.skipped++;
        continue;
      }

      const sendRes = (await sendMessage(
        accessToken,
        shopId,
        buyerId,
        content,
        { country: countryKey }
      )) as Record<string, unknown>;
      const sentId = extractMessageIdFromSendResponse(sendRes);
      if (sentId) {
        await recordStaffMessageKind(convId, shopId, sentId, "auto");
      }

      await col.updateOne(
        { conversation_id: convId, shop_id: shopId },
        {
          $set: {
            last_message: content,
            last_message_time: new Date(),
            unread_count: 0,
            last_auto_reply_at: new Date(),
            handling_status: "auto_replied_pending",
            updated_at: new Date(),
          },
        }
      );

      result.sent++;
      console.log(`[auto-reply] Sent to conversation ${convId} shop=${shopId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ conversation_id: convId, error: msg });
      console.error(`[auto-reply] Failed ${convId}:`, e);
      try {
        await col.updateOne(
          { conversation_id: convId, shop_id: shopId },
          {
            $set: {
              auto_reply_pending: false,
              auto_reply_due_at: null,
              updated_at: new Date(),
            },
          }
        );
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}
