import {
  EVENT_TRIGGERED_MESSAGES_COLLECTION,
  EVENT_TRIGGERED_SEND_LOG_COLLECTION,
  type EventTriggeredMessageDoc,
  type EventTriggeredSendLogDoc,
  type EventType,
} from "@/lib/event-triggered-messages";
import { getCollection } from "@/lib/mongodb";
import {
  getOrderDetail,
  sendMessage,
  sendOrderMessage,
} from "@/lib/shopee-api";
import { resolveCountryForShop, getValidToken } from "@/lib/shopee-token";
import {
  getPhase2TriggerSettings,
  resolvePhase2TemplateContent,
  type Phase2TriggerSettings,
} from "@/lib/phase2-trigger-settings";

/**
 * Phase 2: イベント駆動メッセージの enqueue / send を一括で持つ。
 *
 * 既存の auto-reply (営業時間外・12時間ペナルティ回避) とは:
 *   - 別コレクション (event_triggered_messages / event_triggered_send_log)
 *   - 別フラグ (auto_reply_pending / last_auto_reply_at は触らない)
 *   - 別 cron (/api/cron/event-triggered)
 * で完全分離。 staff_message_kind_log にも書かない (既存の誤発火検出ロジックが
 * 反応してしまうため)。
 *
 * テンプレート解決: `phase2_trigger_settings` (singleton) と `reply_templates` を
 * 引いて、 (event_type, country) で動的に決まる。 設定がない / 該当国 disabled /
 * テンプレ未指定 / 本文取得失敗 のいずれも「送らない (cancelled)」で締める。
 * (誤送信 > 送信漏れ の方針)
 *
 * 安全装置:
 *   - 環境変数 PHASE2_TRIGGERS_ENABLED が "true" でない限り enqueue / send は
 *     即 noop。 Vercel ダッシュボードでオン/オフ可能 (再デプロイ不要)。
 *   - event_triggered_send_log の (shop_id, order_sn, event_type) unique index で
 *     構造的に重複送信不可。 insert 失敗 (E11000) を skip 扱いとして握りつぶす。
 */

export function isPhase2Enabled(): boolean {
  return String(process.env.PHASE2_TRIGGERS_ENABLED ?? "").toLowerCase() === "true";
}

export type EnqueueArgs = {
  shop_id: number;
  order_sn: string;
  event_type: EventType;
  /**
   * 任意。 enqueue 時に既知なら入れる。 不明なら send 時に getOrderDetail で
   * 解決するので空でも可。
   */
  customer_id?: number;
  /** 任意。 送信時の get_one_conversation 用ヒント。 */
  conversation_id?: string;
  /** 任意。 デフォルトは即時 (now)。 */
  due_at?: Date;
};

/**
 * pending queue に enqueue する。 同じ (shop_id, order_sn, event_type) で
 * pending が既にあれば partial unique index で挿入失敗 → 黙って skip。
 *
 * - PHASE2_TRIGGERS_ENABLED が false の間は何もしない。
 * - 例外は呼び出し側に伝搬させない (webhook 受信を絶対に止めない)。
 *
 * 注: enqueue 時点では template_id を空にしておく。 送信時に settings から
 * (event_type, country) で動的解決するため。
 */
export async function enqueuePhase2Trigger(args: EnqueueArgs): Promise<void> {
  if (!isPhase2Enabled()) return;

  try {
    const col = await getCollection<EventTriggeredMessageDoc>(
      EVENT_TRIGGERED_MESSAGES_COLLECTION
    );

    const now = new Date();
    const doc: Omit<EventTriggeredMessageDoc, "_id"> = {
      shop_id: args.shop_id,
      order_sn: args.order_sn,
      event_type: args.event_type,
      customer_id: args.customer_id ?? 0,
      conversation_id: args.conversation_id,
      template_id: "",
      due_at: args.due_at ?? now,
      status: "pending",
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    };

    try {
      await col.insertOne(doc as EventTriggeredMessageDoc);
      console.log(
        `[phase2] enqueued shop=${args.shop_id} order=${args.order_sn} event=${args.event_type}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // E11000 = duplicate key (既に pending あり) — 想定動作なので INFO ログ
      if (msg.includes("E11000")) {
        console.log(
          `[phase2] enqueue skipped (already pending) shop=${args.shop_id} order=${args.order_sn} event=${args.event_type}`
        );
        return;
      }
      console.error("[phase2] enqueue insert failed:", e);
    }
  } catch (e) {
    console.error("[phase2] enqueue outer failed:", e);
  }
}

/**
 * customer_id を解決する。 enqueue 時点で取れていれば即返す。
 * 取れていなければ Shopee の get_order_detail で buyer_user_id を引く。
 */
async function resolveCustomerId(
  doc: EventTriggeredMessageDoc,
  accessToken: string,
  country: string | undefined
): Promise<number | null> {
  if (Number.isFinite(doc.customer_id) && doc.customer_id > 0) {
    return doc.customer_id;
  }

  try {
    const res = (await getOrderDetail(
      accessToken,
      doc.shop_id,
      [doc.order_sn],
      ["buyer_user_id", "buyer_username"],
      country ? { country } : undefined
    )) as Record<string, unknown>;

    const response = res.response as Record<string, unknown> | undefined;
    const orderList = (response?.order_list ?? []) as Record<string, unknown>[];
    if (!Array.isArray(orderList) || orderList.length === 0) return null;
    const first = orderList[0];
    const buyerId = Number(first.buyer_user_id ?? 0);
    return Number.isFinite(buyerId) && buyerId > 0 ? buyerId : null;
  } catch (e) {
    console.warn(
      `[phase2] getOrderDetail failed shop=${doc.shop_id} order=${doc.order_sn}:`,
      e
    );
    return null;
  }
}

export type ProcessResult = {
  scanned: number;
  sent: number;
  skipped_duplicate: number;
  skipped_missing_customer: number;
  skipped_disabled: number;
  skipped_no_template: number;
  failed: number;
  errors: { order_sn: string; event_type: EventType; error: string }[];
};

/** queue を cancelled で締めるユーティリティ (内部用)。 */
async function markCancelled(
  queueCol: Awaited<
    ReturnType<typeof getCollection<EventTriggeredMessageDoc>>
  >,
  doc: EventTriggeredMessageDoc,
  reason: string
): Promise<void> {
  await queueCol.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: "cancelled",
        last_error: reason,
        updated_at: new Date(),
      },
    }
  );
}

/**
 * pending queue を drain して送信する。 cron が呼ぶ。
 * - PHASE2_TRIGGERS_ENABLED が false の間は noop で 0 件返す。
 * - settings (singleton) が未投入 / 該当 event_type が disabled / 該当 country が
 *   disabled / template_id 未設定 / 本文未取得 のいずれも cancelled。
 * - 1 回の起動で最大 maxBatch 件まで処理 (cron 実行時間内に収める)。
 * - 失敗は status="failed" + retry_count++ で残し、 次回 cron で再試行可能。
 */
export async function processDuePhase2Triggers(
  opts?: { maxBatch?: number }
): Promise<ProcessResult> {
  const result: ProcessResult = {
    scanned: 0,
    sent: 0,
    skipped_duplicate: 0,
    skipped_missing_customer: 0,
    skipped_disabled: 0,
    skipped_no_template: 0,
    failed: 0,
    errors: [],
  };

  if (!isPhase2Enabled()) return result;

  const settings: Phase2TriggerSettings | null = await getPhase2TriggerSettings();
  // settings 未投入 (UI からまだ一度も保存されていない) → 何もしない。
  // pending を cancelled で潰さない方針 (UI 側で保存後に同 cron で送信再開できるよう
  // pending のまま残す)。
  if (!settings) return result;

  const maxBatch = Math.max(1, Math.min(200, opts?.maxBatch ?? 50));
  const now = new Date();

  const queueCol = await getCollection<EventTriggeredMessageDoc>(
    EVENT_TRIGGERED_MESSAGES_COLLECTION
  );
  const logCol = await getCollection<EventTriggeredSendLogDoc>(
    EVENT_TRIGGERED_SEND_LOG_COLLECTION
  );

  const due = await queueCol
    .find({ status: "pending", due_at: { $lte: now } })
    .sort({ due_at: 1 })
    .limit(maxBatch)
    .toArray();

  result.scanned = due.length;

  for (const doc of due) {
    try {
      // 1) 設定ベースのゲート (event_type 全体)
      const eventCfg = settings.triggers[doc.event_type];
      if (!eventCfg || !eventCfg.enabled_global) {
        await markCancelled(queueCol, doc, "event_type disabled (global)");
        result.skipped_disabled++;
        continue;
      }

      // 2) token + country 取得
      const accessToken = await getValidToken(doc.shop_id);
      const country = await resolveCountryForShop(doc.shop_id);
      const countryKey =
        typeof country === "string" && country.trim().length > 0
          ? country.trim().toUpperCase()
          : "";

      // 3) 国別ゲート + テンプレ ID
      const countryCfg = countryKey
        ? eventCfg.countries[countryKey]
        : undefined;
      if (!countryCfg || !countryCfg.enabled) {
        await markCancelled(
          queueCol,
          doc,
          countryKey
            ? `country disabled (${countryKey})`
            : "country unresolved"
        );
        result.skipped_disabled++;
        continue;
      }
      if (!countryCfg.template_id) {
        await markCancelled(
          queueCol,
          doc,
          `template not set (${countryKey})`
        );
        result.skipped_no_template++;
        continue;
      }

      // 4) テンプレ本文を解決 (失敗 = テンプレ削除済み等 → cancelled)
      const content = await resolvePhase2TemplateContent(countryCfg.template_id);
      if (!content) {
        await markCancelled(
          queueCol,
          doc,
          `template content unresolved (${countryCfg.template_id})`
        );
        result.skipped_no_template++;
        continue;
      }

      // 5) customer_id 解決
      const customerId = await resolveCustomerId(doc, accessToken, country);
      if (!customerId) {
        result.skipped_missing_customer++;
        await queueCol.updateOne(
          { _id: doc._id },
          {
            $set: {
              status: "failed",
              last_error: "customer_id unresolved",
              updated_at: new Date(),
            },
            $inc: { retry_count: 1 },
          }
        );
        continue;
      }

      // 6) Shopee に送信 (構造的 dedup の真実の源は send_log の unique index)
      //
      // 注意: 店舗 → バイヤーへの「先制テキスト送信」は、既存会話がない 2 者間では
      // Shopee 側で拒否される (エラー: "If 2 users have no existing conversation,
      // the message must contain order information between 2 users.")。
      //
      // この場合 1 回だけ注文カード (message_type: "order") を送って会話を確立してから、
      // 同じトリガー内でテキストを再送する。 注文カード自体が「自動メッセージ」として
      // バイヤー側に表示されることでも本トリガーの目的 (注文確認 / 発送通知 / レビュー
      // 依頼) のフックは果たせるため、片方が失敗しても価値は残る。
      console.log(
        `[phase2] sendMessage attempt shop=${doc.shop_id} order=${doc.order_sn} event=${doc.event_type} to_id=${customerId} country=${countryKey} content_len=${content.length}`
      );
      let sendRes: Record<string, unknown>;
      let openedWithOrderCard = false;
      try {
        sendRes = (await sendMessage(
          accessToken,
          doc.shop_id,
          customerId,
          content,
          country ? { country } : undefined
        )) as Record<string, unknown>;
      } catch (sendErr) {
        const sendMsg =
          sendErr instanceof Error ? sendErr.message : String(sendErr);
        const noConversation =
          sendMsg.includes("must contain order information") ||
          sendMsg.includes("no existing conversation");
        if (!noConversation) throw sendErr;

        console.log(
          `[phase2] no_existing_conversation -> opening with order card shop=${doc.shop_id} order=${doc.order_sn} event=${doc.event_type}`
        );
        await sendOrderMessage(
          accessToken,
          doc.shop_id,
          customerId,
          doc.order_sn,
          country ? { country } : undefined
        );
        openedWithOrderCard = true;

        // 会話確立直後の text 再送
        sendRes = (await sendMessage(
          accessToken,
          doc.shop_id,
          customerId,
          content,
          country ? { country } : undefined
        )) as Record<string, unknown>;
        console.log(
          `[phase2] retry sendMessage after order card succeeded shop=${doc.shop_id} order=${doc.order_sn} event=${doc.event_type}`
        );
      }

      const sentMessageId = extractSentMessageId(sendRes);

      // 7) 送信ジャーナルに insert (unique index で 1 度だけ)
      try {
        await logCol.insertOne({
          shop_id: doc.shop_id,
          order_sn: doc.order_sn,
          event_type: doc.event_type,
          sent_at: new Date(),
          message_id: sentMessageId ?? "",
        } as EventTriggeredSendLogDoc);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("E11000")) {
          // 既に send_log にある = 別経路で送信済み。 queue は cancelled で締める。
          result.skipped_duplicate++;
          await queueCol.updateOne(
            { _id: doc._id },
            {
              $set: {
                status: "cancelled",
                last_error: "duplicate send_log entry",
                updated_at: new Date(),
              },
            }
          );
          continue;
        }
        throw e;
      }

      // 8) queue を sent に + 解決した template_id を記録 (デバッグ用)
      await queueCol.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: "sent",
            sent_at: new Date(),
            sent_message_id: sentMessageId ?? null,
            template_id: countryCfg.template_id,
            last_error: null,
            updated_at: new Date(),
          },
        }
      );

      result.sent++;
      console.log(
        `[phase2] sent shop=${doc.shop_id} order=${doc.order_sn} event=${doc.event_type} country=${countryKey} template=${countryCfg.template_id} opened_with_order_card=${openedWithOrderCard}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed++;
      result.errors.push({
        order_sn: doc.order_sn,
        event_type: doc.event_type,
        error: msg,
      });
      try {
        await queueCol.updateOne(
          { _id: doc._id },
          {
            $set: {
              status: "failed",
              last_error: msg.slice(0, 500),
              updated_at: new Date(),
            },
            $inc: { retry_count: 1 },
          }
        );
      } catch {
        /* ignore */
      }
      console.error(
        `[phase2] send failed shop=${doc.shop_id} order=${doc.order_sn} event=${doc.event_type}:`,
        e
      );
    }
  }

  return result;
}

function extractSentMessageId(sendRes: Record<string, unknown>): string | null {
  const response = sendRes.response as Record<string, unknown> | undefined;
  const mid = response?.message_id ?? sendRes.message_id;
  if (mid == null) return null;
  return String(mid);
}
