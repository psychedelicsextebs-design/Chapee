import { NextRequest, NextResponse } from "next/server";
import { computeAutoReplyPipelineDiag } from "@/lib/diag-auto-reply-pipeline";

/**
 * GET /api/admin/diag-auto-reply-pipeline?name=wmfahmi
 *
 * End-to-end auto-reply pipeline diagnostic (2026-05-21). Read-only. mutation ゼロ。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * curl を叩かずとも、 auto-reply cron route (15 分間隔 cron) からも
 * logAutoReplyPipelineDiag("cron") が呼ばれ、 次の cron tick (15 分以内) で
 * 同じ結果が Vercel Logs に出る。
 *
 * TO BE DELETED after root cause is fixed (cf. diag-template-resolve パターン)。
 */

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const name = new URL(request.url).searchParams.get("name") ?? "wmfahmi";
    const result = await computeAutoReplyPipelineDiag(name);
    console.log(
      "[diag-pipeline/admin-endpoint] full result",
      JSON.stringify(result, null, 2)
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("[diag-auto-reply-pipeline]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "diag-auto-reply-pipeline failed",
      },
      { status: 500 }
    );
  }
}
