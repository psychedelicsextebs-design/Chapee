import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mocks ----------------------------------------------------------------
const mockCollection = {
  find: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockCollection),
}));

// alias `@/` は ./src/ 解決なので、 root 直下の `app/` は相対 import で参照する
import { GET } from "../../app/api/health/token-freshness/route";
import type { NextRequest } from "next/server";

function dummyReq(): NextRequest {
  // 実装は request 引数を使わない (_request として無視) ので minimal stub で足りる
  return {} as unknown as NextRequest;
}

function daysAgoDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe("GET /api/health/token-freshness", () => {
  beforeEach(() => {
    mockCollection.find.mockReset();
    delete process.env.TOKEN_STALE_ALERT_DAYS;
  });

  function setupTokens(
    rows: Array<{
      shop_id: number;
      country?: string;
      shop_name?: string;
      updated_at?: Date;
    }>
  ) {
    mockCollection.find.mockReturnValue({
      toArray: async () => rows,
    });
  }

  it("全 shop 新鮮 (< 40 日) → 200 + status='ok'", async () => {
    setupTokens([
      {
        shop_id: 100,
        country: "SG",
        shop_name: "Shop A",
        updated_at: daysAgoDate(5),
      },
      {
        shop_id: 200,
        country: "MY",
        shop_name: "Shop B",
        updated_at: daysAgoDate(10),
      },
    ]);
    const res = await GET(dummyReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      shops: Array<{ shop_id: number; stale: boolean; days_since_update: number }>;
    };
    expect(body.status).toBe("ok");
    expect(body.shops.every((s) => !s.stale)).toBe(true);
    expect(body.shops[0].days_since_update).toBe(5);
    expect(body.shops[1].days_since_update).toBe(10);
  });

  it("1 shop stale (40 日以上前) → 500 + status='stale'", async () => {
    setupTokens([
      { shop_id: 100, country: "SG", updated_at: daysAgoDate(5) },
      {
        shop_id: 200,
        country: "MY",
        shop_name: "Craneshop.my",
        updated_at: daysAgoDate(45),
      },
    ]);
    const res = await GET(dummyReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      status: string;
      shops: Array<{ shop_id: number; stale: boolean; days_since_update: number }>;
    };
    expect(body.status).toBe("stale");
    const stale = body.shops.filter((s) => s.stale);
    expect(stale).toHaveLength(1);
    expect(stale[0].shop_id).toBe(200);
    expect(stale[0].days_since_update).toBe(45);
  });

  it("Mongo throw → 500 + status='error'", async () => {
    mockCollection.find.mockImplementation(() => {
      throw new Error("Mongo connection lost");
    });
    // avoid console.error noise
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(dummyReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toBe("Mongo connection lost");
    errSpy.mockRestore();
  });

  it("env TOKEN_STALE_ALERT_DAYS=30 → 30日で判定", async () => {
    process.env.TOKEN_STALE_ALERT_DAYS = "30";
    setupTokens([
      { shop_id: 100, country: "SG", updated_at: daysAgoDate(35) },
    ]);
    const res = await GET(dummyReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      stale_days_threshold: number;
      shops: Array<{ stale: boolean }>;
    };
    expect(body.stale_days_threshold).toBe(30);
    expect(body.shops[0].stale).toBe(true);
  });

  it("env 不正値 → デフォルト 40 に fallback", async () => {
    process.env.TOKEN_STALE_ALERT_DAYS = "not-a-number";
    setupTokens([
      { shop_id: 100, country: "SG", updated_at: daysAgoDate(35) },
    ]);
    const res = await GET(dummyReq());
    // 35 < 40 → healthy
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stale_days_threshold: number };
    expect(body.stale_days_threshold).toBe(40);
  });

  it("updated_at が Date でない (missing) → stale 扱い (Infinity days)", async () => {
    setupTokens([
      { shop_id: 100, country: "SG" }, // updated_at 欠損
    ]);
    const res = await GET(dummyReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      shops: Array<{ stale: boolean; days_since_update: number | null }>;
    };
    expect(body.shops[0].stale).toBe(true);
    expect(body.shops[0].days_since_update).toBe(null);
  });

  it("projection で access_token / refresh_token を除外 (呼出引数検証)", async () => {
    setupTokens([]);
    await GET(dummyReq());
    expect(mockCollection.find).toHaveBeenCalledTimes(1);
    const [filter, options] = mockCollection.find.mock.calls[0];
    expect(filter).toEqual({});
    expect(options.projection).toEqual({
      shop_id: 1,
      country: 1,
      shop_name: 1,
      updated_at: 1,
      _id: 0,
    });
    // access_token / refresh_token は projection に含まれない (= 返らない)
    expect(options.projection.access_token).toBeUndefined();
    expect(options.projection.refresh_token).toBeUndefined();
  });

  it("空 shop リスト → 200 (staleShops 0)", async () => {
    setupTokens([]);
    const res = await GET(dummyReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; shops: unknown[] };
    expect(body.status).toBe("ok");
    expect(body.shops).toHaveLength(0);
  });
});
