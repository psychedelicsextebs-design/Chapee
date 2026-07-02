import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * ⚠ TEMPORARY / TO BE DELETED
 * Shopee 再接続の効果確認用。 shopee_tokens.updated_at を per-shop で返す。
 */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TOKEN =
  "M2xQ7pW9vLb5hF3jN8kR4tYcE1oD6uA0zGiSoIpTqBnPa2rSs4uVvXwYy0zZAcCe";

function iso(d?: Date | null): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toISOString()
    : null;
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
      access_token?: string;
      refresh_token?: string;
      expires_at?: Date;
      updated_at?: Date;
      created_at?: Date;
    }>("shopee_tokens");
    const docs = await col.find({}).toArray();
    const rows = docs.map((t) => ({
      shop_id: t.shop_id,
      country: t.country ?? null,
      has_access_token: !!t.access_token,
      access_token_len: t.access_token?.length ?? 0,
      has_refresh_token: !!t.refresh_token,
      refresh_token_len: t.refresh_token?.length ?? 0,
      access_token_expires_at: iso(t.expires_at ?? null),
      access_token_expires_in_hours: t.expires_at
        ? Math.round(
            ((t.expires_at.getTime() - now.getTime()) / 3600_000) * 10
          ) / 10
        : null,
      access_token_expired: t.expires_at
        ? t.expires_at.getTime() <= now.getTime()
        : null,
      updated_at: iso(t.updated_at ?? null),
      updated_age_hours: t.updated_at
        ? Math.round(
            ((now.getTime() - t.updated_at.getTime()) / 3600_000) * 10
          ) / 10
        : null,
      created_at: iso(t.created_at ?? null),
    }));
    return NextResponse.json({
      _note: "temp diag; will be removed",
      now: now.toISOString(),
      shops: rows,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
