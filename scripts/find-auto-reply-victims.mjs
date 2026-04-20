#!/usr/bin/env node
/**
 * find-auto-reply-victims.mjs
 *
 * 目的: 過去に「スタッフが手動返信済みなのに自動返信が送られた」スレッドを洗い出す。
 *
 * 検出条件:
 *   1. staff_message_kind_log に kind="auto" のエントリがある会話
 *   2. その auto 送信の message_id を shopee_chat_messages から引き、timestamp を得る
 *   3. それより前の最新メッセージ（immediately previous）を取得
 *   4. その previous メッセージの from_id が customer_id と一致しない
 *      （= スタッフ送信、shop本体でもサブアカウントでも）→ 被害スレッド確定
 *
 * 使い方 (cmd.exe):
 *   cd "C:\Users\psych\Downloads\Chapee-main (1)\Chapee-main"
 *   node scripts\find-auto-reply-victims.mjs
 *
 * 環境変数（.env から自動で読み込む。未設定なら環境変数を利用）:
 *   MONGODB_URI  - Mongo 接続文字列
 *   MONGODB_DB   - DB 名（省略時 "chapee"）
 *
 * オプション:
 *   --days=N    過去 N 日分のみ対象（デフォルト 30）
 *   --out=PATH  JSON 出力先（デフォルト scripts/auto-reply-victims.json）
 *
 * 出力:
 *   stdout に件数・サンプル・上位リスト
 *   --out で指定した JSON ファイルに全件
 */

import { MongoClient } from "mongodb";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ---- .env を読む（dotenv 未インストール環境でも動くように手書き） -----------
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

// ---- CLI args --------------------------------------------------------------
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.replace(/^--/, "").split("=");
      return [k, v];
    })
);
const DAYS = Math.max(1, Number(args.days ?? 30));
const OUT_PATH = args.out
  ? resolve(args.out)
  : join(__dirname, "auto-reply-victims.json");

// ---- Mongo connection ------------------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "chapee";

if (!MONGODB_URI) {
  console.error(
    "ERROR: MONGODB_URI が設定されていません。.env か環境変数で指定してください。"
  );
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);

async function main() {
  console.log(`[find-victims] 接続中: ${MONGODB_DB}`);
  await client.connect();
  const db = client.db(MONGODB_DB);
  const convCol = db.collection("shopee_conversations");
  const msgCol = db.collection("shopee_chat_messages");

  const sinceMs = Date.now() - DAYS * 24 * 3600 * 1000;
  console.log(
    `[find-victims] 対象期間: 過去 ${DAYS} 日（${new Date(sinceMs).toISOString()} 以降）`
  );

  // 1) auto エントリを持つ会話を列挙
  //    （customer_id を必ず必要とする — 判定の軸）
  const candidates = await convCol
    .find({
      "staff_message_kind_log.kind": "auto",
      customer_id: { $exists: true, $gt: 0 },
    })
    .project({
      conversation_id: 1,
      shop_id: 1,
      customer_id: 1,
      customer_name: 1,
      staff_message_kind_log: 1,
      country: 1,
    })
    .toArray();

  console.log(`[find-victims] 候補会話数: ${candidates.length}`);

  const victims = [];
  let scannedAutoEntries = 0;

  for (const conv of candidates) {
    const convId = String(conv.conversation_id);
    const shopId = Number(conv.shop_id);
    const customerId = Number(conv.customer_id);
    if (!Number.isFinite(customerId) || customerId <= 0) continue;

    const autoEntries = (conv.staff_message_kind_log || []).filter(
      (e) => e && e.kind === "auto" && e.id
    );
    if (!autoEntries.length) continue;

    for (const entry of autoEntries) {
      scannedAutoEntries++;
      const autoMsgId = String(entry.id);

      // 2) auto メッセージ本体を取得
      const autoMsg = await msgCol.findOne({
        conversation_id: convId,
        shop_id: shopId,
        message_id: autoMsgId,
      });
      if (!autoMsg) continue; // 本文ログが残っていない古い送信はスキップ

      const autoTs = Number(autoMsg.timestamp_ms ?? 0);
      if (!autoTs || autoTs < sinceMs) continue; // 期間外

      // 3) 直前のメッセージ（時刻が autoTs 未満で最新）
      const prev = await msgCol
        .find({
          conversation_id: convId,
          shop_id: shopId,
          timestamp_ms: { $lt: autoTs },
        })
        .sort({ timestamp_ms: -1 })
        .limit(1)
        .next();

      if (!prev) continue;

      const raw = prev.raw || {};
      const prevFromId = Number(raw.from_id ?? raw.from_user_id ?? 0);
      // 4) 直前がスタッフ（from_id !== customer_id）なら被害確定
      if (prevFromId === 0) continue; // system card は除外
      if (prevFromId === customerId) continue; // 直前がバイヤーなら正常な自動返信

      victims.push({
        conversation_id: convId,
        shop_id: shopId,
        country: conv.country ?? null,
        customer_id: customerId,
        customer_name: conv.customer_name ?? null,
        auto_reply: {
          message_id: autoMsgId,
          sent_at: new Date(autoTs).toISOString(),
        },
        previous_staff_message: {
          message_id: String(prev.message_id ?? ""),
          from_id: prevFromId,
          sent_at: new Date(Number(prev.timestamp_ms ?? 0)).toISOString(),
        },
      });
    }
  }

  // 並び替え: 送信日時 新しい順
  victims.sort((a, b) =>
    b.auto_reply.sent_at.localeCompare(a.auto_reply.sent_at)
  );

  // ---- 出力 ---------------------------------------------------------------
  console.log("");
  console.log("============================================================");
  console.log(`[find-victims] スキャンした auto 送信: ${scannedAutoEntries} 件`);
  console.log(`[find-victims] 誤送信と判定: ${victims.length} 件`);
  console.log("============================================================");

  if (victims.length > 0) {
    console.log("\n直近 20 件（新しい順）:");
    for (const v of victims.slice(0, 20)) {
      console.log(
        `  - conv=${v.conversation_id} shop=${v.shop_id} customer=${v.customer_id} (${v.customer_name ?? "?"})` +
          `  auto=${v.auto_reply.sent_at}  prev_staff_from_id=${v.previous_staff_message.from_id}`
      );
    }
    if (victims.length > 20) {
      console.log(`  … 他 ${victims.length - 20} 件`);
    }
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        period_days: DAYS,
        since: new Date(sinceMs).toISOString(),
        candidates_scanned: candidates.length,
        auto_entries_scanned: scannedAutoEntries,
        victims_count: victims.length,
        victims,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\n[find-victims] 全件 JSON 出力: ${OUT_PATH}`);
}

main()
  .catch((e) => {
    console.error("[find-victims] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => {});
  });
