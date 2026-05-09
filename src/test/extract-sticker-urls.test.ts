import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ---------------------------------------------------------------

const mockCol = {
  find: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockCol),
}));

import { GET } from "../../app/api/admin/extract-sticker-urls/route";
import { NextRequest } from "next/server";

// ---- Helpers -------------------------------------------------------------

function mockFindReturn(docs: Record<string, unknown>[]) {
  const toArray = vi.fn().mockResolvedValue(docs);
  const limit = vi.fn().mockReturnValue({ toArray });
  const sort = vi.fn().mockReturnValue({ limit });
  mockCol.find.mockReturnValue({ sort });
  return { sort, limit, toArray };
}

/**
 * Build a raw shopee chat message doc shape that mirrors what Shopee delivers
 * for a sticker. Multiple known fields are populated so displayFromShopeeChatMessage
 * picks them up via the same flat extraction path used in production.
 */
function stickerDoc(opts: {
  conversation_id: string;
  shop_id: number;
  message_id: string;
  timestamp_ms: number;
  sticker_id: string;
  package_id: string;
  image_url?: string;
}) {
  return {
    conversation_id: opts.conversation_id,
    shop_id: opts.shop_id,
    message_id: opts.message_id,
    timestamp_ms: opts.timestamp_ms,
    synced_at: new Date(opts.timestamp_ms),
    raw: {
      message_type: "sticker",
      from_id: 12345,
      timestamp: Math.floor(opts.timestamp_ms / 1000),
      sticker_id: opts.sticker_id,
      sticker_package_id: opts.package_id,
      ...(opts.image_url ? { image_url: opts.image_url } : {}),
    },
  };
}

// ---- Auth fixture --------------------------------------------------------

let prevSecret: string | undefined;

beforeEach(() => {
  mockCol.find.mockReset();
  prevSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "testsecret";
});

afterEach(() => {
  if (prevSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = prevSecret;
  }
});

function authedReq() {
  return new NextRequest(
    "http://localhost/api/admin/extract-sticker-urls",
    { headers: { authorization: "Bearer testsecret" } }
  );
}

// ===========================================================================
// auth
// ===========================================================================
describe("GET /api/admin/extract-sticker-urls — auth", () => {
  it("returns 500 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(
      new NextRequest("http://localhost/api/admin/extract-sticker-urls")
    );
    expect(res.status).toBe(500);
  });

  it("returns 401 with no auth header", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/extract-sticker-urls")
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong bearer", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/extract-sticker-urls", {
        headers: { authorization: "Bearer wrong" },
      })
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// extraction
// ===========================================================================
describe("GET /api/admin/extract-sticker-urls — extraction", () => {
  it("returns 4 results when all target sticker IDs are present (orangutan_my_new pack)", async () => {
    const T0 = 1_700_000_000_000;
    const docs = [
      stickerDoc({
        conversation_id: "c1",
        shop_id: 100,
        message_id: "m1",
        timestamp_ms: T0,
        sticker_id: "06",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/06.png",
      }),
      stickerDoc({
        conversation_id: "c2",
        shop_id: 100,
        message_id: "m2",
        timestamp_ms: T0 - 1000,
        sticker_id: "29",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/29.png",
      }),
      stickerDoc({
        conversation_id: "c3",
        shop_id: 100,
        message_id: "m3",
        timestamp_ms: T0 - 2000,
        sticker_id: "02",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/02.png",
      }),
      stickerDoc({
        conversation_id: "c4",
        shop_id: 100,
        message_id: "m4",
        timestamp_ms: T0 - 3000,
        sticker_id: "03",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/03.png",
      }),
    ];
    mockFindReturn(docs);

    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.results).toHaveLength(4);
    expect(body.missing_sticker_ids).toEqual([]);

    const idMap = Object.fromEntries(
      (body.results as Array<{ sticker_id: string; image_url: string }>).map((r) => [
        r.sticker_id,
        r.image_url,
      ])
    );
    expect(idMap["06"]).toBe("https://cdn.example/06.png");
    expect(idMap["29"]).toBe("https://cdn.example/29.png");
    expect(idMap["02"]).toBe("https://cdn.example/02.png");
    expect(idMap["03"]).toBe("https://cdn.example/03.png");

    // preset_patch is a copy/paste-friendly map { sticker_id -> url }
    expect(body.preset_patch).toEqual({
      "06": "https://cdn.example/06.png",
      "29": "https://cdn.example/29.png",
      "02": "https://cdn.example/02.png",
      "03": "https://cdn.example/03.png",
    });
  });

  it("picks the latest image_url per sticker_id (sort=desc + first-wins)", async () => {
    const T0 = 1_700_000_000_000;
    // Two messages for sticker_id=06, the first (newest by sort desc) wins.
    const docs = [
      stickerDoc({
        conversation_id: "newer",
        shop_id: 100,
        message_id: "m_new",
        timestamp_ms: T0,
        sticker_id: "06",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/NEW.png",
      }),
      stickerDoc({
        conversation_id: "older",
        shop_id: 100,
        message_id: "m_old",
        timestamp_ms: T0 - 86_400_000,
        sticker_id: "06",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/OLD.png",
      }),
    ];
    mockFindReturn(docs);

    const res = await GET(authedReq());
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].image_url).toBe("https://cdn.example/NEW.png");
    expect(body.results[0].conversation_id).toBe("newer");
  });

  it("excludes other packs even if sticker_id matches", async () => {
    const T0 = 1_700_000_000_000;
    const docs = [
      // 別パックの sticker_id "06" — 除外
      stickerDoc({
        conversation_id: "c_other",
        shop_id: 100,
        message_id: "m",
        timestamp_ms: T0,
        sticker_id: "06",
        package_id: "different_pack",
        image_url: "https://cdn.example/should_not_appear.png",
      }),
    ];
    mockFindReturn(docs);

    const res = await GET(authedReq());
    const body = await res.json();
    expect(body.results).toHaveLength(0);
    expect(body.missing_sticker_ids).toEqual(["06", "29", "02", "03"]);
  });

  it("excludes target pack stickers whose sticker_id is not one of 06/29/02/03", async () => {
    const T0 = 1_700_000_000_000;
    const docs = [
      stickerDoc({
        conversation_id: "c_99",
        shop_id: 100,
        message_id: "m",
        timestamp_ms: T0,
        sticker_id: "99",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/99.png",
      }),
    ];
    mockFindReturn(docs);

    const res = await GET(authedReq());
    const body = await res.json();
    expect(body.results).toHaveLength(0);
  });

  it("excludes sticker docs whose image_url is missing or non-http", async () => {
    const T0 = 1_700_000_000_000;
    const docs = [
      stickerDoc({
        conversation_id: "c_no_url",
        shop_id: 100,
        message_id: "m",
        timestamp_ms: T0,
        sticker_id: "06",
        package_id: "orangutan_my_new",
        // image_url omitted
      }),
    ];
    mockFindReturn(docs);

    const res = await GET(authedReq());
    const body = await res.json();
    expect(body.results).toHaveLength(0);
    expect(body.missing_sticker_ids).toContain("06");
  });

  it("returns missing_sticker_ids for partial coverage (e.g. only 2 of 4 found)", async () => {
    const T0 = 1_700_000_000_000;
    const docs = [
      stickerDoc({
        conversation_id: "c_06",
        shop_id: 100,
        message_id: "m_06",
        timestamp_ms: T0,
        sticker_id: "06",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/06.png",
      }),
      stickerDoc({
        conversation_id: "c_03",
        shop_id: 100,
        message_id: "m_03",
        timestamp_ms: T0 - 1000,
        sticker_id: "03",
        package_id: "orangutan_my_new",
        image_url: "https://cdn.example/03.png",
      }),
    ];
    mockFindReturn(docs);

    const res = await GET(authedReq());
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    const ids = (
      body.results as Array<{ sticker_id: string }>
    ).map((r) => r.sticker_id);
    expect(ids).toEqual(expect.arrayContaining(["06", "03"]));
    expect(body.missing_sticker_ids).toEqual(
      expect.arrayContaining(["29", "02"])
    );
  });

  it("returns 0 results and missing=4 when DB has nothing", async () => {
    mockFindReturn([]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(body.missing_sticker_ids).toEqual(["06", "29", "02", "03"]);
    expect(body.preset_patch).toEqual({});
  });
});
