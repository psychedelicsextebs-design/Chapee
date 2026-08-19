import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { getCollection } from "@/lib/mongodb";

const COL = "auto_reply_settings";
const TEMPLATES_COL = "reply_templates";
const SINGLETON_ID = "singleton";

export type AutoReplyCountryStored = {
  enabled: boolean;
  triggerHour: number;
  /** `reply_templates` のドキュメント ID */
  template_id: string;
  subAccounts?: { id: string; name: string; enabled: boolean }[];
};

type AutoReplyDoc = {
  _id: string;
  countries: Record<string, AutoReplyCountryStored>;
  updated_at?: Date;
  created_at?: Date;
};

type TemplateDoc = {
  _id: ObjectId;
  content?: string;
};

async function requireSession() {
  const cookieStore = await cookies();
  return getSession(cookieStore);
}

/**
 * 層2 (SKILL.md「バリデーションは書込側と読出側の両方で行う」):
 * 保存済 countries と reply_templates を突合して、 各 country の template_id が
 *   - orphan (実在しない): `template_orphans[country] = <id>`
 *   - 実在するが content が空: `empty_content[country] = <id>`
 * を検出する。 UI (auto-reply page) と dashboard で警告表示する。
 */
function detectTemplateIssues(
  countries: Record<string, AutoReplyCountryStored>,
  templates: TemplateDoc[]
): {
  template_orphans: Record<string, string>;
  empty_content: Record<string, string>;
} {
  const validIds = new Set(templates.map((t) => String(t._id)));
  const emptyContentIds = new Set(
    templates.filter((t) => !t.content?.trim()).map((t) => String(t._id))
  );
  const template_orphans: Record<string, string> = {};
  const empty_content: Record<string, string> = {};
  for (const [country, cfg] of Object.entries(countries)) {
    const tid = String(cfg?.template_id ?? "").trim();
    if (!tid) continue; // 空は許容 (auto-reply 実質無効化)
    if (!validIds.has(tid)) {
      template_orphans[country] = tid;
    } else if (emptyContentIds.has(tid)) {
      empty_content[country] = tid;
    }
  }
  return { template_orphans, empty_content };
}

/**
 * GET /api/settings/auto-reply — 国別自動返信設定 + 不整合検出
 *
 * response:
 *   countries         国別 cfg
 *   updated_at        最終更新時刻
 *   template_orphans  {country: template_id} orphan (reply_templates に不在)
 *   empty_content     {country: template_id} 実在するが content 空 (fallback 発火予兆)
 */
export async function GET() {
  const session = await requireSession();
  if (!session.valid) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  try {
    const col = await getCollection<AutoReplyDoc>(COL);
    const doc = await col.findOne({ _id: SINGLETON_ID });
    const countries = doc?.countries ?? {};

    const tplCol = await getCollection<TemplateDoc>(TEMPLATES_COL);
    const templates = await tplCol
      .find({})
      .project<TemplateDoc>({ _id: 1, content: 1 })
      .toArray();

    const issues = detectTemplateIssues(countries, templates);

    return NextResponse.json({
      countries,
      updated_at: doc?.updated_at ?? null,
      ...issues,
    });
  } catch (e) {
    console.error("[auto-reply GET]", e);
    return NextResponse.json({ error: "読み込みに失敗しました" }, { status: 500 });
  }
}

/**
 * PUT /api/settings/auto-reply — body: { countries: Record<string, AutoReplyCountryStored> }
 *
 * 層1 (SKILL.md「バリデーションは書込側と読出側の両方で行う」):
 *   template_id を validate:
 *     - 空文字は許容 (auto-reply 実質無効化と等価)
 *     - 非空なら ObjectId 形式必須 + reply_templates に実在必須
 *   validation 失敗時は 400 で拒否 (silent 保存を止める)
 */
export async function PUT(request: NextRequest) {
  const session = await requireSession();
  if (!session.valid) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as {
      countries?: Record<string, AutoReplyCountryStored>;
    };
    if (!body.countries || typeof body.countries !== "object") {
      return NextResponse.json({ error: "countries が必要です" }, { status: 400 });
    }

    const tplCol = await getCollection<{ _id: ObjectId }>(TEMPLATES_COL);
    const tplDocs = await tplCol.find({}).project<{ _id: ObjectId }>({ _id: 1 }).toArray();
    const validIds = new Set(tplDocs.map((d) => String(d._id)));

    const errors: Array<{
      country: string;
      template_id: string;
      reason: string;
    }> = [];
    for (const [country, cfg] of Object.entries(body.countries)) {
      const tid = String(cfg?.template_id ?? "").trim();
      if (!tid) continue; // 空は許容
      if (!ObjectId.isValid(tid)) {
        errors.push({
          country,
          template_id: tid,
          reason: "invalid ObjectId format",
        });
        continue;
      }
      if (!validIds.has(tid)) {
        errors.push({
          country,
          template_id: tid,
          reason: "template not found in reply_templates (orphan)",
        });
      }
    }

    if (errors.length > 0) {
      console.warn("[auto-reply PUT] validation failed", errors);
      return NextResponse.json(
        {
          error: "template_id validation failed",
          details: errors,
        },
        { status: 400 }
      );
    }

    const col = await getCollection<AutoReplyDoc>(COL);
    await col.updateOne(
      { _id: SINGLETON_ID },
      {
        $set: {
          countries: body.countries,
          updated_at: new Date(),
        },
        $setOnInsert: {
          _id: SINGLETON_ID,
          created_at: new Date(),
        },
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[auto-reply PUT]", e);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}
