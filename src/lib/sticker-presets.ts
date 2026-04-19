/**
 * よく使うスタンプのプリセット定義
 * ------------------------------------------------------------------
 * Shopee Open Platform は公式のスタンプ一覧 API を提供していない。
 * そのため各スタンプの (sticker_package_id, sticker_id) ペアは
 * 事前に手動で取得してこのファイルに貼り付ける必要がある。
 *
 * 【ID の取得手順】
 *  1. Seller Center / Shopee 公式アプリから該当スタンプを
 *     任意の（テスト用）会話に送信する。
 *  2. Chapee の /chats/[id] 画面で既存の「スタンプ」ボタンを開き、
 *     会話内のスタンプ一覧からそのスタンプが出ていることを確認。
 *  3. 各タイルの button 要素の title 属性に
 *     「送信 (pkg: XXXX, id: YYYY)」が表示されるので読み取る。
 *     代替手段: MongoDB の該当会話ドキュメント内メッセージから
 *     sticker_card.package_id / sticker_id を確認。
 *  4. 下の STICKER_PRESETS の該当ラベルの
 *     sticker_package_id / sticker_id に貼り付けてコミット。
 *
 * 【supported_markets】
 *  未指定 (undefined) なら「全市場で使える想定」。
 *  実運用で特定市場でしか動かないと判明したら
 *  例: supported_markets: ["SG", "MY"] のように絞る。
 *
 * 【最終取得日】
 *  2026-04-19: 初期スケルトン（ID 未投入）
 *  2026-04-19: orangutan_my_new パックの4種を投入（ありがとう/確認中/了解/お待たせしました）
 * ------------------------------------------------------------------
 */

export type StickerPreset = {
  /** UI に表示するラベル */
  label: string;
  /** Shopee sticker_package_id（数値文字列） */
  sticker_package_id: string;
  /** Shopee sticker_id（数値文字列） */
  sticker_id: string;
  /** 省略時は全市場対応想定。特定市場限定の場合のみ指定 */
  supported_markets?: string[];
};

/**
 * UI に並べる順でそのまま表示される。
 * sticker_package_id / sticker_id が空文字のものは UI に出ない（自動で非表示）。
 */
export const STICKER_PRESETS: StickerPreset[] = [
  {
    label: "ありがとう",
    sticker_package_id: "orangutan_my_new",
    sticker_id: "06",
  },
  {
    label: "確認中",
    sticker_package_id: "orangutan_my_new",
    sticker_id: "29",
  },
  {
    label: "了解",
    sticker_package_id: "orangutan_my_new",
    sticker_id: "02",
  },
  {
    label: "お待たせしました",
    sticker_package_id: "orangutan_my_new",
    sticker_id: "03",
  },
];

/**
 * 指定市場で利用できるプリセットに絞って返す。
 * - market が undefined → 全プリセットが候補
 * - プリセットの supported_markets が未指定 → 全市場で候補
 * - 両方指定されている → market が supported_markets に含まれるものだけ
 * ただし sticker_package_id / sticker_id が空のものは常に除外する
 * （未投入のプリセットが UI に表示されないようにする）
 */
export function getStickerPresetsForMarket(market?: string): StickerPreset[] {
  return STICKER_PRESETS.filter((p) => {
    if (!p.sticker_package_id || !p.sticker_id) return false;
    if (!market) return true;
    if (!p.supported_markets || p.supported_markets.length === 0) return true;
    return p.supported_markets.includes(market);
  });
}
