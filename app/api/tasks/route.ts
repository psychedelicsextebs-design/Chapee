import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { Filter } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { getSession } from "@/lib/auth";
import {
  TaskDoc,
  serializeTask,
  parseOptionalDate,
  normalizeStringArray,
} from "@/lib/tasks";

/** 認証チェック。無効なら null を返す */
async function requireSession() {
  const cookieStore = await cookies();
  const session = await getSession(cookieStore);
  return session.valid ? session : null;
}

/** GET /api/tasks  — 一覧
 * query:
 *   completed=0|1        （未完了/完了）
 *   country=SG|MY|...    （国で絞り込み）
 *   assignee=<staff_id>  （特定担当者を含むもの）
 *   conversation_id=...  （特定会話のタスク）
 *   limit=<num>          （デフォルト 200、最大 500）
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const q = url.searchParams;
    const filter: Filter<TaskDoc> = {};

    const completed = q.get("completed");
    if (completed === "1" || completed === "true") filter.completed = true;
    else if (completed === "0" || completed === "false") filter.completed = false;

    const country = q.get("country");
    if (country) filter.country = country;

    const assignee = q.get("assignee");
    if (assignee) filter.assignees = assignee;

    const conversationId = q.get("conversation_id");
    if (conversationId) filter.conversation_id = conversationId;

    const limitRaw = Number(q.get("limit") ?? "200");
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 500);

    const col = await getCollection<TaskDoc>("tasks");
    // 未完了は期限の早い順→作成新しい順、完了は完了日時の新しい順
    const sort: Record<string, 1 | -1> = filter.completed === true
      ? { completed_at: -1 }
      : { due_date: 1, created_at: -1 };

    const rows = await col.find(filter).sort(sort).limit(limit).toArray();
    return NextResponse.json({
      tasks: rows.map((r) => serializeTask(r as TaskDoc)),
    });
  } catch (e) {
    console.error("[tasks GET]", e);
    return NextResponse.json({ error: "Failed to load tasks" }, { status: 500 });
  }
}

/** POST /api/tasks  — 作成
 * body: { title, content?, assignees?, due_date?, conversation_id?, buyer_id?, country? }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const title = String(body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ error: "タスク名が必要です" }, { status: 400 });
    }

    const now = new Date();
    const doc: Omit<TaskDoc, "_id"> = {
      title,
      content: String(body.content ?? ""),
      assignees: normalizeStringArray(body.assignees),
      due_date: parseOptionalDate(body.due_date),
      completed: false,
      completed_at: null,
      completed_by: null,
      conversation_id: body.conversation_id
        ? String(body.conversation_id)
        : null,
      buyer_id: body.buyer_id ? String(body.buyer_id) : null,
      country: body.country ? String(body.country) : null,
      created_at: now,
      updated_at: now,
      created_by: session.email,
    };

    const col = await getCollection<TaskDoc>("tasks");
    const r = await col.insertOne(doc as TaskDoc);
    const inserted = await col.findOne({ _id: r.insertedId });
    if (!inserted) throw new Error("insert failed");

    return NextResponse.json({ task: serializeTask(inserted as TaskDoc) });
  } catch (e) {
    console.error("[tasks POST]", e);
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
