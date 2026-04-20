import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mocks for external dependencies ----------------------------------
// NOTE: mocks must be hoisted above the import of the module under test,
// which is why we put them at the top of the file before the dynamic imports.

const mockCollection = {
  findOne: vi.fn(),
  updateOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockCollection),
}));

vi.mock("@/lib/shopee-api", () => ({
  fetchAllConversationMessages: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/lib/shopee-token", () => ({
  getShopCountry: vi.fn(async () => "SG"),
  getValidToken: vi.fn(async () => "dummy_token"),
  resolveCountryForShop: vi.fn(async () => "SG"),
}));

vi.mock("@/lib/staff-message-kind", () => ({
  extractMessageIdFromSendResponse: vi.fn(),
  recordStaffMessageKind: vi.fn(),
}));

import {
  classifyShopeeMessageSender,
  computeBuyerStaffLastMs,
  reviewAutoReplySchedule,
} from "@/lib/auto-reply";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SHOP_ID = 2032481; // partner / shop id (example from project)
const CUSTOMER_ID = 293172181; // toyota_seg buyer id from the bug report
const SUBACCOUNT_USER_ID = 555666777; // a Shopee Seller Center sub-account user id
const TEMPLATE_ID = "507f1f77bcf86cd799439011"; // a valid-looking ObjectId hex

/** Build a fake Shopee `get_message` row. ts is ms since epoch. */
function msg(fromId: number, timeMs: number) {
  return { from_id: fromId, timestamp: Math.floor(timeMs / 1000) };
}

function hoursAgo(h: number): number {
  return Date.now() - h * 3600_000;
}

// ===========================================================================
// Pure helper tests — these directly prove the bug-fix classification
// ===========================================================================
describe("classifyShopeeMessageSender", () => {
  it("returns 'buyer' when from_id === customer_id", () => {
    expect(
      classifyShopeeMessageSender({ from_id: CUSTOMER_ID }, CUSTOMER_ID)
    ).toBe("buyer");
  });

  it("returns 'staff' when from_id === shop_id (traditional staff case)", () => {
    expect(
      classifyShopeeMessageSender({ from_id: SHOP_ID }, CUSTOMER_ID)
    ).toBe("staff");
  });

  it("returns 'staff' when from_id is a sub-account user_id (the bug case)", () => {
    // Core regression: staff replying via Shopee Seller Center shows up with
    // their personal user_id, not shop_id. Must not be misclassified as buyer.
    expect(
      classifyShopeeMessageSender({ from_id: SUBACCOUNT_USER_ID }, CUSTOMER_ID)
    ).toBe("staff");
  });

  it("returns 'unknown' when from_id is 0 / missing (system card)", () => {
    expect(classifyShopeeMessageSender({ from_id: 0 }, CUSTOMER_ID)).toBe(
      "unknown"
    );
    expect(classifyShopeeMessageSender({}, CUSTOMER_ID)).toBe("unknown");
  });

  it("returns 'staff' when customer_id is 0/invalid but from_id is positive (defensive)", () => {
    // If we don't know buyer id, any sender is treated as non-buyer → staff
    // This ensures we never schedule an auto-reply from a message we can't attribute.
    expect(classifyShopeeMessageSender({ from_id: 123 }, 0)).toBe("staff");
  });
});

describe("computeBuyerStaffLastMs", () => {
  it("returns zeros for an empty list", () => {
    const r = computeBuyerStaffLastMs([], CUSTOMER_ID);
    expect(r).toEqual({ lastBuyerMs: 0, lastStaffMs: 0 });
  });

  it("toyota_seg reproduction: buyer / shop / buyer / sub-account staff", () => {
    // Timeline from the real incident (ms anchors are arbitrary, only order matters)
    const t1 = 100_000_000_000; // buyer
    const t2 = t1 + 2 * 3600_000; // shop_id staff reply
    const t3 = t2 + 20 * 60_000; // buyer again (LAST buyer message)
    const t4 = t3 + 7 * 3600_000; // STAFF via sub-account user_id (was mis-labelled buyer)
    const raw = [
      msg(CUSTOMER_ID, t1),
      msg(SHOP_ID, t2),
      msg(CUSTOMER_ID, t3),
      msg(SUBACCOUNT_USER_ID, t4),
    ];
    const r = computeBuyerStaffLastMs(raw, CUSTOMER_ID);
    expect(r.lastBuyerMs).toBe(t3);
    expect(r.lastStaffMs).toBe(t4);
    // Therefore lastStaff >= lastBuyer → auto-reply must be cancelled.
    expect(r.lastStaffMs).toBeGreaterThanOrEqual(r.lastBuyerMs);
  });

  it("buyer-only thread: lastBuyerMs set, lastStaffMs stays 0", () => {
    const t1 = 1_700_000_000_000;
    const r = computeBuyerStaffLastMs([msg(CUSTOMER_ID, t1)], CUSTOMER_ID);
    expect(r.lastBuyerMs).toBe(t1);
    expect(r.lastStaffMs).toBe(0);
  });

  it("ignores system messages (from_id=0)", () => {
    const t1 = 1_700_000_000_000;
    const r = computeBuyerStaffLastMs(
      [{ from_id: 0, timestamp: Math.floor(t1 / 1000) }, msg(CUSTOMER_ID, t1 + 1000)],
      CUSTOMER_ID
    );
    expect(r.lastBuyerMs).toBe(t1 + 1000);
    expect(r.lastStaffMs).toBe(0);
  });
});

// ===========================================================================
// reviewAutoReplySchedule integration tests with mocked mongodb collection.
// These cover the four required scenarios from the feature spec.
// ===========================================================================
describe("reviewAutoReplySchedule", () => {
  beforeEach(() => {
    mockCollection.findOne.mockReset();
    mockCollection.updateOne.mockReset();

    // Default auto_reply_settings singleton: enabled, 11h trigger
    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          _id: "singleton",
          countries: {
            SG: {
              enabled: true,
              triggerHour: 11,
              template_id: TEMPLATE_ID,
            },
          },
        };
      }
      // conversation lookup default: overridden per test
      return null;
    });
  });

  // --------------------------------------------------------------------------
  // Case 1: buyer received, 11h elapsed, no staff reply → must SCHEDULE (= send)
  // --------------------------------------------------------------------------
  it("Case 1: buyer unanswered for >11h → schedules due_at (will fire)", async () => {
    const buyerMsgMs = hoursAgo(12); // 12h ago → already past 11h trigger

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      // conversation doc: has customer_id, not yet scheduled
      return {
        conversation_id: "conv1",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: false,
        auto_reply_due_at: null,
        last_auto_reply_at: null,
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, buyerMsgMs)],
      SHOP_ID,
      "conv1"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(true);
    expect(update.$set.auto_reply_due_at).toBeInstanceOf(Date);
  });

  // --------------------------------------------------------------------------
  // Case 2: buyer received, then STAFF replied via shop_id → must NOT schedule
  // --------------------------------------------------------------------------
  it("Case 2: staff replied with from_id === shop_id → pending cleared", async () => {
    const buyerMsgMs = hoursAgo(12);
    const staffMsgMs = hoursAgo(10); // after buyer

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv2",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: true, // was scheduled
        auto_reply_due_at: new Date(buyerMsgMs + 11 * 3600_000),
        last_auto_reply_at: null,
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, buyerMsgMs), msg(SHOP_ID, staffMsgMs)],
      SHOP_ID,
      "conv2"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(false);
    expect(update.$set.auto_reply_due_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Case 3 (REGRESSION): buyer received, then STAFF replied via SUB-ACCOUNT
  //                      (from_id = staff personal user_id, NOT shop_id)
  //                      Must NOT send auto-reply.
  // --------------------------------------------------------------------------
  it("Case 3 (bug fix): staff replied via sub-account user_id → pending cleared", async () => {
    const buyerMsgMs = hoursAgo(18);
    const staffMsgMs = hoursAgo(11); // 11h ago staff reply via seller center sub-account

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv3",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: true, // was incorrectly scheduled
        auto_reply_due_at: new Date(buyerMsgMs + 11 * 3600_000),
        last_auto_reply_at: null,
      };
    });

    await reviewAutoReplySchedule(
      [
        msg(CUSTOMER_ID, buyerMsgMs),
        // Staff message with from_id = sub-account user_id (NOT shop_id).
        // Under the old code this was mis-labelled as a buyer message and the
        // schedule was renewed. It MUST now be treated as staff and cancelled.
        msg(SUBACCOUNT_USER_ID, staffMsgMs),
      ],
      SHOP_ID,
      "conv3"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(false);
    expect(update.$set.auto_reply_due_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Case 4: customer_id is missing on the conversation doc → must NOT send.
  // --------------------------------------------------------------------------
  it("Case 4: customer_id missing → skip & clear pending (保守的)", async () => {
    const buyerMsgMs = hoursAgo(12);

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv4",
        shop_id: SHOP_ID,
        country: "SG",
        // customer_id missing ←
        auto_reply_pending: true,
        auto_reply_due_at: new Date(buyerMsgMs + 11 * 3600_000),
        last_auto_reply_at: null,
      };
    });

    await reviewAutoReplySchedule(
      [msg(123456, buyerMsgMs)], // from_id arbitrary since we shouldn't judge
      SHOP_ID,
      "conv4"
    );

    // Exactly one write: clear pending. No scheduling write.
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(false);
    expect(update.$set.auto_reply_due_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Extra safety: notification chats are always skipped regardless of input.
  // --------------------------------------------------------------------------
  it("notification chat_type → never writes", async () => {
    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "convN",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        chat_type: "notification",
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, hoursAgo(12))],
      SHOP_ID,
      "convN"
    );

    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });
});
