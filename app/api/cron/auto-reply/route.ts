import { NextRequest, NextResponse } from "next/server";
import {
  processDueAutoReplies,
  rescueUnflaggedAutoReplies,
} from "@/lib/auto-reply";
import { logAutoReplyPipelineDiag } from "@/lib/diag-auto-reply-pipeline";

/**
 * GET /api/cron/auto-reply
 * 期限到来の自動返信を送信。
 *
 * Vercel Cron の制限:
 * - Hobby: 1日1回まで（それ以上の頻度の式はデプロイ失敗）。vercel.json は日次に合わせている。
 * - Pro/Enterprise: 分単位まで設定可能。短い間隔が必要なら vercel.json の schedule を
 *   10 分間隔などの式に変更する。
 *
 * Hobby で数分おきに処理したい場合: 外部 cron（cron-job.org 等）から同 URL を
 * Authorization: Bearer CRON_SECRET と同じ値で叩く。
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // [TEMP DIAG 2026-05-21] sent:0 / rescue scanned:0 の真因確定用。
    // rescue が pending を立てる前の「素の状態」を撮るため、 必ず rescue より先に実行する
    // (rescue_query.count == rescue が実際に scan する件数 になるよう順序を固定)。
    // 真因確定後に diag-auto-reply-pipeline 一式と共に削除する。
    await logAutoReplyPipelineDiag("cron");

    // フラグ立ての 3 経路 (webhook / sync / chats-messages review) が空振りした
    // 場合の最後の砦。 直近 24h の buyer 着信を網羅的に拾って pending=true を
    // 立てるだけで、 staff 応答などの検証は processDueAutoReplies の pre-send
    // guard に委ねる (誤発火ゼロを維持)。
    const rescue = await rescueUnflaggedAutoReplies();
    console.log("[cron/auto-reply] rescue", rescue);

    const results = await processDueAutoReplies();
    console.log("[cron/auto-reply] process", results);

    return NextResponse.json({
      success: true,
      rescue,
      ...results,
    });
  } catch (error) {
    console.error("[cron/auto-reply]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Auto-reply job failed",
      },
      { status: 500 }
    );
  }
}
