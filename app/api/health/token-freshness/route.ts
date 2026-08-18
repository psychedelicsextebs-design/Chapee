import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * GET /api/health/token-freshness
 *
 * Shopee token の健全性を **外部監視** から確認するための無認証エンドポイント。
 * UptimeRobot / cron-job.org 等の HTTP 監視サービスから叩く前提。
 *
 * 判定:
 *   - shopee_tokens.updated_at が N 日以上前の shop があれば HTTP 500
 *   - 正常なら HTTP 200
 *   - Mongo 障害も HTTP 500 (外部監視が Mongo ダウンも検知できる)
 *   - N は env TOKEN_STALE_ALERT_DAYS (未設定なら 40)
 *
 * 【返さない情報】
 *   access_token / refresh_token / partner_key は projection で除外。
 *   返すのは shop_id / country / shop_name / days_since_update / stale フラグのみ。
 *
 * 【副作用】
 *   完全 read-only。 Shopee API は呼ばない。 **外部通知 (Chatwork 等) は行わない**
 *   (UI 警告と外部監視の 2 経路で気づける設計)。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_STALE_DAYS = 40;

type ShopeeTokenRow = {
  shop_id: number;
  country?: string;
  shop_name?: string;
  updated_at?: Date;
};

export async function GET(_request: NextRequest) {
  const staleDaysRaw = Number(
    process.env.TOKEN_STALE_ALERT_DAYS ?? DEFAULT_STALE_DAYS
  );
  const staleDays =
    Number.isFinite(staleDaysRaw) && staleDaysRaw > 0
      ? Math.floor(staleDaysRaw)
      : DEFAULT_STALE_DAYS;
  const nowMs = Date.now();
  const staleCutoffMs = staleDays * 24 * 60 * 60 * 1000;

  try {
    const col = await getCollection<ShopeeTokenRow>("shopee_tokens");
    const rows = await col
      .find(
        {},
        {
          projection: {
            shop_id: 1,
            country: 1,
            shop_name: 1,
            updated_at: 1,
            _id: 0,
          },
        }
      )
      .toArray();

    const shops = rows.map((row) => {
      const updatedAt = row.updated_at instanceof Date ? row.updated_at : null;
      const ageMs = updatedAt ? nowMs - updatedAt.getTime() : Infinity;
      const daysSince = updatedAt
        ? Math.floor(ageMs / (24 * 60 * 60 * 1000))
        : null;
      const stale = ageMs >= staleCutoffMs;
      return {
        shop_id: row.shop_id,
        country: row.country ?? null,
        shop_name: row.shop_name ?? null,
        days_since_update: daysSince,
        stale,
      };
    });

    const staleShops = shops.filter((s) => s.stale);
    if (staleShops.length > 0) {
      return NextResponse.json(
        {
          status: "stale",
          stale_days_threshold: staleDays,
          checked_at: new Date().toISOString(),
          shops,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        status: "ok",
        stale_days_threshold: staleDays,
        checked_at: new Date().toISOString(),
        shops,
      },
      { status: 200 }
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[health/token-freshness]", errMsg);
    return NextResponse.json(
      {
        status: "error",
        stale_days_threshold: staleDays,
        checked_at: new Date().toISOString(),
        error: errMsg,
      },
      { status: 500 }
    );
  }
}
