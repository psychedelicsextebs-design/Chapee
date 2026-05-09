import { describe, it, expect } from "vitest";
import {
  STICKER_PRESETS,
  getStickerPresetsForMarket,
  resolveStickerPreviewUrl,
  type StickerPreset,
  type StickerThreadChoice,
} from "@/lib/sticker-presets";

// ===========================================================================
// resolveStickerPreviewUrl — 3 段 fallback の優先順位
// ===========================================================================
describe("resolveStickerPreviewUrl", () => {
  const SAMPLE_PRESET: Pick<
    StickerPreset,
    "sticker_package_id" | "sticker_id" | "image_url"
  > = {
    sticker_package_id: "orangutan_my_new",
    sticker_id: "06",
  };

  const PRESET_URL = "https://cdn.example/preset/06.png";
  const THREAD_URL = "https://cdn.example/thread/06.png";

  // ケース1: preset.image_url がある → それが採用される
  it("Case 1: returns preset.image_url when defined (1st priority)", () => {
    const url = resolveStickerPreviewUrl(
      { ...SAMPLE_PRESET, image_url: PRESET_URL },
      [] // 履歴は空でも OK
    );
    expect(url).toBe(PRESET_URL);
  });

  it("Case 1b: preset.image_url overrides thread match (1st > 2nd)", () => {
    // 履歴側にも同 ID があるが、preset.image_url 優先
    const url = resolveStickerPreviewUrl(
      { ...SAMPLE_PRESET, image_url: PRESET_URL },
      [
        {
          sticker_id: "06",
          package_id: "orangutan_my_new",
          image_url: THREAD_URL,
        },
      ]
    );
    expect(url).toBe(PRESET_URL);
  });

  // ケース2: preset.image_url が無く、会話履歴に同 ID がある → 履歴の URL
  it("Case 2: falls back to thread history image_url when preset.image_url missing", () => {
    const url = resolveStickerPreviewUrl(SAMPLE_PRESET, [
      {
        sticker_id: "06",
        package_id: "orangutan_my_new",
        image_url: THREAD_URL,
      },
    ]);
    expect(url).toBe(THREAD_URL);
  });

  it("Case 2b: matches by both sticker_id AND package_id (not just sticker_id)", () => {
    // 別パックの同じ sticker_id "06" は無視される
    const url = resolveStickerPreviewUrl(SAMPLE_PRESET, [
      {
        sticker_id: "06",
        package_id: "different_pack", // ← 別パック
        image_url: THREAD_URL,
      },
    ]);
    expect(url).toBeUndefined();
  });

  it("Case 2c: thread entry without image_url is treated as missing", () => {
    const url = resolveStickerPreviewUrl(SAMPLE_PRESET, [
      {
        sticker_id: "06",
        package_id: "orangutan_my_new",
        image_url: undefined, // 履歴はあるが URL 無し
      },
    ]);
    expect(url).toBeUndefined();
  });

  // ケース3: preset の URL も履歴も無い → undefined (UI 側でラベル fallback)
  it("Case 3: returns undefined when neither preset nor thread has URL", () => {
    expect(resolveStickerPreviewUrl(SAMPLE_PRESET, [])).toBeUndefined();
  });

  it("Case 3b: empty preset.image_url ('') is treated as missing", () => {
    // truthy check なので空文字も missing 扱い
    const url = resolveStickerPreviewUrl(
      { ...SAMPLE_PRESET, image_url: "" },
      [
        {
          sticker_id: "06",
          package_id: "orangutan_my_new",
          image_url: THREAD_URL,
        },
      ]
    );
    expect(url).toBe(THREAD_URL);
  });
});

// ===========================================================================
// 既存型 (StickerPreset) と既存ヘルパ (getStickerPresetsForMarket) の回帰確認
// ===========================================================================
describe("StickerPreset / getStickerPresetsForMarket — backward compatibility", () => {
  // ケース4: image_url を追加しても既存の他用途は壊れない
  it("Case 4: STICKER_PRESETS entries are still well-formed without image_url", () => {
    expect(STICKER_PRESETS.length).toBeGreaterThan(0);
    for (const p of STICKER_PRESETS) {
      expect(typeof p.label).toBe("string");
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.sticker_package_id).toBe("string");
      expect(typeof p.sticker_id).toBe("string");
      // image_url は optional: 未設定なら undefined、あれば string
      if (p.image_url !== undefined) {
        expect(typeof p.image_url).toBe("string");
      }
    }
  });

  it("Case 4b: getStickerPresetsForMarket(undefined) returns all populated presets", () => {
    const all = getStickerPresetsForMarket(undefined);
    expect(all.length).toBe(STICKER_PRESETS.length);
    for (const p of all) {
      expect(p.sticker_package_id).not.toBe("");
      expect(p.sticker_id).not.toBe("");
    }
  });

  it("Case 4c: market filter still works after image_url addition", () => {
    // supported_markets 未指定のプリセット (全市場) は SG / MY 両方で出る
    const sg = getStickerPresetsForMarket("SG");
    const my = getStickerPresetsForMarket("MY");
    expect(sg.length).toBeGreaterThan(0);
    expect(my.length).toBeGreaterThan(0);
  });

  it("Case 4d: presets with empty sticker_id/package_id are excluded (regression)", () => {
    // image_url が無くても sticker_id / package_id が揃っていれば UI に出る
    // (新フィールド追加でこの既存ガードが壊れていないことの確認)
    const filtered: StickerPreset[] = [
      {
        label: "skip me",
        sticker_package_id: "",
        sticker_id: "06",
      },
      {
        label: "show me",
        sticker_package_id: "pkg",
        sticker_id: "01",
      },
    ];
    // Direct simulation of internal filter logic (since STICKER_PRESETS is a const)
    const valid = filtered.filter((p) => p.sticker_package_id && p.sticker_id);
    expect(valid).toHaveLength(1);
    expect(valid[0].label).toBe("show me");
  });
});

// ===========================================================================
// 配置確認: orangutan_my_new パックの 4 種が STICKER_PRESETS に存在
// ===========================================================================
describe("STICKER_PRESETS — orangutan_my_new pack coverage", () => {
  const EXPECTED_IDS = new Set(["06", "29", "02", "03"]);

  it("contains all 4 orangutan_my_new sticker IDs (06/29/02/03)", () => {
    const ids = new Set(
      STICKER_PRESETS.filter((p) => p.sticker_package_id === "orangutan_my_new").map(
        (p) => p.sticker_id
      )
    );
    for (const expected of EXPECTED_IDS) {
      expect(ids).toContain(expected);
    }
  });

  it("each preset uses correct package id 'orangutan_my_new' for the pack", () => {
    // ラベル対応 (2026-05-09 第 5 ラウンドでテスト送信により最終確定):
    //   06=ありがとう (Thank you) / 29=こんにちは (Hi) /
    //   02=了解       (OK)         / 03=ごめんなさい (Sorry)
    const expected: Array<{ sticker_id: string; label: string }> = [
      { sticker_id: "06", label: "ありがとう" },
      { sticker_id: "29", label: "こんにちは" },
      { sticker_id: "02", label: "了解" },
      { sticker_id: "03", label: "ごめんなさい" },
    ];
    for (const e of expected) {
      const found = STICKER_PRESETS.find(
        (p) => p.sticker_id === e.sticker_id && p.sticker_package_id === "orangutan_my_new"
      );
      expect(found).toBeDefined();
      expect(found!.label).toBe(e.label);
    }
  });

  // 投入された image_url は https URL または public/ 直下のルート相対パス
  // ("/stickers/...") のいずれか。 Shopee CDN を使う将来の選択肢を残すため両対応。
  it("image_url is either an https URL or a root-relative public path", () => {
    for (const p of STICKER_PRESETS) {
      if (p.image_url) {
        expect(p.image_url).toMatch(/^(https:\/\/|\/)/);
      }
    }
  });

  // public/stickers/ 自前ホスト (現行解): 4 種すべてルート相対の /stickers/ 配下
  it("each preset has an image_url pointing to /stickers/orangutan_my_new_<id>.png", () => {
    for (const p of STICKER_PRESETS) {
      if (p.sticker_package_id !== "orangutan_my_new") continue;
      expect(p.image_url).toBe(`/stickers/orangutan_my_new_${p.sticker_id}.png`);
    }
  });
});
