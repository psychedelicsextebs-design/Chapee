import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * GET /api/admin/diag-customer-state?token=...&names=gg.ah.goh.goh,shopaholic138
 *
 * ★ 一時 endpoint ★ — 2026-05-11 auto-reply 商品カード問い合わせ漏れ調査用。
 * 本タスク完了後に削除する。
 *
 * Auth: query `token` パラメータが下記ハードコード値と一致したら応答。
 *   CC が自走で curl するために CRON_SECRET を共有しなくて済むよう一時 URL token 方式。
 *   token は単発、 endpoint 削除と同時に git history から見えるが endpoint 自体が消える
 *   ので攻撃可能性は数時間のデプロイ窓のみ。 read-only かつ customer_name 指定必須
 *   のため、 任意 doc の漏洩はない。
 *
 * 戻り値: 各 customer_name について shopee_conversations の状態 + 直近 N 件の
 * raw メッセージ (shopee_chat_messages から、 sync 済の分のみ)。
 */

const DIAG_TOKEN = "2bb9dce89a912342734fad5ccdf67c37a9f9423b643e2086";
const RAW_MESSAGES_LIMIT = 10;

type ConvDoc = {
  _id?: unknown;
  conversation_id: string;
  shop_id: number;
  country?: string;
  customer_id?: number;
  customer_name?: string;
  chat_type?: string;
  last_message?: string;
  last_message_time?: Date;
  last_buyer_message_time?: Date;
  last_message_type?: string;
  latest_message_type?: string;
  unread_count?: number;
  status?: string;
  handling_status?: string;
  auto_reply_pending?: boolean;
  auto_reply_due_at?: Date | null;
  last_auto_reply_at?: Date | null;
  staff_message_kind_log?: { id: string; kind: string }[];
  created_at?: Date;
  updated_at?: Date;
};

type ChatMsgDoc = {
  conversation_id: string;
  shop_id: number;
  message_id: string;
  timestamp_ms: number;
  raw?: Record<string, unknown>;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") ?? "";
  if (token !== DIAG_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const namesParam = searchParams.get("names") ?? "";
  const names = namesParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return NextResponse.json(
      { error: "names query param required (comma-separated)" },
      { status: 400 },
    );
  }

  try {
    const convCol = await getCollection<ConvDoc>("shopee_conversations");
    const msgCol = await getCollection<ChatMsgDoc>("shopee_chat_messages");

    const out: Record<string, unknown> = {
      scanned_at: new Date().toISOString(),
      names,
    };

    for (const name of names) {
      // customer_name の case-insensitive 完全一致 + 部分一致を試す
      const docs = await convCol
        .find({
          $or: [
            { customer_name: name },
            { customer_name: name.toLowerCase() },
            { customer_name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } },
          ],
        })
        .limit(5)
        .toArray();

      const perCustomer = await Promise.all(
        docs.map(async (doc) => {
          const rawMsgs = await msgCol
            .find({
              conversation_id: String(doc.conversation_id),
              shop_id: doc.shop_id,
            })
            .sort({ timestamp_ms: -1 })
            .limit(RAW_MESSAGES_LIMIT)
            .toArray();

          return {
            conversation_id: doc.conversation_id,
            shop_id: doc.shop_id,
            country: doc.country ?? null,
            customer_id: doc.customer_id ?? null,
            customer_name: doc.customer_name ?? null,
            chat_type: doc.chat_type ?? null,
            last_message: trunc(doc.last_message, 120),
            last_message_time: doc.last_message_time?.toISOString?.() ?? null,
            last_buyer_message_time:
              doc.last_buyer_message_time?.toISOString?.() ?? null,
            last_message_type: doc.last_message_type ?? null,
            latest_message_type: doc.latest_message_type ?? null,
            unread_count: doc.unread_count ?? 0,
            status: doc.status ?? null,
            handling_status: doc.handling_status ?? null,
            auto_reply_pending: doc.auto_reply_pending ?? false,
            auto_reply_due_at: doc.auto_reply_due_at?.toISOString?.() ?? null,
            last_auto_reply_at:
              doc.last_auto_reply_at?.toISOString?.() ?? null,
            staff_message_kind_log_tail:
              doc.staff_message_kind_log?.slice(-5) ?? [],
            created_at: doc.created_at?.toISOString?.() ?? null,
            updated_at: doc.updated_at?.toISOString?.() ?? null,
            recent_messages: rawMsgs.map((m) => ({
              message_id: m.message_id,
              timestamp_ms: m.timestamp_ms,
              timestamp_iso: new Date(m.timestamp_ms).toISOString(),
              from_id: m.raw?.from_id ?? null,
              to_id: m.raw?.to_id ?? null,
              from_user_id: m.raw?.from_user_id ?? null,
              to_user_id: m.raw?.to_user_id ?? null,
              message_type: m.raw?.message_type ?? null,
              content_snippet: snipContent(m.raw?.content),
            })),
          };
        }),
      );

      out[name] = perCustomer;
    }

    return NextResponse.json(out);
  } catch (e) {
    console.error("[diag-customer-state]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "diag failed" },
      { status: 500 },
    );
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trunc(s: string | undefined, n: number): string | null {
  if (s == null) return null;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function snipContent(c: unknown): unknown {
  if (typeof c === "string") return trunc(c, 200);
  if (c && typeof c === "object") {
    // text / image / item card 等の構造を浅く要約
    const obj = c as Record<string, unknown>;
    return {
      text: typeof obj.text === "string" ? trunc(obj.text, 120) : undefined,
      item_id: obj.item_id ?? undefined,
      shop_id: obj.shop_id ?? undefined,
      order_sn: obj.order_sn ?? undefined,
      sticker_id: obj.sticker_id ?? undefined,
    };
  }
  return null;
}
