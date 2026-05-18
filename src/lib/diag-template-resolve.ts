import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/mongodb";

/**
 * Temporary diagnostic helper for "auto-reply: template content empty/missing"
 * investigation (2026-05-18). To be deleted alongside
 * `app/api/admin/diag-template-resolve/route.ts` after the root cause is fixed.
 *
 * Pure DB reads (auto_reply_settings + reply_templates). No mutation.
 */

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

export type TemplateResolveDiag = {
  now: string;
  settings: {
    _id: string | null;
    countries: Record<string, AutoReplyCountryCfg> | null;
    updated_at: Date | null;
    created_at: Date | null;
  };
  templates_count: number;
  templates: Array<{
    id: string;
    country: string;
    category: string;
    name: string;
    autoReply: boolean | null;
    langs: string[] | null;
    content_present: boolean;
    content_typeof: string;
    content_length_raw: number;
    content_length_trimmed: number;
    content_preview: string;
    updated_at: Date | null;
  }>;
  countries_analysis: Record<
    string,
    {
      enabled: boolean;
      triggerHour: number;
      template_id_raw: string | null;
      template_id_str: string | null;
      template_id_empty: boolean;
      template_id_valid_objectid: boolean;
      matching_template_found: boolean;
      matched_template_summary: {
        id: string;
        country: string;
        name: string;
        content_typeof: string;
        content_length_raw: number;
        content_length_trimmed: number;
      } | null;
      resolveTemplateContent_simulated: string | null;
      would_skip_pre_send: boolean;
    }
  >;
};

export async function computeTemplateResolveDiag(): Promise<TemplateResolveDiag> {
  const settingsCol = await getCollection<AutoReplyDoc>("auto_reply_settings");
  const templatesCol = await getCollection<TemplateDoc>("reply_templates");

  const settingsDoc = await settingsCol.findOne({ _id: "singleton" });
  const templateDocs = await templatesCol.find({}).toArray();

  const templates: TemplateResolveDiag["templates"] = templateDocs.map((t) => {
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

  const countriesAnalysis: TemplateResolveDiag["countries_analysis"] = {};
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

  return {
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
  };
}

/**
 * Compute the diag result AND dump it to console.log as structured JSON so it
 * appears in Vercel Logs without requiring an HTTP curl with CRON_SECRET.
 * `label` distinguishes invocation sources (e.g. "cron", "admin-endpoint").
 */
export async function logTemplateResolveDiag(label: string): Promise<void> {
  try {
    const result = await computeTemplateResolveDiag();
    console.log(
      `[diag-template/${label}] full result`,
      JSON.stringify(result, null, 2)
    );
  } catch (e) {
    console.error(`[diag-template/${label}] failed`, e);
  }
}
