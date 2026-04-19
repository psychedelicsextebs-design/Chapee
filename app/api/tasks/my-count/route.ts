import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";
import { getSession } from "@/lib/auth";
import { TaskDoc } from "@/lib/tasks";

type StaffDoc = {
  _id: ObjectId;
  email: string;
};

/** GET /api/tasks/my-count
 * ログイン中ユーザーが担当者として含まれる未完了タスクの件数を返す。
 * session.email → staff_members の _id を解決 → tasks.assignees に含まれるものをカウント。
 * staff_members に該当レコードが無い場合は count: 0 を返す（エラーにしない）。
 */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const session = await getSession(cookieStore);
    if (!session.valid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const staffCol = await getCollection<StaffDoc>("staff_members");
    const me = await staffCol.findOne({ email: session.email });
    if (!me) {
      return NextResponse.json({ count: 0, staff_id: null });
    }
    const myId = me._id.toString();

    const tasksCol = await getCollection<TaskDoc>("tasks");
    const count = await tasksCol.countDocuments({
      completed: false,
      assignees: myId,
    });

    return NextResponse.json({ count, staff_id: myId });
  } catch (e) {
    console.error("[tasks/my-count GET]", e);
    return NextResponse.json({ error: "Failed to load count" }, { status: 500 });
  }
}
