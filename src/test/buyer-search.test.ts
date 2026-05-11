import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted) =====

const convToArray = vi.fn();
const convProject = vi.fn(() => ({ toArray: convToArray }));
const convFind = vi.fn(() => ({ project: convProject }));
const mockConvCollection = { find: convFind };

// shopee_tokens 用 (multi-shop fan-out テストで上書き)
const tokensToArray = vi.fn(async () => [] as Array<{ shop_id: number }>);
const tokensProject = vi.fn(() => ({ toArray: tokensToArray }));
const tokensFind = vi.fn(() => ({ project: tokensProject }));
const mockTokensCollection = { find: tokensFind };

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async (name: string) =>
    name === "shopee_tokens" ? mockTokensCollection : mockConvCollection,
  ),
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
import {
  GET,
  __clearBuyerSearchCacheForTest,
} from "../../app/api/buyers/search/route";
import {
  getOrderList,
  getOrderDetail,
} from "@/lib/shopee-api";
import { resolveCountryForShop } from "@/lib/shopee-token";

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
  tokensToArray.mockResolvedValue([]); // 連携 shop なし default (shop_id 明示テストで使われない)
  __clearBuyerSearchCacheForTest(); // in-process cache をテスト間で隔離
});

// ============================================================================
// Validation
// ============================================================================

describe("/api/buyers/search — validation", () => {
  it("returns 200 with empty buyers when shop_id is missing and no connected shops", async () => {
    // shop_id 省略時は全 shop 並列検索。 連携 shop ゼロなら空配列。
    tokensToArray.mockResolvedValueOnce([]);
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toEqual([]);
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
// Alphanumeric order_sn matching (regression: 26051154AEC7M7 bug)
// ============================================================================

describe("/api/buyers/search — alphanumeric order_sn matching", () => {
  beforeEach(() => {
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse(["26051154AEC7M7", "26052200ZZZ9Q9", "25123199ABCDEF"]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([
        { order_sn: "26051154AEC7M7", buyer_user_id: 2001, buyer_username: "handofz" },
        { order_sn: "26052200ZZZ9Q9", buyer_user_id: 2002, buyer_username: "second_buyer" },
        { order_sn: "25123199ABCDEF", buyer_user_id: 2003, buyer_username: "third_buyer" },
      ]),
    );
  });

  it("hits on full alphanumeric order_sn (26051154AEC7M7)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "26051154AEC7M7" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].order_sn).toBe("26051154AEC7M7");
  });

  it("hits on order_sn digit-prefix (26051154)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "26051154" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].order_sn).toBe("26051154AEC7M7");
  });

  it("hits on order_sn alphanumeric suffix (AEC7M7)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "AEC7M7" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].order_sn).toBe("26051154AEC7M7");
  });

  it("hits on order_sn lower-case (26051154aec7m7)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "26051154aec7m7" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].order_sn).toBe("26051154AEC7M7");
  });

  it("hits on buyer_username (handofz)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "handofz" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].buyer_username).toBe("handofz");
  });

  it("hits on uppercase buyer_username (HANDOFZ)", async () => {
    const res = await GET(
      makeRequest({ shop_id: String(SHOP_ID), q: "HANDOFZ" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].buyer_username).toBe("handofz");
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

// ============================================================================
// In-process cache (TTL 60s, key = `${shop_id}:${q}:${days}`)
// ============================================================================

describe("/api/buyers/search — in-process cache", () => {
  beforeEach(() => {
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse(["240509AAA"]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([
        { order_sn: "240509AAA", buyer_user_id: 1001, buyer_username: "cache_buyer" },
      ]),
    );
  });

  it("serves second identical query from cache (no extra Shopee calls)", async () => {
    const params = { shop_id: String(SHOP_ID), q: "cache_buyer", days: "30" };
    await GET(makeRequest(params));
    const callsAfterFirst = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 2 回目: 同一 key → cache 直返し
    await GET(makeRequest(params));
    const callsAfterSecond = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("treats different q as separate cache entries", async () => {
    await GET(makeRequest({ shop_id: String(SHOP_ID), q: "first" }));
    const after1 = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await GET(makeRequest({ shop_id: String(SHOP_ID), q: "second" }));
    const after2 = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after2).toBeGreaterThan(after1);
  });

  it("re-fetches after explicit cache clear (simulates TTL expiry)", async () => {
    const params = { shop_id: String(SHOP_ID), q: "ttl_test" };
    await GET(makeRequest(params));
    const after1 = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    __clearBuyerSearchCacheForTest();

    await GET(makeRequest(params));
    const after2 = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after2).toBeGreaterThan(after1);
  });
});

// ============================================================================
// Multi-shop fan-out when shop_id is omitted (STEP 4)
// ============================================================================

describe("/api/buyers/search — multi-shop parallel fan-out", () => {
  it("queries each connected shop and merges results", async () => {
    // 連携 shop が 2 つ
    tokensToArray.mockResolvedValueOnce([
      { shop_id: 1001 },
      { shop_id: 1002 },
    ]);
    // 各 shop が返す order_sn は別物
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_token: string, shopId: number) => {
        return buildListResponse([`SN-${shopId}-A`]);
      },
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_token: string, shopId: number, sns: string[]) => {
        return buildDetailResponse(
          sns.map((sn) => ({
            order_sn: sn,
            buyer_user_id: shopId,
            buyer_username: `buyer_${shopId}`,
          })),
        );
      },
    );

    const res = await GET(makeRequest({}));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.buyers).toHaveLength(2);
    const shopIds = data.buyers.map(
      (b: { shop_id: number }) => b.shop_id,
    );
    expect(shopIds).toContain(1001);
    expect(shopIds).toContain(1002);
  });

  it("ignores country filter — all connected shops are queried regardless of country", async () => {
    tokensToArray.mockResolvedValueOnce([
      { shop_id: 1001 },
      { shop_id: 1002 },
    ]);
    // 各 shop で異なる country を返すよう resolveCountryForShop mock
    (resolveCountryForShop as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (shopId: number) => (shopId === 1001 ? "SG" : "MY"),
    );
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildListResponse([]),
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildDetailResponse([]),
    );

    await GET(makeRequest({}));

    // 国フィルタは無視 = 両方の shop で getOrderList が呼ばれた
    const calls = (getOrderList as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const calledShopIds = new Set(calls.map((c) => c[1])); // 2 番目の引数が shopId
    expect(calledShopIds.has(1001)).toBe(true);
    expect(calledShopIds.has(1002)).toBe(true);
  });

  it("returns partial results when one shop fails", async () => {
    tokensToArray.mockResolvedValueOnce([
      { shop_id: 1001 },
      { shop_id: 1002 },
    ]);
    (getOrderList as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_token: string, shopId: number) => {
        if (shopId === 1001) throw new Error("simulated shop 1001 failure");
        return buildListResponse([`SN-${shopId}-A`]);
      },
    );
    (getOrderDetail as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_token: string, shopId: number, sns: string[]) => {
        return buildDetailResponse(
          sns.map((sn) => ({
            order_sn: sn,
            buyer_user_id: shopId,
            buyer_username: `buyer_${shopId}`,
          })),
        );
      },
    );

    const res = await GET(makeRequest({}));
    expect(res.status).toBe(200);
    const data = await res.json();
    // shop 1001 は order_list 全 window 失敗 → 0 件、 shop 1002 のみ 1 件
    expect(data.buyers).toHaveLength(1);
    expect(data.buyers[0].shop_id).toBe(1002);
  });
});
