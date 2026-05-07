import {
  EVENT_TRIGGERED_MESSAGES_COLLECTION,
  EVENT_TRIGGERED_SEND_LOG_COLLECTION,
  type EventTriggeredMessageDoc,
  type EventTriggeredSendLogDoc,
  type EventType,
} from "@/lib/event-triggered-messages";
import { getCollection } from "@/lib/mongodb";
import { getOrderDetail, sendMessage } from "@/lib/shopee-api";
import { resolveCountryForShop, getValidToken } from "@/lib/shopee-token";

/**
 * Phase 2: イベント駆動メッセージのテンプレート / enqueue / send を一括で持つ。
 *
 * 既存の auto-reply (営業時間外・12時間ペナルティ回避) とは:
 *   - 別コレクション (event_triggered_messages / event_triggered_send_log)
 *   - 別フラグ (auto_reply_pending / last_auto_reply_at は触らない)
 *   - 別 cron (/api/cron/event-triggered)
 * で完全分離。 staff_message_kind_log にも書かない (既存の誤発火検出ロジックが
 * 反応してしまうため)。
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

/** ハードコード英語テンプレート (将来の多言語化は同 file 内の Record 拡張で対応可) */
const TEMPLATES: Record<EventType, string> = {
  order_confirmed:
    "Thank you for your order! We're preparing your items for shipment. " +
    "You'll receive a tracking number once the parcel leaves our warehouse.",

  tracking_registered:
    "Your order has been shipped! You can track its journey using the " +
    "tracking number provided in your Shopee app. Thank you for shopping with us!",

  delivered_plus_3d:
    "We hope you're enjoying your purchase! If you're satisfied, we'd " +
    "really appreciate a review on Shopee. If anything's wrong, please reply " +
    "here and we'll make it right.",
};

/** template_id field に入れる sentinel (DB テンプレート参照ではないことを示す) */
function templateSentinelId(et: EventType): string {
  return `code:${et}:default`;
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
      template_id: templateSentinelId(args.event_type),
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
  failed: number;
  errors: { order_sn: string; event_type: EventType; error: string }[];
};

/**
 * pending queue を drain して送信する。 cron が呼ぶ。
 * - PHASE2_TRIGGERS_ENABLED が false の間は noop で 0 件返す。
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
    failed: 0,
    errors: [],
  };

  if (!isPhase2Enabled()) return result;

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
      // 1) token + country 取得
      const accessToken = await getValidToken(doc.shop_id);
      const country = await resolveCountryForShop(doc.shop_id);

      // 2) customer_id 解決
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

      // 3) Shopee に送信 (構造的 dedup の真実の源は send_log の unique index)
      const content = TEMPLATES[doc.event_type];

      const sendRes = (await sendMessage(
        accessToken,
        doc.shop_id,
        customerId,
        content,
        country ? { country } : undefined
      )) as Record<string, unknown>;

      const sentMessageId = extractSentMessageId(sendRes);

      // 4) 送信ジャーナルに insert (unique index で 1 度だけ)
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

      // 5) queue を sent に
      await queueCol.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: "sent",
            sent_at: new Date(),
            sent_message_id: sentMessageId ?? null,
            last_error: null,
            updated_at: new Date(),
          },
        }
      );

      result.sent++;
      console.log(
        `[phase2] sent shop=${doc.shop_id} order=${doc.order_sn} event=${doc.event_type}`
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
