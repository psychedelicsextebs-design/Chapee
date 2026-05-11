import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  getOrderList,
  getOrderDetail,
  SHOPEE_ORDER_LIST_MAX_RANGE_SEC,
} from "@/lib/shopee-api";
import { getValidToken, resolveCountryForShop } from "@/lib/shopee-token";

/**
 * GET /api/buyers/search — バイヤー検索 (注文ID or バイヤー名)
 *
 * クエリ:
 *   - shop_id (任意): 検索対象の Shopee shop ID。省略時は連携済み全 shop に並列検索
 *   - q       (任意): 検索文字列。order_sn と buyer_username の両方を OR 部分一致 (大小無視)
 *   - days    (任意): 過去 N 日 (default 30, max 90)
 *
 * 設計メモ:
 *   - shop_id 省略時は shopee_tokens から連携済み shop を取り、 100ms 間隔で並列検索
 *     (Promise.allSettled — 一部失敗は全体を止めない)
 *   - in-process キャッシュ TTL 60 秒、 キー `${shop_id}:${q}:${days}`
 *   - 結果は order_create_time 降順
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const ORDER_DETAIL_BATCH_SIZE = 50; // Shopee 仕様上限
const SHOP_FANOUT_DELAY_MS = 100;
const CACHE_TTL_MS = 60 * 1000;

type ShopeeListResponse = {
  response?: { order_list?: Array<{ order_sn?: string }> };
  order_list?: Array<{ order_sn?: string }>;
};

type ShopeeDetailResponse = {
  response?: { order_list?: Array<Record<string, unknown>> };
  order_list?: Array<Record<string, unknown>>;
};

export type BuyerSearchResult = {
  shop_id: number;
  buyer_user_id: number;
  buyer_username: string;
  order_sn: string;
  order_create_time: string; // ISO
  item_preview: string;
  currency: string;
  total_amount: number;
  has_conversation: boolean;
  conversation_id: string | null;
};

// ===== in-process cache =====
type CacheEntry = { expiresAt: number; results: BuyerSearchResult[] };
const searchCache = new Map<string, CacheEntry>();

function cacheKey(shopId: number, q: string, days: number): string {
  return `${shopId}:${q}:${days}`;
}

function getCached(key: string): BuyerSearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

function setCached(key: string, results: BuyerSearchResult[]): void {
  searchCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, results });
}

/** テスト用にキャッシュをクリア */
export function __clearBuyerSearchCacheForTest(): void {
  searchCache.clear();
}

// ===== 単一 shop 検索 =====
async function searchOneShop(
  shopId: number,
  q: string,
  days: number,
): Promise<BuyerSearchResult[]> {
  const key = cacheKey(shopId, q, days);
  const cached = getCached(key);
  if (cached) return cached;

  const accessToken = await getValidToken(shopId);
  const country = await resolveCountryForShop(shopId);

  // ===== Order list を 15 日窓で収集 =====
  const now = Math.floor(Date.now() / 1000);
  const lookbackSec = days * 24 * 60 * 60;
  const windowCount = Math.ceil(lookbackSec / SHOPEE_ORDER_LIST_MAX_RANGE_SEC);
  const orderSns = new Set<string>();

  for (let w = 0; w < windowCount; w++) {
    const timeTo = now - w * SHOPEE_ORDER_LIST_MAX_RANGE_SEC;
    const timeFrom = Math.max(
      now - lookbackSec,
      timeTo - SHOPEE_ORDER_LIST_MAX_RANGE_SEC,
    );
    if (timeFrom >= timeTo) break;

    try {
      const listRes = (await getOrderList(
        accessToken,
        shopId,
        {
          time_range_field: "create_time",
          time_from: timeFrom,
          time_to: timeTo,
          page_size: 100,
        },
        { country },
      )) as ShopeeListResponse;
      const orders =
        listRes.response?.order_list ?? listRes.order_list ?? [];
      for (const o of orders) {
        if (o.order_sn) orderSns.add(o.order_sn);
      }
    } catch (e) {
      console.warn(
        `[buyers/search] getOrderList window ${w} failed shop=${shopId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ===== Order detail を 50 件 batch で取得 =====
  const allSns = Array.from(orderSns);
  const detailList: Array<Record<string, unknown>> = [];
  for (let i = 0; i < allSns.length; i += ORDER_DETAIL_BATCH_SIZE) {
    const batch = allSns.slice(i, i + ORDER_DETAIL_BATCH_SIZE);
    try {
      const detailRes = (await getOrderDetail(
        accessToken,
        shopId,
        batch,
        [
          "buyer_user_id",
          "buyer_username",
          "item_list",
          "create_time",
          "currency",
          "total_amount",
        ],
        { country },
      )) as ShopeeDetailResponse;
      const list = detailRes.response?.order_list ?? detailRes.order_list ?? [];
      detailList.push(...list);
    } catch (e) {
      console.warn(
        `[buyers/search] getOrderDetail batch ${i} failed shop=${shopId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ===== q で filter (order_sn と buyer_username の OR 部分一致、 大小無視) =====
  // 注: order_sn は英数字混在 (例: "26051154AEC7M7") のため数字判定で分岐するのは NG。常に両方 OR。
  const qLower = q.toLowerCase();

  const filteredOrders = detailList.filter((o) => {
    if (q.length === 0) return true;
    const sn = String(o.order_sn ?? "").toLowerCase();
    const buyerName = String(o.buyer_username ?? "").toLowerCase();
    return sn.includes(qLower) || buyerName.includes(qLower);
  });

  // ===== shopee_conversations 突合 =====
  const buyerIds = new Set<number>();
  for (const o of filteredOrders) {
    const buyerId = Number(o.buyer_user_id ?? 0);
    if (buyerId > 0) buyerIds.add(buyerId);
  }

  const convMap = new Map<number, string>();
  if (buyerIds.size > 0) {
    const convCol = await getCollection<{
      conversation_id: string;
      shop_id: number;
      customer_id: number;
    }>("shopee_conversations");
    const convs = await convCol
      .find({ shop_id: shopId, customer_id: { $in: Array.from(buyerIds) } })
      .project<{ conversation_id: string; customer_id: number }>({
        conversation_id: 1,
        customer_id: 1,
        _id: 0,
      })
      .toArray();
    for (const c of convs) convMap.set(c.customer_id, c.conversation_id);
  }

  // ===== 結果を整形 =====
  const buyers: BuyerSearchResult[] = filteredOrders.map((o) => {
    const buyerId = Number(o.buyer_user_id ?? 0);
    const items = Array.isArray(o.item_list)
      ? (o.item_list as Array<Record<string, unknown>>)
      : [];
    const first = items[0];
    const firstName = first
      ? String(first.item_name ?? first.model_name ?? "")
      : "";
    const preview =
      firstName +
      (items.length > 1 ? ` 他 ${items.length - 1} 点` : "");
    const createTime = Number(o.create_time ?? 0);
    const totalRaw = o.total_amount;
    const total =
      typeof totalRaw === "number"
        ? totalRaw
        : typeof totalRaw === "string"
          ? parseFloat(totalRaw)
          : 0;
    const conversationId = convMap.get(buyerId) ?? null;

    return {
      shop_id: shopId,
      buyer_user_id: buyerId,
      buyer_username: String(o.buyer_username ?? ""),
      order_sn: String(o.order_sn ?? ""),
      order_create_time:
        createTime > 0 ? new Date(createTime * 1000).toISOString() : "",
      item_preview: preview,
      currency: String(o.currency ?? ""),
      total_amount: Number.isFinite(total) ? total : 0,
      has_conversation: conversationId !== null,
      conversation_id: conversationId,
    };
  });

  setCached(key, buyers);
  return buyers;
}

// ===== 連携済み shop_id 一覧 =====
async function listConnectedShopIds(): Promise<number[]> {
  const col = await getCollection<{ shop_id: number }>("shopee_tokens");
  const rows = await col
    .find({})
    .project<{ shop_id: number }>({ shop_id: 1, _id: 0 })
    .toArray();
  const ids = new Set<number>();
  for (const r of rows) {
    if (typeof r.shop_id === "number" && r.shop_id > 0) {
      ids.add(r.shop_id);
    }
  }
  return Array.from(ids);
}

// ===== 全 shop 並列検索 =====
async function searchAllShops(
  q: string,
  days: number,
): Promise<BuyerSearchResult[]> {
  const shopIds = await listConnectedShopIds();
  if (shopIds.length === 0) return [];

  // 100ms 間隔で並列起動 (allSettled で一部失敗は無視)
  const promises = shopIds.map(
    (shopId, idx) =>
      new Promise<BuyerSearchResult[]>((resolve) => {
        setTimeout(() => {
          searchOneShop(shopId, q, days)
            .then(resolve)
            .catch((e) => {
              console.warn(
                `[buyers/search] shop ${shopId} failed:`,
                e instanceof Error ? e.message : e,
              );
              resolve([]);
            });
        }, idx * SHOP_FANOUT_DELAY_MS);
      }),
  );

  const settled = await Promise.allSettled(promises);
  const all: BuyerSearchResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  return all;
}

// ===== Route handler =====
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const shopIdStr = url.searchParams.get("shop_id");
    const q = (url.searchParams.get("q") ?? "").trim();
    const daysStr = url.searchParams.get("days");

    let days = daysStr ? Number(daysStr) : DEFAULT_DAYS;
    if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
    if (days > MAX_DAYS) days = MAX_DAYS;

    let buyers: BuyerSearchResult[];

    if (shopIdStr) {
      const shopId = Number(shopIdStr);
      if (!Number.isFinite(shopId) || shopId <= 0) {
        return NextResponse.json(
          { error: "shop_id が不正です" },
          { status: 400 },
        );
      }
      buyers = await searchOneShop(shopId, q, days);
    } else {
      // shop_id 省略 → 連携済み全 shop に並列検索 (国フィルタ無視)
      buyers = await searchAllShops(q, days);
    }

    // 注文日時降順
    buyers.sort((a, b) =>
      b.order_create_time.localeCompare(a.order_create_time),
    );

    return NextResponse.json({ buyers });
  } catch (e) {
    console.error("[buyers/search]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "検索に失敗しました" },
      { status: 500 },
    );
  }
}
