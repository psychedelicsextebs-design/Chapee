import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { refreshAccessToken } from "@/lib/shopee-api";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 *
 * STEP 3-DIAG: refresh_token 生死検証 (DB 書込なし)。
 * - shopee_tokens を全フィールドマスク出力
 * - refreshAccessToken を dry-run 呼び出し (Shopee API に refresh 要求するが、
 *   結果を DB に **書き込まない**)。 生きていれば全 UI 認可を回避可能。
 * URL token 保護。 次 commit で削除。
 */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TOKEN =
  "L9nP3rQ7vX2wKj5tHfB4mC8dY6aE1sD0uG9zNoIpTqSbUcVdKeXfLwHrJcMnPqRs";

function iso(d?: Date | null): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toISOString()
    : null;
}

function mask(v?: string | null): {
  present: boolean;
  length: number;
  head4: string | null;
  tail4: string | null;
} {
  if (!v || typeof v !== "string" || v.length === 0)
    return { present: false, length: 0, head4: null, tail4: null };
  return {
    present: true,
    length: v.length,
    head4: v.slice(0, 4),
    tail4: v.slice(-4),
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    const col = await getCollection<{
      shop_id: number;
      country?: string;
      shop_name?: string;
      access_token?: string;
      refresh_token?: string;
      expires_at?: Date;
      created_at?: Date;
      updated_at?: Date;
    }>("shopee_tokens");

    const docs = await col.find({}).toArray();
    const results: Array<Record<string, unknown>> = [];

    for (const t of docs) {
      const snap = {
        shop_id: t.shop_id,
        country: t.country ?? null,
        shop_name: t.shop_name ?? null,
        access_token_masked: mask(t.access_token ?? null),
        refresh_token_masked: mask(t.refresh_token ?? null),
        expires_at: iso(t.expires_at ?? null),
        access_token_expired: t.expires_at
          ? t.expires_at.getTime() <= now.getTime()
          : null,
        created_at: iso(t.created_at ?? null),
        updated_at: iso(t.updated_at ?? null),
        updated_age_days: t.updated_at
          ? Math.round(
              ((now.getTime() - t.updated_at.getTime()) /
                (24 * 3600_000)) *
                10
            ) / 10
          : null,
      };

      // === DRY-RUN refresh (Shopee API 呼び出しのみ、DB 書込は絶対にしない) ===
      let refreshResult: Record<string, unknown>;
      if (!t.refresh_token) {
        refreshResult = {
          attempted: false,
          reason: "refresh_token not present",
        };
      } else {
        try {
          const country = t.country?.trim() || undefined;
          const newTok = await refreshAccessToken(
            t.refresh_token,
            t.shop_id,
            country ? { country } : undefined
          );
          // ⚠ 意図的に updateOne しない (dry-run)
          refreshResult = {
            attempted: true,
            success: true,
            new_access_token_masked: mask(newTok.access_token),
            new_refresh_token_masked: mask(newTok.refresh_token),
            new_expire_in_seconds: newTok.expire_in,
            note: "DB not written (dry-run)",
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          refreshResult = {
            attempted: true,
            success: false,
            error_message: msg,
          };
        }
      }

      results.push({ snapshot: snap, refresh_dry_run: refreshResult });
    }

    return NextResponse.json({
      _note:
        "temporary token-liveness diag (dry-run refresh, NO DB write). will be removed.",
      now: now.toISOString(),
      shops: results,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
