import { describe, it, expect } from "vitest";
import { inferShopNotificationCategory } from "@/lib/shopee-shop-notification-parse";

describe("inferShopNotificationCategory — タイトル優先のカテゴリ推定", () => {
  const cases: Array<[string, string]> = [
    ["Rate Buyer", "rating"],
    ["Order completed", "order"],
    ["New Order", "order"],
    ["Order Cancelled", "order"],
    ["Proceed to Ship", "order"],
    ["Payment Transfer", "balance"],
    ["Improve your performance", "performance"],
    ["Return & Refund request", "return_refund"],
  ];

  for (const [title, expected] of cases) {
    it(`"${title}" → ${expected}`, () => {
      expect(inferShopNotificationCategory({ title })).toBe(expected);
    });
  }

  it("「Order completed... rate the buyer」はタイトル基準で order（rating に流れない）", () => {
    expect(
      inferShopNotificationCategory({
        title: "Order completed",
        content: "Order X is completed. Please rate the buyer by ...",
      })
    ).toBe("order");
  });

  it("タイトルで判定不能なら本文で判定", () => {
    expect(
      inferShopNotificationCategory({
        title: "お知らせ",
        content: "Your payout has been transferred",
      })
    ).toBe("balance");
  });

  it("どれにも該当しなければ other", () => {
    expect(
      inferShopNotificationCategory({ title: "Hello", content: "world" })
    ).toBe("other");
  });
});
