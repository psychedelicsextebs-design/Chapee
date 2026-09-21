import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====

const mockCol = { find: vi.fn() };

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockCol),
}));

import { NextRequest } from "next/server";
import { GET, STALL_WARNING_HOURS } from "../../app/api/chats/route";

// find().sort().limit().toArray() のチェーンを模倣する
function chain(docs: unknown[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(docs),
  };
}

function req(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/chats${qs}`);
}

const HOUR_MS = 3600_000;

function convDoc(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    conversation_id: "convX",
    shop_id: 1,
    country: "SG",
    customer_id: 111,
    customer_name: "test buyer",
    last_message: "hi",
    last_message_time: now,
    unread_count: 0,
    pinned: false,
    status: "active",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * 結果ベース検知 (stall) は auto-reply の分類/pending/gave_up 状態に
 * 一切依存しない独立判定であることを担保するテスト。
 */
describe("GET /api/chats — stall detection (結果ベース検知 2026-09-21)", () => {
  it("STALL_WARNING_HOURS = 10 (ハードコード確認)", () => {
    expect(STALL_WARNING_HOURS).toBe(10);
  });

  it("elapsed < 10h → stall=false", async () => {
    const t = new Date(Date.now() - 9 * HOUR_MS); // 9h ago
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "c1",
          unread_count: 1, // handling_status=unreplied
          last_message_time: t,
          last_buyer_message_time: t,
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as { chats: Array<{ stall: boolean }> };
    expect(json.chats[0].stall).toBe(false);
  });

  it("elapsed >= 10h AND handling=unreplied → stall=true", async () => {
    const t = new Date(Date.now() - 11 * HOUR_MS); // 11h ago
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "c2",
          unread_count: 1,
          last_message_time: t,
          last_buyer_message_time: t,
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as { chats: Array<{ stall: boolean }> };
    expect(json.chats[0].stall).toBe(true);
  });

  it("境界値 elapsed = 10h ちょうど → stall=true (>= 判定)", async () => {
    // 10h 丁度は inclusive で stall。 実装は elapsed.toFixed(1) の値と
    // STALL_WARNING_HOURS を比較するので、 若干のドリフトを避けて 10.05h 使う。
    const t = new Date(Date.now() - 10.05 * HOUR_MS);
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "c-bnd",
          unread_count: 1,
          last_message_time: t,
          last_buyer_message_time: t,
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as { chats: Array<{ stall: boolean }> };
    expect(json.chats[0].stall).toBe(true);
  });

  it("elapsed >= 10h だが handling=completed → stall=false (返信済扱い)", async () => {
    // completed の場合、 buyer からの発信 (20h 前) の後に staff が返信 or 完了
    // マークをしており、 last_message_time は buyer より後 (buyerLast=false)。
    // resolveHandlingStatus は buyerLast=false のとき stored="completed" をそのまま返す。
    const buyerT = new Date(Date.now() - 20 * HOUR_MS);
    const lmt = new Date(Date.now() - 5 * HOUR_MS); // staff/完了マークが最新
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "c3",
          unread_count: 0,
          last_message_time: lmt,
          last_buyer_message_time: buyerT,
          handling_status: "completed",
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as {
      chats: Array<{ stall: boolean; handling_status: string; elapsed: number }>;
    };
    expect(json.chats[0].handling_status).toBe("completed");
    // elapsed は buyer 発信時刻 (20h 前) 基準
    expect(json.chats[0].elapsed).toBeGreaterThanOrEqual(STALL_WARNING_HOURS);
    // それでも handling=completed なので stall=false
    expect(json.chats[0].stall).toBe(false);
  });

  it("elapsed >= 10h だが handling=auto_replied_pending → stall=false (Shopee カウント済)", async () => {
    // 自動返信が届いていれば Shopee 応答率は満たされているので stall ではない。
    const buyerT = new Date(Date.now() - 20 * HOUR_MS);
    const lmt = new Date(Date.now() - 5 * HOUR_MS); // staff が最新
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "c4",
          unread_count: 0,
          last_message_time: lmt,
          last_buyer_message_time: buyerT,
          handling_status: "auto_replied_pending",
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as {
      chats: Array<{ stall: boolean; handling_status: string }>;
    };
    expect(json.chats[0].handling_status).toBe("auto_replied_pending");
    expect(json.chats[0].stall).toBe(false);
  });

  it("chat_type=notification は elapsed >= 10h でも stall=false", async () => {
    const t = new Date(Date.now() - 20 * HOUR_MS);
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "notif1",
          chat_type: "notification",
          unread_count: 1,
          last_message_time: t,
          last_buyer_message_time: t,
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as {
      chats: Array<{ stall: boolean; type: string }>;
    };
    expect(json.chats[0].type).toBe("notification");
    expect(json.chats[0].stall).toBe(false);
  });

  it("独立性: auto_reply_gave_up_at 未 set でも elapsed 条件のみで stall 判定", async () => {
    // give_up_at が set されていなくても、 elapsed 10h & unreplied なら stall。
    // auto-reply 側のバグで pending / gave_up が立たなくても検知できる = 独立性の実証。
    const t = new Date(Date.now() - 11 * HOUR_MS);
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "indep",
          unread_count: 1,
          last_message_time: t,
          last_buyer_message_time: t,
          // auto_reply_gave_up_at: 意図的に未 set (undefined)
          // auto_reply_pending: 意図的に未 set
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as {
      chats: Array<{ stall: boolean; give_up: boolean }>;
    };
    expect(json.chats[0].give_up).toBe(false);
    expect(json.chats[0].stall).toBe(true);
  });

  it("独立性: give_up=true と stall=true は共存可能 (両方 true)", async () => {
    const t = new Date(Date.now() - 15 * HOUR_MS);
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "both",
          unread_count: 1,
          last_message_time: t,
          last_buyer_message_time: t,
          auto_reply_gave_up_at: new Date(),
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as {
      chats: Array<{ stall: boolean; give_up: boolean }>;
    };
    expect(json.chats[0].give_up).toBe(true);
    expect(json.chats[0].stall).toBe(true);
  });

  it("last_buyer_message_time 未 set → last_message_time フォールバックで elapsed 算出", async () => {
    const t = new Date(Date.now() - 12 * HOUR_MS);
    mockCol.find.mockReturnValue(
      chain([
        convDoc({
          conversation_id: "fb",
          unread_count: 1,
          last_message_time: t,
          // last_buyer_message_time: 明示的に未 set
        }),
      ])
    );
    const res = await GET(req());
    const json = (await res.json()) as {
      chats: Array<{ stall: boolean; elapsed: number }>;
    };
    expect(json.chats[0].elapsed).toBeGreaterThanOrEqual(STALL_WARNING_HOURS);
    expect(json.chats[0].stall).toBe(true);
  });
});
