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
 * Returns "unknown" when `from_id` is 0/missing (system cards etc.) — callers
 * should ignore those entries rather than treating them as either side.
 */
export function classifyShopeeMessageSender(
  msg: Record<string, unknown>,
  customerId: number
): "buyer" | "staff" | "unknown" {
  const fromId = Number(msg.from_id ?? msg.from_user_id ?? 0);
  if (!Number.isFinite(fromId) || fromId === 0) return "unknown";
  const buyer = Number(customerId);
  if (Number.isFinite(buyer) && buyer > 0 && fromId === buyer) return "buyer";
  return "staff";
}

/**
 * Pure helper (testable): walk raw messages and return the latest buyer/staff
 * timestamps (ms since epoch, 0 if none).
 */
export function computeBuyerStaffLastMs(
  rawMessages: Record<string, unknown>[],
  customerId: number
): { lastBuyerMs: number; lastStaffMs: number } {
  let lastBuyerMs = 0;
  let lastStaffMs = 0;
  for (const msg of rawMessages) {
    const kind = classifyShopeeMessageSender(msg, customerId);
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

async function resolveTemplateContent(templateId: string): Promise<string | null> {
  if (!templateId || !ObjectId.isValid(templateId)) return null;
  const col = await getCollection<{ _id: ObjectId; content: string }>(
    "reply_templates"
  );
  const doc = await col.findOne({ _id: new ObjectId(templateId) });
  const text = doc?.content?.trim();
  return text || null;
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
    const { lastBuyerMs, lastStaffMs } = computeBuyerStaffLastMs(
      rawMessages,
      customerId
    );

    if (lastBuyerMs === 0) {
      // No buyer activity at all → nothing to auto-reply to.
      if (existing.auto_reply_pending) {
        await clearAutoReplySchedule(convId, shopId);
      }
      return;
    }

    // Staff has already replied after the last buyer message → cancel
    if (lastStaffMs >= lastBuyerMs) {
      if (existing.auto_reply_pending) {
        await clearAutoReplySchedule(convId, shopId);
        console.log(`[auto-reply] review: cleared (staff replied) conv=${convId}`);
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

const MAX_BATCH = 30;

/**
 * 期限到来の会話にテンプレートを送信（cron 用）
 */
export async function processDueAutoReplies(): Promise<ProcessAutoReplyResult> {
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
    if (
      !afterReview?.auto_reply_pending ||
      !(afterReview.auto_reply_due_at instanceof Date) ||
      afterReview.auto_reply_due_at.getTime() > nowSend.getTime()
    ) {
      result.skipped++;
      continue;
    }

    /**
     * 送信直前の最終ガード（防御多重化）:
     * review ロジックに将来バグが入っても誤送信が発生しないよう、ここで独立に
     * 「最新メッセージが buyer からの送信であること」を直接検査する。
     * buyer ではない（= スタッフ側からの送信）なら送らずキャンセル。
     */
    const { lastBuyerMs: guardBuyerMs, lastStaffMs: guardStaffMs } =
      computeBuyerStaffLastMs(rawList, customerIdNum);
    if (guardBuyerMs === 0 || guardStaffMs >= guardBuyerMs) {
      await clearAutoReplySchedule(convId, shopId);
      console.log(
        `[auto-reply] pre-send guard: cancelled (latest is staff or no buyer msg) conv=${convId} shop=${shopId}`
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
      result.skipped++;
      continue;
    }

    try {
      const cfg = countries[countryKey];
      if (!cfg?.enabled || !cfg.template_id?.trim()) {
        result.skipped++;
        continue;
      }

      const content = await resolveTemplateContent(cfg.template_id);
      if (!content) {
        result.skipped++;
        continue;
      }

      const buyerId = Number(doc.customer_id);
      if (!Number.isFinite(buyerId) || buyerId <= 0) {
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
