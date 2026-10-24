import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  fetchAllConversationMessages,
} from "@/lib/shopee-api";
import { getValidToken, resolveCountryForShop } from "@/lib/shopee-token";
import { reviewAutoReplySchedule } from "@/lib/auto-reply";

/**
 * POST /api/admin/cleanup-stale-give-ups
 * Authorization: Bearer ${CRON_SECRET}
 *
 * 2026-10-24: Fix A sender-aware refactor (9/21) の副作用で発生した give_up
 * false-positive の掃除。 Shopee system が buyer-side pos (from_id=0, to_id=shop_id)
 * で配信する product_new / notification / extended_markdown 等が buyer と誤分類
 * され、 send_message 失敗 → 12h リトライ → give_up になった 46件を能動的に
 * 再評価する。
 *
 * 流れ:
 *   1. auto_reply_gave_up_at が set されている全会話を列挙
 *   2. 各会話について Shopee API から最新 msg を取得
 *   3. reviewAutoReplySchedule を呼ぶ (新 classifier で再判定)
 *   4. 新 classifier が「buyer msg 無し」と判定すれば、 review 内の
 *      lastBuyerMs===0 分岐で stale gave_up_at が自動 clear される
 *   5. 真の buyer msg がある場合は正常スケジュールに復帰
 *
 * 完全に review に委譲するので mutation は review 経由のみ。
 * dry_run=1 で件数集計のみ (実行なし)。
 *
 * ★ 一時的な修復用 endpoint。 fix の浸透後に撤去する (diag-template-resolve
 *   パターン、 SKILL.md「検知手段を撤去するときは代替を用意する」原則)。
 */

export const maxDuration = 300;

type ConvDoc = {
  conversation_id: string;
  shop_id: number;
  country?: string;
  customer_name?: string;
  auto_reply_gave_up_at?: Date | null;
  last_message?: string;
};

type Result = {
  conversation_id: string;
  shop_id: number;
  customer_name: string | null;
  last_message_preview: string;
  action: "cleared" | "preserved" | "error" | "dry_run";
  error?: string;
};

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 未設定のため実行できません" },
      { status: 500 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dryRun =
    searchParams.get("dry_run") === "1" ||
    searchParams.get("dry_run") === "true";
  const limitRaw = parseInt(searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

  const col = await getCollection<ConvDoc>("shopee_conversations");

  const docs = await col
    .find({ auto_reply_gave_up_at: { $exists: true, $ne: null } })
    .limit(limit)
    .toArray();

  const results: Result[] = [];
  const summary = {
    total_scanned: docs.length,
    cleared: 0,
    preserved: 0,
    errors: 0,
    dry_run: dryRun,
  };

  for (const doc of docs) {
    const convId = String(doc.conversation_id);
    const lastPreview = String(doc.last_message ?? "").slice(0, 60);
    const base: Omit<Result, "action" | "error"> = {
      conversation_id: convId,
      shop_id: doc.shop_id,
      customer_name: doc.customer_name ?? null,
      last_message_preview: lastPreview,
    };

    if (dryRun) {
      results.push({ ...base, action: "dry_run" });
      continue;
    }

    try {
      const accessToken = await getValidToken(doc.shop_id);
      const country = await resolveCountryForShop(doc.shop_id, doc.country);
      const rawList = (await fetchAllConversationMessages(
        accessToken,
        doc.shop_id,
        convId,
        { country }
      )) as Record<string, unknown>[];

      await reviewAutoReplySchedule(rawList, doc.shop_id, convId);

      // Re-fetch to see if gave_up was cleared
      const after = await col.findOne({
        conversation_id: convId,
        shop_id: doc.shop_id,
      });
      const stillGaveUp = after?.auto_reply_gave_up_at instanceof Date;
      if (stillGaveUp) {
        results.push({ ...base, action: "preserved" });
        summary.preserved++;
      } else {
        results.push({ ...base, action: "cleared" });
        summary.cleared++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ ...base, action: "error", error: msg });
      summary.errors++;
    }
  }

  return NextResponse.json({
    summary,
    results,
  });
}
