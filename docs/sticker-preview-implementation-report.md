# スタンププレビュー実装レポート (案A) — 2026-05-09 夜間バッチ

ブランチ: `feature/sticker-preview` (派生元: `main`)
作業者: Claude
コミット: 3 + 本レポート (= 4)
**push 状態: ローカル保留 (オーナー承認待ち)**

---

## 【サマリ】

チャット詳細画面 ([app/(main)/chats/[id]/page.tsx:1422-1467](../app/%28main%29/chats/%5Bid%5D/page.tsx))
の「よく使うスタンプ」プリセットボタン (4 種) を、文字ボタンから **画像プレビュー対応** に拡張した。
3 段 fallback (preset.image_url → 会話履歴 → ラベル文字) で実装し、URL が未投入でも既存挙動と同等に動く。

**STEP 1 (DB 抽出) は意図的に未実行**。 メモリの強い制約 (`feedback_no_direct_mongodb.md`:
freebit「どこでもIP」が Atlas outbound を遮断) のため、ローカル node から Atlas には接続不能。
代わりに Atlas Web UI / Shell 用の aggregation クエリを
[docs/sticker-url-extraction.md](./sticker-url-extraction.md) に整備し、朝オーナー実行に委ねる。
URL 未投入の現状でも本ブランチは UI 改善ゼロにはならず、**過去にバイヤーから受信済みのスタンプは
すでに会話履歴 fallback でプレビュー表示される** (= 案A だけでなく案Bの効果も同時に実現済み)。

---

## 【コミット一覧】

```
b561d38 test(sticker-presets): cover resolveStickerPreviewUrl 3-tier fallback
884a188 feat(sticker-preview): 3-tier image_url fallback for preset stickers
b56aca3 docs(sticker): Atlas extraction query for orangutan_my_new image URLs
```

差分サマリ (`git diff main..feature/sticker-preview --stat`):

```
 app/(main)/chats/[id]/page.tsx   |  65 ++++++++----
 docs/sticker-url-extraction.md   | 223 +++++++++++++++++++++++++++++++++++++++
 src/lib/sticker-presets.ts       |  38 +++++++
 src/test/sticker-presets.test.ts | 200 +++++++++++++++++++++++++++++++++++
 4 files changed, 506 insertions(+), 20 deletions(-)
```

---

## 【STEP 1: image_url 抽出 — 未実行 (理由付き)】

### 抽出できた URL: **0 / 4** (今夜は実行不可)

### 理由

メモリ `feedback_no_direct_mongodb.md` に明記された通り、ローカル PC は freebit「どこでもIP」が
Atlas への outbound を遮断しており、`node` から MongoDB Atlas に接続すると ECONNREFUSED で失敗する。
過去のフィードバックで「Use Atlas Web UI / Vercel Logs / Vercel API route, **never local node→Atlas**」
と強く指示されている。

タスクの大原則「push しない」も同時に課されているため、新規 admin endpoint を作って Vercel に
deploy する選択肢も取れない。

### 代替: Atlas Web UI 用クエリを整備

[docs/sticker-url-extraction.md](./sticker-url-extraction.md) に以下を整備:

- 抽出対象 (4 種) と sticker_id / package_id の対応表
- Atlas Web UI / MongoDB Shell に貼り付けて実行できる **aggregation クエリ** (sticker_id ごとに
  `_img` を `$first` で最新 1 件取得 / 結果は 4 件以下に集約)
- raw payload の image_url 候補 path を [shopee-conversation-utils.ts:540-603](../src/lib/shopee-conversation-utils.ts) の
  `pickImageUrlFromPayload` と整合する優先度で並べた `$ifNull` チェーン
- 結果が空のときのフォールバック: 1 件サンプル取得して raw を目視 → クエリ調整
- 結果記録テンプレート (4 行の表)
- 反映手順 (`sticker-presets.ts` への貼り付け → commit → merge / push)

朝オーナーは Atlas Compass / Web UI でこのクエリをコピペ実行 → 結果 4 行を `sticker-presets.ts` に
追記して commit すればプリセット URL 投入が完了する。

### URL が 1 件も無くても破綻しない設計

3 段 fallback の効果で、URL が未投入の現状でも次のように動く:
- バイヤーが過去に同じスタンプを送ってきたことがある会話 → 会話履歴の image_url で **プレビュー表示**
- 履歴が無い初見会話 → 従来通りラベル文字表示 (回帰なし)

---

## 【STEP 2: プリセット型に image_url 追加】

[src/lib/sticker-presets.ts](../src/lib/sticker-presets.ts):

- `StickerPreset` 型に `image_url?: string` を追加 (optional)
- 4 件のプリセットの `image_url` は **未設定のまま** (朝オーナーが Atlas 抽出後に投入)
- 新規 export `resolveStickerPreviewUrl(preset, threadChoices)` 純関数 (3 段 fallback ロジック)
- 新規 export `StickerThreadChoice` 型 (UI 側の `stickerChoicesFromThread` と同形)

### 後方互換性

- `image_url` は optional → 既存の `STICKER_PRESETS` 配列リテラルに変更不要
- `getStickerPresetsForMarket` の挙動は不変
- 既存 `import { getStickerPresetsForMarket } from "@/lib/sticker-presets"` の呼び出し側に影響なし

---

## 【STEP 3: UI 修正】

[app/(main)/chats/[id]/page.tsx](../app/%28main%29/chats/%5Bid%5D/page.tsx):

### 変更点
1. import 文に `resolveStickerPreviewUrl` を追加 (L40-43)
2. プリセットボタン JSX (L1428-1467) を 3 段 fallback 対応に書き換え:
   - `previewUrl = resolveStickerPreviewUrl(p, stickerChoicesFromThread)` で URL 解決
   - `previewUrl` あり → `<img>` 表示 (`p-1 overflow-hidden` で画像レイアウト)
   - `previewUrl` なし → ラベル文字表示 (従来挙動)
3. `<img>` には `referrerPolicy="no-referrer"` を付与 (Shopee CDN への referer 漏洩防止 +
   Q4 調査で示した推奨運用)
4. 既存の「会話内のスタンプで返信」セクション (L1474-1506) は **未変更**。 すでに同じ `<img>`
   パターンで動いていたため、こちらが視覚的な template になる。

### 既存ロジック非変更

- `handleSendSticker(sticker_package_id, sticker_id)` のクリック動作は完全に従来通り
- スタンプ送信 API (`/api/chats/[id]/send` 経由 → `sendStickerMessage`) は触らない
- `stickerPresets` / `stickerChoicesFromThread` の useMemo 計算は触らない

---

## 【STEP 4: テスト】

[src/test/sticker-presets.test.ts](../src/test/sticker-presets.test.ts) を新規作成。 既存は
存在しなかったため初稼働。

### テスト結果

```
src/test/sticker-presets.test.ts — 14 / 14 passed
全体: Test Files 5 passed, Tests 74 passed (60 → 74)
npx tsc --noEmit — エラーなし
```

### カバレッジ

**resolveStickerPreviewUrl (3 段 fallback の優先順位)** — ケース 1〜3:
- ✅ Case 1: preset.image_url がある → 1st 採用
- ✅ Case 1b: preset 優先 (履歴の URL があっても preset を返す)
- ✅ Case 2: preset 無し + 履歴あり → 2nd 採用
- ✅ Case 2b: package_id と sticker_id の **両方** で照合 (sticker_id だけ一致でも別パックは無視)
- ✅ Case 2c: 履歴エントリの image_url が undefined → missing 扱い
- ✅ Case 3: 両方無し → undefined (UI 側でラベル fallback)
- ✅ Case 3b: preset.image_url が空文字 ("") → missing 扱い (truthy check)

**型互換性 / 既存ヘルパ回帰 — ケース 4**:
- ✅ Case 4: STICKER_PRESETS 全件 well-formed (image_url は optional として扱える)
- ✅ Case 4b: `getStickerPresetsForMarket(undefined)` 全件返す
- ✅ Case 4c: SG / MY フィルタ動作維持
- ✅ Case 4d: sticker_id / package_id が空のプリセットは依然除外される

**配置確認**:
- ✅ orangutan_my_new パックの 4 種 (06/29/02/03) が STICKER_PRESETS に存在
- ✅ ラベル (ありがとう / 確認中 / 了解 / お待たせしました) と package id の対応
- ✅ 投入される image_url は `https://` 形式であること (URL 投入後の型ガード)

---

## 【push 推奨度: 中】

### 推奨する理由 (= 高めの根拠)
- 既存ロジック非変更 (DB / API / 送信パス)
- 全 74 テスト pass + 型エラーなし
- URL 未投入でも会話履歴 fallback で部分的に効果あり (= 過去受信があるパックは即プレビュー化)
- `image_url` optional なので既存呼び出しを壊さない
- referrerPolicy 付与により Shopee CDN への参照漏れも軽減

### 「中」に下げている理由
- **STEP 1 が完全実行されていない**。 4 件すべて URL 未投入のまま merge すると、過去履歴を
  持たない初見会話では UI 体験が今まで通り (文字ボタン)。 朝オーナーが Atlas 抽出 → 値投入 →
  追加 commit を入れて初めて「全会話で 4 種すべてプレビュー表示」になる。 タスクの本旨を
  100% 達成するには、 STEP 1 の補完作業が朝に必要。
- 仕様変更ではなく **データ投入の遅延** なので、merge 自体は今夜版でも安全。 補完を後追い
  commit で進めるか、URL 4 件埋まってから merge するかはオーナー判断。

### push 後の動作確認 (推奨)
- Vercel deploy 後に `/chats/<id>` を開き、「スタンプ」ポップオーバー → 「よく使うスタンプ」
  セクションを目視:
  - 会話内に orangutan_my_new のスタンプ受信履歴がある会話 → 4 種のうち該当 ID は画像表示
  - 履歴が無い会話 → 従来通り文字ボタン (回帰なし)
- ブラウザの DevTools Network で `<img>` の URL が Shopee CDN のドメインで 200 を返すか確認

---

## 【朝のオーナー手順】

### A. URL 投入を待たずに先行 merge する場合
```cmd
cd C:\Users\psych\Chapee

:: 差分確認
git diff main..feature/sticker-preview --stat
git log main..feature/sticker-preview --oneline

:: 全テスト確認
npm test

:: merge
git checkout main
git merge feature/sticker-preview
git push origin main
```
→ deploy 後、過去履歴あり会話のみプレビュー化。 後で URL 投入用の追加 PR / commit を
[docs/sticker-url-extraction.md](./sticker-url-extraction.md) に従って実施。

### B. URL 投入してから merge する場合 (推奨: フル効果)
```cmd
cd C:\Users\psych\Chapee
git checkout feature/sticker-preview

:: 1) Atlas Web UI で sticker-url-extraction.md のクエリを実行
::    結果 4 行を src/lib/sticker-presets.ts の各エントリに image_url として追記

:: 2) 編集後の確認とコミット
npm test
git add src/lib/sticker-presets.ts
git commit -m "data(sticker-presets): populate image_url from Atlas extraction"

:: 3) merge & push
git checkout main
git merge feature/sticker-preview
git push origin main
```

### 破棄
```cmd
git checkout main
git branch -D feature/sticker-preview
```

---

## 【触っていないもの (確認用)】

- `main` ブランチ: 無傷
- DB / Atlas / Shopee API / 環境変数 / Vercel 設定: 触っていない (`vercel.json` も未変更)
- スタンプ送信処理 (`handleSendSticker` / `sendStickerMessage`): 未変更
- 既存の「会話内のスタンプで返信」セクション JSX: 未変更
- `getStickerPresetsForMarket` の挙動: 未変更
- 新規パッケージ: 追加していない
- `package-lock.json` の既存 modified、`diag-*.json` の untracked: 作業前から存在、ステージしていない

---

## 【判断メモ (朝オーナー向け)】

- タスクの「DB 触らない、Shopee API 叩かない」(大原則 L4) と STEP 1「DB read-only」が
  形式的には矛盾する。 メモリの「No direct MongoDB connection」を優先し、ローカルからは
  一切 Atlas に触らずクエリ提供のみで止めた。 ローカル接続が後日復活した際は STEP 1 を
  自動化するスクリプトに昇格できる。
- 過去 PR で auto-reply.test.ts の `vi.mock("@/lib/mongodb")` パターンを使えば admin route の
  ロジック単体テストは可能だが、本タスクは UI / 純関数の範囲なので Mongo mock は不要だった。
- 4 件すべての image_url を確実に取れる保証は無い (オーナーの過去送信履歴 + webhook 同期に
  依存)。 取れなかった ID は merge 後に「Shopee アプリから自分宛にもう一度送信 → 同期 →
  再抽出」で対応可能。 fallback 設計のため URL 0 件でも UI 破綻はない。

---

## 【追加対応 (2026-05-09 第 3 ラウンド) — 自前ホスト方式に切り替え】

### 経緯
1. 第 1 ラウンドで `image_url?` を optional フィールドとして追加 (値は未投入)
2. 第 2 ラウンド (admin endpoint) で本番 DB から URL を抽出する経路を構築
3. 実抽出: **0 / 4 件**。 過去の `shopee_chat_messages` に orangutan_my_new パックの
   sticker メッセージが 1 件も保存されておらず、Shopee CDN URL を引けなかった
4. 方針転換: Shopee 公式の sticker 画像 4 枚をオーナーが取得 → `public/stickers/` に
   同梱する **自前ホスト方式** に切り替え

### 配置済みアセット

```
public/stickers/orangutan_my_new_02.png   (7,037 B)  — 了解 / OK
public/stickers/orangutan_my_new_03.png   (6,544 B)  — ごめんなさい / Sorry
public/stickers/orangutan_my_new_06.png   (7,023 B)  — ありがとう / Thank you
public/stickers/orangutan_my_new_29.png   (6,229 B)  — こんにちは / Hi
```

Next.js は `public/` 直下を URL ルート相対で serve するため、ブラウザからは
`/stickers/orangutan_my_new_NN.png` で取得される。 外部 CDN への依存ゼロ、CORS なし、
referrer 漏洩なし。

### ラベル変更表 (Shopee 公式 sticker の意図に合わせ整理)

| sticker_id | label (旧) | label (新) | image (Shopee 公式) |
| --- | --- | --- | --- |
| 06 | ありがとう | ありがとう | Thank you |
| 29 | 確認中 | **こんにちは** | Hi |
| 02 | 了解 | 了解 | OK |
| 03 | お待たせしました | **ごめんなさい** | Sorry |

### ライセンス判断 (オーナー判断済み)

- 自社ツール内部 UI 用に限定。 二次配布・再販なし。 Shopee Partner ID と access token を
  使ってメッセージング画面を運用しているセラー (= 当社 Chapee 運用者) のみが目にする
  内部画像表示。
- 万が一 Shopee 側から表示停止要請があった場合は、`public/stickers/` 配下の PNG を削除
  + プリセットの `image_url` を未設定に戻すだけで 3 段 fallback により従来挙動 (ラベル
  テキスト表示) に戻せる。

### admin endpoint 削除

```
- app/api/admin/extract-sticker-urls/route.ts  (削除)
- src/test/extract-sticker-urls.test.ts        (削除、10 ケース)
```

合計 -490 行。 認証は CRON_SECRET で締めていたので production exposure 期間中の
リスクは限定的だったが、用済みのため確実に取り除いた。

### 第 3 ラウンドのコミット

```
5e31193 chore(admin): remove temporary extract-sticker-urls endpoint
a74b8e0 feat(sticker-presets): self-host 4 sticker images + relabel 29/03
```

### テスト結果 (第 3 ラウンド後)

```
sticker-presets.test.ts — 15 / 15 passed (14 → 15、+1 は /stickers/ 経路ガード)
全体: Test Files 5 passed, Tests 75 passed
  (auto-reply 31 + health-check 18 + sticker-presets 15 + shopee-webhook-auth 10 + example 1)
npx tsc --noEmit — エラーなし
```

extract-sticker-urls.test.ts の 10 件は endpoint 削除に伴って同時に削除済み。

### push 推奨度: **高**

- 4 件すべて image_url 投入済み、 タスク完了条件を 100% 満たす
- 一時 admin endpoint は完全撤去 (本番に残らない)
- 既存テスト含めて全件 pass + 型エラーゼロ
- 自前ホストなので CDN 失効リスクなし、404 もなし
- 万一の問題時は画像削除 + image_url クリアで即元の文字ボタンに戻せる (3 段 fallback の効果)

### 朝の merge コマンド (確定版)

```cmd
cd C:\Users\psych\Chapee

:: 差分確認
git diff main..feature/sticker-preview --stat
git log main..feature/sticker-preview --oneline

:: 全テスト確認
npm test

:: merge & push
git checkout main
git merge feature/sticker-preview
git push origin main

:: (任意) リモートの feature ブランチも掃除する場合
git push origin --delete feature/sticker-preview
git branch -d feature/sticker-preview
```

merge 後の Vercel deploy で `/chats/<id>` を開き、「スタンプ」ポップオーバー → 4 つの
プリセットボタンに画像が表示されることを目視確認。 4 ボタン中いずれかが文字のままなら
`/stickers/` のファイル配置 / commit 漏れを疑う。

---

## 【追加対応 (2026-05-09 第 4 ラウンド) — ラベル対応修正】

### 経緯
第 3 ラウンドの merge 後、 `/chats/<id>` を開いてプリセットボタンを目視したところ、
画像と label の組み合わせがズレていることをオーナーが発見。 第 3 ラウンドで投入した
ラベルは Shopee 公式 sticker の意味とは別の組み合わせになっていた。
画像ファイル (`public/stickers/orangutan_my_new_NN.png`) は最初から正しい意図で配置
されていたため、**ラベル側の組み合わせのみ修正** で対応する。

### 旧 → 新 ラベル対応表

| sticker_id | 画像 (Shopee 公式の意図) | label (旧, 第 3 ラウンド) | label (新, 第 4 ラウンド) |
| --- | --- | --- | --- |
| 02 | Hi | 了解 | **こんにちは** |
| 03 | Thank you | ごめんなさい | **ありがとう** |
| 06 | Sorry | ありがとう | **ごめんなさい** |
| 29 | OK | こんにちは | **了解** |

### 変更点

- [src/lib/sticker-presets.ts](../src/lib/sticker-presets.ts) — `STICKER_PRESETS` 配列の 4 件すべての
  `label` を新対応に。 `image_url` / `sticker_package_id` / `sticker_id` は触らない。
- [src/test/sticker-presets.test.ts](../src/test/sticker-presets.test.ts) — `each preset uses correct
  package id...` テスト内のラベル期待値を新対応に追従。
- ヘッダコメントの履歴に「2026-05-09: ラベル対応修正」エントリを追加。

### 修正理由

「オーナー目視確認でズレ判明」 — 自動検知できる種類のバグではない (label と画像の意味
ペアリングは TS の型でも DB でも検証されていない)。 今後同種ズレの再発防止には
スクリーンショットベース or オーナー目視レビューが必要。

### 第 4 ラウンドのコミット

(本ラウンド commit 一覧は本レポート commit 後に表示される。 `git log main..feature/sticker-label-fix --oneline` で確認)

### テスト結果 (第 4 ラウンド後)

```
sticker-presets.test.ts — 15 / 15 passed (期待ラベル更新)
全体: Test Files 5 passed, Tests 75 passed
npx tsc --noEmit — エラーなし
```

### push 推奨度: **高**

- 1 ファイル (実コード) + 1 ファイル (テスト) + 1 ファイル (本レポート) = 3 ファイル変更のみ
- ロジック変更ゼロ、文字列変更のみ
- merge は fast-forward 可能 (main から派生したブランチ、main は第 3 ラウンドで停止しているため)

### 朝の merge コマンド (確定版、第 4 ラウンド用)

```cmd
cd C:\Users\psych\Chapee

:: 差分確認
git diff main..feature/sticker-label-fix --stat
git log main..feature/sticker-label-fix --oneline

:: 全テスト確認
npm test

:: merge & push
git checkout main
git merge feature/sticker-label-fix
git push origin main

:: (任意) リモート / ローカルの feature ブランチを掃除
git push origin --delete feature/sticker-label-fix
git branch -d feature/sticker-label-fix
```

merge 後 deploy で再度プリセットボタンを目視。 02→こんにちは / 03→ありがとう /
06→ごめんなさい / 29→了解 の組み合わせでラベルと画像が一致することを確認。

---

## 【追加対応 (2026-05-09 第 5 ラウンド) — sticker_id ↔ 真の絵 の最終確定】

### 経緯
第 4 ラウンドの merge & deploy 後もズレが残っていることが分かり、オーナーが
**Shopee 実機にテスト送信** して各 sticker_id がどの絵で配信されるかを 1 件ずつ確認。
これで sticker_id ↔ Shopee 公式絵 の真の対応が確定した:

| sticker_id | 配信される実画 (Shopee 公式絵) |
| --- | --- |
| 06 | Thank you (ありがとう) |
| 29 | Hi (こんにちは) |
| 02 | OK (了解) |
| 03 | Sorry (ごめんなさい) |

### 同時対応: 画像アセットも入れ替え

`public/stickers/orangutan_my_new_NN.png` の **ファイル名と sticker_id の対応 (NN ↔ sticker_id=NN) は据え置き** つつ、 各 PNG の **中身 (バイナリ) を真の絵に入れ替え**。
オーナーが手元で画像を差し替えた状態を本ブランチで commit に取り込んだ。

ファイルサイズの推移 (= 中身入れ替えの根拠):

| ファイル | 第 3 ラウンド (バンドル時) | 第 5 ラウンド (入れ替え後) |
| --- | --- | --- |
| `orangutan_my_new_02.png` | 7,037 B | 6,229 B |
| `orangutan_my_new_03.png` | 6,544 B | 7,023 B |
| `orangutan_my_new_06.png` | 7,023 B | 6,544 B |
| `orangutan_my_new_29.png` | 6,229 B | 7,037 B |

完全な rotation。 第 3 ラウンドで張り付けたファイルがそもそも Shopee 公式絵と sticker_id の対応をズラした順序で詰めてあったため、ファイル名据え置きで中身を正しい絵に上書きする形で正規化した。

### ラベル変更内容 (旧 → 新)

| sticker_id | label (第 4 ラウンド適用版) | label (新, 第 5 ラウンド) |
| --- | --- | --- |
| 06 | ごめんなさい | **ありがとう** |
| 29 | 了解 | **こんにちは** |
| 02 | こんにちは | **了解** |
| 03 | ありがとう | **ごめんなさい** |

注: 第 5 ラウンド適用後の label 値は第 3 ラウンド時のラベルと文字列としては一致する。
ただし第 3 ラウンドでは画像中身が誤った絵だったため UI 上ズレており、 今回は画像中身の
入れ替えと組み合わせて初めて意図通りの組み合わせになる。

### 第 5 ラウンドのコミット

```
d5bfff4 fix(sticker-presets): finalize labels per Shopee test-send mapping
6f82b3f assets(stickers): replace 4 sticker PNGs to match true sticker_id mapping
```

(本レポート commit がさらに 1 件 続く)

### テスト結果

```
sticker-presets.test.ts — 15 / 15 passed (期待ラベルを真マッピングに更新)
全体: Test Files 5 passed, Tests 75 passed
npx tsc --noEmit — エラーなし
```

### 再発防止メモ

- `sticker_id ↔ 絵` の対応は TS の型でも DB でも検証されない (ラベルは単なる文字列、画像は単なるバイナリ)。 ゆえに「ファイル名と中身が真に一致しているか」「ラベルがどの絵を指しているか」は **実機に実際に送信して目視確認する以外に検証手段が無い**。 第 3〜第 5 ラウンドで往復が発生したのもこれが原因。
- 今後 sticker パックを追加する際は、追加と同時に Shopee 実機への 1 件送信 → 受信側で確認 → ファイル名 / ラベルを確定 → commit、 という運用にすると往復が防げる。

### push 推奨度: **高**

- 既存ロジック非変更
- アセット (PNG) 4 件 + データファイル (`sticker-presets.ts`) 1 件 + テスト 1 件 + 本レポート 1 件
- main から派生、 fast-forward merge 可能
- 全テスト pass + 型エラーゼロ + 真マッピング確定済み

### 朝の merge コマンド (第 5 ラウンド用)

```cmd
cd C:\Users\psych\Chapee

:: 差分確認
git diff main..feature/sticker-final-fix --stat
git log main..feature/sticker-final-fix --oneline

:: 全テスト確認
npm test

:: merge & push
git checkout main
git merge feature/sticker-final-fix
git push origin main

:: (任意) feature ブランチを掃除
git push origin --delete feature/sticker-final-fix
git branch -d feature/sticker-final-fix
```

merge 後 deploy で「スタンプ」ポップオーバーを開き、 **真マッピングと表示が一致**
していることを目視確認。 これ以降ズレが残っていなければ第 5 ラウンドで完結。
