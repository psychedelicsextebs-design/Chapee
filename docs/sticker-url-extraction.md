# Sticker image_url 抽出ガイド (orangutan_my_new パック 4 種)

> 目的: チャット画面の「よく使うスタンプ」プリセット (ありがとう / 確認中 / 了解 / お待たせしました)
> に表示する画像 URL を、過去の受信履歴から抽出して [src/lib/sticker-presets.ts](../src/lib/sticker-presets.ts)
> に貼る。

## 前提 (重要)

ローカル PC から MongoDB Atlas への直接接続は **freebit「どこでもIP」が outbound を遮断** しており
ECONNREFUSED で失敗する。 そのため本タスクの STEP 1「DB read-only 抽出」は
**Atlas Web UI (Data Explorer / MongoDB Shell) でオーナー手動実行** が前提。
※ Vercel API route 化する選択肢もあるが、本ブランチは push しないルールのため見送る。

---

## 抽出対象

| label | sticker_package_id | sticker_id |
| --- | --- | --- |
| ありがとう | `orangutan_my_new` | `06` |
| 確認中 | `orangutan_my_new` | `29` |
| 了解 | `orangutan_my_new` | `02` |
| お待たせしました | `orangutan_my_new` | `03` |

---

## クエリ (Atlas Web UI / MongoDB Shell に貼り付け)

DB 名は本番デプロイで使っている database (例: `chapee` 等) を選択する。 collection は
`shopee_chat_messages` (= [shopee-conversation-db-sync.ts:21](../src/lib/shopee-conversation-db-sync.ts) の
`SHOPEE_CHAT_MESSAGES_COLLECTION` 定数)。

### Aggregation (推奨)

```js
db.shopee_chat_messages.aggregate([
  // 1) raw payload の sticker_id / package_id を抽出 (複数ありうる nest path に対応)
  {
    $addFields: {
      _sid: {
        $toString: {
          $ifNull: [
            "$raw.sticker_id",
            { $ifNull: [
              "$raw.content.sticker_id",
              { $ifNull: [ "$raw.sticker.sticker_id", "" ] }
            ] }
          ]
        }
      },
      _pid: {
        $toString: {
          $ifNull: [
            "$raw.sticker_package_id",
            { $ifNull: [
              "$raw.content.sticker_package_id",
              { $ifNull: [
                "$raw.package_id",
                { $ifNull: [
                  "$raw.content.package_id",
                  { $ifNull: [ "$raw.sticker.sticker_package_id", "" ] }
                ] }
              ] }
            ] }
          ]
        }
      },
      // image_url: pickImageUrlFromPayload (shopee-conversation-utils.ts:540-603) と同じ
      // 優先度を最低限カバー。他フィールドに入っているケースは結果が空ならクエリ最下段の
      // フォールバック手順を参照。
      _img: {
        $ifNull: [
          "$raw.sticker_url",
          { $ifNull: [
            "$raw.sticker_preview_url",
            { $ifNull: [
              "$raw.preview_image_url",
              { $ifNull: [
                "$raw.image_url",
                { $ifNull: [
                  "$raw.thumb_url",
                  { $ifNull: [
                    "$raw.thumbnail_url",
                    { $ifNull: [
                      "$raw.content.image_url",
                      { $ifNull: [
                        "$raw.content.preview_image_url",
                        { $ifNull: [
                          "$raw.content.sticker_url",
                          { $ifNull: [
                            "$raw.sticker.image_url",
                            null
                          ] }
                        ] }
                      ] }
                    ] }
                  ] }
                ] }
              ] }
            ] }
          ] }
        ]
      }
    }
  },
  // 2) 4 種に絞り込み + image_url が取れたものだけ
  {
    $match: {
      _pid: "orangutan_my_new",
      _sid: { $in: ["06", "29", "02", "03"] },
      _img: { $type: "string", $ne: "" }
    }
  },
  // 3) 各 sticker_id ごとに最新 1 件 (timestamp_ms 降順 → $first)
  { $sort: { timestamp_ms: -1 } },
  {
    $group: {
      _id: "$_sid",
      image_url: { $first: "$_img" },
      sample_conversation_id: { $first: "$conversation_id" },
      sample_shop_id: { $first: "$shop_id" },
      sample_message_id: { $first: "$message_id" },
      sample_timestamp_ms: { $first: "$timestamp_ms" },
      sample_synced_at: { $first: "$synced_at" }
    }
  },
  { $sort: { _id: 1 } }
]);
```

### 期待される結果

```text
[
  {
    "_id": "02",                  // 了解
    "image_url": "https://...png",
    "sample_conversation_id": "...",
    ...
  },
  {
    "_id": "03",                  // お待たせしました
    "image_url": "https://...png",
    ...
  },
  {
    "_id": "06",                  // ありがとう
    "image_url": "https://...png",
    ...
  },
  {
    "_id": "29",                  // 確認中
    "image_url": "https://...png",
    ...
  }
]
```

### フォールバック: 結果が空 / 一部欠落の場合

raw payload の image_url が想定外の path にネストされている可能性がある。
**1 件だけサンプル取得** して raw を目視確認する:

```js
// 該当パックの sticker メッセージを 1 件だけ覗く
db.shopee_chat_messages.findOne(
  {
    $or: [
      { "raw.sticker_package_id": "orangutan_my_new" },
      { "raw.content.sticker_package_id": "orangutan_my_new" },
      { "raw.package_id": "orangutan_my_new" },
      { "raw.content.package_id": "orangutan_my_new" },
      { "raw.sticker.sticker_package_id": "orangutan_my_new" }
    ]
  },
  { raw: 1, timestamp_ms: 1, conversation_id: 1 }
);
```

その raw を上記 `_img` の `$ifNull` チェーンと突き合わせて、抜けているフィールドを追加してから
aggregation を再実行する。

### sticker メッセージが 1 件も無い場合

オーナーが Shopee アプリから自分宛の会話に 4 種それぞれを 1 回ずつ送信 → webhook 同期を待つ
(`syncWebhookConversationFull` が `shopee_chat_messages` に upsert する) →
再度 aggregation を走らせる。

---

## 結果記録テンプレート (朝オーナーが値を埋める)

実行後、ここに値を記録してから [sticker-presets.ts](../src/lib/sticker-presets.ts) に貼る。

| sticker_id | label | image_url (URL) | 抽出元 conversation_id | sample_synced_at |
| --- | --- | --- | --- | --- |
| 06 | ありがとう |  |  |  |
| 29 | 確認中 |  |  |  |
| 02 | 了解 |  |  |  |
| 03 | お待たせしました |  |  |  |

---

## 反映手順 (Atlas クエリ完了後にオーナー実施)

1. [src/lib/sticker-presets.ts](../src/lib/sticker-presets.ts) を開く。
2. `STICKER_PRESETS` 配列の各要素に `image_url: "<取得した URL>"` を追記。
3. ローカルで `npm test` (回帰確認) → 通れば commit:
   ```
   git checkout feature/sticker-preview
   git add src/lib/sticker-presets.ts
   git commit -m "data(sticker-presets): populate image_url from Atlas extraction"
   ```
4. その後 main に merge して push:
   ```
   git checkout main
   git merge feature/sticker-preview
   git push origin main
   ```
   (vercel.json には変更なし、deploy のみで反映)

未投入 (空欄) のままでも本ブランチの UI 改修は **3 段 fallback** (preset → 会話履歴 → ラベル文字)
で動作するため、4 件のうち一部しか URL が取れなくても破綻はしない。
