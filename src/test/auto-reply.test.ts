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
  computeLastAnyMessageMs,
  reviewAutoReplySchedule,
  scheduleAutoReplyForUnread,
} from "@/lib/auto-reply";
import { fetchAllConversationMessages } from "@/lib/shopee-api";

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

  it("returns 'unknown' when from_id is 0 AND no to_id (system card)", () => {
    expect(classifyShopeeMessageSender({ from_id: 0 }, CUSTOMER_ID)).toBe(
      "unknown"
    );
    expect(classifyShopeeMessageSender({}, CUSTOMER_ID)).toBe("unknown");
  });

  // Patch A regression: 4/22 09:10 sabara2722 / dareraru 誤発火パターン.
  // Shopee sticker は from_id=0 で配信されるが to_id は customer_id を持つ。
  // → 「buyer 宛」と確定できるので staff 送信扱いに分類されるべき。
  it("returns 'staff' when from_id=0 but to_id === customer_id (Patch A: sticker fallback)", () => {
    expect(
      classifyShopeeMessageSender(
        { from_id: 0, to_id: CUSTOMER_ID },
        CUSTOMER_ID
      )
    ).toBe("staff");
    // alt key (to_user_id) も拾えること
    expect(
      classifyShopeeMessageSender(
        { from_user_id: 0, to_user_id: CUSTOMER_ID },
        CUSTOMER_ID
      )
    ).toBe("staff");
  });

  // Patch B: from_id=0 かつ to_id も customer_id でない場合は引き続き "unknown"。
  // (真の system card や、向きが特定できない異常系を staff/buyer に決めつけない)
  it("returns 'unknown' when from_id=0 and to_id is also unresolvable (Patch B: default kept)", () => {
    expect(
      classifyShopeeMessageSender({ from_id: 0, to_id: 0 }, CUSTOMER_ID)
    ).toBe("unknown");
    // to_id があるが customer_id とは違う (向き不明) → staff/buyer 確定せず unknown
    expect(
      classifyShopeeMessageSender(
        { from_id: 0, to_id: 999_999_999 },
        CUSTOMER_ID
      )
    ).toBe("unknown");
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

  // Patch A 効果: from_id=0 + to_id=customer_id の sticker は staff 扱いになる
  it("counts from_id=0 + to_id=customer_id sticker as staff (Patch A integration)", () => {
    const tBuyer = 1_700_000_000_000;
    const tSticker = tBuyer + 60_000; // 1 分後に staff sticker
    const r = computeBuyerStaffLastMs(
      [
        msg(CUSTOMER_ID, tBuyer),
        { from_id: 0, to_id: CUSTOMER_ID, timestamp: Math.floor(tSticker / 1000) },
      ],
      CUSTOMER_ID
    );
    expect(r.lastBuyerMs).toBe(tBuyer);
    expect(r.lastStaffMs).toBe(tSticker);
  });
});

// ===========================================================================
// Patch C: computeLastAnyMessageMs — pre-send 二重防衛 cooldown 用
// ===========================================================================
describe("computeLastAnyMessageMs", () => {
  it("returns 0 for empty list", () => {
    expect(computeLastAnyMessageMs([])).toBe(0);
  });

  it("returns max timestamp regardless of from_id classification", () => {
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 5_000;
    const t3 = t2 + 10_000;
    // 真ん中だけ from_id=0/to_id=0 (true unknown) でも timestamp は拾うのが本ヘルパーの目的
    const r = computeLastAnyMessageMs([
      msg(CUSTOMER_ID, t1),
      { from_id: 0, to_id: 0, timestamp: Math.floor(t2 / 1000) },
      msg(SHOP_ID, t3),
    ]);
    expect(r).toBe(t3);
  });

  it("captures timestamp of unclassifiable sticker (the bug case)", () => {
    // buyer message → 後に from_id=0 の sticker (to_id 不明 = unknown 扱い)
    // computeBuyerStaffLastMs では捉えられない最終活動を Patch C ガードが拾う。
    const tBuyer = 1_700_000_000_000;
    const tSticker = tBuyer + 60_000;
    const list = [
      msg(CUSTOMER_ID, tBuyer),
      { from_id: 0, to_id: 0, timestamp: Math.floor(tSticker / 1000) },
    ];
    const buyerStaff = computeBuyerStaffLastMs(list, CUSTOMER_ID);
    const lastAny = computeLastAnyMessageMs(list);
    expect(buyerStaff.lastStaffMs).toBe(0); // 既存ロジックでは検出不能
    expect(lastAny).toBe(tSticker);          // Patch C はここで救う
    expect(lastAny).toBeGreaterThan(buyerStaff.lastBuyerMs);
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

  // --------------------------------------------------------------------------
  // NEW Case 5: M_latest 以降にスタッフ手動返信あり → pending クリア
  //   M1-M4 業務フローの「M1(顧客) → 手動返信 S1」段の基本動作。
  //   残存 pending 予約があっても、生メッセージ検査で staff 応答を検出し解除する。
  // --------------------------------------------------------------------------
  it("Case 5: staff manual reply after M_latest → pending cleared", async () => {
    const M1 = hoursAgo(20);
    const S1 = hoursAgo(5); // after M1

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv5",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: true, // 残存予約(last_auto_reply_at は未更新のまま)
        auto_reply_due_at: new Date(M1 + 11 * 3600_000),
        last_auto_reply_at: null,
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, M1), msg(SHOP_ID, S1)],
      SHOP_ID,
      "conv5"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(false);
    expect(update.$set.auto_reply_due_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // NEW Case 6: M_latest 以降にスタッフ応答なし & triggerHour 経過 → 発火予約
  //   過去 due は now に丸められる (歴史的仕様、pre-send guard が安全網)。
  // --------------------------------------------------------------------------
  it("Case 6: no staff response & triggerHour elapsed → schedules due≈now", async () => {
    const M1 = hoursAgo(12); // 12h前、triggerHour=11h なので既に過ぎている

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv6",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: false,
        auto_reply_due_at: null,
        last_auto_reply_at: null,
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, M1)],
      SHOP_ID,
      "conv6"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(true);
    const due = update.$set.auto_reply_due_at as Date;
    expect(due).toBeInstanceOf(Date);
    expect(Math.abs(due.getTime() - Date.now())).toBeLessThan(5_000);
  });

  // --------------------------------------------------------------------------
  // NEW Case 7: 自動返信自体がスタッフ応答としてカウントされる → 再発火しない
  //   「同一顧客メッセージへの連投防止」の本丸。cooldown 撤去後も
  //   lastStaffMs(auto-reply) >= lastBuyerMs で正しくキャンセルされる。
  // --------------------------------------------------------------------------
  it("Case 7: auto-reply counts as staff → no re-fire for same buyer msg", async () => {
    const M1 = hoursAgo(15);
    const A1 = hoursAgo(4); // auto-reply 4h ago (旧 cooldown ならブロック範囲)

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv7",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: true,
        auto_reply_due_at: new Date(M1 + 11 * 3600_000),
        last_auto_reply_at: new Date(A1),
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, M1), msg(SHOP_ID, A1)], // auto-reply は shop_id 送信扱い
      SHOP_ID,
      "conv7"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(false);
    expect(update.$set.auto_reply_due_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // NEW Case 8: M1 → A1 → M2(新規 buyer) → M2 基準で再スケジュール
  //   旧 cooldown なら A1 から 11h 以内のためブロックされたが、新設計では
  //   「M2 以降にスタッフ応答なし」で正常に due_at = M2 + triggerHour にセット。
  // --------------------------------------------------------------------------
  it("Case 8: new buyer msg after auto-reply → schedules again (no cooldown)", async () => {
    const M1 = hoursAgo(20);
    const A1 = hoursAgo(9);     // auto-reply 9h ago
    const M2 = hoursAgo(8);     // buyer replied 1h after auto-reply
    // triggerHour=11h → M2 基準の due = M2+11h ≈ +3h future

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "conv8",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: false,
        auto_reply_due_at: null,
        last_auto_reply_at: new Date(A1),
      };
    });

    await reviewAutoReplySchedule(
      [msg(CUSTOMER_ID, M1), msg(SHOP_ID, A1), msg(CUSTOMER_ID, M2)],
      SHOP_ID,
      "conv8"
    );

    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(true);
    const due = update.$set.auto_reply_due_at as Date;
    const diffH = (due.getTime() - Date.now()) / 3600_000;
    expect(diffH).toBeGreaterThan(2.5);
    expect(diffH).toBeLessThan(3.5);
  });
});

// ===========================================================================
// scheduleAutoReplyForUnread — coverage window filter
//   last_message_time が (triggerHour - 1h) 以内の会話のみ raw fetch → review 委譲
// ===========================================================================
describe("scheduleAutoReplyForUnread — coverage window filter", () => {
  const mockedFetch = vi.mocked(fetchAllConversationMessages);

  beforeEach(() => {
    mockCollection.findOne.mockReset();
    mockCollection.updateOne.mockReset();
    mockCollection.find.mockReset();
    mockedFetch.mockReset();

    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return null;
    });
  });

  function mockCandidates(docs: Record<string, unknown>[]) {
    mockCollection.find.mockReturnValue({
      toArray: vi.fn().mockResolvedValue(docs),
    });
  }

  // ------------------------------------------------------------------------
  // カバレッジ窓外(4日前など)の会話は DB フィルタで除外 → raw fetch されない
  // ------------------------------------------------------------------------
  it("excludes convs older than (triggerHour - 1h) → no raw fetch", async () => {
    mockCandidates([]); // DB find が cutoff 適用でヒットなし

    await scheduleAutoReplyForUnread(SHOP_ID, ["c_old"]);

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------------
  // 窓内の会話は review に委譲 → buyer 最終のみなら schedule される
  // ------------------------------------------------------------------------
  it("includes convs within window → delegates to review & schedules", async () => {
    const recent = hoursAgo(2); // triggerHour=11h の 10h 窓内

    mockCandidates([
      {
        conversation_id: "c_recent",
        shop_id: SHOP_ID,
        last_message_time: new Date(recent),
      },
    ]);

    // singleton 以外の findOne は conv doc を返す(review 内での lookup)
    mockCollection.findOne.mockImplementation(async (filter: Record<string, unknown>) => {
      if (filter._id === "singleton") {
        return {
          countries: {
            SG: { enabled: true, triggerHour: 11, template_id: TEMPLATE_ID },
          },
        };
      }
      return {
        conversation_id: "c_recent",
        shop_id: SHOP_ID,
        country: "SG",
        customer_id: CUSTOMER_ID,
        auto_reply_pending: false,
        auto_reply_due_at: null,
        last_auto_reply_at: null,
      };
    });

    mockedFetch.mockResolvedValue([msg(CUSTOMER_ID, recent)]);

    await scheduleAutoReplyForUnread(SHOP_ID, ["c_recent"]);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockCollection.updateOne.mock.calls[0];
    expect(update.$set.auto_reply_pending).toBe(true);
  });
});
