import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 回帰防止: Phase 2 (event-triggered) の二重送信 (alexsmiths 案件 2026-05-28)。
 *
 * 真因: 旧コードは sendMessage を先に実行し、その後 send_log に insert していた。
 * send_log の unique index は E11000 を「送信後」に返すだけなので、Shopee が同じ
 * 注文に code3/code4 を再送 (実測 1 注文 5 回) して新しい pending が作られると、
 * バイヤーに同じメッセージが再度届いてしまっていた。
 *
 * 修正: drain ループ冒頭で send_log を findOne し、既にあれば送信前に cancelled。
 * 本テストは「send_log に既存 → sendMessage を呼ばない」ことと
 * 「未送信 → 通常通り送る」ことの両方を固定する。
 */

const mockQueueCol = {
  find: vi.fn(),
  updateOne: vi.fn(async (..._a: unknown[]) => ({})),
};
const mockLogCol = {
  findOne: vi.fn(async (..._a: unknown[]) => null as unknown),
  insertOne: vi.fn(async (..._a: unknown[]) => ({})),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async (name: string) =>
    name === "event_triggered_send_log" ? mockLogCol : mockQueueCol
  ),
}));

vi.mock("@/lib/shopee-api", () => ({
  sendMessage: vi.fn(async () => ({ response: { message_id: "m1" } })),
  sendOrderMessage: vi.fn(async () => ({})),
  getOrderDetail: vi.fn(async () => ({ response: { order_list: [] } })),
}));

vi.mock("@/lib/shopee-token", () => ({
  getValidToken: vi.fn(async () => "tok"),
  resolveCountryForShop: vi.fn(async () => "SG"),
}));

vi.mock("@/lib/phase2-trigger-settings", () => ({
  getPhase2TriggerSettings: vi.fn(async () => ({
    updated_at: new Date(),
    triggers: {
      tracking_registered: {
        enabled_global: true,
        countries: { SG: { enabled: true, template_id: "tpl1" } },
      },
      order_confirmed: {
        enabled_global: true,
        countries: { SG: { enabled: true, template_id: "tpl1" } },
      },
      delivered_plus_3d: {
        enabled_global: true,
        countries: { SG: { enabled: true, template_id: "tpl1" } },
      },
    },
  })),
  resolvePhase2TemplateContent: vi.fn(async () => "Your order has been shipped."),
}));

import { processDuePhase2Triggers } from "@/lib/phase2-triggers";
import { sendMessage } from "@/lib/shopee-api";

function dueDoc() {
  return {
    _id: "q1",
    shop_id: 1689220556,
    order_sn: "260505J9TD6BTC",
    event_type: "tracking_registered",
    customer_id: 469873669, // > 0 → getOrderDetail を呼ばない
    template_id: "",
    due_at: new Date(Date.now() - 1000),
    status: "pending",
    retry_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function mockDueQueue(docs: unknown[]) {
  mockQueueCol.find.mockReturnValue({
    sort: () => ({ limit: () => ({ toArray: async () => docs }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PHASE2_TRIGGERS_ENABLED = "true";
});

describe("processDuePhase2Triggers — 送信前 dedup", () => {
  it("send_log に既存があれば sendMessage を呼ばず cancelled", async () => {
    mockDueQueue([dueDoc()]);
    mockLogCol.findOne.mockResolvedValue({
      shop_id: 1689220556,
      order_sn: "260505J9TD6BTC",
      event_type: "tracking_registered",
    });

    const res = await processDuePhase2Triggers();

    expect(vi.mocked(sendMessage)).not.toHaveBeenCalled();
    expect(mockLogCol.insertOne).not.toHaveBeenCalled();
    expect(res.skipped_duplicate).toBe(1);
    expect(res.sent).toBe(0);
    // queue は cancelled に更新される
    expect(mockQueueCol.updateOne).toHaveBeenCalledTimes(1);
    const setArg = mockQueueCol.updateOne.mock.calls[0][1] as {
      $set?: { status?: string; last_error?: string };
    };
    expect(setArg.$set?.status).toBe("cancelled");
    expect(setArg.$set?.last_error).toContain("pre-send dedup");
  });

  it("send_log が未送信なら通常通り 1 件送信する", async () => {
    mockDueQueue([dueDoc()]);
    mockLogCol.findOne.mockResolvedValue(null); // prededup 通過

    const res = await processDuePhase2Triggers();

    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1);
    expect(mockLogCol.insertOne).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(1);
    expect(res.skipped_duplicate).toBe(0);
  });
});
