import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";

/**
 * GET /api/admin/diag-template-resolve
 *
 * Emergency diagnostic for "auto-reply sent:0 / template content empty/missing"
 * investigation (2026-05-18).
 *
 * Read-only. Returns:
 *   1. auto_reply_settings.singleton ドキュメント全文 (countries map)
 *   2. 各 reply_templates のサマリ (id / country / category / name /
 *      autoReply / langs / content_length / content_preview)
 *   3. 各国 settings の template_id がどのように解決されるかの分析:
 *        - template_id の値そのもの
 *        - ObjectId.isValid() 結果
 *        - reply_templates に matching doc が存在するか
 *        - 存在するなら content が空文字 / whitespace のみでないか
 *        - resolveTemplateContent 相当の結果 (null / text)
 *
 * 認証: Authorization: Bearer ${CRON_SECRET}
 *
 * TO BE DELETED after investigation completes (cf. 1a3abf8 / 6bbbc39 pattern).
 */

export const maxDuration = 30;

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
  created_at?: Date;
};

type TemplateDoc = {
  _id: ObjectId;
  country: string;
  category: string;
  name: string;
  content?: string;
  autoReply?: boolean;
  langs?: string[];
  created_at?: Date;
  updated_at?: Date;
};

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settingsCol = await getCollection<AutoReplyDoc>("auto_reply_settings");
    const templatesCol = await getCollection<TemplateDoc>("reply_templates");

    const settingsDoc = await settingsCol.findOne({ _id: "singleton" });
    const templateDocs = await templatesCol.find({}).toArray();

    const templates = templateDocs.map((t) => {
      const raw = t.content;
      const content =
        typeof raw === "string" ? raw : raw == null ? "" : String(raw);
      const trimmed = content.trim();
      const preview =
        content.length > 80
          ? `${content.slice(0, 80)}…(+${content.length - 80} chars)`
          : content;
      return {
        id: t._id.toHexString(),
        country: t.country,
        category: t.category,
        name: t.name,
        autoReply: t.autoReply ?? null,
        langs: t.langs ?? null,
        content_present: typeof raw === "string",
        content_typeof: typeof raw,
        content_length_raw: content.length,
        content_length_trimmed: trimmed.length,
        content_preview: preview,
        updated_at: t.updated_at ?? null,
      };
    });

    const templatesById = new Map(
      templateDocs.map((t) => [t._id.toHexString(), t])
    );

    const countriesAnalysis: Record<string, unknown> = {};
    const countries = settingsDoc?.countries ?? {};
    for (const [country, cfg] of Object.entries(countries)) {
      const tid = cfg?.template_id ?? null;
      const tidStr = typeof tid === "string" ? tid.trim() : null;
      const isValidObjectId = tidStr ? ObjectId.isValid(tidStr) : false;
      const matched = tidStr ? templatesById.get(tidStr) : null;
      const rawContent = matched?.content;
      const contentStr =
        typeof rawContent === "string"
          ? rawContent
          : rawContent == null
            ? ""
            : String(rawContent);
      const trimmed = contentStr.trim();
      const resolveResult: string | null = matched ? trimmed || null : null;

      countriesAnalysis[country] = {
        enabled: cfg.enabled,
        triggerHour: cfg.triggerHour,
        template_id_raw: tid,
        template_id_str: tidStr,
        template_id_empty: !tidStr,
        template_id_valid_objectid: isValidObjectId,
        matching_template_found: !!matched,
        matched_template_summary: matched
          ? {
              id: matched._id.toHexString(),
              country: matched.country,
              name: matched.name,
              content_typeof: typeof rawContent,
              content_length_raw: contentStr.length,
              content_length_trimmed: trimmed.length,
            }
          : null,
        resolveTemplateContent_simulated: resolveResult,
        would_skip_pre_send:
          !isValidObjectId || !matched || trimmed.length === 0,
      };
    }

    return NextResponse.json({
      now: new Date().toISOString(),
      settings: {
        _id: settingsDoc?._id ?? null,
        countries: settingsDoc?.countries ?? null,
        updated_at: settingsDoc?.updated_at ?? null,
        created_at: settingsDoc?.created_at ?? null,
      },
      templates_count: templates.length,
      templates,
      countries_analysis: countriesAnalysis,
    });
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
