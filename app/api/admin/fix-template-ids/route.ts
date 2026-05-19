import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";

/**
 * POST /api/admin/fix-template-ids
 *
 * Emergency one-shot: auto_reply_settings.countries.*.template_id を「営業時間外の
 * 自動返信」テンプレ (autoReply=true) に強制統一する。
 *
 * 背景: テンプレ削除/再作成のたびに本番 auto-reply が「template content empty/missing」
 * で skipped になる構造欠陥への即時対処 (2026-05-19)。UI 経由の保存が DB に反映され
 * ないバグの可能性もあり、 確実な DB 直接更新パスとして用意する。
 *
 * 認証: Authorization: Bearer ${CRON_SECRET} (env が設定されていれば必須)
 *
 * 使い方:
 *   curl -X POST https://chapee-jet.vercel.app/api/admin/fix-template-ids \
 *     -H "Authorization: Bearer ${CRON_SECRET}" \
 *     -H "Content-Type: application/json" -d '{}'
 *
 * dry_run: true で DB 更新せず差分のみ返す。
 *
 * 使い捨て: 投入後に同 commit セットで削除する想定 (cf. 1a3abf8 / 6bbbc39 パターン)。
 */

const TARGET_TEMPLATE_ID = "69fd937436d074c27df37548";

type AutoReplyCountryCfg = {
  enabled: boolean;
  triggerHour: number;
  template_id: string;
  subAccounts?: { id: string; name: string; enabled: boolean }[];
};

type AutoReplyDoc = {
  _id: string;
  countries: Record<string, AutoReplyCountryCfg>;
  updated_at?: Date;
};

type TemplateDoc = {
  _id: ObjectId;
  content?: string;
  autoReply?: boolean;
  name?: string;
};

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = (await request.json().catch(() => ({}))) as {
    dry_run?: boolean;
  };
  const dryRun = body.dry_run === true;

  if (!ObjectId.isValid(TARGET_TEMPLATE_ID)) {
    return NextResponse.json(
      { error: "TARGET_TEMPLATE_ID is not a valid ObjectId" },
      { status: 500 }
    );
  }

  const templatesCol = await getCollection<TemplateDoc>("reply_templates");
  const target = await templatesCol.findOne({
    _id: new ObjectId(TARGET_TEMPLATE_ID),
  });

  if (!target) {
    return NextResponse.json(
      {
        error: `target template ${TARGET_TEMPLATE_ID} not found in reply_templates`,
      },
      { status: 404 }
    );
  }

  const settingsCol = await getCollection<AutoReplyDoc>("auto_reply_settings");
  const doc = await settingsCol.findOne({ _id: "singleton" });
  if (!doc) {
    return NextResponse.json(
      { error: "auto_reply_settings singleton not found" },
      { status: 404 }
    );
  }

  const countries = doc.countries ?? {};
  const before: Record<string, string | null> = {};
  for (const [country, cfg] of Object.entries(countries)) {
    before[country] = cfg?.template_id ?? null;
  }
  const countriesUpdated = Object.keys(countries);

  if (!dryRun && countriesUpdated.length > 0) {
    const $set: Record<string, unknown> = { updated_at: new Date() };
    for (const country of countriesUpdated) {
      $set[`countries.${country}.template_id`] = TARGET_TEMPLATE_ID;
    }
    await settingsCol.updateOne({ _id: "singleton" }, { $set });
  }

  const targetContent =
    typeof target.content === "string" ? target.content : "";

  const result = {
    success: true,
    dry_run: dryRun,
    target_template_id: TARGET_TEMPLATE_ID,
    target_template_name: target.name ?? null,
    target_autoReply: target.autoReply ?? null,
    target_content_length: targetContent.length,
    target_content_trimmed_length: targetContent.trim().length,
    countries_updated: countriesUpdated,
    before,
    after: Object.fromEntries(
      countriesUpdated.map((c) => [c, TARGET_TEMPLATE_ID])
    ),
  };

  console.log(
    `[fix-template-ids] dry_run=${dryRun} target=${TARGET_TEMPLATE_ID}`,
    JSON.stringify(result, null, 2)
  );

  return NextResponse.json(result);
}
