import type { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";

/**
 * Webhook Observation Log — Phase 1 の実 payload 採取用コレクション。
 *
 * 目的:
 *   Live Push ON 直後、Shopee が実際にどんな payload を送ってくるかを採取する。
 *   Shopee のドキュメント記載フィールドと実配信フィールドが食い違うケースがあり、
 *   Phase 2 の消費ロジックを「推定 spec」で書くのではなく「実 payload」で書くための土台。
 *
 * event_triggered_send_log とは **別コレクション**:
 *   - unique index (shop_id, order_sn, event_type) に引っかけない（観察は同じ order に
 *     複数 push が来る）
 *   - 観察データと実送信ログは概念的に別物
 *   - Phase 2 消費ロジック検証時に観察データを振り返り分析したい
 *
 * このコレクションは「書き込み専用」で、Phase 1 では消費側は実装しない。
 * Phase 2 移行時に、observed データと Phase 2 の実送信ログを突合して取りこぼしを確認する。
 */
export const WEBHOOK_OBSERVATION_LOG_COLLECTION = "webhook_observation_log";

export type WebhookObservationLogDoc = {
  _id?: ObjectId;
  received_at: Date;
  /** Shopee Push Code (1, 3, 4, 10 等) */
  code: number;
  /** payload 上の shop_id。code によっては data.shop_id に入る */
  shop_id?: number;
  /** 生 payload（JSON.parse 済み）。 Shopee のフィールドが仕様書と異なる場合の調査用 */
  raw_payload: Record<string, unknown>;
  /** 署名検証結果。false でも記録する（攻撃者のテストなのか Shopee の設定ミスなのか切り分けたい） */
  signature_valid: boolean;
  /**
   * Phase 2 以降でこの observation を消費ロジックが処理したかのマーカー。
   * Phase 1 時点では常に false で書き込み、Phase 2 の backfill スクリプトが true に更新する。
   */
  processed: boolean;
  /** 任意の補足情報 */
  note?: string;
};

/**
 * 観察用 collection への書き込みヘルパ。
 * 絶対に失敗を上に伝搬させない（webhook 受信が止まる方が困る）。
 */
export async function recordWebhookObservation(
  entry: Omit<WebhookObservationLogDoc, "_id" | "received_at"> & {
    received_at?: Date;
  }
): Promise<void> {
  try {
    const col = await getCollection<WebhookObservationLogDoc>(
      WEBHOOK_OBSERVATION_LOG_COLLECTION
    );
    await col.insertOne({
      received_at: entry.received_at ?? new Date(),
      code: entry.code,
      shop_id: entry.shop_id,
      raw_payload: entry.raw_payload,
      signature_valid: entry.signature_valid,
      processed: entry.processed,
      ...(entry.note ? { note: entry.note } : {}),
    });
  } catch (e) {
    // 観察ログの失敗で Shopee 側に 500 を返したくないため握りつぶす
    console.warn("[webhook-observation] insert failed:", e);
  }
}
