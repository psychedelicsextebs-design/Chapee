import { describe, it, expect } from "vitest";
import { inferChatTypeFromShopee } from "@/lib/shopee-conversation-utils";

describe("inferChatTypeFromShopee — 種別分類", () => {
  it("システムカードで終わる会話は buyer（通知扱いしない）", () => {
    // 以前は notification に誤分類していた3種。今はバイヤー会話として扱う。
    for (const mt of [
      "return_refund_card",
      "out_of_stock_reminder_card",
      "faq_liveagent_prompt",
    ]) {
      expect(
        inferChatTypeFromShopee({ latest_message_type: mt, to_name: "buyer123" })
      ).toBe("buyer");
    }
  });

  it("相手が Shopee 通知アカウントなら notification", () => {
    expect(
      inferChatTypeFromShopee({ latest_message_type: "text", to_name: "Shopee通知" })
    ).toBe("notification");
  });

  it("affiliate メッセージ種別は affiliate", () => {
    expect(
      inferChatTypeFromShopee({
        latest_message_type: "affiliate_xxx",
        to_name: "someone",
      })
    ).toBe("affiliate");
  });

  it("通常テキストは buyer", () => {
    expect(
      inferChatTypeFromShopee({ latest_message_type: "text", to_name: "ashleytankm" })
    ).toBe("buyer");
  });
});
