import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import {
  loadOrSeedPhase2TriggerSettings,
  savePhase2TriggerSettings,
} from "@/lib/phase2-trigger-settings";

/**
 * GET / PUT /api/settings/event-triggered
 *
 * Phase 2 イベント駆動メッセージ (注文確定 / 追跡番号 / 配達後 +3d) の
 * 国別 enabled + テンプレート選択を保持する singleton 設定。
 *
 * 既存の /api/settings/auto-reply (バイヤー無返答 → 時限テンプレ送信) とは
 * 別概念のため別エンドポイント・別コレクション。
 */

async function requireSession() {
  const cookieStore = await cookies();
  return getSession(cookieStore);
}

export async function GET() {
  const session = await requireSession();
  if (!session.valid) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  try {
    const s = await loadOrSeedPhase2TriggerSettings();
    return NextResponse.json({
      triggers: s.triggers,
      updated_at: s.updated_at,
    });
  } catch (e) {
    console.error("[settings/event-triggered GET]", e);
    return NextResponse.json(
      { error: "読み込みに失敗しました" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const session = await requireSession();
  if (!session.valid) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as {
      triggers?: Record<string, unknown>;
    };
    if (!body.triggers || typeof body.triggers !== "object") {
      return NextResponse.json(
        { error: "triggers が必要です" },
        { status: 400 }
      );
    }
    const saved = await savePhase2TriggerSettings({ triggers: body.triggers });
    return NextResponse.json({
      ok: true,
      triggers: saved.triggers,
      updated_at: saved.updated_at,
    });
  } catch (e) {
    console.error("[settings/event-triggered PUT]", e);
    return NextResponse.json(
      { error: "保存に失敗しました" },
      { status: 500 }
    );
  }
}
