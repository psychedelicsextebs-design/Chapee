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
 */

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

    const results = [];

    for (const shop of shopsToSync) {
      try {
        console.log(`[Sync] Syncing shop ${shop.shop_id} (${shop.country})...`);
        const accessToken = await getValidToken(shop.shop_id);
        console.log(`[Sync] Got access token for shop ${shop.shop_id}`);

        const col = await getCollection<{
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
          assigned_staff?: string;
          created_at: Date;
          updated_at: Date;
        }>("shopee_conversations");

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
            {
              page_size: 25,
            },
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

        let synced = 0;
        // Phase 1: autoReplyCandidateIds 収集を廃止
        //   scheduleAutoReplyForUnread を sync ルートから外したため不要。
        //   webhook (handleNewMessage) が会話毎に reviewAutoReplySchedule を回し、
        //   さらに /api/cron/auto-reply の processDueAutoReplies が pre-send guard
        //   で最終チェックする 2 段構えのままで網羅できる。

        for (const conv of allConversations) {
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

          await col.updateOne(
            {
              conversation_id: String(conv.conversation_id),
              shop_id: shop.shop_id,
            },
            {
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
                updated_at: new Date(),
              },
              $setOnInsert: {
                conversation_id: String(conv.conversation_id),
                shop_id: shop.shop_id,
                created_at: new Date(),
              },
            },
            { upsert: true }
          );
          synced++;
        }

        console.log(`[Sync] Synced ${synced} conversations to database`);

        try {
          await saveSyncSnapshot(
            shop.shop_id,
            buildConvLastTsMap(allConversations),
            notifIdsForSnapshot
          );
        } catch (e) {
          console.warn(`[Sync] save snapshot shop ${shop.shop_id}:`, e);
        }

        results.push({
          shop_id: shop.shop_id,
          country: shop.country,
          synced,
          total: allConversations.length,
          delta: {
            new_conversation_ids: newConversationIds,
            new_notification_ids: newNotificationIds,
          },
        });
      } catch (error) {
        console.error(`[Sync] Failed to sync shop ${shop.shop_id}:`, error);
        results.push({
          shop_id: shop.shop_id,
          country: shop.country,
          error: error instanceof Error ? error.message : "Sync failed",
        });
      }
    }

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
