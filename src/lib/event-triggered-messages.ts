import type { ObjectId } from "mongodb";

/**
 * イベント駆動メッセージ機能（Phase 1: 型定義のみ・送信ロジックは Phase 2）
 *
 * 既存の「時間経過トリガー自動返信」(12時間ペナルティ回避用) とは完全に別系統:
 *   - 別コレクション (event_triggered_messages / event_triggered_send_log)
 *   - 別フラグ (既存 auto_reply_pending / last_auto_reply_at とは独立)
 *   - 別トリガー (Shopee 注文ライフサイクルの Push Code 3 / 4)
 *
 * 既存の auto-reply のスタッフ応答判定 / customer_id 判定ロジックは import しない
 * ことで、相互干渉を構造的に防ぐ。
 */

export type EventType =
  /** 注文確定（支払完了 / UNPAID → READY_TO_SHIP 遷移） */
  | "order_confirmed"
  /** 追跡番号登録（order_trackingno_push code 4） */
  | "tracking_registered"
  /** 配送完了 + 3.5 日（actual_receive_time から 84h 後） */
  | "delivered_plus_3d";

export const EVENT_TYPES: EventType[] = [
  "order_confirmed",
  "tracking_registered",
  "delivered_plus_3d",
];

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as string[]).includes(v);
}

export type EventMessageStatus =
  | "pending"    // due_at 到来待ち
  | "sent"       // 送信成功 → event_triggered_send_log にも行が入る
  | "cancelled"  // 送信前に取り消し（注文キャンセル等）
  | "failed";    // 送信失敗（リトライ切れ）

/**
 * 送信キュー。 (shop_id, order_sn, event_type) で一意（pending に限定した partial index）。
 * 同じ注文に同じイベントでは pending を1つしか持てないため、重複スケジュール不可。
 */
export type EventTriggeredMessageDoc = {
  _id?: ObjectId;
  shop_id: number;
  order_sn: string;
  event_type: EventType;

  /** 送信先の買い手 user_id（customer_id と同義） */
  customer_id: number;
  /**
   * 関連会話 ID（任意）。get_order_detail で取れたものを保存。
   * 送信時に会話が無ければ Shopee 側で自動作成される。
   */
  conversation_id?: string;

  /** 送信対象テンプレート（reply_templates._id） */
  template_id: string;

  /** 送信予定時刻（UTC） */
  due_at: Date;

  status: EventMessageStatus;

  /** 送信完了後のみセット */
  sent_at?: Date | null;
  sent_message_id?: string | null;

  /** デバッグ用: 何回送信リトライしたか */
  retry_count?: number;
  last_error?: string | null;

  created_at: Date;
  updated_at: Date;
};

/**
 * 送信ジャーナル。 (shop_id, order_sn, event_type) で **unique index**。
 * 「このイベントで送った／送っていない」の真実の源。重複送信防止の土台。
 */
export type EventTriggeredSendLogDoc = {
  _id?: ObjectId;
  shop_id: number;
  order_sn: string;
  event_type: EventType;
  sent_at: Date;
  message_id: string;
};

/** コレクション名（collection() 呼び出し時のシングルソース） */
export const EVENT_TRIGGERED_MESSAGES_COLLECTION = "event_triggered_messages";
export const EVENT_TRIGGERED_SEND_LOG_COLLECTION = "event_triggered_send_log";
