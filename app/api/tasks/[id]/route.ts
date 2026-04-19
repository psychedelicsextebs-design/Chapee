import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { getSession } from "@/lib/auth";
import {
  TaskDoc,
  serializeTask,
  parseOptionalDate,
  normalizeStringArray,
} from "@/lib/tasks";

async function requireSession() {
  const cookieStore = await cookies();
  const session = await getSession(cookieStore);
  return session.valid ? session : null;
}

function parseObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

/** GET /api/tasks/[id] */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const oid = parseObjectId(id);
    if (!oid) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const col = await getCollection<TaskDoc>("tasks");
    const doc = await col.findOne({ _id: oid });
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({ task: serializeTask(doc as TaskDoc) });
  } catch (e) {
    console.error("[tasks/[id] GET]", e);
    return NextResponse.json({ error: "Failed to load task" }, { status: 500 });
  }
}

/** PATCH /api/tasks/[id]
 * body: { title?, content?, assignees?, due_date?, country?, buyer_id?, conversation_id? }
 * いずれも未指定なら変更しない
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const oid = parseObjectId(id);
    if (!oid) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const $set: Partial<TaskDoc> = { updated_at: new Date() };

    if (typeof body.title === "string") {
      const t = body.title.trim();
      if (!t) {
        return NextResponse.json({ error: "タスク名は空にできません" }, { status: 400 });
      }
      $set.title = t;
    }
    if (typeof body.content === "string") $set.content = body.content;
    if (Array.isArray(body.assignees)) $set.assignees = normalizeStringArray(body.assignees);
    if ("due_date" in body) $set.due_date = parseOptionalDate(body.due_date);
    if ("country" in body) $set.country = body.country ? String(body.country) : null;
    if ("buyer_id" in body) $set.buyer_id = body.buyer_id ? String(body.buyer_id) : null;
    if ("conversation_id" in body) {
      $set.conversation_id = body.conversation_id ? String(body.conversation_id) : null;
    }

    const col = await getCollection<TaskDoc>("tasks");
    const result = await col.findOneAndUpdate(
      { _id: oid },
      { $set },
      { returnDocument: "after" }
    );
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({ task: serializeTask(result as TaskDoc) });
  } catch (e) {
    console.error("[tasks/[id] PATCH]", e);
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }
}

/** DELETE /api/tasks/[id] */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const oid = parseObjectId(id);
    if (!oid) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const col = await getCollection<TaskDoc>("tasks");
    const r = await col.deleteOne({ _id: oid });
    if (r.deletedCount === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[tasks/[id] DELETE]", e);
    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
