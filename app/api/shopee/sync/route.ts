import type { AnyBulkWriteOperation } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getConversations, getShopNotification } from "@/lib/shopee-api";
import { getValidToken, getConnectedShops } from "@/lib/shopee-token";
import { getCollection } from "@/lib/mongodb";
import {
  dedupeShopNotificationItems,
  parseShopNotificationPayload,
} from "@/lib/shopee-shop-notification-parse";
import {
  buildConvLastTsMap,
  computeNewConversationActivity,
  computeNewNotificationIds,
  getSyncSnapshot,
  saveSyncSnapshot,
} from "@/lib/sync-snapshot";
import {
  extractBuyerAvatarFromShopee,
  inferChatTypeFromShopee,
  previewFromConversationListItem,
  shopeeNanoTimestampToDate,
} from "@/lib/shopee-conversation-utils";

/**
 * Phase 1 (2026-04-28): processDueAutoReplies と scheduleAutoReplyForUnread を
 * 本ルートから外した。
 *
 * 理由:
 *   - sync ボタン押下が 3 分超 / 504 timeout を起こし、ダッシュボードが事実上
 *     使えなくなっていた (Vercel Function timeout)。
 *   - 両関数はそれぞれ Shopee API への multi-page fetch を「会話 1 件あたり」
 *     行うため、 sync 1 回のコストを 50-100 倍に膨らませていた。
 *   - 役割は別経路でカバー済み:
 *       * 自動返信スケジュール    → webhook (handleNewMessage / 9606c72 で復活)
 *       * 自動返信送信            → /api/cron/auto-reply (vercel.json: 15分毎 cron)
 *   - 旧コードのコメント「Hobby は Cron 日次のみ」は stale (現在 Pro)。
 *
 * Phase 2 (2026-04-28 続編): Phase 1 だけでは依然 504 が発生したため、残った
 * ボトルネック 2 つを潰す。
 *   1. 1 shop あたり最大 1000 会話の updateOne 直列ループ
 *      → 単一 bulkWrite (unordered) に統合、1 round-trip で済ませる
 *   2. shop 毎の処理を直列 for ループ
 *      → Promise.allSettled で並列実行 (各 shop の Shopee API は独立)
 *
 * 業務影響: なし。 sync の責務(MongoDB ミラー更新)は不変、所要時間のみ短縮。
 */

type ShopConvDoc = {
  conversation_id: string;
  shop_id: number;
  country: string;
  customer_id: number;
  customer_name: string;
  customer_avatar_url?: string;
  last_message: string;
  last_message_time: Date;
  last_message_type?: string;
  chat_type?: "buyer" | "notification" | "affiliate";
  unread_count: number;
  pinned: boolean;
  status: "active" | "resolved" | "archived";
  handling_status?: "unreplied" | "replying" | "replied";
  assigned_staff?: string;
  created_at: Date;
  updated_at: Date;
};

type ShopSyncResult = {
  shop_id: number;
  country: string;
  synced?: number;
  total?: number;
  delta?: {
    new_conversation_ids: string[];
    new_notification_ids: string[];
  };
  error?: string;
};

type ShopeeConversation = {
  conversation_id: string;
  to_id: number;
  to_name: string;
  last_read_message_id: string;
  unread_count: number;
  pinned: boolean;
  last_message_timestamp: number;
  last_message_type: string;
  latest_message_type?: string;
  latest_message_content?: { text?: string } | null;
  max_general_option_list?: unknown[];
};

/**
 * Sync Shopee conversations to database
 * GET /api/shopee/sync?shop_id=123 (specific shop)
 * GET /api/shopee/sync (all shops)
 */
export async function GET(request: NextRequest) {
  try {
    console.log("[Sync] Starting conversation sync...");

    const { searchParams } = new URL(request.url);
    const shopIdParam = searchParams.get("shop_id");

    let shopsToSync: { shop_id: number; country: string }[];

    if (shopIdParam) {
      // Sync specific shop
      const shopId = parseInt(shopIdParam);
      const shops = await getConnectedShops();
      const shop = shops.find((s) => s.shop_id === shopId);
      if (!shop) {
        return NextResponse.json(
          { error: "Shop not found" },
          { status: 404 }
        );
      }
      shopsToSync = [{ shop_id: shopId, country: shop.country }];
    } else {
      // Sync all connected shops
      const shops = await getConnectedShops();
      console.log(`[Sync] Found ${shops.length} connected shops`);
      
      if (shops.length === 0) {
        return NextResponse.json({
          success: true,
          message: "No shops connected. Please connect a shop in Settings.",
          results: [],
        });
      }
      
      shopsToSync = shops.map((s) => ({
        shop_id: s.shop_id,
        country: s.country,
      }));
    }

    // Phase 2: shop 毎の処理を Promise.allSettled で並列実行
    //   - 1 shop が遅くても他 shop のレスポンスは戻る
    //   - 例外は results 配列の error フィールドに格納 (旧 try/catch と同じ挙動)
    const results: ShopSyncResult[] = await Promise.all(
      shopsToSync.map((shop) => syncOneShop(shop))
    );

    // Phase 1: processDueAutoReplies はここで呼ばない。
    // /api/cron/auto-reply (Pro: */15 * * * *) が定期実行する。
    // sync ルートは「Shopee 一覧 → MongoDB ミラー更新」だけに専念し、
    // 504 timeout を防ぐ。

    console.log("[Sync] Sync complete. Results:", results);

    return NextResponse.json({
      success: true,
      message: "Conversations synced",
      results,
    });
  } catch (error) {
    console.error("[Sync] Sync error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Sync failed",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/shopee/sync - Trigger manual sync
 */
export async function POST(request: NextRequest) {
  return GET(request);
}

/**
 * 1 shop 分の同期処理。Phase 2 で per-shop を並列実行できるよう関数化した。
 * 例外は外に投げず、 ShopSyncResult.error にして返す。
 *
 * 内訳:
 *   1. token 取得
 *   2. 会話一覧をページング取得 (Shopee API、必要な分のみ直列)
 *   3. shop_notification 取得 (delta 用、1 call)
 *   4. **bulkWrite で会話を一括 upsert**
 *      旧: 会話毎に updateOne(直列) → 1000 会話で 1000 round-trip
 *      新: 1 round-trip で全件 upsert (unordered=true、個別失敗は許容)
 *   5. saveSyncSnapshot
 */
async function syncOneShop(shop: {
  shop_id: number;
  country: string;
}): Promise<ShopSyncResult> {
  try {
    console.log(`[Sync] Syncing shop ${shop.shop_id} (${shop.country})...`);
    const accessToken = await getValidToken(shop.shop_id);
    console.log(`[Sync] Got access token for shop ${shop.shop_id}`);

    const col = await getCollection<ShopConvDoc>("shopee_conversations");

    // ---- 会話一覧をページング取得 (Shopee API は per-shop で直列、 rate limit 配慮) ----
    const allConversations: ShopeeConversation[] = [];
    let nextCursor: string | Record<string, unknown> | undefined;
    let page = 0;
    const maxPages = 40;

    do {
      const response = await getConversations(
        accessToken,
        shop.shop_id,
        {
          page_size: 25,
          direction: nextCursor ? "older" : "latest",
          next_cursor: nextCursor,
        },
        { country: shop.country }
      );

      const pageList: ShopeeConversation[] =
        response.response?.conversations ??
        response.response?.conversation_list ??
        [];

      allConversations.push(...pageList);

      const pageResult = response.response?.page_result as
        | {
            more?: boolean;
            next_cursor?: string | Record<string, unknown>;
          }
        | undefined;

      nextCursor =
        pageResult?.more && pageResult?.next_cursor
          ? pageResult.next_cursor
          : undefined;
      page++;
    } while (nextCursor && page < maxPages);

    console.log(
      `[Sync] Found ${allConversations.length} conversations for shop ${shop.shop_id} (${page} page(s))`
    );

    const prevSnapshot = await getSyncSnapshot(shop.shop_id);
    const newConversationIds = computeNewConversationActivity(
      prevSnapshot,
      allConversations
    );

    let newNotificationIds: string[] = [];
    let notifIdsForSnapshot: string[] = prevSnapshot?.notification_ids ?? [];
    try {
      const notifRaw = await getShopNotification(
        accessToken,
        shop.shop_id,
        { page_size: 25 },
        { country: shop.country }
      );
      const notifJson = {
        shop_id: shop.shop_id,
        ...(notifRaw as Record<string, unknown>),
      };
      const parsed = parseShopNotificationPayload(notifJson);
      notifIdsForSnapshot = dedupeShopNotificationItems(parsed.items).map(
        (i) => i.id
      );
      newNotificationIds = computeNewNotificationIds(
        prevSnapshot?.notification_ids,
        notifIdsForSnapshot
      );
    } catch (e) {
      console.warn(
        `[Sync] get_shop_notification for delta (shop ${shop.shop_id}):`,
        e
      );
    }

    // ---- Phase 2: 会話 upsert を bulkWrite に統合 ----
    // unordered=true: 個別 op の失敗が他を止めない (rate limit 等の局所失敗を許容)
    const now = new Date();
    const ops: AnyBulkWriteOperation<ShopConvDoc>[] = allConversations.map(
      (conv) => {
        const lastAt = shopeeNanoTimestampToDate(conv.last_message_timestamp);
        const preview = previewFromConversationListItem(conv);
        const msgType =
          conv.latest_message_type ?? conv.last_message_type ?? "";
        const chatType = inferChatTypeFromShopee({
          latest_message_type: msgType,
          to_name: conv.to_name,
        });
        const buyerAvatar = extractBuyerAvatarFromShopee(
          conv as unknown as Record<string, unknown>
        );

        return {
          updateOne: {
            filter: {
              conversation_id: String(conv.conversation_id),
              shop_id: shop.shop_id,
            },
            update: {
              $set: {
                country: shop.country,
                customer_id: conv.to_id,
                customer_name: conv.to_name,
                ...(buyerAvatar ? { customer_avatar_url: buyerAvatar } : {}),
                last_message: preview,
                last_message_time: lastAt,
                last_message_type: msgType,
                chat_type: chatType,
                unread_count: conv.unread_count,
                pinned: conv.pinned,
                status: conv.unread_count > 0 ? "active" : "resolved",
                ...(conv.unread_count > 0
                  ? { handling_status: "unreplied" as const }
                  : {}),
                updated_at: now,
              },
              $setOnInsert: {
                conversation_id: String(conv.conversation_id),
                shop_id: shop.shop_id,
                created_at: now,
              },
            },
            upsert: true,
          },
        };
      }
    );

    let synced = 0;
    if (ops.length > 0) {
      const bulkRes = await col.bulkWrite(ops, { ordered: false });
      // Mongo 4+: matchedCount + upsertedCount で「実際に書いた件数」を出す
      synced =
        (bulkRes.matchedCount ?? 0) + (bulkRes.upsertedCount ?? 0);
    }
    console.log(
      `[Sync] Synced ${synced}/${ops.length} conversations to database (bulkWrite)`
    );

    try {
      await saveSyncSnapshot(
        shop.shop_id,
        buildConvLastTsMap(allConversations),
        notifIdsForSnapshot
      );
    } catch (e) {
      console.warn(`[Sync] save snapshot shop ${shop.shop_id}:`, e);
    }

    return {
      shop_id: shop.shop_id,
      country: shop.country,
      synced,
      total: allConversations.length,
      delta: {
        new_conversation_ids: newConversationIds,
        new_notification_ids: newNotificationIds,
      },
    };
  } catch (error) {
    console.error(`[Sync] Failed to sync shop ${shop.shop_id}:`, error);
    return {
      shop_id: shop.shop_id,
      country: shop.country,
      error: error instanceof Error ? error.message : "Sync failed",
    };
  }
}
