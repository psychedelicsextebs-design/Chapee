import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 * Sync 停止 RCA。tokens + webhook 到達 + sync 対象会話の状態を一括で取る。
 */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TOKEN =
  "Z7wK9pR4tYnQ2vLbH5jFmC8dE1sA0uT6yPo3iBnPgCvXhQrMkWlOpZaSbUcVdKeX";
const HOUR = 3600_000;

function iso(d?: Date | null): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toISOString()
    : null;
}
function ageHours(d: Date | null | undefined, now: number): number | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return Math.round(((now - d.getTime()) / HOUR) * 10) / 10;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const stepsDone: string[] = [];
  try {
    return await runDiag(stepsDone);
  } catch (e) {
    return NextResponse.json(
      {
        error: "diag crashed",
        crashed_at: stepsDone[stepsDone.length - 1] ?? "<none>",
        steps_done: stepsDone,
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}

async function runDiag(stepsDone: string[]) {
  const now = new Date();
  const nowMs = now.getTime();

  // 1) tokens: 現在の状態
  stepsDone.push("tokens");
  const tokenCol = await getCollection<{
    shop_id: number;
    country?: string;
    shop_name?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: Date;
    updated_at?: Date;
    created_at?: Date;
  }>("shopee_tokens");
  const tokens = await tokenCol.find({}).toArray();
  const tokensStatus = tokens.map((t) => ({
    shop_id: t.shop_id,
    country: t.country ?? null,
    shop_name: t.shop_name ?? null,
    updated_at: iso(t.updated_at ?? null),
    updated_age_hours: ageHours(t.updated_at ?? null, nowMs),
    updated_age_days:
      t.updated_at
        ? Math.round(((nowMs - t.updated_at.getTime()) / (24 * HOUR)) * 10) / 10
        : null,
    created_at: iso(t.created_at ?? null),
    expires_at: iso(t.expires_at ?? null),
    expires_in_hours: t.expires_at
      ? Math.round(((t.expires_at.getTime() - nowMs) / HOUR) * 10) / 10
      : null,
    expired: t.expires_at ? t.expires_at.getTime() <= nowMs : null,
    access_token_len: t.access_token?.length ?? 0,
    refresh_token_len: t.refresh_token?.length ?? 0,
  }));

  // 2) webhook_observation_log: Shopee が push してきているか (最新10件)
  stepsDone.push("webhook_observation_log");
  let webhookRecent: Array<{
    received_at: string | null;
    code: number | null;
    shop_id: number | null;
    note: string | null;
    age_hours: number | null;
  }> = [];
  let webhookTotal = 0;
  try {
    const obsCol = await getCollection<{
      received_at?: Date;
      code?: number;
      shop_id?: number;
      note?: string;
    }>("webhook_observation_log");
    webhookTotal = await obsCol.countDocuments({});
    const rows = await obsCol
      .find({})
      .sort({ received_at: -1 })
      .limit(10)
      .toArray();
    webhookRecent = rows.map((r) => ({
      received_at: iso(r.received_at ?? null),
      code: r.code ?? null,
      shop_id: r.shop_id ?? null,
      note: r.note ?? null,
      age_hours: ageHours(r.received_at ?? null, nowMs),
    }));
  } catch {
    // collection may not exist
  }

  // 3) shopee_conversations: 最新の last_message_time と件数
  stepsDone.push("conversations");
  const convCol = await getCollection<{
    conversation_id: string;
    shop_id: number;
    last_message_time?: Date | null;
    updated_at?: Date | null;
  }>("shopee_conversations");
  const convTotal = await convCol.countDocuments({});
  const perShopRaw = await convCol
    .aggregate<{
      _id: number;
      total: number;
      newest_lmt: Date | null;
      newest_updated_at: Date | null;
    }>([
      {
        $group: {
          _id: "$shop_id",
          total: { $sum: 1 },
          newest_lmt: { $max: "$last_message_time" },
          newest_updated_at: { $max: "$updated_at" },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const perShop = perShopRaw.map((r) => ({
    shop_id: r._id,
    total: r.total,
    newest_last_message_time: iso(r.newest_lmt),
    newest_lmt_age_days: r.newest_lmt
      ? Math.round(((nowMs - r.newest_lmt.getTime()) / (24 * HOUR)) * 10) / 10
      : null,
    newest_updated_at: iso(r.newest_updated_at),
    newest_updated_age_days: r.newest_updated_at
      ? Math.round(((nowMs - r.newest_updated_at.getTime()) / (24 * HOUR)) * 10) / 10
      : null,
  }));

  // 4) sync_snapshot: sync が最後にいつ書いたか
  stepsDone.push("sync_snapshot");
  let syncSnapshot: unknown = null;
  try {
    const snapCol = await getCollection<{
      _id: string;
      shop_id?: number;
      last_synced_at?: Date;
      notification_ids?: string[];
      updated_at?: Date;
    }>("sync_snapshots");
    const snaps = await snapCol.find({}).limit(10).toArray();
    syncSnapshot = snaps.map((s) => ({
      _id: s._id,
      shop_id: s.shop_id ?? null,
      last_synced_at: iso(s.last_synced_at ?? null),
      last_synced_age_hours: ageHours(s.last_synced_at ?? null, nowMs),
      notification_ids_len: s.notification_ids?.length ?? 0,
      updated_at: iso(s.updated_at ?? null),
    }));
  } catch {
    syncSnapshot = { note: "collection missing or error" };
  }

  // 5) settings と env の間接確認 (SHOPEE_REDIRECT_URL が生成URLに正しく入るかは既に外側で確認済)
  stepsDone.push("env indirect");
  const envIndirect = {
    partner_id_configured: !!process.env.SHOPEE_PARTNER_ID,
    partner_key_configured: !!process.env.SHOPEE_PARTNER_KEY,
    redirect_url_configured: !!process.env.SHOPEE_REDIRECT_URL,
    redirect_url_value:
      process.env.SHOPEE_REDIRECT_URL?.replace(/[^\/]+\/\//, "$&") ?? null, // 出力の安全: 単に値を出す
    mongodb_db: process.env.MONGODB_DB ?? null,
  };

  return NextResponse.json({
    _note: "temporary sync-state diag; will be removed",
    now: now.toISOString(),
    tokens_status: tokensStatus,
    webhook_observation_log: {
      total_count: webhookTotal,
      recent_10: webhookRecent,
    },
    conversations: {
      total: convTotal,
      per_shop: perShop,
    },
    sync_snapshots: syncSnapshot,
    env_indirect: envIndirect,
  });
}
