#!/usr/bin/env node
/**
 * debug-sticker-message.mjs
 *
 * 目的: shopee_chat_messages に保存された「スタンプ」「商品カード」などの
 *       特殊メッセージの raw.from_id が実際に何になっているかを確認する。
 *
 *   - from_id === 0 (システムカード扱い)  なら auto-reply.ts の分類ロジックは
 *     "unknown" を返すため、staff 返信として数えられず、古い会話でも
 *     最後のバイヤーメッセージが残ったまま判定される。
 *   - from_id === customer_id              ならバイヤーが送ったリアクションスタンプ
 *   - from_id === shop_id / サブアカ個人id  ならスタッフ送信
 *
 * 使い方 (cmd.exe):
 *   cd /d "C:\Users\psych\AppData\Local\Temp\chapee-push\Chapee"
 *   node scripts\debug-sticker-message.mjs
 *
 * 出力:
 *   1. shopee_chat_messages 内の message_type 上位15件と件数
 *   2. sticker メッセージ 5件のサンプル (raw.from_id と該当会話の customer_id / shop_id)
 *   3. item_card / product / order 系 (名称ゆらぎに対応) 5件のサンプル
 *   4. from_id === 0 の全メッセージについて message_type の分布
 */

import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ---- .env を手書き読込 (dotenv 無しで動く) ---------------------------------
function loadDotEnv() {
  const envPath = join(REPO_ROOT, ".env");
  try {
    const txt = readFileSync(envPath, "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* .env が無くても続行 */
  }
}
loadDotEnv();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "chapee";

if (!MONGODB_URI) {
  console.error(
    "ERROR: MONGODB_URI が設定されていません。.env か環境変数で指定してください。"
  );
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);

function formatSample(doc) {
  const raw = doc.raw || {};
  return {
    _id: String(doc._id),
    conversation_id: doc.conversation_id ?? null,
    shop_id: doc.shop_id ?? null,
    message_id: doc.message_id ?? null,
    timestamp_ms: doc.timestamp_ms ?? null,
    timestamp_iso: doc.timestamp_ms
      ? new Date(Number(doc.timestamp_ms)).toISOString()
      : null,
    message_type: raw.message_type ?? null,
    raw_from_id: raw.from_id ?? null,
    raw_from_user_id: raw.from_user_id ?? null,
    raw_to_id: raw.to_id ?? null,
    raw_content_keys: raw.content ? Object.keys(raw.content) : null,
  };
}

async function main() {
  console.log(`[debug-sticker] 接続中: ${MONGODB_DB}`);
  await client.connect();
  const db = client.db(MONGODB_DB);
  const msgCol = db.collection("shopee_chat_messages");
  const convCol = db.collection("shopee_conversations");

  // 1) message_type 分布 --------------------------------------------------
  console.log("\n===== 1. message_type 上位15件 =====");
  const typeAgg = await msgCol
    .aggregate([
      { $group: { _id: "$raw.message_type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 },
    ])
    .toArray();
  for (const row of typeAgg) {
    console.log(`  ${String(row._id ?? "(null)").padEnd(20)} ${row.count}`);
  }

  // 2) sticker サンプル ---------------------------------------------------
  console.log("\n===== 2. sticker サンプル (5件) =====");
  const stickers = await msgCol
    .find({ "raw.message_type": "sticker" })
    .limit(5)
    .toArray();
  if (stickers.length === 0) {
    console.log("  (sticker メッセージなし)");
  } else {
    for (const s of stickers) {
      const sample = formatSample(s);
      const conv = await convCol.findOne(
        {
          conversation_id: String(s.conversation_id),
          shop_id: Number(s.shop_id),
        },
        { projection: { customer_id: 1, shop_id: 1, customer_name: 1 } }
      );
      console.log(JSON.stringify(sample, null, 2));
      console.log(
        `  ↳ conv.customer_id=${conv?.customer_id ?? "?"}  conv.shop_id=${conv?.shop_id ?? "?"}  customer_name=${conv?.customer_name ?? "?"}`
      );
      const fromId = Number(sample.raw_from_id ?? sample.raw_from_user_id ?? 0);
      const cid = Number(conv?.customer_id ?? 0);
      let verdict = "?";
      if (fromId === 0) verdict = "system (from_id=0) → classify: unknown";
      else if (cid > 0 && fromId === cid) verdict = "buyer";
      else verdict = "staff";
      console.log(`  ↳ 判定: ${verdict}\n`);
    }
  }

  // 3) カード/商品/注文 サンプル -----------------------------------------
  console.log("\n===== 3. item_card / order / product 系サンプル (各5件) =====");
  const cardTypes = [
    "item_card",
    "item",
    "product",
    "product_card",
    "order",
    "order_card",
    "card",
  ];
  for (const t of cardTypes) {
    const docs = await msgCol
      .find({ "raw.message_type": t })
      .limit(5)
      .toArray();
    if (docs.length === 0) continue;
    console.log(`\n-- message_type="${t}" --`);
    for (const d of docs) {
      const sample = formatSample(d);
      const conv = await convCol.findOne(
        {
          conversation_id: String(d.conversation_id),
          shop_id: Number(d.shop_id),
        },
        { projection: { customer_id: 1, shop_id: 1 } }
      );
      const fromId = Number(sample.raw_from_id ?? sample.raw_from_user_id ?? 0);
      const cid = Number(conv?.customer_id ?? 0);
      let verdict = "?";
      if (fromId === 0) verdict = "system";
      else if (cid > 0 && fromId === cid) verdict = "buyer";
      else verdict = "staff";
      console.log(
        `  from_id=${sample.raw_from_id}  customer_id=${cid}  shop_id=${conv?.shop_id}  type=${sample.message_type}  => ${verdict}`
      );
    }
  }

  // 4) from_id === 0 の message_type 分布 --------------------------------
  console.log("\n===== 4. from_id === 0 の message_type 分布 =====");
  const zeroAgg = await msgCol
    .aggregate([
      { $match: { "raw.from_id": 0 } },
      { $group: { _id: "$raw.message_type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ])
    .toArray();
  if (zeroAgg.length === 0) {
    console.log("  (from_id=0 のメッセージは0件)");
  } else {
    for (const row of zeroAgg) {
      console.log(`  ${String(row._id ?? "(null)").padEnd(20)} ${row.count}`);
    }
  }

  console.log("\n[debug-sticker] 完了");
}

main()
  .catch((e) => {
    console.error("[debug-sticker] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => {});
  });
