import { describe, it, expect } from "vitest";

import {
  inferChatMessageSender,
  isLatestMessageFromBuyer,
} from "@/lib/shopee-conversation-utils";
import { resolveHandlingStatus } from "@/lib/handling-status";

/**
 * 回帰防止: 手動返信 (テキスト / スタンプ) 後に対応ステータスが「未返信」に
 * 戻ってしまうバグ (pikieyjaafar 案件 2026-05-28) の真因と修正を固定する。
 *
 * 真因: 出品者がチャットを送ると from_id は「出品者の user_id」で来る。これは
 * shop_id とは別番号 (本番実データ: shop_id=1704031241 / from_id=7792491535)。
 * スタンプは from_id=0 で来ることもある。旧 inferChatMessageSender は
 * `from_id === shop_id` だけを staff としていたため、これらを customer と誤判定し、
 * isLatestMessageFromBuyer=true → resolveHandlingStatus が「未返信」を返していた。
 */

// 本番 pikieyjaafar 会話の実値
const SHOP_ID = 1704031241;
const SELLER_USER_ID = 7792491535; // 出品者の user_id (shop_id と別番号)
const BUYER_ID = 93369981;

describe("inferChatMessageSender — 出品者 user_id / スタンプの staff 判定", () => {
  it("出品者の user_id (shop_id と別番号) からの送信は staff", () => {
    expect(
      inferChatMessageSender({ from_id: SELLER_USER_ID }, SHOP_ID, BUYER_ID)
    ).toBe("staff");
  });

  it("shop_id そのものからの送信も staff (後方互換)", () => {
    expect(
      inferChatMessageSender({ from_id: SHOP_ID }, SHOP_ID, BUYER_ID)
    ).toBe("staff");
  });

  it("buyer の user_id からの送信は customer", () => {
    expect(
      inferChatMessageSender({ from_id: BUYER_ID }, SHOP_ID, BUYER_ID)
    ).toBe("customer");
  });

  it("from_id=0 のスタンプで to_id=buyer なら staff 送信", () => {
    expect(
      inferChatMessageSender(
        { from_id: 0, to_id: BUYER_ID, message_type: "sticker" },
        SHOP_ID,
        BUYER_ID
      )
    ).toBe("staff");
  });

  it("from_id=0 で to_id=shop なら buyer 発信 (商品カード問い合わせ等)", () => {
    expect(
      inferChatMessageSender(
        { from_id: 0, to_id: SHOP_ID, message_type: "item" },
        SHOP_ID,
        BUYER_ID
      )
    ).toBe("customer");
  });

  it("from_shop_id が shop なら staff (from_id=0 / to_id 不明でも)", () => {
    expect(
      inferChatMessageSender(
        { from_id: 0, from_shop_id: SHOP_ID },
        SHOP_ID,
        BUYER_ID
      )
    ).toBe("staff");
  });

  it("判定不能 (from_id=0, to_id=0) は customer 側に倒す (従来通り)", () => {
    expect(
      inferChatMessageSender({ from_id: 0, to_id: 0 }, SHOP_ID, BUYER_ID)
    ).toBe("customer");
  });
});

describe("isLatestMessageFromBuyer — 店舗スタンプが最終なら false", () => {
  function msg(fromId: number, toId: number, timeMs: number) {
    return {
      from_id: fromId,
      to_id: toId,
      timestamp: Math.floor(timeMs / 1000),
    };
  }

  it("最終メッセージが出品者スタンプ (from_id=seller_user) なら false", () => {
    const t0 = Date.now() - 10 * 60_000;
    const rawList = [
      msg(BUYER_ID, SHOP_ID, t0), // buyer
      msg(SELLER_USER_ID, BUYER_ID, t0 + 5 * 60_000), // staff sticker (latest)
    ];
    expect(isLatestMessageFromBuyer(rawList, SHOP_ID, BUYER_ID)).toBe(false);
  });

  it("最終メッセージが from_id=0 の店舗スタンプ (to_id=buyer) でも false", () => {
    const t0 = Date.now() - 10 * 60_000;
    const rawList = [
      msg(BUYER_ID, SHOP_ID, t0),
      { from_id: 0, to_id: BUYER_ID, timestamp: Math.floor((t0 + 60_000) / 1000) },
    ];
    expect(isLatestMessageFromBuyer(rawList, SHOP_ID, BUYER_ID)).toBe(false);
  });

  it("最終メッセージが buyer なら true", () => {
    const t0 = Date.now() - 10 * 60_000;
    const rawList = [
      msg(SELLER_USER_ID, BUYER_ID, t0),
      msg(BUYER_ID, SHOP_ID, t0 + 60_000),
    ];
    expect(isLatestMessageFromBuyer(rawList, SHOP_ID, BUYER_ID)).toBe(true);
  });
});

describe("resolveHandlingStatus — 手動返信後は in_progress を維持", () => {
  it("店舗スタンプが最終 (buyerLast=false) なら stored=in_progress を維持", () => {
    expect(
      resolveHandlingStatus(
        { handling_status: "in_progress", unread_count: 0 },
        { buyer_last_message_is_latest: false }
      )
    ).toBe("in_progress");
  });

  it("buyerLast=true (誤判定なし) なら in_progress は未返信に戻る (既存仕様)", () => {
    expect(
      resolveHandlingStatus(
        { handling_status: "in_progress", unread_count: 0 },
        { buyer_last_message_is_latest: true }
      )
    ).toBe("unreplied");
  });
});
