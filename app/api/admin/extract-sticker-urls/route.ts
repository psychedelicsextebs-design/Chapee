import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongodb";
import { displayFromShopeeChatMessage } from "@/lib/shopee-conversation-utils";
import {
  SHOPEE_CHAT_MESSAGES_COLLECTION,
  type ShopeeChatMessageDoc,
} from "@/lib/shopee-conversation-db-sync";

/**
 * GET /api/admin/extract-sticker-urls
 *
 * !!! TEMPORARY ENDPOINT — DELETE AFTER URL EXTRACTION !!!
 *
 * 目的:
 *   sticker-presets.ts に投入する image_url を、過去の受信 sticker メッセージ
 *   (`shopee_chat_messages`) から抽出する。 ローカル PC は Atlas outbound 不通の
 *   ため、本 endpoint を Vercel 経由で叩く形で抽出する。
 *
 * 抽出対象 (orangutan_my_new パック 4 種):
 *   sticker_id = 06 (ありがとう), 29 (確認中), 02 (了解), 03 (お待たせしました)
 *
 * 動作:
 *   1) `shopee_chat_messages` から sticker_shape を持つ raw を timestamp_ms 降順で
 *      最大 5000 件取得 (≒ 半年分の通常運用想定)
 *   2) 各 raw を `displayFromShopeeChatMessage` で正規化 → kind=="sticker" のものだけ採用
 *   3) package_id == "orangutan_my_new" かつ target sticker_id でフィルタ
 *   4) 各 sticker_id について最新 1 件 (image_url 付き) を返す
 *
 * 認証: Authorization: Bearer ${CRON_SECRET} 必須 (CRON_SECRET 未設定なら 500)。
 *
 * 副作用: read-only。 DB 書き込み一切なし。 Shopee API も叩かない。
 *
 * 削除タイミング:
 *   URL 投入後、別 commit で本ファイル + 関連テストを削除する想定。
 *   永続化したい場合は別途レビュー。
 */

export const maxDuration = 60;

const TARGET_PACKAGE_ID = "orangutan_my_new";
const TARGET_STICKER_IDS = ["06", "29", "02", "03"] as const;
const STICKER_LABELS: Record<string, string> = {
  "06": "ありがとう",
  "29": "確認中",
  "02": "了解",
  "03": "お待たせしました",
};
const SCAN_LIMIT = 5000;

type ExtractedRow = {
  sticker_id: string;
  label: string;
  image_url: string;
  conversation_id: string;
  shop_id: number;
  message_id: string;
  timestamp_ms: number;
  synced_at: string;
};

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET 未設定のため実行できません" },
      { status: 500 }
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const col = await getCollection<ShopeeChatMessageDoc>(
      SHOPEE_CHAT_MESSAGES_COLLECTION
    );

    // sticker shape を持つ raw を広めに引く。 raw payload は Shopee 仕様のばらつきが
    // あるため複数 path を $or で許容し、displayFromShopeeChatMessage に正規化判定を
    // 任せる。 timestamp_ms 降順で最新から走査して、各 sticker_id を 1 件見つけた
    // 時点で打ち切るのが効率的だが、簡潔さのため SCAN_LIMIT で粗フィルタする。
    const docs = await col
      .find({
        $or: [
          { "raw.message_type": "sticker" },
          { "raw.type": "sticker" },
          { "raw.sticker_id": { $exists: true } },
          { "raw.content.sticker_id": { $exists: true } },
          { "raw.sticker.sticker_id": { $exists: true } },
        ],
      })
      .sort({ timestamp_ms: -1 })
      .limit(SCAN_LIMIT)
      .toArray();

    const found: Map<string, ExtractedRow> = new Map();
    let stickerMessageCount = 0;

    for (const d of docs) {
      const raw = d.raw;
      if (!raw || typeof raw !== "object") continue;

      const display = displayFromShopeeChatMessage(raw as Record<string, unknown>);
      if (display.kind !== "sticker") continue;
      stickerMessageCount++;

      const sticker = display.sticker;
      const pid = sticker?.package_id?.trim();
      const sid = sticker?.sticker_id?.trim();
      const url = sticker?.image_url?.trim();

      if (pid !== TARGET_PACKAGE_ID) continue;
      if (!sid || !TARGET_STICKER_IDS.includes(sid as (typeof TARGET_STICKER_IDS)[number])) {
        continue;
      }
      if (!url || !/^https?:\/\//i.test(url)) continue;

      // sort 済みなので最初に出てきた (= 最新の) もので確定
      if (!found.has(sid)) {
        found.set(sid, {
          sticker_id: sid,
          label: STICKER_LABELS[sid] ?? sid,
          image_url: url,
          conversation_id: String(d.conversation_id),
          shop_id: Number(d.shop_id ?? 0),
          message_id: String(d.message_id),
          timestamp_ms: Number(d.timestamp_ms ?? 0),
          synced_at:
            d.synced_at instanceof Date
              ? d.synced_at.toISOString()
              : String(d.synced_at ?? ""),
        });
        if (found.size === TARGET_STICKER_IDS.length) break; // 全件揃ったら早期終了
      }
    }

    const results = TARGET_STICKER_IDS.map(
      (sid) => found.get(sid) ?? null
    ).filter((x): x is ExtractedRow => x !== null);
    const missing_sticker_ids = TARGET_STICKER_IDS.filter((sid) => !found.has(sid));

    return NextResponse.json({
      scanned_at: new Date().toISOString(),
      package_id: TARGET_PACKAGE_ID,
      total_docs_scanned: docs.length,
      sticker_messages_seen: stickerMessageCount,
      results,
      missing_sticker_ids,
      // sticker-presets.ts に貼り付けやすいスニペット
      preset_patch: results.reduce<Record<string, string>>((acc, r) => {
        acc[r.sticker_id] = r.image_url;
        return acc;
      }, {}),
    });
  } catch (error) {
    console.error("[admin/extract-sticker-urls]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "extract-sticker-urls failed",
      },
      { status: 500 }
    );
  }
}
