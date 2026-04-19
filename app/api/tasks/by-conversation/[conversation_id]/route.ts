import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCollection } from "@/lib/mongodb";
import { getSession } from "@/lib/auth";
import { TaskDoc, serializeTask } from "@/lib/tasks";

/** GET /api/tasks/by-conversation/[conversation_id]
 * 指定会話に紐づくタスクを返す。未完了→完了の順、未完了内は期限の早い順。
 * query: completed=0|1 で絞り込み可
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const session = await getSession(cookieStore);
    if (!session.valid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { conversation_id } = await params;
    if (!conversation_id) {
      return NextResponse.json({ error: "Missing conversation_id" }, { status: 400 });
    }

    const url = new URL(request.url);
    const completed = url.searchParams.get("completed");
    const filter: Partial<TaskDoc> & { conversation_id: string } = { conversation_id };
    if (completed === "1" || completed === "true") filter.completed = true;
    else if (completed === "0" || completed === "false") filter.completed = false;

    const col = await getCollection<TaskDoc>("tasks");
    const rows = await col
      .find(filter)
      .sort({ completed: 1, due_date: 1, created_at: -1 })
      .toArray();

    return NextResponse.json({
      tasks: rows.map((r) => serializeTask(r as TaskDoc)),
    });
  } catch (e) {
    console.error("[tasks/by-conversation GET]", e);
    return NextResponse.json({ error: "Failed to load tasks" }, { status: 500 });
  }
}
