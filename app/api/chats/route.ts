import type { Filter } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { lastStaffKindFromLog } from "@/lib/staff-message-kind";
import {
  type HandlingStatus,
  isHandlingStatus,
  resolveHandlingStatus,
} from "@/lib/handling-status";

type ChatType = "buyer" | "notification" | "affiliate";

/**
 * 結果ベース検知 (stall detection, 2026-09-21):
 *
 * 「買い手の未返信メッセージが N 時間経過しており、 自動返信も人間の返信も
 *  無い」会話を、 原因を問わず警告対象にする。 auto-reply の内部ロジック
 *  (classifyShopeeMessageSender / pending / gave_up_at) には一切依存しない
 *  独立判定 — 分類のバグで警告まで黙らないための最終防衛層。
 *
 * 閾値 10h の根拠:
 *   - Shopee ペナルティ = 12h。 それより 2h 前に警告する。
 *   - SG triggerHour (8h): 10h = 8h + 2h → 自動返信が発火するはずの時刻から
 *     2h 経過しても届いていない状態を検知。
 *   - MY triggerHour (11h/9h): 10h = triggerHour 直前〜1h 経過。 自動返信の
 *     発火予定より前 (or 直後) に検知できる。
 *   - 固定値でハードコード: auto-reply 設定 (auto_reply_settings) に依存しない
 *     ことで、 設定破壊 / 無効化された場合も警告が消えない。
 *
 * 判定入力 (いずれも classifyShopeeMessageSender と独立):
 *   - handling_status === "unreplied" (resolveHandlingStatus 経由、 unread_count
 *     と last_buyer_message_time > last_message_time の照合のみ)
 *   - elapsed = now - (last_buyer_message_time ?? last_message_time)
 */
export const STALL_WARNING_HOURS = 10;

/**
 * GET /api/chats — conversations synced from Shopee (`shopee_conversations` in MongoDB)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const country = searchParams.get("country");
    const status = searchParams.get("status");
    const type = searchParams.get("type");
    const excludeChatTypesRaw = searchParams.get("exclude_chat_types");
    const searchQuery = searchParams.get("search")?.trim() ?? "";
    const handlingParam = searchParams.get("handling")?.trim() ?? "";
    const unreadOnly =
      searchParams.get("unread_only") === "1" ||
      searchParams.get("unread_only") === "true";

    const limitRaw = parseInt(searchParams.get("limit") ?? "500", 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 500));

    const col = await getCollection<{
      conversation_id: string;
      shop_id: number;
      country: string;
      customer_id: number;
      customer_name: string;
      last_message: string;
      last_message_time: Date;
      last_buyer_message_time?: Date;
      last_message_type?: string;
      chat_type?: ChatType;
      unread_count: number;
      pinned: boolean;
      status: "active" | "resolved" | "archived";
      assigned_staff?: string;
      created_at: Date;
      updated_at: Date;
      staff_message_kind_log?: { id: string; kind: string }[];
      handling_status?: HandlingStatus;
      last_auto_reply_at?: Date | null;
      auto_reply_gave_up_at?: Date | null;
    }>("shopee_conversations");

    type ConvDoc = {
      conversation_id: string;
      shop_id: number;
      country: string;
      customer_id: number;
      customer_name: string;
      last_message: string;
      last_message_time: Date;
      last_buyer_message_time?: Date;
      last_message_type?: string;
      chat_type?: ChatType;
      unread_count: number;
      pinned: boolean;
      status: "active" | "resolved" | "archived";
      assigned_staff?: string;
      created_at: Date;
      updated_at: Date;
      staff_message_kind_log?: { id: string; kind: string }[];
      handling_status?: HandlingStatus;
      last_auto_reply_at?: Date | null;
      auto_reply_gave_up_at?: Date | null;
    };

    const filterDoc: Filter<ConvDoc> = {};
    if (country && country !== "全て") filterDoc.country = country;
    if (
      status &&
      (status === "active" || status === "resolved" || status === "archived")
    ) {
      filterDoc.status = status;
    }

    const allowedTypes: ChatType[] = ["buyer", "notification", "affiliate"];
    if (type && allowedTypes.includes(type as ChatType)) {
      filterDoc.chat_type = type as ChatType;
    } else {
      const exclude = (excludeChatTypesRaw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is ChatType =>
          ["buyer", "notification", "affiliate"].includes(s)
        );
      if (exclude.length) filterDoc.chat_type = { $nin: exclude };
    }

    if (unreadOnly) {
      filterDoc.unread_count = { $gt: 0 };
    }

    const conversations = await col
      .find(filterDoc)
      .sort({ last_message_time: -1 })
      .limit(limit)
      .toArray();

    /** 未読優先 → その後は最新アクティビティ順 */
    conversations.sort((a, b) => {
      const ua = a.unread_count > 0 ? 1 : 0;
      const ub = b.unread_count > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return b.last_message_time.getTime() - a.last_message_time.getTime();
    });

    const now = Date.now();
    let chats = conversations.map((conv) => {
      // バイヤーの最新メッセージ時刻を基準にする（スタッフ返信時刻は除外）
      const elapsedBase = conv.last_buyer_message_time ?? conv.last_message_time;
      const elapsed = (now - elapsedBase.getTime()) / (1000 * 60 * 60);

      const lastKind = lastStaffKindFromLog(conv.staff_message_kind_log);

      const handling_status = resolveHandlingStatus({
        handling_status: conv.handling_status,
        unread_count: conv.unread_count,
        staff_message_kind_log: conv.staff_message_kind_log,
        last_message_time: conv.last_message_time,
        last_buyer_message_time: conv.last_buyer_message_time,
      });

      /**
       * stall (2026-09-21): 買い手未返信が STALL_WARNING_HOURS を超え、
       * かつ handling_status === "unreplied" (未読 or 買い手が最終発言) の会話。
       * auto-reply 側の分類/pending/gave_up 状態には一切依存しない独立判定。
       * chat_type=buyer 系のみを対象 (notification / affiliate は除外)。
       */
      const chatType = conv.chat_type ?? "buyer";
      const stall =
        chatType !== "notification" &&
        handling_status === "unreplied" &&
        elapsed >= STALL_WARNING_HOURS;

      return {
        id: conv.conversation_id,
        shop_id: conv.shop_id,
        country: conv.country,
        customer: conv.customer_name,
        customer_id: conv.customer_id,
        lastMessage: conv.last_message,
        product: "—",
        date: elapsedBase.toLocaleDateString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
        time: elapsedBase.toLocaleTimeString("ja-JP", {
          timeZone: "Asia/Tokyo",
          hour: "2-digit",
          minute: "2-digit",
        }),
        elapsed: parseFloat(elapsed.toFixed(1)),
        staff: conv.assigned_staff || "未割当",
        unread: conv.unread_count,
        pinned: conv.pinned,
        status: conv.status,
        handling_status,
        type: chatType,
        last_staff_send_kind: lastKind ?? null,
        // Fix E' (2026-08-14): auto-reply が期限内に送信できず諦めた会話 (MISSED
        // DEADLINE) を UI で識別可能にする。 staff 送信 / 完了マーク / 自然回復で
        // clearAutoReplySchedule 経由でリセットされるため、 未対応の間だけ true。
        give_up: conv.auto_reply_gave_up_at instanceof Date,
        stall,
      };
    });

    if (searchQuery) {
      const q = searchQuery.toLowerCase().replace(/\s+/g, " ");
      const tokens = q.split(" ").filter(Boolean);
      chats = chats.filter((c) => {
        const searchable = [c.customer, c.lastMessage, c.product]
          .join(" ")
          .toLowerCase()
          .replace(/\s+/g, " ");
        return tokens.every((t) => searchable.includes(t));
      });
    }

    if (handlingParam && isHandlingStatus(handlingParam)) {
      chats = chats.filter((c) => c.handling_status === handlingParam);
    }

    return NextResponse.json({ chats });
  } catch (error) {
    console.error("Get chats error:", error);
    return NextResponse.json(
      { error: "Failed to fetch chats" },
      { status: 500 }
    );
  }
}
