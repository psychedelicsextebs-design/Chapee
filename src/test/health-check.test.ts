import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks for external dependencies ----------------------------------
// Mocks must be hoisted above the import of the module under test.

const mockSettingsCol = {
  findOne: vi.fn(),
};

const mockConvCol = {
  find: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async (name: string) => {
    if (name === "auto_reply_settings") return mockSettingsCol;
    if (name === "shopee_conversations") return mockConvCol;
    throw new Error(`unexpected collection: ${name}`);
  }),
}));

import {
  findMissedConversations,
  HEALTH_CHECK_MAX_SCAN,
} from "@/lib/health-check";
import { GET } from "../../app/api/cron/health-check/route";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = 1689220556;
const TEMPLATE_ID = "507f1f77bcf86cd799439011";

/** Build a chained find() mock returning the supplied docs. */
function mockFindReturn(docs: Record<string, unknown>[]) {
  const toArray = vi.fn().mockResolvedValue(docs);
  const limit = vi.fn().mockReturnValue({ toArray });
  const sort = vi.fn().mockReturnValue({ limit });
  mockConvCol.find.mockReturnValue({ sort });
  return { sort, limit, toArray };
}

function settingsWith(
  countries: Record<string, { triggerHour?: number; enabled?: boolean }>
) {
  return {
    _id: "singleton",
    countries: Object.fromEntries(
      Object.entries(countries).map(([k, v]) => [
        k,
        {
          enabled: v.enabled ?? true,
          triggerHour: v.triggerHour ?? 12,
          template_id: TEMPLATE_ID,
        },
      ])
    ),
  };
}

beforeEach(() => {
  mockSettingsCol.findOne.mockReset();
  mockConvCol.find.mockReset();
});

// ===========================================================================
// findMissedConversations unit tests (ケース 1, 2, 4)
// ===========================================================================
describe("findMissedConversations", () => {
  it("Case 1: no missed candidates → empty array, missed_count=0", async () => {
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([]); // DB returns nothing

    const result = await findMissedConversations(Date.UTC(2026, 4, 9, 8, 0, 0));

    expect(result.missed_count).toBe(0);
    expect(result.missed_conversations).toEqual([]);
    expect(result.total_conversations_checked).toBe(0);
    expect(result.scanned_at).toBe("2026-05-09T08:00:00.000Z");
  });

  it("Case 2: one missed candidate → returned with correct fields", async () => {
    const NOW = Date.UTC(2026, 4, 9, 8, 0, 0); // 2026-05-09T08:00:00Z
    const LMT = Date.UTC(2026, 4, 9, 7, 42, 0); // 18 min ago → 0.3h elapsed
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([
      {
        conversation_id: "445264213363626460",
        customer_name: "sunrainsky",
        shop_id: SHOP_ID,
        country: "SG",
        chat_type: "buyer",
        customer_id: 999_111_222,
        last_message_time: new Date(LMT),
        auto_reply_pending: false,
        last_auto_reply_at: null,
        handling_status: "unreplied",
        latest_message_type: "product",
      },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await findMissedConversations(NOW);

      expect(result.missed_count).toBe(1);
      expect(result.total_conversations_checked).toBe(1);
      const m = result.missed_conversations[0];
      expect(m.conversation_id).toBe("445264213363626460");
      expect(m.customer_name).toBe("sunrainsky");
      expect(m.shop_id).toBe(SHOP_ID);
      expect(m.country).toBe("SG");
      expect(m.last_message_time).toBe(new Date(LMT).toISOString());
      expect(m.elapsed_hours).toBe(0.3);
      expect(m.trigger_hour).toBe(12);
      expect(m.expected_due_at).toBe(
        new Date(LMT + 12 * 3600_000).toISOString()
      );
      expect(m.last_message_type).toBe("product");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("Case 2b: GET handler logs console.warn when missed_count > 0", async () => {
    const NOW = Date.now();
    const LMT = NOW - 30 * 60_000; // 30 min ago
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([
      {
        conversation_id: "c_warn",
        customer_name: "u1",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: 1,
        last_message_time: new Date(LMT),
        auto_reply_pending: false,
        last_auto_reply_at: null,
        handling_status: "unreplied",
      },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prevSecret = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET; // 認証スキップ路線

    try {
      const req = new NextRequest("http://localhost/api/cron/health-check");
      const res = await GET(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.missed_count).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("missed=1");
    } finally {
      if (prevSecret !== undefined) process.env.CRON_SECRET = prevSecret;
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("Case 4: country with no triggerHour setting is excluded from scan", async () => {
    const NOW = Date.UTC(2026, 4, 9, 8, 0, 0);
    const LMT = NOW - 30 * 60_000;

    // Only SG configured. PH has NO triggerHour entry → Mongo $in does not include
    // PH, and even if a doc snuck in we'd exclude it in app-layer filter.
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));

    // Simulate that the find query would (defensively) include a PH conversation
    // even though $in excludes it — we want to prove the app filter also blocks it.
    mockFindReturn([
      {
        conversation_id: "c_ph",
        customer_name: "ph_buyer",
        shop_id: SHOP_ID,
        country: "PH",
        customer_id: 1,
        last_message_time: new Date(LMT),
        auto_reply_pending: false,
        last_auto_reply_at: null,
        handling_status: "unreplied",
      },
    ]);

    const result = await findMissedConversations(NOW);
    expect(result.missed_count).toBe(0);

    // Verify the Mongo query restricted country: $in to configured ones (SG only).
    const findCall = mockConvCol.find.mock.calls[0][0] as Record<string, unknown>;
    expect(findCall).toHaveProperty("country");
    const countryClause = findCall.country as { $in?: string[] };
    expect(countryClause.$in).toEqual(["SG"]);
  });

  it("Case 4b: when no countries are configured at all, returns empty without querying conversations", async () => {
    mockSettingsCol.findOne.mockResolvedValue({ _id: "singleton", countries: {} });
    // mockConvCol.find should NOT be called.

    const result = await findMissedConversations(Date.UTC(2026, 4, 9, 8, 0, 0));
    expect(result.missed_count).toBe(0);
    expect(result.total_conversations_checked).toBe(0);
    expect(mockConvCol.find).not.toHaveBeenCalled();
  });

  it("excludes docs already auto-replied (last_auto_reply_at >= last_message_time)", async () => {
    const NOW = Date.UTC(2026, 4, 9, 8, 0, 0);
    const LMT = NOW - 30 * 60_000;
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([
      {
        conversation_id: "c_already",
        customer_name: "u",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: 1,
        last_message_time: new Date(LMT),
        auto_reply_pending: false,
        last_auto_reply_at: new Date(LMT + 1000), // already replied after the msg
        handling_status: "auto_replied_pending",
      },
    ]);
    const result = await findMissedConversations(NOW);
    expect(result.missed_count).toBe(0);
  });

  it("excludes docs older than (triggerHour - 2h) (out-of-window)", async () => {
    const NOW = Date.UTC(2026, 4, 9, 20, 0, 0);
    // SG triggerHour=12 → window = 10h. 11h ago should be excluded.
    const LMT_OUT = NOW - 11 * 3600_000;
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([
      {
        conversation_id: "c_old",
        customer_name: "u",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: 1,
        last_message_time: new Date(LMT_OUT),
        auto_reply_pending: false,
        last_auto_reply_at: null,
        handling_status: "unreplied",
      },
    ]);
    const result = await findMissedConversations(NOW);
    expect(result.missed_count).toBe(0);
  });

  it("Mongo query honors HEALTH_CHECK_MAX_SCAN limit (= 100)", async () => {
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    const { limit } = mockFindReturn([]);
    await findMissedConversations(Date.UTC(2026, 4, 9, 8, 0, 0));
    expect(limit).toHaveBeenCalledWith(HEALTH_CHECK_MAX_SCAN);
    expect(HEALTH_CHECK_MAX_SCAN).toBe(100);
  });

  it("Mongo query has all required filter clauses (read-only safety)", async () => {
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([]);
    await findMissedConversations(Date.UTC(2026, 4, 9, 8, 0, 0));
    const filter = mockConvCol.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.chat_type).toEqual({ $ne: "notification" });
    expect(filter.customer_id).toEqual({ $gt: 0 });
    expect(filter.auto_reply_pending).toEqual({ $ne: true });
    expect(filter.handling_status).toEqual({ $ne: "completed" });
    expect(filter).toHaveProperty("last_message_time");
    expect(filter).toHaveProperty("country");
  });
});

// ===========================================================================
// GET /api/cron/health-check — auth (ケース 3)
// ===========================================================================
describe("GET /api/cron/health-check (auth)", () => {
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = prevSecret;
    }
  });

  it("Case 3: returns 401 when CRON_SECRET is set and auth header is missing", async () => {
    process.env.CRON_SECRET = "supersecret";
    // (find should NOT be called when 401)
    const req = new NextRequest("http://localhost/api/cron/health-check");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mockConvCol.find).not.toHaveBeenCalled();
    expect(mockSettingsCol.findOne).not.toHaveBeenCalled();
  });

  it("Case 3b: returns 401 with wrong bearer", async () => {
    process.env.CRON_SECRET = "supersecret";
    const req = new NextRequest("http://localhost/api/cron/health-check", {
      headers: { authorization: "Bearer wrong" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("Case 3c: returns 200 with correct bearer", async () => {
    process.env.CRON_SECRET = "supersecret";
    mockSettingsCol.findOne.mockResolvedValue(settingsWith({ SG: { triggerHour: 12 } }));
    mockFindReturn([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const req = new NextRequest("http://localhost/api/cron/health-check", {
        headers: { authorization: "Bearer supersecret" },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.missed_count).toBe(0);
      expect(body.scanned_at).toBeTruthy();
    } finally {
      logSpy.mockRestore();
    }
  });
});
