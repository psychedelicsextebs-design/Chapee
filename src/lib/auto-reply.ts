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
 * Fix A (2026-08-14): Shopee 側が自動生成するシステムカードを検出する。
 *
 * yonghuing 案件: buyer msg の 1 秒後に [logistics_card] が staff 側で着弾し
 * "cleared (staff replied)" ブランチで pending がクリアされていた。 これらの
 * カードは Shopee がバイヤーの質問に自動応答するシステムメッセージであり、
 * 販売者の返信ではないため、 応答率ペナルティの起算点を消してはならない。
 *
 * 判定基準:
 *   1. 既知の message_type (実サンプルから収集) にヒット
 *   2. パターン (_card / _notification / _prompt / _reminder / system_) にヒット
 *
 * 未知の新種カードにも一定の耐性を持たせるためパターンマッチも併用。
 */
const KNOWN_SYSTEM_CARD_TYPES = new Set<string>([
  "logistics_card",
  "new_faq",
  "faq_liveagent_prompt",
  "faq_card",
  "return_refund_card",
  "out_of_stock_reminder_card",
  "auto_reply",
  "delivery_notification",
]);

const SYSTEM_MESSAGE_PATTERN = /(_card|_notification|_prompt|_reminder|^system_)/;

export function looksLikeSystemGeneratedMessage(
  msg: Record<string, unknown>
): boolean {
  const mt = String(msg.message_type ?? msg.type ?? "").toLowerCase();
  if (!mt) return false;
  if (KNOWN_SYSTEM_CARD_TYPES.has(mt)) return true;
  return SYSTEM_MESSAGE_PATTERN.test(mt);
}

/**
 * Fix B (2026-08-14): 買い手 msg から HUMAN_REPLY_MIN_INTERVAL_MS 以内に staff-side
 * で着弾したメッセージは人間の返信ではありえない (通知遅延 + 内容読解 + タイプで
 * 最低数十秒必要)。 これらは Shopee 側の自動応答と判断し、 staff としてカウント
 * しない。 未知システムカードにも耐性を持たせるための時間ベース補完。
 *
 * 30秒閾値の根拠: 人間の応答は最低でも 30秒+ かかる。 誤除外リスク (真の staff
 * 高速返信) は極めて低く、 起きても「auto-reply が 1 通多く送られる」だけで
 * ペナルティ超過より遥かに軽微。
 */
export const HUMAN_REPLY_MIN_INTERVAL_MS = 30_000;

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
  // Fix A: 既知/パターン一致のシステムカードは常に "unknown" (buyer/staff どちらにも
  // カウントしない → 応答率の起算点を消さない)。 from_id/to_id 判定より優先する。
  if (looksLikeSystemGeneratedMessage(msg)) return "unknown";

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
 * Fix B (2026-08-14): メッセージリストを ts 昇順で走査し、 各 msg に精緻化された
 * kind を付与する:
 *   - initial "buyer" → "buyer"
 *   - initial "staff" AND 直前の buyer msg から HUMAN_REPLY_MIN_INTERVAL_MS 未満
 *     → "system" (Shopee 自動応答扱い、 staff カウント外)
 *   - initial "staff" AND buyer から充分離れている or 直前 buyer なし → "staff"
 *   - initial "unknown" → "system" (旧設計は skip して Patch C で拾っていたが、
 *     新設計「取りこぼしゼロ」では unknown も送信ブロックに使わない)
 *
 * 「送るのを止める」判定に使えるのは refined kind が "staff" のものだけ。
 * "system" は staff/buyer どちらのカウントにも影響しない。
 */
type RefinedKind = "buyer" | "staff" | "system";
type RefinedMessage = { ts: number; kind: RefinedKind };

function refineMessageKinds(
  rawMessages: Record<string, unknown>[],
  customerId: number,
  shopId?: number
): RefinedMessage[] {
  const initial = rawMessages.map((msg) => ({
    ts: shopeeMessageTimeToMs(
      msg.timestamp ?? msg.created_timestamp ?? msg.time
    ),
    initialKind: classifyShopeeMessageSender(msg, customerId, shopId),
  }));
  initial.sort((a, b) => a.ts - b.ts);

  const refined: RefinedMessage[] = [];
  let lastBuyerTs = 0;
  for (const item of initial) {
    let kind: RefinedKind;
    if (item.initialKind === "buyer") {
      kind = "buyer";
      lastBuyerTs = item.ts;
    } else if (item.initialKind === "staff") {
      if (
        lastBuyerTs > 0 &&
        item.ts - lastBuyerTs < HUMAN_REPLY_MIN_INTERVAL_MS
      ) {
        // Fix B: 直前 buyer msg から近すぎる → 人間返信ではない (システム自動応答)
        kind = "system";
      } else {
        kind = "staff";
      }
    } else {
      // Fix A/D 統合: unknown は system 扱いにする (送信ブロックしない)
      kind = "system";
    }
    refined.push({ ts: item.ts, kind });
  }
  return refined;
}

/**
 * Pure helper (testable): walk raw messages and return the latest buyer/staff
 * timestamps (ms since epoch, 0 if none) plus the *first unreplied* buyer
 * message timestamp.
 *
 * firstUnrepliedBuyerMs は「最後の staff 返信より後の、最も古い buyer 発信」。
 * Shopee 応答率ペナルティは「最初の未返信 buyer msg」から 12h で起算されるため、
 * auto-reply の due 起算点はこの値を使う必要がある (lastBuyerMs を使うと連投で
 * due が後退してペナルティ期限を超過する)。
 *   - staff 未返信 (lastStaffMs=0): 全 buyer msg が対象 → 最古の buyer msg
 *   - staff が全 buyer より新しい (lastStaffMs >= lastBuyerMs): 未返信なし → 0
 *   - 途中 staff 返信 → 続く buyer 発信: staff 以降の最古 buyer msg
 *
 * Fix A+B (2026-08-14) 以降: system 判定された msg (既知カード / パターン一致 /
 * 30秒近接ガード / 分類不能) は lastStaffMs 計算から除外される。
 */
export function computeBuyerStaffLastMs(
  rawMessages: Record<string, unknown>[],
  customerId: number,
  shopId?: number
): { lastBuyerMs: number; lastStaffMs: number; firstUnrepliedBuyerMs: number } {
  const refined = refineMessageKinds(rawMessages, customerId, shopId);
  let lastBuyerMs = 0;
  let lastStaffMs = 0;
  const buyerTimestamps: number[] = [];
  for (const m of refined) {
    if (m.kind === "buyer") {
      buyerTimestamps.push(m.ts);
      if (m.ts > lastBuyerMs) lastBuyerMs = m.ts;
    } else if (m.kind === "staff") {
      if (m.ts > lastStaffMs) lastStaffMs = m.ts;
    }
    // system: 集計から除外
  }
  let firstUnrepliedBuyerMs = 0;
  for (const ts of buyerTimestamps) {
    if (ts > lastStaffMs && (firstUnrepliedBuyerMs === 0 || ts < firstUnrepliedBuyerMs)) {
      firstUnrepliedBuyerMs = ts;
    }
  }
  return { lastBuyerMs, lastStaffMs, firstUnrepliedBuyerMs };
}

/**
 * Pure helper (testable): return the latest message timestamp (ms) regardless
 * of sender classification. 旧 Patch C の per-tick 判定用に維持 (テスト後方互換)。
 *
 * ⚠ 新規コードは代わりに `computeLastNonSystemActivityMs` を使うこと (システム
 * カードと proximity 近接 staff を除外し「取りこぼしゼロ」設計に沿う)。
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

/**
 * Fix D (2026-08-14): Patch C 用の system 除外版 lastAny。 system 判定された
 * メッセージ (既知カード / パターン一致 / 30秒近接 staff / 分類不能) を除外して、
 * 「buyer msg より新しい非システム活動」を検出する。
 *
 * 旧 computeLastAnyMessageMs は全 msg を含んでいたため、 [logistics_card] のような
 * システムカードで Patch C が誤発火していた。 これを filter する。
 */
export function computeLastNonSystemActivityMs(
  rawMessages: Record<string, unknown>[],
  customerId: number,
  shopId?: number
): number {
  const refined = refineMessageKinds(rawMessages, customerId, shopId);
  let last = 0;
  for (const m of refined) {
    if (m.kind === "system") continue;
    if (m.ts > last) last = m.ts;
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

/**
 * スタッフ送信後・手動送信後 / staff replied 検知 / notification 判定等、
 * 「auto-reply を進めない」判断で pending を解除する共通関数。
 *
 * Fix E' (2026-08-14): 「pending クリア = 対応が入った or 対応不要と判断された」
 * = GIVE UP 警告 (auto_reply_gave_up_at) も表示不要 = リセットする。 これにより
 * UI 上の「自動返信失敗」警告は staff 手動送信 / 完了マーク / staff replied 検知 /
 * 自然回復のいずれかで自動的に消える。 retry_count も次回発生時のカウンタリセット
 * のため 0 に戻す。
 */
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
        auto_reply_retry_count: 0,
        auto_reply_gave_up_at: null,
        auto_reply_last_error: null,
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
      first_unreplied_buyer_message_time?: Date | null;
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
    let firstUnrepliedBuyerMs = classified.firstUnrepliedBuyerMs;

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
        firstUnrepliedBuyerMs = lmt.getTime();
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

    // Compute due from the FIRST unreplied buyer message (Shopee 応答率
    // ペナルティ 12h 起算点)。 連投で due が後退しないよう lastBuyerMs ではなく
    // firstUnrepliedBuyerMs を使う。
    const dueMs = firstUnrepliedBuyerMs + triggerHour * 60 * 60 * 1000;
    const now = Date.now();
    // Note: 過去 due を now に丸める挙動は歴史的経緯で残している。
    // pre-send guard (スタッフ応答の再検証) で誤送信は止まるため実害なし。
    const due = new Date(dueMs > now ? dueMs : now);

    // Skip write if already scheduled with the same due AND first_unreplied
    // (±1 min tolerance)。 first_unreplied フィールドが未 populate の場合は
    // 落として updateOne を実行し、フィールドを埋める。
    const existingDue = existing.auto_reply_due_at?.getTime?.();
    const existingFirstUnreplied =
      existing.first_unreplied_buyer_message_time?.getTime?.();
    if (
      existing.auto_reply_pending === true &&
      typeof existingDue === "number" &&
      Math.abs(existingDue - due.getTime()) < 60_000 &&
      typeof existingFirstUnreplied === "number" &&
      Math.abs(existingFirstUnreplied - firstUnrepliedBuyerMs) < 60_000
    ) {
      return;
    }

    await col.updateOne(
      { conversation_id: convId, shop_id: shopId },
      {
        $set: {
          auto_reply_pending: true,
          auto_reply_due_at: due,
          first_unreplied_buyer_message_time: new Date(firstUnrepliedBuyerMs),
          updated_at: new Date(),
        },
      }
    );

    console.log(
      `[auto-reply] review: (re-)scheduled conv=${convId} shop=${shopId} due=${due.toISOString()} firstUnreplied=${new Date(firstUnrepliedBuyerMs).toISOString()} (${triggerHour}h)`
    );
  } catch (e) {
    console.warn(`[auto-reply] reviewAutoReplySchedule failed conv=${convId}:`, e);
  }
}

// handleAutoReplyOnWebhookMessage (削除 2026-08-05): webhook route は
// syncWebhookConversationFull → reviewAutoReplySchedule 経由になっており、
// この関数はプロダクション caller ゼロの dead code だった。 かつ `due` を
// `Date.now() + triggerHour` で計算しており firstUnrepliedBuyerMs 基準の
// 新設計と不整合。 将来の事故要因を残さないため削除する。

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
 * Fix E' (2026-08-14 root-cause redesign): 期限ベース retry。
 *
 * 【設計原則】
 * 諦める条件は「ペナルティ期限切れ」のみ、 回数では諦めない。
 * 期限内は cron が呼ばれる限り何度でも再試行する。 期限直前は緊急 cron
 * (/api/cron/auto-reply-urgent, 1分間隔) で更に高頻度化する。
 *
 * PENALTY_WINDOW_MS = 12h: Shopee 応答率ペナルティは
 *   「最初の未返信 buyer msg (first_unreplied_buyer_message_time) + 12h」
 * を超えて未返信のまま = ペナルティカウント確定。 これが唯一の締切。
 *
 * URGENT_HORIZON_MS = 2h: この期限まで N h 以内 = 緊急枠として扱い、
 * 1 分 cron の対象にする。 2h ならば 120 回試行可能。
 *
 * 旧 MAX_SEND_RETRY (=5 回で諦め) は削除。 12h 中 75 分しか使わない誤設計。
 */
export const PENALTY_WINDOW_MS = 12 * 60 * 60 * 1000;
export const URGENT_HORIZON_MS = 2 * 60 * 60 * 1000;

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
 * 通常は webhook (syncWebhookConversationFull → reviewAutoReplySchedule) /
 * sync (scheduleAutoReplyForUnread) / chats-messages の review が
 * `auto_reply_pending=true` をセットするが、 3 経路が何らかの理由で空振りすると
 * DB に処理対象が存在せず cron は永遠に空回りする
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
    last_buyer_message_time?: Date | null;
    first_unreplied_buyer_message_time?: Date | null;
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
    // ペナルティ 12h 起算点は「最初の未返信 buyer msg」。 raw 経由の review が
    // populate した first_unreplied_buyer_message_time があれば最優先。 無ければ
    // last_buyer_message_time → last_message_time の順に fallback (fallback は
    // 連投で due が後退する可能性があるが、 process → review 経由で自然補正)。
    const baseMs =
      doc.first_unreplied_buyer_message_time?.getTime?.() ??
      doc.last_buyer_message_time?.getTime?.() ??
      lmt.getTime();
    const dueMs = baseMs + triggerHour * 60 * 60 * 1000;
    const nowMs = Date.now();
    const due = new Date(dueMs > nowMs ? dueMs : nowMs);

    // Fix E' (2026-08-14): first_unreplied_buyer_message_time が未 populate なら
    // baseMs (last_buyer or last_message の fallback) で埋める。 これは緊急 cron
    // (`/api/cron/auto-reply-urgent`) の filter が populate 前提のため。
    // 既に review が正しい値を書いていれば上書きしない (承認方針: field 空なら書く、
    // 既存なら上書きしない)。
    const setDoc: Record<string, unknown> = {
      auto_reply_pending: true,
      auto_reply_due_at: due,
      rescue_at: new Date(),
      updated_at: new Date(),
    };
    if (!(doc.first_unreplied_buyer_message_time instanceof Date)) {
      setDoc.first_unreplied_buyer_message_time = new Date(baseMs);
    }

    await col.updateOne(
      { conversation_id: doc.conversation_id, shop_id: doc.shop_id },
      { $set: setDoc }
    );

    result.rescued++;
    console.log(
      `[auto-reply] rescue: flagged conv=${doc.conversation_id} shop=${doc.shop_id} ` +
        `base=${new Date(baseMs).toISOString()} due=${due.toISOString()}`
    );
  }

  return result;
}

/**
 * 期限到来の会話にテンプレートを送信（cron 用）
 */
export async function processDueAutoReplies(opts?: {
  /**
   * true にすると「ペナルティ期限まで URGENT_HORIZON_MS 以内」の pending 会話
   * だけを対象にする。 緊急 cron (/api/cron/auto-reply-urgent、 1 分間隔) 専用の
   * 絞込。 通常 cron (15 分) は全 due 会話を対象 (undefined/false)。
   */
  urgentOnly?: boolean;
}): Promise<ProcessAutoReplyResult> {
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
    auto_reply_retry_count?: number;
    first_unreplied_buyer_message_time?: Date | null;
    last_auto_reply_at?: Date | null;
    chat_type?: string;
    last_message_time?: Date | null;
    staff_message_kind_log?: { id: string; kind: string }[];
    rescue_at?: Date | null;
  }>("shopee_conversations");

  const now = new Date();
  const countries = await getSingletonAutoReplyCountries();

  // urgentOnly=true: first_unreplied <= now - (PENALTY_WINDOW_MS - URGENT_HORIZON_MS)
  //   = first_unreplied <= now - 10h  (= ペナルティ期限まで 2h 以内)
  // first_unreplied_buyer_message_time が populate されていない legacy doc は
  // urgent 対象外 (通常 cron が拾う)。
  const findFilter: Record<string, unknown> = {
    auto_reply_pending: true,
    auto_reply_due_at: { $lte: now },
  };
  if (opts?.urgentOnly) {
    findFilter.first_unreplied_buyer_message_time = {
      $lte: new Date(now.getTime() - (PENALTY_WINDOW_MS - URGENT_HORIZON_MS)),
    };
  }

  const due = await col.find(findFilter).limit(MAX_BATCH).toArray();

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
     * 「最後に判定できた buyer メッセージより新しい非システム活動が 1 件でも
     *  存在するなら送信を見送る」。
     *
     * Fix D (2026-08-14): 旧 computeLastAnyMessageMs は全 msg を含んでいたため、
     * [logistics_card] 等の Shopee 自動生成カードが「未分類活動」として誤発火し
     * yonghuing 案件で auto-reply がブロックされていた。 computeLastNonSystemActivityMs
     * に切替: 既知カード / パターン一致 / 30秒近接 staff / 分類不能 は除外し、
     * 「取りこぼしゼロ」原則に沿う (誤送信 1通 < ペナルティ超過 の非対称性を前提)。
     */
    const lastAnyMs = computeLastNonSystemActivityMs(
      rawList,
      customerIdNum,
      shopId
    );
    if (lastAnyMs > effectiveBuyerMs) {
      await clearAutoReplySchedule(convId, shopId);
      console.log(
        `[auto-reply] pre-send guard (Patch C): cancelled (non-system activity after lastBuyer) ` +
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
            auto_reply_retry_count: 0,
            auto_reply_gave_up_at: null,
            auto_reply_last_error: null,
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

      /**
       * Fix E' (2026-08-14 期限ベース redesign): 諦める条件は「Shopee ペナルティ
       * 期限 (first_unreplied + 12h) 切れ」のみ。 回数では諦めない。
       *
       * 旧 Fix E (MAX_SEND_RETRY=5、 75分で諦め) は 12h 中 75 分しか使わない
       * 誤設計だった。 12h あるうち全部使うのが正解。 期限直前は緊急 cron
       * (/api/cron/auto-reply-urgent, 1分間隔) が最大 120 回試行を保証。
       *
       * fallback: first_unreplied 未populate の場合は now を基準に 12h 猶予
       * (次tick で review が正しい値に置換される想定の一時救済)。
       *
       * MISSED DEADLINE ログ形式は外部監視/UI 警告の識別子。 変更しない。
       */
      try {
        const firstUnrepliedTs =
          doc.first_unreplied_buyer_message_time?.getTime?.();
        const nowMs = Date.now();
        const deadlineMs = firstUnrepliedTs
          ? firstUnrepliedTs + PENALTY_WINDOW_MS
          : nowMs + PENALTY_WINDOW_MS;

        const retryCount =
          Number(
            (doc as { auto_reply_retry_count?: number }).auto_reply_retry_count ??
              0
          ) + 1;

        if (nowMs >= deadlineMs) {
          await col.updateOne(
            { conversation_id: convId, shop_id: shopId },
            {
              $set: {
                auto_reply_pending: false,
                auto_reply_due_at: null,
                auto_reply_retry_count: 0,
                auto_reply_gave_up_at: new Date(),
                auto_reply_last_error: msg,
                updated_at: new Date(),
              },
            }
          );
          const overdueMinutes = Math.floor((nowMs - deadlineMs) / 60_000);
          console.error(
            `[auto-reply] MISSED DEADLINE conv=${convId} shop=${shopId} ` +
              `retry=${retryCount} deadline=${new Date(deadlineMs).toISOString()} ` +
              `overdue_min=${overdueMinutes} reason=${msg}`
          );
        } else {
          await col.updateOne(
            { conversation_id: convId, shop_id: shopId },
            {
              $set: {
                auto_reply_retry_count: retryCount,
                auto_reply_last_error: msg,
                updated_at: new Date(),
              },
            }
          );
          const remainingHours = (deadlineMs - nowMs) / 3_600_000;
          console.warn(
            `[auto-reply] retry pending conv=${convId} shop=${shopId} ` +
              `retry=${retryCount} remaining_h=${remainingHours.toFixed(2)}`
          );
        }
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}
