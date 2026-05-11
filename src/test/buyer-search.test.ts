import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted) =====

const convToArray = vi.fn();
const convProject = vi.fn(() => ({ toArray: convToArray }));
const convFind = vi.fn(() => ({ project: convProject }));
const mockConvCollection = { find: convFind };

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockConvCollection),
}));

vi.mock("@/lib/shopee-api", () => ({
  getOrderList: vi.fn(),
  getOrderDetail: vi.fn(),
  SHOPEE_ORDER_LIST_MAX_RANGE_SEC: 15 * 24 * 60 * 60,
}));

vi.mock("@/lib/shopee-token", () => ({
  getValidToken: vi.fn(async () => "dummy_token"),
  resolveCountryForShop: vi.fn(async () => "SG"),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/buyers/search/route";
import { getOrderList, getOrderDetail } from "@/lib/shopee-api";

// ===== Fixtures =====

const SHOP_ID = 2032481;

function buildListResponse(orderSns: string[]) {
  return {
    response: {
      order_list: orderSns.map((sn) => ({ order_sn: sn })),
    },
  };
}

function buildDetailResponse(
  orders: Array<{
    order_sn: string;
    buyer_user_id: number;
    buyer_username: string;
    item_name?: string;
    create_time?: number;
    currency?: string;
    total_amount?: number;
  }>,
) {
  return {
    response: {
      order_list: orders.map((o) => ({
        order_sn: o.order_sn,
        buyer_user_id: o.buyer_user_id,
        buyer_username: o.buyer_username,
        item_list: [{ item_name: o.item_name ?? "Item Name" }],
        create_time: o.create_time ?? Math.floor(Date.now() / 1000),
        currency: o.currency ?? "SGD",
        total_amount: o.total_amount ?? 1234,
      })),
    },
  };
}

function makeRequest(searchParams: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/buyers/search");
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  convToArray.mockResolvedValue([]); // 既存会話なし default
});

// ============================================================================
// Validation
// ============================================================================

describe("/api/buyers/search — validation", () => {
  it("returns 400 when shop_id is missing", async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("shop_id");
  });

  it("returns 400 when shop_id is non-numeric", async () => {
    const res = await GET(makeRequest({ shop_id: "abc" }));
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// Filter behavior
// ============================================================================

describe("/api/buyers/search — q filter behavior", () => {
  beforeEach(() => {
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse(["240509AAA", "240510BBB", "240511CCC"]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([
        { order_sn: "240509AAA", buyer_user_id: 1001, buyer_username: "sunrainsky" },
        { order_sn: "240510BBB", buyer_user_id: 1002, buyer_username: "toyota_seg" },
        { order_sn: "240511CCC", buyer_user_id: 1003, buyer_username: "alice_buyer" },
      ]),
    );
  });

  it("returns all orders when q is empty (case 3)", async () => {
    const res = await GET(makeRequest({ shop_id: String(SHOP_ID) }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(3);
  });

  it("filters by order_sn partial match when q is all digits (case 1)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "240509" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].order_sn).toBe("240509AAA");
  });

  it("filters by buyer_username partial match (case-insensitive) when q is text (case 2)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "TOYOTA" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].buyer_username).toBe("toyota_seg");
  });

  it("returns empty array when no match", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "nonexistent" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toEqual([]);
  });
});

// ============================================================================
// has_conversation flag
// ============================================================================

describe("/api/buyers/search — has_conversation flag (case 4)", () => {
  beforeEach(() => {
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse(["240509AAA", "240510BBB"]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([
        { order_sn: "240509AAA", buyer_user_id: 1001, buyer_username: "alice" },
        { order_sn: "240510BBB", buyer_user_id: 1002, buyer_username: "bob" },
      ]),
    );
  });

  it("sets has_conversation=true for buyers with existing conversation", async () => {
    // 1001 だけ会話あり、 1002 はなし
    convToArray.mockResolvedValueOnce([
      { conversation_id: "conv-1001", customer_id: 1001 },
    ]);
    const res = await GET(makeRequest({ shop_id: String(SHOP_ID) }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const alice = data.buyers.find(
      (b: { buyer_user_id: number }) => b.buyer_user_id === 1001,
    );
    const bob = data.buyers.find(
      (b: { buyer_user_id: number }) => b.buyer_user_id === 1002,
    );
    expect(alice.has_conversation).toBe(true);
    expect(alice.conversation_id).toBe("conv-1001");
    expect(bob.has_conversation).toBe(false);
    expect(bob.conversation_id).toBeNull();
  });

  it("queries shopee_conversations with shop_id + customer_id $in", async () => {
    convToArray.mockResolvedValueOnce([]);
    await GET(makeRequest({ shop_id: String(SHOP_ID) }));
    expect(convFind).toHaveBeenCalledWith({
      shop_id: SHOP_ID,
      customer_id: { $in: expect.arrayContaining([1001, 1002]) },
    });
  });
});

// ============================================================================
// Window range / pagination
// ============================================================================

describe("/api/buyers/search — window range", () => {
  it("uses default 30 days when days param is omitted", async () => {
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse([]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([]),
    );
    await GET(makeRequest({ shop_id: String(SHOP_ID) }));
    // 30 日 / 15 日 = 2 windows
    expect(getOrderList).toHaveBeenCalledTimes(2);
  });

  it("clamps days to max 90", async () => {
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse([]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([]),
    );
    await GET(makeRequest({ shop_id: String(SHOP_ID), days: "365" }));
    // 90 日 / 15 日 = 6 windows
    expect(getOrderList).toHaveBeenCalledTimes(6);
  });
});
