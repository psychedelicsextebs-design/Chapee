import crypto from "crypto";

/**
 * Shopee Open Platform の Live Push (v2) 署名検証。
 *
 * 公式仕様:
 *   Authorization: HMAC_SHA256(url + "|" + raw_body_string, partner_key) を hex で返す
 *
 *   - url は Shopee コンソールで登録したコールバック URL（full URL, スキーム・パス含む）
 *   - raw_body_string は JSON.stringify 前の **素の** body 文字列
 *   - partner_key は SHOPEE_PARTNER_KEY 環境変数
 *
 * Shopee は大文字小文字の揺れがあるため、比較は lower-case で行う。
 * タイミングアタック対策に `timingSafeEqual` を使用。
 *
 * partner_key が未設定、または Authorization ヘッダーが無い場合は false を返す
 * （呼び出し側で 401 にする）。
 *
 * 注意:
 *   `/api/v2/...` API 呼び出し用の署名とは base string のフォーマットが異なる
 *   （API は `partner_id|path|timestamp|access_token|shop_id`, push は `url|body`）。
 *   共用ヘルパにはしない方が安全なので別ファイルで分離している。
 */
export function verifyShopeeWebhookSignature(params: {
  /** request URL。Shopee に登録した callback URL と**完全一致**する必要がある */
  url: string;
  /** request の生 body（バッファ or string）。JSON.parse する前の値を渡すこと */
  rawBody: string;
  /** request header `Authorization` の値 */
  authorizationHeader: string | null | undefined;
  /** Shopee Partner Key (env `SHOPEE_PARTNER_KEY`) */
  partnerKey: string;
}): boolean {
  const { url, rawBody, authorizationHeader, partnerKey } = params;
  if (!partnerKey) return false;
  if (!authorizationHeader) return false;
  const received = authorizationHeader.trim().toLowerCase();
  if (!received) return false;

  const baseString = `${url}|${rawBody}`;
  const expected = crypto
    .createHmac("sha256", partnerKey)
    .update(baseString)
    .digest("hex")
    .toLowerCase();

  // timingSafeEqual は同一長バッファでないと例外を投げるため長さチェック先行
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(received, "utf8"),
      Buffer.from(expected, "utf8")
    );
  } catch {
    return false;
  }
}

/**
 * NextRequest から webhook 検証に必要な URL を構築する。
 *
 * Shopee のコンソールに登録する callback URL は運用上
 * `https://chapee-jet.vercel.app/api/shopee/webhook` のように固定なので、
 * 本番では env `SHOPEE_WEBHOOK_URL` を参照し、未設定時のみ request から推測する。
 *
 * Preview deployment (Phase 2 テスト) では env が未設定でも
 * `request.url` の origin をそのまま使って検証できるようにするためのフォールバック。
 */
export function resolveShopeeWebhookUrl(requestUrl: string): string {
  const explicit = process.env.SHOPEE_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  try {
    const u = new URL(requestUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return requestUrl;
  }
}
