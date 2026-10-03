import { describe, it, expect } from "vitest";
import { extractWebchatPushIds } from "@/lib/webhook-chat-payload";

describe("extractWebchatPushIds", () => {
  it("旧形式: data 直下の conversation_id / shop_id", () => {
    expect(
      extractWebchatPushIds({ conversation_id: "123", shop_id: 1689220556 })
    ).toEqual({ conversationId: "123", shopId: 1689220556, source: "data" });
  });

  it("新形式 (message): data.content にネスト", () => {
    const r = extractWebchatPushIds({
      type: "message",
      region: "SG",
      content: {
        message_id: "2438997513839477105",
        shop_id: 1689220556,
        from_id: 315945543,
        message_type: "text",
        conversation_id: "1356975776191975900",
      },
    });
    expect(r).toEqual({
      conversationId: "1356975776191975900",
      shopId: 1689220556,
      source: "data.content",
    });
  });

  it("新形式 (notification/mark_as_replied): shop_id が無くても会話IDは取れる", () => {
    const r = extractWebchatPushIds({
      type: "notification",
      region: "MY",
      content: { user_id: 7792491535, conversation_id: "4708232579012636673", type: "mark_as_replied" },
    });
    expect(r.conversationId).toBe("4708232579012636673");
    expect(r.shopId).toBe(0); // 呼び出し側が payload top-level の shop_id でフォールバックする
    expect(r.source).toBe("data.content");
  });

  it("どちらにも無ければ none", () => {
    expect(extractWebchatPushIds({ type: "x", content: {} })).toEqual({
      conversationId: "",
      shopId: 0,
      source: "none",
    });
    expect(extractWebchatPushIds({}).source).toBe("none");
  });
});
