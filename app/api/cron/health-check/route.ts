import { NextRequest, NextResponse } from "next/server";
import { findMissedConversations } from "@/lib/health-check";

/**
 * GET /api/cron/health-check
 * Auto-reply 漏れ候補の検知 (read-only).
 *
 * 設計目的:
 *   sunrainsky 級の事故 (Shopee Overdue 警告 = triggerHour 経過後の自動返信失敗)
 *   が発生する前に、auto_reply_pending が立っていない / last_auto_reply_at が
 *   未更新の会話を 15 分間隔で監視する。
 *
 * 通知:
 *   Phase 1 は console.warn のみ。 Slack / メール通知は Phase 2 で別実装予定。
 *
 * 認証:
 *   Authorization: Bearer ${CRON_SECRET}。 CRON_SECRET 未設定時は認証スキップ
 *   (ローカル開発互換)。 既存 cron ルートと同じ規約。
 *
 * 副作用なし:
 *   DB は read-only (find のみ)。 Shopee API は叩かない。
 *   auto_reply_pending を立てる等の自動修復は意図的にしていない (Phase 1)。
 */
export async function GET(request: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await findMissedConversations();

    if (result.missed_count > 0) {
      console.warn(
        `[cron/health-check] missed=${result.missed_count} ` +
          `scanned=${result.total_conversations_checked} ` +
          `at=${result.scanned_at}`,
        result.missed_conversations
      );
    } else {
      console.log(
        `[cron/health-check] healthy: scanned=${result.total_conversations_checked} ` +
          `missed=0 at=${result.scanned_at}`
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[cron/health-check]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Health check failed",
      },
      { status: 500 }
    );
  }
}
