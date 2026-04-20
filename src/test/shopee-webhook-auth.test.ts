import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  resolveShopeeWebhookUrl,
  verifyShopeeWebhookSignature,
} from "@/lib/shopee-webhook-auth";

const PARTNER_KEY = "test_partner_key_abcdef1234567890";
const URL_REAL = "https://chapee-jet.vercel.app/api/shopee/webhook";
const BODY = JSON.stringify({
  code: 3,
  shop_id: 2032481,
  data: { ordersn: "240419ABCXYZ", status: "READY_TO_SHIP" },
});

function computeSig(url: string, body: string, key: string, toUpper = false) {
  const hex = crypto
    .createHmac("sha256", key)
    .update(`${url}|${body}`)
    .digest("hex");
  return toUpper ? hex.toUpperCase() : hex;
}

describe("verifyShopeeWebhookSignature", () => {
  it("accepts a correctly-signed request (lower-case hex)", () => {
    const sig = computeSig(URL_REAL, BODY, PARTNER_KEY);
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: sig,
        partnerKey: PARTNER_KEY,
      })
    ).toBe(true);
  });

  it("accepts upper-case hex signature (case-insensitive compare)", () => {
    const sig = computeSig(URL_REAL, BODY, PARTNER_KEY, true);
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: sig,
        partnerKey: PARTNER_KEY,
      })
    ).toBe(true);
  });

  it("rejects tampered body", () => {
    const sig = computeSig(URL_REAL, BODY, PARTNER_KEY);
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY + " ",
        authorizationHeader: sig,
        partnerKey: PARTNER_KEY,
      })
    ).toBe(false);
  });

  it("rejects wrong partner key", () => {
    const sig = computeSig(URL_REAL, BODY, "different_key");
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: sig,
        partnerKey: PARTNER_KEY,
      })
    ).toBe(false);
  });

  it("rejects URL mismatch (preview vs production)", () => {
    const sigForPreview = computeSig(
      "https://chapee-preview.vercel.app/api/shopee/webhook",
      BODY,
      PARTNER_KEY
    );
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: sigForPreview,
        partnerKey: PARTNER_KEY,
      })
    ).toBe(false);
  });

  it("rejects empty Authorization header", () => {
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: "",
        partnerKey: PARTNER_KEY,
      })
    ).toBe(false);
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: null,
        partnerKey: PARTNER_KEY,
      })
    ).toBe(false);
  });

  it("rejects when partner_key is empty (defensive)", () => {
    const sig = computeSig(URL_REAL, BODY, PARTNER_KEY);
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: sig,
        partnerKey: "",
      })
    ).toBe(false);
  });

  it("rejects wrong-length signature without throwing (timingSafeEqual guard)", () => {
    expect(
      verifyShopeeWebhookSignature({
        url: URL_REAL,
        rawBody: BODY,
        authorizationHeader: "abc123",
        partnerKey: PARTNER_KEY,
      })
    ).toBe(false);
  });
});

describe("resolveShopeeWebhookUrl", () => {
  it("uses SHOPEE_WEBHOOK_URL env when set", () => {
    const orig = process.env.SHOPEE_WEBHOOK_URL;
    process.env.SHOPEE_WEBHOOK_URL = "https://explicit.example.com/api/x";
    try {
      expect(
        resolveShopeeWebhookUrl("https://ignored.example.com/api/y?a=1")
      ).toBe("https://explicit.example.com/api/x");
    } finally {
      if (orig === undefined) delete process.env.SHOPEE_WEBHOOK_URL;
      else process.env.SHOPEE_WEBHOOK_URL = orig;
    }
  });

  it("falls back to origin+pathname from request URL when env unset", () => {
    const orig = process.env.SHOPEE_WEBHOOK_URL;
    delete process.env.SHOPEE_WEBHOOK_URL;
    try {
      expect(
        resolveShopeeWebhookUrl(
          "https://chapee-preview.vercel.app/api/shopee/webhook?test=1"
        )
      ).toBe("https://chapee-preview.vercel.app/api/shopee/webhook");
    } finally {
      if (orig !== undefined) process.env.SHOPEE_WEBHOOK_URL = orig;
    }
  });
});
