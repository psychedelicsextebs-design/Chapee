import { NextRequest, NextResponse } from "next/server";
import {
  processDueAutoReplies,
  rescueUnflaggedAutoReplies,
} from "@/lib/auto-reply";
import { logTemplateResolveDiag } from "@/lib/diag-template-resolve";

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

    // [TEMP 2026-05-18] auto-reply skipped:* の真因 (template content
    // empty/missing) を Vercel Logs から特定するため、 cron 冒頭で
    // auto_reply_settings + reply_templates を read-only でダンプする。
    // 真因確定後に diag-template-resolve helper と一緒に削除する想定。
    // mutation ゼロ / auto-reply ロジックの結果には影響しない。
    await logTemplateResolveDiag("cron");

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
