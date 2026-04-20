import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

/**
 * GET /api/admin/find-auto-reply-victims?days=30&mode=summary
 *
 * 自動返信が「スタッフ手動返信済みのスレッド」にも誤送信されていた過去ケースを抽出する。
 * 今回のバグ (from_id !== shop_id のスタッフ返信を buyer と誤認していた) の影響範囲調査用。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * パラメータ:
 *   days  - 過去 N 日を対象（デフォルト 30）
 *   mode  - "summary" | "full"（デフォルト "summary"）
 *           summary: 件数サマリ + トップ顧客 + 国別分布
 *           full:    summary に加え、被害スレッド全件リスト
 *
 * 検出ロジック:
 *   1. staff_message_kind_log.kind="auto" のエントリがある会話を候補に
 *   2. その auto 送信の message_id を shopee_chat_messages から引き、timestamp を取得
 *   3. 直前のメッセージ（timestamp_ms < autoTs）を1件取得
 *   4. 直前メッセージの from_id !== customer_id （かつ != 0）= スタッフ送信
 *      → 被害スレッド確定
 */

export const maxDuration = 300; // Vercel Pro: 最大 300 秒

type AutoKindEntry = { id?: string; kind?: string };

type ConversationDoc = {
  conversation_id: string;
  shop_id: number;
  customer_id?: number;
  customer_name?: string;
  country?: string;
  staff_message_kind_log?: AutoKindEntry[];
};

type ChatMessageDoc = {
  conversation_id: string;
  shop_id: number;
  message_id: string;
  timestamp_ms: number;
  raw?: Record<string, unknown>;
};

type Victim = {
  conversation_id: string;
  shop_id: number;
  country: string | null;
  customer_id: number;
  customer_name: string | null;
  auto_reply: {
    message_id: string;
    sent_at: string;
  };
  previous_staff_message: {
    message_id: string;
    from_id: number;
    sent_at: string;
  };
};

function numberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(request: NextRequest) {
  // --- Auth ---
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 未設定のため実行できません" },
      { status: 500 }
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Params ---
  const url = new URL(request.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 30)));
  const modeRaw = (url.searchParams.get("mode") ?? "summary").toLowerCase();
  const mode: "summary" | "full" = modeRaw === "full" ? "full" : "summary";
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;

  // --- Collections ---
  const convCol = await getCollection<ConversationDoc>("shopee_conversations");
  const msgCol = await getCollection<ChatMessageDoc>("shopee_chat_messages");

  const candidates = await convCol
    .find({
      "staff_message_kind_log.kind": "auto",
      customer_id: { $exists: true, $gt: 0 },
    })
    .project<ConversationDoc>({
      conversation_id: 1,
      shop_id: 1,
      customer_id: 1,
      customer_name: 1,
      country: 1,
      staff_message_kind_log: 1,
    })
    .toArray();

  const victims: Victim[] = [];
  let scannedAutoEntries = 0;

  for (const conv of candidates) {
    const convId = String(conv.conversation_id);
    const shopId = Number(conv.shop_id);
    const customerId = numberOrNull(conv.customer_id);
    if (!customerId) continue;

    const autoEntries = (conv.staff_message_kind_log ?? []).filter(
      (e): e is AutoKindEntry & { id: string } =>
        !!e && e.kind === "auto" && typeof e.id === "string" && e.id.length > 0
    );
    if (autoEntries.length === 0) continue;

    for (const entry of autoEntries) {
      scannedAutoEntries++;
      const autoMsgId = String(entry.id);

      const autoMsg = await msgCol.findOne({
        conversation_id: convId,
        shop_id: shopId,
        message_id: autoMsgId,
      });
      if (!autoMsg) continue;

      const autoTs = Number(autoMsg.timestamp_ms ?? 0);
      if (!autoTs || autoTs < sinceMs) continue;

      const prev = await msgCol
        .find({
          conversation_id: convId,
          shop_id: shopId,
          timestamp_ms: { $lt: autoTs },
        })
        .sort({ timestamp_ms: -1 })
        .limit(1)
        .next();
      if (!prev) continue;

      const raw = prev.raw ?? {};
      const prevFromId = Number(
        (raw as { from_id?: unknown; from_user_id?: unknown }).from_id ??
          (raw as { from_id?: unknown; from_user_id?: unknown }).from_user_id ??
          0
      );
      if (prevFromId === 0) continue; // system card
      if (prevFromId === customerId) continue; // 正常な自動返信（直前は buyer）

      victims.push({
        conversation_id: convId,
        shop_id: shopId,
        country: conv.country ?? null,
        customer_id: customerId,
        customer_name: conv.customer_name ?? null,
        auto_reply: {
          message_id: autoMsgId,
          sent_at: new Date(autoTs).toISOString(),
        },
        previous_staff_message: {
          message_id: String(prev.message_id ?? ""),
          from_id: prevFromId,
          sent_at: new Date(Number(prev.timestamp_ms ?? 0)).toISOString(),
        },
      });
    }
  }

  // 新しい順
  victims.sort((a, b) =>
    b.auto_reply.sent_at.localeCompare(a.auto_reply.sent_at)
  );

  // --- 集計 ---
  const uniqueThreads = new Set(
    victims.map((v) => `${v.shop_id}:${v.conversation_id}`)
  ).size;

  const byCustomer = new Map<
    number,
    { customer_id: number; customer_name: string | null; count: number }
  >();
  for (const v of victims) {
    const cur =
      byCustomer.get(v.customer_id) ?? {
        customer_id: v.customer_id,
        customer_name: v.customer_name,
        count: 0,
      };
    cur.count++;
    // 名前は遅延マージ（後で出現した非nullで上書き）
    if (!cur.customer_name && v.customer_name) cur.customer_name = v.customer_name;
    byCustomer.set(v.customer_id, cur);
  }
  const topCustomers = Array.from(byCustomer.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const byCountry: Record<string, number> = {};
  for (const v of victims) {
    const c = (v.country ?? "UNKNOWN").toUpperCase();
    byCountry[c] = (byCountry[c] ?? 0) + 1;
  }

  const summary = {
    generated_at: new Date().toISOString(),
    period_days: days,
    since: new Date(sinceMs).toISOString(),
    candidates_scanned: candidates.length,
    auto_entries_scanned: scannedAutoEntries,
    victims_count: victims.length,
    unique_threads: uniqueThreads,
    top_customers: topCustomers,
    by_country: byCountry,
  };

  console.log("[find-auto-reply-victims]", summary);

  if (mode === "full") {
    return NextResponse.json({ ...summary, victims });
  }

  // summary モード: 直近 20 件だけサンプル付き
  return NextResponse.json({
    ...summary,
    sample_recent: victims.slice(0, 20),
  });
}
