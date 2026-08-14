import { NextRequest, NextResponse } from "next/server";
import { processDueAutoReplies } from "@/lib/auto-reply";

/**
 * GET /api/cron/auto-reply-urgent
 *
 * ペナルティ期限まで URGENT_HORIZON_MS (2h) 以内の pending 会話だけを
 * 1 分間隔で処理する緊急送信 cron。
 *
 * 【設計】
 * 通常 cron (/api/cron/auto-reply, 15 分間隔) では期限直前の retry 回数が
 * 不足する (期限 15 分前突入時に 1 回しか試行できない)。 緊急枠を別建てして
 * 1 分間隔 = 期限 2h 前から最大 120 回試行を保証する。
 *
 * 対象: pending=true AND due<=now AND first_unreplied <= now - 10h
 * (= ペナルティ期限まで 2h 以内)
 *
 * 【実装】
 * 通常 cron と同じ processDueAutoReplies() を再利用、 opts.urgentOnly=true で
 * find filter だけ絞る。 rescue はここでは呼ばない (通常 cron の rescue が
 * pending を立てる)。
 *
 * 【認証】
 * Authorization: Bearer ${CRON_SECRET} (Vercel Cron が自動注入)。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const results = await processDueAutoReplies({ urgentOnly: true });
    // 対象ゼロの tick は極力静かに (ノイズ削減)。 送信/エラー時のみ詳細ログ。
    if (results.processed > 0 || results.errors.length > 0) {
      console.log("[cron/auto-reply-urgent] process", results);
    }

    return NextResponse.json({ success: true, ...results });
  } catch (error) {
    console.error("[cron/auto-reply-urgent]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Urgent auto-reply failed",
      },
      { status: 500 }
    );
  }
}
