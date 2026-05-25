import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import {
  inferChatTypeFromShopee,
  type UiChatType,
} from "@/lib/shopee-conversation-utils";

/**
 * GET /api/admin/diag-chat-type  — 読み取り専用診断（データ変更なし）
 *
 * 「Shopee通知」フィルタで通知に絞られない問題の切り分け用。
 * shopee_conversations の chat_type 分布、通知扱い文書のサンプル、
 * 現行 inferChatTypeFromShopee で再計算した場合の分布/差分を返す。
 *
 * Authorization: Bearer ${CRON_SECRET}
 *
 * 使い方 (cmd.exe):
 *   curl -X GET "https://chapee-jet.vercel.app/api/admin/diag-chat-type" ^
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const col = await getCollection<{
    conversation_id: string;
    shop_id: number;
    customer_name?: string;
    last_message?: string;
    last_message_type?: string;
    last_message_time?: Date;
    chat_type?: UiChatType;
  }>("shopee_conversations");

  const docs = await col.find({}).toArray();

  // 現状の chat_type 分布
  const byChatType: Record<string, number> = {
    buyer: 0,
    notification: 0,
    affiliate: 0,
    unset: 0,
  };
  // 現行ロジックで再計算した場合の分布
  const reclassified: Record<UiChatType, number> = {
    buyer: 0,
    notification: 0,
    affiliate: 0,
  };
  let wouldChange = 0;

  // last_message_type 別の件数（通知判定のヒント: Parcel/Order Delivered が何 type か）
  const byMessageType: Record<string, number> = {};

  const notificationSample: Array<Record<string, unknown>> = [];
  // 「現行ロジックなら通知になる」が現状そうでない文書のサンプル
  const wouldBecomeNotificationSample: Array<Record<string, unknown>> = [];

  for (const d of docs) {
    const current = (d.chat_type ?? "unset") as string;
    byChatType[current] = (byChatType[current] ?? 0) + 1;

    const mt = d.last_message_type ?? "(none)";
    byMessageType[mt] = (byMessageType[mt] ?? 0) + 1;

    const recomputed = inferChatTypeFromShopee({
      latest_message_type: d.last_message_type,
      to_name: d.customer_name,
    });
    reclassified[recomputed]++;
    if ((d.chat_type ?? "buyer") !== recomputed) wouldChange++;

    if (d.chat_type === "notification" && notificationSample.length < 15) {
      notificationSample.push({
        conversation_id: d.conversation_id,
        customer_name: d.customer_name,
        last_message_type: d.last_message_type ?? null,
        last_message:
          typeof d.last_message === "string"
            ? d.last_message.slice(0, 80)
            : null,
        last_message_time: d.last_message_time ?? null,
        recomputed_would_be: recomputed,
      });
    }

    if (
      d.chat_type !== "notification" &&
      recomputed === "notification" &&
      wouldBecomeNotificationSample.length < 15
    ) {
      wouldBecomeNotificationSample.push({
        conversation_id: d.conversation_id,
        customer_name: d.customer_name,
        last_message_type: d.last_message_type ?? null,
        last_message:
          typeof d.last_message === "string"
            ? d.last_message.slice(0, 80)
            : null,
        current_chat_type: d.chat_type ?? "unset",
      });
    }
  }

  // last_message_type を多い順に整形（上位20）
  const topMessageTypes = Object.entries(byMessageType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([type, count]) => ({ type, count }));

  return NextResponse.json({
    success: true,
    total: docs.length,
    byChatType,
    reclassifiedWithCurrentLogic: reclassified,
    wouldChange,
    topMessageTypes,
    notificationSample,
    wouldBecomeNotificationSample,
  });
}
