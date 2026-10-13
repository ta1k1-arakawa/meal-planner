# API contract v1.3 (MVP / Issue #6)

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
| POST /plans/:id/regenerate           | `{version, recipeId, allowPurchase?:boolean}`、選んだ候補へ指定日だけ変更。未購入リストを原子的に再計算                           |
| POST /plans/:id/complete             | `{version, idempotencyKey, items:[{ingredientId,amount}]}`                                                                        |
| POST /plans/:id/skip                 | `{version}`                                                                                                                       |
| POST /plans/:id/unskip               | `{version}`、本日以降のスキップを元の料理の予定に戻し、未確定の買い物リストを再計算。過去分・二重実行は拒否                       |
| GET /shopping/current                | 現在の曜日に合う次回買い物の周期を優先、未購入/購入済み数量・未作成の日付                                                         |
| POST /shopping/:id/confirm           | `{version, idempotencyKey, items:[{ingredientId,amount}]}`、全リスト項目を指定。未購入は0                                         |
| GET /meal-logs                       | 直近100件の元の確定スナップショット                                                                                               |
| GET /meal-logs/:id                   | 食材スナップショット・訂正履歴を含む                                                                                              |
| POST /meal-logs/:id/correct          | `{version, idempotencyKey, items:[{ingredientId,amount}]}`、versionは訂正番号（初回0）。全実使用量を置換する訂正スナップショット  |
| GET /settings                        | version付き設定                                                                                                                   |
| PUT /settings                        | GETの設定＋`discardPendingShopping?:boolean`。曜日は0=日〜6=土、重複なし2日                                                       |
| GET /daily-nutrition?date=YYYY-MM-DD | confirmed / projected / unknown を独立して返す                                                                                    |
| PUT /daily-food-entries/:date        | `[{mealType, status, kcal, protein}]`。mealType=breakfast/lunch/snack/bedtime、status=projected/confirmed。その日の手入力を全置換 |

在庫・実使用量・購入量は整数のcanonical単位、同じ食材の重複は拒否します。実使用量0は明示的な不使用を表し、代替食材も登録済み食材なら指定できます。食事完了と訂正は確認操作であり、自動実行しません。

再送キーは8〜128文字。失敗した通信は同じ本文・キーで再送します。キーを別操作・別本文に使うと409。成功済みの再送は元の結果を返し、versionが古くなっていても在庫を書き換えません。配列の順序を含め同じ本文を再送してください。

`operations`、台帳、食事記録、plan状態更新はD1 `batch()` の一つのトランザクションです。在庫は台帳のINSERTトリガーで更新。CHECKで負の在庫を拒否し全バッチがロールバック。compare-and-swap不成立は専用guard表のCHECK違反で処理を中断します。変更件数0を成功と見なしません。訂正時も不足なら全体を拒否します。

計画は実在庫を変えません。開始日より前の未完了献立を予約し、日付順に仮想在庫を消費します。買い物曜日は当日〜次の買い物日前日、それ以外は在庫のみ（明示的に買い足しを許可可能）。完了・スキップ済みは置き換えません。スキップ・スキップ取消・使用量変更・在庫補正時は未購入リストも再計算。スキップ取消は元の料理を復元し、レシピ変更は予定を対象に別の候補を選択します。確定済み買い物リストは変更しません。追加購入は別のrunで記録します（v1.3）。購入提案は正味不足のcanonical数量で、店舗のパック単位への丸め最適化は後続範囲です。

日別栄養の予定は予定夕食・未確認プリセット・手入力の予定を含み、確認済みとは加算して「確定総量」と呼びません。最新の食事訂正を反映します。記録一覧は元の確定値なので、訂正後の値は詳細APIの訂正履歴で参照します。

未来の買い物周期を先に生成する場合、今日以降の先行周期の未確定購入提案を仮想在庫へ一度だけ加えてから予約量を差し引きます。先行周期の不足を次の周期で二重計上しません。過去の未確定購入を実在庫に含めることはありません。献立変更・スキップ・実使用量変更時は後続の未購入周期も再計算します。

写真関連・体重ログ・プリセット編集は未実装で404。破壊的契約変更時はこの文書と型を一緒に改訂します。

## 常備調味料とレシピ表示（v1.1の変更）

`GET /ingredients` は在庫量を含めない全食材カタログで、`inventory_exempt`（0/1）を返します。`GET /inventory` と換算係数編集は通常食材だけが対象です。既存の調味料在庫・履歴はDBに保存しますが、新しい在庫操作は拒否します。分類は初期5件に限定するコードではなく食材フラグに従います。生しょうがは除外しません。

`GET /recipes` と献立内の `recipe.items` は全材料の `ingredientId`, `name`, `amount`, `unit`, `inventory_exempt`（boolean）、栄養参照値・出典・状態を返します。`instructions_json` はDB内のテンプレートを材料行の名前・分量・単位で展開済みの文字列配列です。UIは通常食材と調味料を分けます。調味料もkcal・たんぱく質・アレルゲン・除外食材の判定対象です。

完了・訂正の `items` は通常食材の `{ingredientId, amount}` のみ送信します。調味料を明示的に送信すると422 `INVENTORY_EXEMPT`。サーバーが調味料の既定量を自動で栄養に加えます。完了した `meal_log_items` の `amount_source` は `actual` または `recipe_default`、訂正JSONは `amountSource` で同じ区別を保存します。既定量は確認された実測量を意味しません。訂正は元の `recipe_snapshot` の分量と保存済み栄養参照を使うため、カタログ更新に影響されません。旧ログに詳細参照値がない場合は保存済み食材行の単位量あたりの栄養を使用し、量0等で算出不能な値のみ現在の参照値を使います。元のログ・訂正・台帳を上書きしません。

買い物確認は表示される通常食材のみを送信します。調味料は既存の買い物行からも除外し、数量やstatusの更新を行いません。通常食材がない周期は `items: []` で確定可能です。新規確認で調味料を送信すると422です。未購入リストを再計算するときも既存の調味料行は削除せず保持します。

新しいクライアントは `recipe.items` 全体を完了本文へ転送せず、通常食材のIDと量だけに絞ります。更新前に成功済みの操作は同じ元の本文・キーで再送すると元の結果を返し、新しい在庫移動は作りません。`0004` と新Worker/UIをセットで更新してください。

## 曜日変更と候補比較（v1.2）

`POST /plans/:id/candidates` は `{version, allowPurchase?:boolean, exclude?:string[]}` を受け、`{planId, version, candidates:[{recipe, missing:[{ingredientId,name,amount,unit}]}], hasMore}` を返します。最大5件、現在と以前変更して外した料理は除外し、同じ材料構成に偏りにくい順で提示します。次ページは表示済みIDを `exclude` に渡します。取得のみではDBを変更しません。0件も正常応答で理由を画面に表示します。

`regenerate` は `recipeId` 必須へ変更しました。旧クライアントの即時自動変更は400となるので画面を再読み込みしてください。選択確定時も条件・在庫を再判定し、変更済みversionは409、却下済み・不適合レシピは422。変更は当日のみで、後続料理は維持して全未購入リストを再計算します。stock-onlyの要求では確定済み購入期間の不足を拒否します。v1.3の購入許可付き変更は別のrunで不足を計算します。

`PUT /settings` は曜日変更によって旧未確定リストが残る場合、`discardPendingShopping:true` の明示確認がないと409 `SHOPPING_RESET_REQUIRED`（details.pendingLists）で全体を拒否します。承認後は旧reviewを `obsolete=1` として保持し、次回期間を既存献立から再計算します。新たな料理の生成は行いません。すでに曜日だけ変更済みの旧不整合リストも同じフラグで修復できます。

cycleは `obsolete`, `shopping_days_json`, `unplanned_dates` を追加しました。次回リストがあればそれを優先し、なければ現在期間の整合するリストを返します。旧設定のreviewは表示・仮想購入から除外し、IDを直接送っても409 `OBSOLETE_SHOPPING`。購入済みリストと再送結果は不変です。火・土なら10/13〜10/16（4日）と10/17〜10/19（3日）。未作成日がある場合、表示量は作成済みの料理だけであり、UIから明示的に期間の献立を生成します。

`0005` を既存のバックアップ付き手動リリースで適用します。過去のリストは削除しません。同じ開始日の未確定行だけは、破棄承認後に高いversionで再利用できます。確定済み行は再利用せず、衝突する期間は409。実在庫・履歴・スナップショットは変更しません。本番への自動更新は禁止です。

次回購入量は対象期間の献立だけから算出し、過去の未完了献立や買い物前の不足を追加購入量に混ぜません。本日以降の先行献立は実在庫の利用可能分を予約し、現在の設定に合う将来の先行購入提案だけを一度投影します。

## スマホの日常操作・いつでも買い物（v1.3）

`POST /shopping/today` は本文 `{}` のみ。日本時間の今日から次の目安買い物日前日までを対象とし、料理がない日だけ生成して `Cycle` を返します。購入は行いません。既存の予定料理・スキップ・完了は変更せず、過去の未処理献立は投影から除外します。目安曜日以外でも許可チェックや事前の期間選択は不要です。

Cycleに `kind:"cycle"|"run"` を追加し、旧サイクルと買い物ごとの新しいrunを同じ読み取り契約にします。既存ルート `POST /shopping/:id/confirm` はどちらのIDも扱い、返却 `{cycleId}` と再送契約は維持します。新しいrunは開始日ごとに未購入・有効な行が1つだけ。購入済みrunは再利用せず、同じ日の追加購入も別行に保存して実在庫から不足分だけ計算します。itemsが空なら追加購入は不要です。常備調味料の在庫・購入入力は引き続き不要です。

今日買う操作で、対象期間と重複・期限切れ・旧曜日のreviewはobsoleteにして保持します。確定済み行は無効化や書き換えの対象外。リスト表示・候補取得は在庫を増減しません。操作後は画面が自動取得し、409時は最新versionと候補を再取得して再確認を案内します。

購入を許可した料理変更は、確定済み期間でも可能です。既存購入を上書きせず、足りない分の追加reviewを作成します。`allowPurchase:false` のstock-only契約は残し、後続の夕食分まで在庫が足りる候補だけを返します。

献立画面は `/today` の日付以降だけを描画します。`GET /plans`、食事ログ・訂正・台帳APIは従来どおり保持し、記録タブ削除に伴うDB削除は行いません。新UIはチェックを廃止しますが、settings APIの `discardPendingShopping` 確認フラグは保持し、必要な場面にだけ短いダイアログを出します。

`0006` は追加表だけを作り、既存行を変更しません。リリースは既存の手動Actionsでバックアップ→移行→配信を実行し、この開発作業では本番操作しません。
