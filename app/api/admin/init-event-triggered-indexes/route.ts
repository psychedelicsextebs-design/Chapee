import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";

/**
 * POST /api/admin/init-event-triggered-indexes
 *
 * scripts/init-event-triggered-indexes.mjs と同等の処理を Vercel 上で実行する
 * 一時的な管理エンドポイント。ローカルから MongoDB Atlas に SRV レコードで
 * 接続できない環境 (固定IPプロキシ配下など) からも index 作成を可能にする。
 *
 * 対象コレクション:
 *   - event_triggered_messages
 *   - event_triggered_send_log
 *   - webhook_observation_log
 *
 * 冪等: MongoDB の createIndex は同一 name/keys/options なら no-op。
 *       options が衝突する場合は IndexKeySpecsConflict で errors に記録する。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * ⚠️  このルートは一時的。index 作成の確認後、別コミットで削除する前提。
 */

export const maxDuration = 60;

type IndexEntry = {
  keys: Record<string, 1 | -1>;
  options: {
    name: string;
    unique?: boolean;
    partialFilterExpression?: Record<string, unknown>;
  };
};

type CollectionIndexSpec = {
  collection: string;
  indexes: IndexEntry[];
};

const INDEXES: CollectionIndexSpec[] = [
  {
    collection: "event_triggered_messages",
    indexes: [
      {
        // pending 状態の重複スケジュールを構造的に防ぐ (partial unique)
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
        options: { name: "uniq_log_shop_ordersn_eventtype", unique: true },
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

type AppliedIndex = { name: string; returned_name: string };
type IndexError = { name: string; error: string };
type CurrentIndex = {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};
type CollectionResult = {
  collection: string;
  applied: AppliedIndex[];
  errors: IndexError[];
  current_indexes: CurrentIndex[];
};

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 未設定のため実行できません" },
      { status: 500 }
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const results: CollectionResult[] = [];

  for (const def of INDEXES) {
    const col = db.collection(def.collection);
    const applied: AppliedIndex[] = [];
    const errors: IndexError[] = [];

    for (const idx of def.indexes) {
      try {
        const returnedName = await col.createIndex(idx.keys, idx.options);
        applied.push({ name: idx.options.name, returned_name: returnedName });
      } catch (e) {
        errors.push({
          name: idx.options.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    let current: CurrentIndex[] = [];
    try {
      const indexes = await col.listIndexes().toArray();
      current = indexes.map((i) => ({
        name: String(i.name ?? ""),
        key: (i.key ?? {}) as Record<string, unknown>,
        unique: i.unique === true ? true : undefined,
        partialFilterExpression: i.partialFilterExpression as
          | Record<string, unknown>
          | undefined,
      }));
    } catch {
      /* collection が存在しない場合 (通常 createIndex で自動作成されるため無視) */
    }

    results.push({
      collection: def.collection,
      applied,
      errors,
      current_indexes: current,
    });
  }

  const summary = {
    generated_at: new Date().toISOString(),
    note: "Temporary admin endpoint — remove after verification.",
    total_applied: results.reduce((s, r) => s + r.applied.length, 0),
    total_errors: results.reduce((s, r) => s + r.errors.length, 0),
    results,
  };

  console.log(
    "[init-event-triggered-indexes] applied=%d errors=%d",
    summary.total_applied,
    summary.total_errors
  );

  return NextResponse.json(summary);
}
