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
 *   - shop_id (必須): 検索対象の Shopee shop ID
 *   - q       (任意): 検索文字列。 全数字なら order_sn 部分一致、
 *                     文字列なら buyer_username 部分一致 (大小無視)、 空なら期間内全件
 *   - days    (任意): 過去 N 日 (default 30, max 90)
 *
 * フロー:
 *   1. shop_id の access_token / country を解決
 *   2. getOrderList を 15 日窓で連結して期間内 order_sn を収集
 *   3. getOrderDetail (50 sn batch) で buyer_user_id / buyer_username / item_list 等取得
 *   4. q で filter
 *   5. shopee_conversations と突合して has_conversation + conversation_id を付与
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const ORDER_DETAIL_BATCH_SIZE = 50; // Shopee 仕様上限

type ShopeeListResponse = {
  response?: { order_list?: Array<{ order_sn?: string }> };
  order_list?: Array<{ order_sn?: string }>;
};

type ShopeeDetailResponse = {
  response?: { order_list?: Array<Record<string, unknown>> };
  order_list?: Array<Record<string, unknown>>;
};

export type BuyerSearchResult = {
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

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const shopIdStr = url.searchParams.get("shop_id");
    const q = (url.searchParams.get("q") ?? "").trim();
    const daysStr = url.searchParams.get("days");

    const shopId = Number(shopIdStr);
    if (!shopIdStr || !Number.isFinite(shopId) || shopId <= 0) {
      return NextResponse.json(
        { error: "shop_id が必要です" },
        { status: 400 },
      );
    }

    let days = daysStr ? Number(daysStr) : DEFAULT_DAYS;
    if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
    if (days > MAX_DAYS) days = MAX_DAYS;

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

    // ===== q で filter =====
    const qIsDigits = q.length > 0 && /^[0-9]+$/.test(q);
    const qLower = q.toLowerCase();

    const filteredOrders = detailList.filter((o) => {
      if (q.length === 0) return true;
      const sn = String(o.order_sn ?? "");
      const buyerName = String(o.buyer_username ?? "");
      if (qIsDigits) {
        return sn.includes(q);
      }
      return buyerName.toLowerCase().includes(qLower);
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
