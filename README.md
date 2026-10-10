# 夕食の献立帳

`SPEC.md` v1.2 に沿った個人用・日本語の夕食プランナー。React / TypeScript / Vite、Cloudflare Workers / D1 を使用します。

## 今回の実装

- パスワード認証（署名済み HttpOnly / SameSite Cookie、12時間）と全APIの入力検証。
- 外部キー・CHECK・UNIQUE付きのドメインスキーマ、30件の夕食レシピと食品成分の概算値。
- g / ml の在庫、個・丁の換算、追加・減算・変更履歴。期限は扱いません。
- 次の買い物日前日までの夕食生成。設備・アレルゲン・時間を満たす候補を、栄養目標・在庫不足・バリエーションで評価。部分的な成功は保存しません。
- 累計の不足量、実購入量の編集・確定、再送による二重追加の防止。
- 実使用量を編集して食事完了、スキップ、履歴。訂正は元の記録を変更せず差分在庫と訂正スナップショットを追記します。
- 今日・献立・買い物・在庫・記録・設定のモバイル向け画面。確認済み・予定・未確認の栄養を区別。
- 「献立」画面から30件すべてのレシピの食材名・分量・具体的な配合と手順を閲覧できます。分量は材料データから手順へ展開します。
- 油・しょうゆ・みそ・砂糖・カレー粉は常備調味料として扱い、在庫登録・購入・実使用量入力は不要。栄養・アレルゲンには含め、完了時に既定量を自動保存します。生しょうがは通常食材です。

写真認識、体重トレンド、プリセットの詳細編集、PWAのオフライン対応は後続の実装範囲です。写真認識の仮データを表示する実装はありません。昼食等の栄養入力・食事記録訂正・換算係数編集は現段階ではAPIから利用します。

## ローカル起動

Node.js 22以降と Python 3（レシピマイグレーション生成・整合性確認時）。依存バージョンは `package-lock.json` に固定しています。

```sh
npm ci
cp .env.example .dev.vars
# .dev.vars の APP_PASSWORD を32文字以上のランダムな値に変更
npm run build
npm run db:migrate
npm run dev:api
```

`http://localhost:8787` を開き、設定したパスワードでログインします。DBは `.wrangler/` 内に保存されます。初期在庫はすべて0。最初に在庫を追加するか、献立画面で買い足しを許可し、買い物リストを確定してください。

フロントの開発時は別ターミナルで `npm run dev` を実行し `http://localhost:5173` を開きます。Vite が `/api` をローカル Worker に転送します。

マイグレーション `0002_seed.sql` は初期データを含み、`db:migrate` で一度だけ適用されます。`0001`〜`0003` は既に適用済みのファイルとして変更しません。`scripts/generate-seed.py` は現在、追加の `0004_pantry_recipe_details.sql` を生成します。`python3 scripts/generate-seed.py --check` で生成元とSQLの一致を確認できます。今後の変更はさらに新しい番号のマイグレーションにしてください。

## 既存DBの更新（Issue #2）

`0004` は分類フラグと量の入力元カラムを追加し、30件の手順を更新します。在庫量、在庫履歴、食事記録・訂正履歴、材料量は削除・上書きしません。既存の調味料在庫と買い物項目は保存したまま画面・業務処理から除外します。過去の食事記録は当時のスナップショットのままです。

ローカルは `npm run db:migrate` で未適用の `0004` だけを追加できます。本番はこのPRではデプロイもDB更新も行いません。承認後にD1バックアップを取得し、`0004` と対応するWorker/UIを同じ更新作業で適用してください。古い画面から新たに調味料を入力するとエラーになるため、利用者は更新後に画面を再読み込みします。既存の成功済み再送キーは元の結果を返します。

## 検証

```sh
npm run lint
npm run typecheck
npm test
npm run build
python3 scripts/generate-seed.py --check
npx wrangler deploy --dry-run
```

結合テストはモックDBではなく Miniflare の D1 で実行します。ローカルの loopback ポートと workerd の起動が必要です。GitHub Actions にも同じチェックを設定しています。

## Cloudflare への配置

1. `npx wrangler d1 create meal-planner` でD1を作成し、表示された `database_id` を `wrangler.jsonc` に設定。
2. `npx wrangler d1 migrations apply meal-planner --remote` を実行。
3. `npx wrangler secret put APP_PASSWORD` で32文字以上のランダムな秘密を登録。`.dev.vars` はローカル用で、本番には自動登録されません。
4. `npm run deploy`。Worker と静的アセットを同じオリジンから配信。HTTPSが必須です。
5. 公開URLで未ログイン時のAPIが401、ログイン後のみ在庫が取得できることを確認。

個人PCの常時起動は不要です。公開シェルには在庫や秘密は含みません。APIレスポンスは `no-store`。本番は Cloudflare Access の許可メール制限やログインルートのWAFレート制限を併用できます。API秘密には `VITE_` 接頭辞を付けないでください。実データを入れる前にD1バックアップの運用を決めてください。

契約・制約は [docs/api.md](docs/api.md)、食品データの扱いは [docs/nutrition.md](docs/nutrition.md) を参照してください。
