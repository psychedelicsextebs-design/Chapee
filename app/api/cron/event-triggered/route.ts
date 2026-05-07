import { NextRequest, NextResponse } from "next/server";
import { processDuePhase2Triggers } from "@/lib/phase2-triggers";

/**
 * GET /api/cron/event-triggered
 * Phase 2 イベント駆動メッセージの pending queue を drain する。
 *
 * vercel.json で 5 分間隔のトリガーに設定。
 *
 * 既存の /api/cron/auto-reply (営業時間外自動返信) とは独立。 同じ会話に
 * 両方が並んで送られても、 staff_message_kind_log を触らない設計なので
 * 既存の誤発火検出ロジックには干渉しない。
 *
 * 認証: Vercel Cron からの呼び出しは Authorization: Bearer ${CRON_SECRET}。
 * 外部 cron / 手動実行も同じ Bearer で叩ける。
 */

export const maxDuration = 300; // Vercel Pro: 最大 300 秒

export async function GET(request: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await processDuePhase2Triggers();
    console.log("[cron/event-triggered]", result);

    return NextResponse.json({
      success: true,
      enabled: String(process.env.PHASE2_TRIGGERS_ENABLED ?? "").toLowerCase() === "true",
      ...result,
    });
  } catch (error) {
    console.error("[cron/event-triggered]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Phase 2 cron job failed",
      },
      { status: 500 }
    );
  }
}
