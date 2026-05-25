import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====

const mockCol = { find: vi.fn() };

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockCol),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/chats/route";

// find().sort().limit().toArray() のチェーンを模倣する
function chain(docs: unknown[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(docs),
  };
}

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/chats${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/chats — chat_type フィルタ (Shopee通知フィルタの土台)", () => {
  it("type=notification は chat_type=notification に絞る", async () => {
    mockCol.find.mockReturnValue(chain([]));
    await GET(req("?type=notification"));
    expect(mockCol.find).toHaveBeenCalledWith(
      expect.objectContaining({ chat_type: "notification" })
    );
  });

  it("exclude_chat_types=notification は通知を除外する (既定の挙動)", async () => {
    mockCol.find.mockReturnValue(chain([]));
    await GET(req("?exclude_chat_types=notification"));
    expect(mockCol.find).toHaveBeenCalledWith(
      expect.objectContaining({ chat_type: { $nin: ["notification"] } })
    );
  });

  it("不正な type は無視される (chat_type で絞らない)", async () => {
    mockCol.find.mockReturnValue(chain([]));
    await GET(req("?type=bogus"));
    const filter = mockCol.find.mock.calls[0][0];
    expect(filter).not.toHaveProperty("chat_type");
  });

  it("type=notification は通知の行のみを返す", async () => {
    const now = new Date();
    mockCol.find.mockReturnValue(
      chain([
        {
          conversation_id: "n1",
          shop_id: 1,
          country: "SG",
          customer_id: 0,
          customer_name: "Shopee通知",
          last_message: "Parcel Delivered",
          last_message_time: now,
          chat_type: "notification",
          unread_count: 0,
          pinned: false,
          status: "resolved",
          created_at: now,
          updated_at: now,
        },
      ])
    );
    const res = await GET(req("?type=notification"));
    const json = await res.json();
    expect(json.chats).toHaveLength(1);
    expect(json.chats[0].type).toBe("notification");
  });
});
