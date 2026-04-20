#!/usr/bin/env node
/**
 * init-event-triggered-indexes.mjs
 *
 * 目的:
 *   Phase 1 で追加した以下のコレクションに必要な index を張る。
 *     - event_triggered_messages      (送信キュー)
 *     - event_triggered_send_log      (送信ジャーナル、重複送信防止の真実の源)
 *     - webhook_observation_log       (実 payload 採取)
 *
 *   冪等 (idempotent): 何度実行しても壊れない。すでに存在する index は再作成されない。
 *
 * 使い方 (cmd.exe):
 *   cd C:\Users\psych\AppData\Local\Temp\chapee-push\Chapee
 *   set MONGODB_URI=mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/
 *   set MONGODB_DB=chapee
 *   node scripts\init-event-triggered-indexes.mjs
 *
 * または（Vercel CLI なしで実行したい場合）:
 *   /api/admin/init-event-triggered-indexes エンドポイントを Phase 2 で追加予定。
 *   Phase 1 の時点ではローカル or CI から手動実行する想定。
 */

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "chapee";

if (!MONGODB_URI) {
  console.error(
    "ERROR: MONGODB_URI が未設定です。環境変数で指定してください。"
  );
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);

/**
 * 期待する index 定義。createIndex は idempotent なので、同一キー・同一 options で
 * 既に存在する場合は何もしない (different options だとエラー → 運用時に気付ける)。
 */
const INDEXES = [
  {
    collection: "event_triggered_messages",
    indexes: [
      {
        // pending 状態の重複スケジュールを構造的に防ぐ (partial unique index)
        keys: { shop_id: 1, order_sn: 1, event_type: 1 },
        options: {
          name: "uniq_pending_shop_ordersn_eventtype",
          unique: true,
          partialFilterExpression: { status: "pending" },
        },
      },
      {
        // cron が due 分を引くためのクエリ最適化
        keys: { status: 1, due_at: 1 },
        options: { name: "status_due_at" },
      },
    ],
  },
  {
    collection: "event_triggered_send_log",
    indexes: [
      {
        // 送信ジャーナルは (shop, order, event) で完全 unique
        keys: { shop_id: 1, order_sn: 1, event_type: 1 },
        options: {
          name: "uniq_log_shop_ordersn_eventtype",
          unique: true,
        },
      },
      {
        keys: { sent_at: -1 },
        options: { name: "sent_at_desc" },
      },
    ],
  },
  {
    collection: "webhook_observation_log",
    indexes: [
      {
        // 観察データは code 別・時系列で引くことが多い
        keys: { code: 1, received_at: -1 },
        options: { name: "code_received_at" },
      },
      {
        keys: { shop_id: 1, received_at: -1 },
        options: { name: "shop_received_at" },
      },
      {
        // Phase 2 で未処理分を backfill するためのクエリ
        keys: { processed: 1, received_at: 1 },
        options: { name: "processed_received_at" },
      },
    ],
  },
];

async function main() {
  console.log(`[init-indexes] 接続中: ${MONGODB_DB}`);
  await client.connect();
  const db = client.db(MONGODB_DB);

  let created = 0;
  let existed = 0;

  for (const def of INDEXES) {
    const col = db.collection(def.collection);
    console.log(`\n[${def.collection}]`);
    for (const idx of def.indexes) {
      try {
        const result = await col.createIndex(idx.keys, idx.options);
        // createIndex は既存でも index 名を返すので、これだけでは新規/既存の判定ができない。
        // listIndexes() の結果と比較する冪等性ログのために簡易に表示。
        console.log(`  ✓ ${idx.options.name}: ${result}`);
        created++;
      } catch (e) {
        console.error(`  ✗ ${idx.options.name}:`, e?.message ?? e);
      }
    }
  }

  console.log(`\n[init-indexes] DONE (create/ensure 呼び出し ${created} 件, err 分はログ参照)`);
  console.log("既に存在する同定義 index は MongoDB が黙って成功扱いにするため、");
  console.log("存在確認をしたい場合は mongo shell で db.<col>.getIndexes() を参照。");
}

main()
  .catch((e) => {
    console.error("[init-indexes] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => {});
  });
