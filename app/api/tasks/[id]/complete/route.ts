import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { getSession } from "@/lib/auth";
import { TaskDoc, serializeTask } from "@/lib/tasks";

/** POST /api/tasks/[id]/complete
 * body: { completed: boolean }  （true/false で完了・未完了を切替）
 * body が空なら true とみなす（完了に倒す）
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies();
    const session = await getSession(cookieStore);
    if (!session.valid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const completed = body.completed === false ? false : true;
    const now = new Date();

    const col = await getCollection<TaskDoc>("tasks");
    const result = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          completed,
          completed_at: completed ? now : null,
          completed_by: completed ? session.email : null,
          updated_at: now,
        },
      },
      { returnDocument: "after" }
    );
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ task: serializeTask(result as TaskDoc) });
  } catch (e) {
    console.error("[tasks/[id]/complete POST]", e);
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }
}
