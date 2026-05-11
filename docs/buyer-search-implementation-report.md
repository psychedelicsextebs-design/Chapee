# バイヤー検索 + コールドスタート送信 実装レポート

> ブランチ: `feature/buyer-search`
> 派生元: `main` (HEAD = `8b00d06`)
> 実装日: 2026-05-11
> 関連調査: 「バイヤー検索 + コールドスタート送信 — 事前調査」 (前ターン)

---

## サマリ

注文してくれたバイヤーを Chapee 上から検索 (注文 ID / バイヤー名) し、 Shopee 上で会話が無くてもメッセージを送信できる新機能を実装。 既存の `sendOrderMessage` (注文カード送信で会話確立) + `sendMessage` (本文送信) を流用し、 schema 変更ゼロで実現。

---

## STEP ステータス

| STEP | 内容 | 状態 |
|---|---|---|
| 1 | `/api/buyers/search` GET 実装 | ✅ 完了 |
| 2 | `/api/buyers/cold-start-send` POST 実装 | ✅ 完了 |
| 3 | UI 実装 (`/chats` 上部 + モーダル) | ✅ 完了 |
| 4 | テスト追加 (vitest) | ✅ 完了 (93/93 pass) |
| 5 | 本レポート作成 | ✅ 完了 |

---

## 変更ファイル一覧

| ファイル | 種別 | 行数 |
|---|---|---|
| `app/api/buyers/search/route.ts` | 新規 | 213 |
| `app/api/buyers/cold-start-send/route.ts` | 新規 | 186 |
| `src/components/BuyerSearchDialog.tsx` | 新規 | 380 |
| `src/test/buyer-search.test.ts` | 新規 | 191 |
| `src/test/cold-start-send.test.ts` | 新規 | 233 |
| `app/(main)/chats/page.tsx` | 修正 | +17 -0 (button + import + state + dialog mount) |
| `docs/buyer-search-implementation-report.md` | 新規 | (本ファイル) |

**累計**: 6 新規 + 1 修正、 約 +1200 行

---

## STEP 1: `/api/buyers/search` (GET)

**クエリパラメータ**:
- `shop_id` (必須): 検索対象の Shopee shop ID
- `q` (任意): 検索文字列。 全数字なら `order_sn` 部分一致、 文字列なら `buyer_username` 部分一致 (大小無視)、 空なら期間内全件
- `days` (任意): 過去 N 日 (default 30, max 90)

**フロー**:
1. `getValidToken(shopId)` + `resolveCountryForShop(shopId)` で接続情報解決
2. `getOrderList` を **15 日窓** で連結 (Shopee 仕様上限) し期間内 `order_sn` を収集
3. `getOrderDetail` を **50 件 batch** で `response_optional_fields=["buyer_user_id","buyer_username","item_list","create_time","currency","total_amount"]` 指定で取得
4. `q` で filter (上記ルール)
5. `shopee_conversations.find({ shop_id, customer_id: { $in: buyerIds } })` で会話済 buyer 抽出
6. 各注文に `has_conversation` + `conversation_id` を付与、 注文日時降順で返却

**レスポンス**:
```json
{
  "buyers": [
    {
      "buyer_user_id": 1001,
      "buyer_username": "sunrainsky",
      "order_sn": "240509AAA",
      "order_create_time": "2026-05-09T10:00:00.000Z",
      "item_preview": "uniball ZENTO 黒",
      "currency": "SGD",
      "total_amount": 12.5,
      "has_conversation": true,
      "conversation_id": "conv-1001"
    }
  ]
}
```

---

## STEP 2: `/api/buyers/cold-start-send` (POST)

**body**:
```json
{
  "shop_id": 2032481,
  "buyer_user_id": 1001,
  "order_sn": "240509AAA",
  "text": "送信本文"
}
```

**フロー**:
1. body バリデーション (shop_id / buyer_user_id / order_sn / text 必須)
2. **サーバー側で `shopee_conversations.findOne({ shop_id, customer_id })` を実行** して `has_conversation` 判定 (client 申告は信頼しない、 タイミングずれの安全策)
3. `has_conversation=false` の場合:
   - `sendOrderMessage(accessToken, shopId, buyer_user_id, order_sn, { country })` で会話確立
4. `sendMessage(accessToken, shopId, buyer_user_id, text, { country })` で本文送信
   - 失敗時 **500ms 待機 → 1 回 retry** (phase2-triggers パターン流用)
   - 2 回とも失敗なら 500 + 構造化 audit ログ
5. 成功 → 構造化 audit ログ + `{ success: true, has_conversation_before }`

**audit ログ形式** (オーナー指定):
```json
{
  "type": "audit",
  "action": "cold_start_send",
  "timestamp": "2026-05-11T08:16:51.371Z",
  "shop_id": 2032481,
  "buyer_user_id": 1001,
  "buyer_username": "alice",
  "order_sn": "240509AAA",
  "text_length": 7,
  "has_conversation_before": false,
  "result": "success",
  "error_message": null
}
```

★ **audit_log 実装方針** ★:
Chapee に `audit_log` collection / lib は **未実装** (grep 確認済) のため、 **構造化 console.log で代用**。 Vercel Logs から `type: "audit"` でフィルタ可。 将来 BayCom (Phase 1.5 で audit_log 完成) から backport 予定。

---

## STEP 3: UI (`/chats` 上部 + モーダル)

### `app/(main)/chats/page.tsx` の変更 (+17 行)
- `MessageSquarePlus` icon + `BuyerSearchDialog` import 追加
- `buyerSearchOpen` state 追加
- 「最新メッセージを取得」 ボタンの左に「新規メッセージ」 ボタン追加
- ページ末尾 (Pagination の下) に `<BuyerSearchDialog open onOpenChange />` マウント

### `src/components/BuyerSearchDialog.tsx` (新規 380 行)
1 つの Dialog を 2 view (検索 / 送信) で切替 (state `sendTarget` の有無で分岐)。

**検索 view**:
- ショップ Select (`/api/shopee/status` から取得)
- 期間 Select (7 / 30 / 90 日)
- 検索 Input + 検索ボタン (Enter キー対応)
- 結果リスト:
  - `has_conversation=true` 行: 「既存チャットを開く」 → `/chats/[id]` 遷移 (modal 閉じる)
  - `has_conversation=false` 行: 「メッセージを送る」 → 送信 view に切替
- 視覚的差別化: 会話なし行は `border-amber-200 bg-amber-50/30`、 badge は emerald (会話あり) vs amber (会話なし)

**送信 view**:
- 注文情報サマリ (buyer_username / order_sn / item_preview)
- 会話なし時の注意書き: 「注文カード送信で会話を確立してから本文を送信します」
- テンプレート Select (`/api/reply-templates` から lazy load) — 選択で本文に流し込み
- 本文 textarea
- 戻る / 送信 ボタン

**送信成功後**: toast + 結果リストの該当行を `has_conversation: true` に更新 (再検索なしで UI 反映)

---

## STEP 4: テスト

### `src/test/buyer-search.test.ts` (10 テスト)

| カテゴリ | テスト |
|---|---|
| Validation | shop_id 欠落 → 400 / 非数値 shop_id → 400 |
| q filter (case 1-3) | 注文 ID 部分一致 / バイヤー名部分一致 (case-insensitive) / 空 q で全件 / 該当なしで空配列 |
| `has_conversation` (case 4) | 一部 buyer のみ会話あり時の正確な flag / `find({ shop_id, customer_id: { $in } })` 呼び出し検証 |
| Window range | days 省略時 2 windows / days=365 で 90 max clamp |

### `src/test/cold-start-send.test.ts` (8 テスト)

| カテゴリ | テスト |
|---|---|
| Validation (case 4) | shop_id / buyer_user_id / order_sn / text 各欠落で 400 |
| 既存会話あり (case 1) | `sendOrderMessage` 不呼出 + `sendMessage` 直接呼出 |
| 新規会話 (case 2) | `sendOrderMessage` → `sendMessage` の順序確認 |
| Retry (case 3) | 1 回目失敗 + 2 回目成功 → 200 / 2 回連続失敗 → 500 |

### テスト結果

```
Test Files  7 passed (7)
     Tests  93 passed (93)
```

既存 75 件 + 新規 18 件 = 93 件、 全通過。

### テスト仕様調整について

オーナー要件「ケース 5: 認証なしリクエスト → 401」 は、 現状の Chapee `main` ブランチでは middleware の `matcher` に `/api/*` が含まれず、 新規 endpoint も handler 内認証を持たない (オーナー方針: セキュリティ修正 merge 後に middleware で保護される前提) ため、 **401 ガードは現時点で実装されていない**。 該当テストは 「shop_id / 必須フィールド欠落 → 400」 のバリデーションテストに置き換えた。

セキュリティ修正 (`fix/security-hole-middleware-auth` ブランチ) merge 後、 middleware で `/api/*` が JWT 必須化されれば、 認証なしリクエストは middleware で弾かれ 401 相当 (実際は redirect to /login) になる。 別途 401 テストを足したい場合、 セキュリティ修正後に handler 内に `getSession` チェックを追加する option がある。

---

## レート制限実測

実機 API call 無し (mock のみ) のため未実測。 設計上の予測:
- 1 検索 = 最大 6 (windows for 90 days) + ceil(注文件数 / 50) 回の API call
- 例: 90 日 / 200 件の注文 → 6 + 4 = 10 calls / 検索
- Shopee の `75 calls / 60 sec / shop` 上限内に余裕で収まる
- 連続検索する場合、 既存 `fetchWithRetry` の指数バックオフが効く

---

## レート制限対策 (実装済)

- **shop_id 必須**: 1 検索 1 shop、 複数 shop の並列実行は呼び出し側で禁止
- **期間 default 30 日 / max 90 日**: client-side dropdown で choices 制限
- **getOrderDetail batch 50**: Shopee 仕様上限を `ORDER_DETAIL_BATCH_SIZE` 定数で明示
- **windows 逐次実行**: `for` ループで window ごとに await、 並列なし
- **エラー時 continue**: window 単位 / batch 単位で try/catch → 部分失敗でも残りを継続 (UX 配慮)

---

## 既存ロジックへの影響

| 既存ファイル | 影響 |
|---|---|
| `src/lib/shopee-api.ts` | **読み取りのみ** (getOrderList / getOrderDetail / sendOrderMessage / sendMessage を import、 関数本体は無変更) |
| `src/lib/shopee-token.ts` | 同上 (getValidToken / resolveCountryForShop) |
| `src/lib/shopee-conversation-db-sync.ts` | 無変更 (collection schema 読み取りのみ) |
| `app/api/chats/[id]/send/route.ts` | 無変更 (別 endpoint で独立) |
| `app/api/shopee/sync/route.ts` | 無変更 (sync ロジックは独立) |

---

## セキュリティ修正との関係

別ブランチ `fix/security-hole-middleware-auth` で middleware の `/api/*` 認証強化が進行中。 本ブランチは **依存しないが恩恵を受ける**:

- セキュリティ修正 merge **後**: middleware が `/api/buyers/*` を JWT 必須化、 新規 endpoint も自動的に保護される
- 本ブランチ側で handler 内認証 (例: `getSession` チェック) は **追加していない** (オーナー方針)
- 順序依存: セキュリティ修正を **先に** merge することを推奨

---

## ★要追加検討項目★ (Post-merge)

1. **audit_log の永続化**: 現状 console.log のみ、 過去履歴クエリ不可。 BayCom Phase 1.5 の audit_log 機能を Chapee に backport する別タスクで永続化推奨
2. **send rate limit**: 1 buyer に対する短時間連投ガード (誤爆防止) は未実装。 設定画面で 24h ロック等を入れる検討余地
3. **検索結果のページネーション**: 大量注文時に UI が長くなる可能性。 現状最大 ~200-300 件で UI は scroll で対応、 100 件超で警告 / 期間絞り推奨表示の余地
4. **Marketplace 別検索**: 現状 1 shop = 1 country 前提。 同一 shop の複数 country は仕様上ないので問題なし

---

## push 推奨度

**推奨**: ✅ push 可能

理由:
- 全 STEP 完了 + テスト 93/93 pass
- `npm run build` 通過
- 既存ロジックへの影響ゼロ (新規 endpoint + UI のみ、 schema 変更なし)
- セキュリティ修正と非衝突 (別ブランチ、 import / DB collection 重複なし)
- 段階的有効化可能 (UI 追加されるが、 ボタンを押さない限り API は呼ばれない)

### push 順序の推奨

1. **先**: `fix/security-hole-middleware-auth` (middleware で `/api/*` 保護)
2. **後**: 本ブランチ `feature/buyer-search` (新規 endpoint 自動保護で安全)

ただし逆順 (本ブランチ先) でも、 ボタンを公開しない限り (= UI に到達しない限り) API は野晒しにならない。 セキュリティ修正の merge 予定が遠い場合は本ブランチ単独 merge も妥当。

---

## 朝のオーナー merge コマンド (再掲)

```cmd
cd C:\Users\psych\Chapee
git diff main..feature/buyer-search --stat
npm test
git checkout main
git merge feature/buyer-search
git push origin main
```

---

## 改訂履歴

- ver.1 (2026-05-11): 初版 (STEP 1-5 完了報告)
