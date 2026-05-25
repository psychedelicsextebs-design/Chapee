import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";

const MAX_IDS = 500;

/**
 * POST /api/chats/bulk-complete — 選択した会話を「返信なし」で対応完了にする。
 *
 * handling_status=completed に一括更新し、保留中の自動返信予約も解除する
 * （再発火防止）。送信は伴わないので staff_message_kind_log には記録しない。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { conversation_ids?: unknown };
    const ids = Array.isArray(body.conversation_ids)
      ? body.conversation_ids
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0)
      : [];

    if (ids.length === 0) {
      return NextResponse.json(
        { error: "conversation_ids が空です" },
        { status: 400 }
      );
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json(
        { error: `一度に処理できるのは ${MAX_IDS} 件までです` },
        { status: 400 }
      );
    }

    const col = await getCollection<{ conversation_id: string }>(
      "shopee_conversations"
    );

    const result = await col.updateMany(
      { conversation_id: { $in: ids } },
      {
        $set: {
          handling_status: "completed",
          auto_reply_pending: false,
          auto_reply_due_at: null,
          updated_at: new Date(),
        },
      }
    );

    return NextResponse.json({
      success: true,
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (error) {
    console.error("POST /api/chats/bulk-complete", error);
    return NextResponse.json(
      { error: "一括完了に失敗しました" },
      { status: 500 }
    );
  }
}
