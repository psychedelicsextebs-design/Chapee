import { NextRequest, NextResponse } from "next/server";
import { computeTemplateResolveDiag } from "@/lib/diag-template-resolve";

/**
 * GET /api/admin/diag-template-resolve
 *
 * Emergency diagnostic for "auto-reply sent:0 / template content empty/missing"
 * investigation (2026-05-18). Read-only. mutation ゼロ。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}。
 *
 * 結果は JSON で返すと同時に console.log("[diag-template/admin-endpoint] full result", ...)
 * で Vercel Logs にも構造化出力する。 curl を叩く必要を排除するため、 auto-reply cron
 * route (vercel.json *\/15) からも logTemplateResolveDiag("cron") が呼ばれており、
 * 次の cron tick (15 分以内) で同じ結果が Vercel Logs に出る。
 *
 * TO BE DELETED after investigation completes (cf. 1a3abf8 / 6bbbc39 パターン)。
 */

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await computeTemplateResolveDiag();
    console.log(
      "[diag-template/admin-endpoint] full result",
      JSON.stringify(result, null, 2)
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("[diag-template-resolve]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "diag-template-resolve failed",
      },
      { status: 500 }
    );
  }
}
