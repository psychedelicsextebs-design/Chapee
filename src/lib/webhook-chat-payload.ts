/**
 * webchat_push (code 10) の data から conversation_id / shop_id を取り出す。
 *
 * 2026-10 時点で Shopee の実配信は data が次のように 1 段ネストされている:
 *   { type: "message",      region, content: { conversation_id, shop_id, from_id, message_type, ... } }
 *   { type: "notification", region, content: { conversation_id, type: "mark_as_replied", ... } }
 * 従来の「data 直下に conversation_id」だけを見る実装では全件
 * "missing shop_id or conversation_id" になり、 webhook 経由の DB 同期と自動返信予約が
 * 止まっていた。 data 直下 (旧形式) と data.content (新形式) の両方を見る。
 */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export interface WebchatPushIds {
  conversationId: string;
  shopId: number;
  /** どの形式から取れたか (ログ用) */
  source: "data" | "data.content" | "none";
}

export function extractWebchatPushIds(
  data: Record<string, unknown>
): WebchatPushIds {
  const flatConv = str(data.conversation_id);
  if (flatConv) {
    return {
      conversationId: flatConv,
      shopId: num(data.shop_id ?? data.shopId),
      source: "data",
    };
  }
  const content = asRecord(data.content);
  const nestedConv = content ? str(content.conversation_id) : "";
  if (content && nestedConv) {
    return {
      conversationId: nestedConv,
      shopId: num(content.shop_id ?? content.shopId ?? data.shop_id ?? data.shopId),
      source: "data.content",
    };
  }
  return { conversationId: "", shopId: 0, source: "none" };
}
