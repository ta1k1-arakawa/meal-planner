# API contract v1.1 (MVP / Issue #2)

同一オリジンの `/api`。JSON本文、全ての非ログインAPIに署名Cookieが必要です。POST / PUT は別オリジンから拒否します。`APP_PASSWORD` が未設定または32文字未満なら503。クライアントは401でログイン画面へ戻ります。

エラーは `{ "error": { "code": "...", "message": "日本語", "details": ... } }`。入力不正400、未ログイン401、送信元不正403、対象なし404、競合・在庫不足409、条件を満たせない422。破壊的更新に version を使います。

| ルート                               | 操作 / 本文                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| POST /auth/login                     | `{password}`、HttpOnly Cookie発行                                                                                                 |
| POST /auth/logout                    | `{}`、Cookie削除                                                                                                                  |
| GET /today                           | 日本時間の日付、献立、栄養集計                                                                                                    |
| GET /inventory                       | 食材・現在量・version・換算係数                                                                                                   |
| GET /inventory/movements             | 直近100件の追記専用台帳                                                                                                           |
| POST /inventory/adjust               | `{ingredientId, delta, version, idempotencyKey, displayUnit?:boolean}`                                                            |
| PUT /ingredients/:id/conversion      | `{displayUnit, amountPerUnit}`、整数の1表示単位あたりg/ml                                                                         |
| GET /recipes                         | 栄養・食材・手順付きのカタログ                                                                                                    |
| GET /plans                           | 日付順の献立                                                                                                                      |
| POST /plans/generate                 | `{startDate:"YYYY-MM-DD", allowPurchase?:boolean}`                                                                                |
| POST /plans/:id/regenerate           | `{version, allowPurchase?:boolean}`、指定日から周期末までの開いた日を再計画                                                       |
| POST /plans/:id/complete             | `{version, idempotencyKey, items:[{ingredientId,amount}]}`                                                                        |
| POST /plans/:id/skip                 | `{version}`                                                                                                                       |
| GET /shopping/current                | 今日を含む周期、未購入/購入済み数量                                                                                               |
| POST /shopping/:id/confirm           | `{version, idempotencyKey, items:[{ingredientId,amount}]}`、全リスト項目を指定。未購入は0                                         |
| GET /meal-logs                       | 直近100件の元の確定スナップショット                                                                                               |
| GET /meal-logs/:id                   | 食材スナップショット・訂正履歴を含む                                                                                              |
| POST /meal-logs/:id/correct          | `{version, idempotencyKey, items:[{ingredientId,amount}]}`、versionは訂正番号（初回0）。全実使用量を置換する訂正スナップショット  |
| GET /settings                        | version付き設定                                                                                                                   |
| PUT /settings                        | GETの完全な設定オブジェクト。曜日は0=日〜6=土、重複なし2日                                                                        |
| GET /daily-nutrition?date=YYYY-MM-DD | confirmed / projected / unknown を独立して返す                                                                                    |
| PUT /daily-food-entries/:date        | `[{mealType, status, kcal, protein}]`。mealType=breakfast/lunch/snack/bedtime、status=projected/confirmed。その日の手入力を全置換 |

在庫・実使用量・購入量は整数のcanonical単位、同じ食材の重複は拒否します。実使用量0は明示的な不使用を表し、代替食材も登録済み食材なら指定できます。食事完了と訂正は確認操作であり、自動実行しません。

再送キーは8〜128文字。失敗した通信は同じ本文・キーで再送します。キーを別操作・別本文に使うと409。成功済みの再送は元の結果を返し、versionが古くなっていても在庫を書き換えません。配列の順序を含め同じ本文を再送してください。

`operations`、台帳、食事記録、plan状態更新はD1 `batch()` の一つのトランザクションです。在庫は台帳のINSERTトリガーで更新。CHECKで負の在庫を拒否し全バッチがロールバック。compare-and-swap不成立は専用guard表のCHECK違反で処理を中断します。変更件数0を成功と見なしません。訂正時も不足なら全体を拒否します。

計画は実在庫を変えません。開始日より前の未完了献立を予約し、日付順に仮想在庫を消費します。買い物曜日は当日〜次の買い物日前日、それ以外は在庫のみ（明示的に買い足しを許可可能）。完了・スキップ済みは置き換えません。スキップ・使用量変更・在庫補正時は未購入リストも再計算。既に確定した周期へ追加購入は記録せず、不足分は明示的な在庫追加を案内します。購入提案は正味不足のcanonical数量で、店舗のパック単位への丸め最適化は後続範囲です。

日別栄養の予定は予定夕食・未確認プリセット・手入力の予定を含み、確認済みとは加算して「確定総量」と呼びません。最新の食事訂正を反映します。記録一覧は元の確定値なので、訂正後の値は詳細APIの訂正履歴で参照します。

未来の買い物周期を先に生成する場合、今日以降の先行周期の未確定購入提案を仮想在庫へ一度だけ加えてから予約量を差し引きます。先行周期の不足を次の周期で二重計上しません。過去の未確定購入を実在庫に含めることはありません。献立変更・スキップ・実使用量変更時は後続の未購入周期も再計算します。

写真関連・体重ログ・プリセット編集は未実装で404。破壊的契約変更時はこの文書と型を一緒に改訂します。

## 常備調味料とレシピ表示（v1.1の変更）

`GET /ingredients` は在庫量を含めない全食材カタログで、`inventory_exempt`（0/1）を返します。`GET /inventory` と換算係数編集は通常食材だけが対象です。既存の調味料在庫・履歴はDBに保存しますが、新しい在庫操作は拒否します。分類は初期5件に限定するコードではなく食材フラグに従います。生しょうがは除外しません。

`GET /recipes` と献立内の `recipe.items` は全材料の `ingredientId`, `name`, `amount`, `unit`, `inventory_exempt`（boolean）、栄養参照値・出典・状態を返します。`instructions_json` はDB内のテンプレートを材料行の名前・分量・単位で展開済みの文字列配列です。UIは通常食材と調味料を分けます。調味料もkcal・たんぱく質・アレルゲン・除外食材の判定対象です。

完了・訂正の `items` は通常食材の `{ingredientId, amount}` のみ送信します。調味料を明示的に送信すると422 `INVENTORY_EXEMPT`。サーバーが調味料の既定量を自動で栄養に加えます。完了した `meal_log_items` の `amount_source` は `actual` または `recipe_default`、訂正JSONは `amountSource` で同じ区別を保存します。既定量は確認された実測量を意味しません。訂正は元の `recipe_snapshot` の分量と保存済み栄養参照を使うため、カタログ更新に影響されません。旧ログに詳細参照値がない場合は保存済み食材行の単位量あたりの栄養を使用し、量0等で算出不能な値のみ現在の参照値を使います。元のログ・訂正・台帳を上書きしません。

買い物確認は表示される通常食材のみを送信します。調味料は既存の買い物行からも除外し、数量やstatusの更新を行いません。通常食材がない周期は `items: []` で確定可能です。新規確認で調味料を送信すると422です。未購入リストを再計算するときも既存の調味料行は削除せず保持します。

新しいクライアントは `recipe.items` 全体を完了本文へ転送せず、通常食材のIDと量だけに絞ります。更新前に成功済みの操作は同じ元の本文・キーで再送すると元の結果を返し、新しい在庫移動は作りません。`0004` と新Worker/UIをセットで更新してください。
