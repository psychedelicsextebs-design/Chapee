import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====

const mockConvCollection = {
  findOne: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockConvCollection),
}));

vi.mock("@/lib/shopee-api", () => ({
  sendOrderMessage: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/lib/shopee-token", () => ({
  getValidToken: vi.fn(async () => "dummy_token"),
  resolveCountryForShop: vi.fn(async () => "SG"),
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/buyers/cold-start-send/route";
import { sendOrderMessage, sendMessage } from "@/lib/shopee-api";

// ===== Fixtures =====

const SHOP_ID = 2032481;
const BUYER_ID = 1001;
const ORDER_SN = "240509AAA";
const TEXT = "テスト送信本文";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/buyers/cold-start-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (sendOrderMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
  });
  (sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
  });
});

// ============================================================================
// Validation
// ============================================================================

describe("/api/buyers/cold-start-send — validation (case 4)", () => {
  it("returns 400 when shop_id is missing", async () => {
    const res = await POST(
      makeRequest({
        buyer_user_id: BUYER_ID,
        order_sn: ORDER_SN,
        text: TEXT,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("shop_id");
  });

  it("returns 400 when buyer_user_id is missing", async () => {
    const res = await POST(
      makeRequest({ shop_id: SHOP_ID, order_sn: ORDER_SN, text: TEXT }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("buyer_user_id");
  });

  it("returns 400 when order_sn is empty", async () => {
    const res = await POST(
      makeRequest({
        shop_id: SHOP_ID,
        buyer_user_id: BUYER_ID,
        order_sn: "",
        text: TEXT,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("order_sn");
  });

  it("returns 400 when text is empty", async () => {
    const res = await POST(
      makeRequest({
        shop_id: SHOP_ID,
        buyer_user_id: BUYER_ID,
        order_sn: ORDER_SN,
        text: "",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("本文");
  });
});

// ============================================================================
// Flow: has_conversation=true → sendMessage 直接
// ============================================================================

describe("/api/buyers/cold-start-send — existing conversation (case 1)", () => {
  it("calls sendMessage directly without sendOrderMessage when conversation exists", async () => {
    mockConvCollection.findOne.mockResolvedValueOnce({
      conversation_id: "conv-1001",
      shop_id: SHOP_ID,
      customer_id: BUYER_ID,
      customer_name: "alice",
    });

    const res = await POST(
      makeRequest({
        shop_id: SHOP_ID,
        buyer_user_id: BUYER_ID,
        order_sn: ORDER_SN,
        text: TEXT,
      }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.has_conversation_before).toBe(true);

    expect(sendOrderMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "dummy_token",
      SHOP_ID,
      BUYER_ID,
      TEXT,
      { country: "SG" },
    );
  });
});

// ============================================================================
// Flow: has_conversation=false → sendOrderMessage → sendMessage
// ============================================================================

describe("/api/buyers/cold-start-send — cold start (case 2)", () => {
  it("calls sendOrderMessage first then sendMessage when no conversation", async () => {
    mockConvCollection.findOne.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({
        shop_id: SHOP_ID,
        buyer_user_id: BUYER_ID,
        order_sn: ORDER_SN,
        text: TEXT,
      }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.has_conversation_before).toBe(false);

    expect(sendOrderMessage).toHaveBeenCalledTimes(1);
    expect(sendOrderMessage).toHaveBeenCalledWith(
      "dummy_token",
      SHOP_ID,
      BUYER_ID,
      ORDER_SN,
      { country: "SG" },
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // 順序確認: sendOrderMessage が sendMessage より先に呼ばれる
    const orderCall = (
      sendOrderMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    const sendCall = (
      sendMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    expect(orderCall).toBeLessThan(sendCall);
  });
});

// ============================================================================
// Retry on sendMessage failure (case 3)
// ============================================================================

describe("/api/buyers/cold-start-send — retry on sendMessage failure (case 3)", () => {
  it("retries sendMessage once after transient failure", async () => {
    mockConvCollection.findOne.mockResolvedValueOnce({
      conversation_id: "conv-1001",
      shop_id: SHOP_ID,
      customer_id: BUYER_ID,
    });
    // 1 回目は失敗、 2 回目で成功
    (sendMessage as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("transient error"))
      .mockResolvedValueOnce({ success: true });

    const res = await POST(
      makeRequest({
        shop_id: SHOP_ID,
        buyer_user_id: BUYER_ID,
        order_sn: ORDER_SN,
        text: TEXT,
      }),
    );

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when sendMessage fails both attempts", async () => {
    mockConvCollection.findOne.mockResolvedValueOnce({
      conversation_id: "conv-1001",
      shop_id: SHOP_ID,
      customer_id: BUYER_ID,
    });
    (sendMessage as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("persistent error"),
    );

    const res = await POST(
      makeRequest({
        shop_id: SHOP_ID,
        buyer_user_id: BUYER_ID,
        order_sn: ORDER_SN,
        text: TEXT,
      }),
    );

    expect(res.status).toBe(500);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
