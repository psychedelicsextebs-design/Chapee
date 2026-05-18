import { getCollection } from "@/lib/mongodb";
import { refreshAccessToken } from "./shopee-api";

/**
 * Shopee access_token の TTL は約 4 時間 (14,400 秒)。 Vercel cron は 15 分
 * 間隔で /api/cron/auto-reply を叩く ([vercel.json](../../vercel.json)) ため、
 * cron 2 tick 分の余裕を残して 30 分前に refresh する。
 *
 * 旧値は 24h で、 これだと毎回の cron で必ず refresh が走り Shopee API を
 * 浪費していた (2026-05-18 観察 — auto-reply cron で 5 件処理に対し
 * 12 秒以上を refresh ループが消費)。
 */
const REFRESH_BUFFER_MS = 30 * 60 * 1000;

/**
 * Get valid access token for a shop, refreshing if needed
 */
export async function getValidToken(shopId: number): Promise<string> {
  const col = await getCollection<{
    shop_id: number;
    country?: string;
    access_token: string;
    refresh_token: string;
    expires_at: Date;
  }>("shopee_tokens");

  const token = await col.findOne({ shop_id: shopId });

  if (!token) {
    console.error(`[Token] Shop ${shopId} not connected in database`);
    throw new Error(`Shop ${shopId} not connected`);
  }

  const countryOpt =
    token.country != null && String(token.country).trim() !== ""
      ? { country: String(token.country) }
      : undefined;

  console.log(`[Token] Found token for shop ${shopId}`);
  console.log(`[Token] Expires at: ${token.expires_at}`);
  console.log(`[Token] Current time: ${new Date()}`);

  const expiresIn = token.expires_at.getTime() - Date.now();

  console.log(`[Token] Expires in: ${Math.floor(expiresIn / 1000 / 60)} minutes`);

  if (expiresIn < REFRESH_BUFFER_MS) {
    console.log(`[Token] Token expiring soon, refreshing for shop ${shopId}...`);
    
    // Refresh token
    const newToken = await refreshAccessToken(
      token.refresh_token,
      shopId,
      countryOpt
    );
    
    await col.updateOne(
      { shop_id: shopId },
      {
        $set: {
          access_token: newToken.access_token,
          refresh_token: newToken.refresh_token,
          expires_at: new Date(Date.now() + newToken.expire_in * 1000),
          updated_at: new Date(),
        },
      }
    );
    
    console.log(`[Token] Successfully refreshed token for shop ${shopId}`);
    return newToken.access_token;
  }

  console.log(`[Token] Using existing token for shop ${shopId}`);
  return token.access_token;
}

/**
 * Get all connected shops
 */
export async function getConnectedShops() {
  const col = await getCollection<{
    shop_id: number;
    shop_name?: string;
    country: string;
    access_token: string;
    refresh_token: string;
    expires_at: Date;
  }>("shopee_tokens");

  return await col.find({}).toArray();
}

/** `shopee_tokens` に保存された店舗のマーケット（OAuth / get_shop_info で設定） */
export async function getShopCountry(
  shopId: number
): Promise<string | null> {
  const col = await getCollection<{ shop_id: number; country: string }>(
    "shopee_tokens"
  );
  const row = await col.findOne({ shop_id: shopId });
  return row?.country ? String(row.country).trim().toUpperCase() : null;
}

/**
 * 会話ドキュメントに `country` が無い旧データでも、トークンから MY 等を復元する。
 */
export async function resolveCountryForShop(
  shopId: number,
  conversationCountry?: string | null
): Promise<string> {
  const c = conversationCountry?.trim();
  if (c) return c.toUpperCase();
  return (await getShopCountry(shopId)) ?? "SG";
}

/**
 * Refresh all tokens that are expiring soon (background job)
 */
export async function refreshAllExpiringTokens() {
  const shops = await getConnectedShops();
  const now = Date.now();

  const results = [];

  for (const shop of shops) {
    const expiresIn = shop.expires_at.getTime() - now;

    if (expiresIn < REFRESH_BUFFER_MS) {
      try {
        await getValidToken(shop.shop_id);
        results.push({ shop_id: shop.shop_id, status: "refreshed" });
      } catch (error) {
        console.error(`Failed to refresh token for shop ${shop.shop_id}:`, error);
        results.push({
          shop_id: shop.shop_id,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    } else {
      results.push({ shop_id: shop.shop_id, status: "valid" });
    }
  }

  return results;
}
