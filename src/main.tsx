import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Stock,
  Plan,
  Cycle,
  MealLog,
  Settings,
  NutritionSummary,
} from "../worker/contracts";
import "./style.css";
type Screen = "今日" | "献立" | "買い物" | "在庫" | "記録" | "設定";
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const res = await fetch("/api" + path, {
    credentials: "same-origin",
    method: body === undefined ? "GET" : method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new Error(
      (data as { error?: { message: string } }).error?.message ??
        "通信に失敗しました",
    );
  }
  return data as T;
}
const number = (n: number) => Math.round(n * 10) / 10;
function App() {
  const [logged, setLogged] = useState(false),
    [checking, setChecking] = useState(true),
    [password, setPassword] = useState("");
  const [screen, setScreen] = useState<Screen>("今日"),
    [stocks, setStocks] = useState<Stock[]>([]),
    [plans, setPlans] = useState<Plan[]>([]),
    [cycle, setCycle] = useState<Cycle | null>(null),
    [logs, setLogs] = useState<MealLog[]>([]),
    [settings, setSettings] = useState<Settings | null>(null);
  const [today, setToday] = useState<{
    date: string;
    plan: Plan | null;
    nutrition: NutritionSummary;
  } | null>(null);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [purchase, setPurchase] = useState(false);
  const [review, setReview] = useState<Plan | null>(null),
    [amounts, setAmounts] = useState<Record<string, number>>({}),
    [shopAmounts, setShopAmounts] = useState<Record<string, number>>({});
  const [adjustIngredient, setAdjustIngredient] = useState(""),
    [delta, setDelta] = useState(0),
    [displayUnit, setDisplayUnit] = useState(false);
  // Keys remain unchanged after a failed request, allowing safe retries after lost responses.
  const [pending, setPending] = useState<{
    fingerprint: string;
    key: string;
  } | null>(null);
  function keyFor(value: unknown) {
    const fingerprint = JSON.stringify(value);
    if (pending?.fingerprint === fingerprint) return pending.key;
    const key = crypto.randomUUID();
    setPending({ fingerprint, key });
    return key;
  }
  async function reload() {
    const [st, pl, sh, lo, se, to] = await Promise.all([
      api<Stock[]>("/inventory"),
      api<Plan[]>("/plans"),
      api<Cycle | null>("/shopping/current"),
      api<MealLog[]>("/meal-logs"),
      api<Settings>("/settings"),
      api<NonNullable<typeof today>>("/today"),
    ]);
    setStocks(st);
    setPlans(pl);
    setCycle(sh);
    setLogs(lo);
    setSettings(se);
    setToday(to);
    setLogged(true);
    setShopAmounts(
      Object.fromEntries(
        sh?.items.map((i) => [i.ingredient_id, i.proposed_amount]) ?? [],
      ),
    );
    setAdjustIngredient((current) => current || st[0]?.id || "");
  }
  useEffect(() => {
    const expired = () => setLogged(false);
    window.addEventListener("session-expired", expired);
    reload()
      .catch((e) => setError(e.message))
      .finally(() => setChecking(false));
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  async function run(
    action: () => Promise<unknown>,
    success: string,
    refresh = true,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setPending(null);
      if (refresh) await reload();
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  function reviewPlan(p: Plan) {
    setReview(p);
    setAmounts(
      Object.fromEntries(p.recipe.items.map((i) => [i.ingredientId, i.amount])),
    );
    setPending(null);
  }
  const selected = stocks.find((s) => s.id === adjustIngredient);
  function recipeCard(p: Plan) {
    const completedLog = logs.find((l) => l.plan_id === p.id);
    const recipe: Plan["recipe"] = completedLog
      ? JSON.parse(completedLog.recipe_snapshot)
      : p.recipe;
    return (
      <article key={p.id} className="card">
        <div className="row">
          <span>{p.local_date}</span>
          <span className={"badge " + p.status}>
            {
              {
                planned: "予定",
                draft: "下書き",
                completed: "食べた",
                skipped: "スキップ",
              }[p.status]
            }
          </span>
        </div>
        <h2>{recipe.title}</h2>
        <p className="metrics">
          約{number(completedLog?.total_kcal ?? recipe.kcal)} kcal · たんぱく質{" "}
          {number(completedLog?.total_protein_g ?? recipe.protein)} g ·{" "}
          {recipe.total_minutes}分
        </p>
        <details>
          <summary>
            {completedLog ? "計画時の食材・作り方を見る" : "食材・作り方を見る"}
          </summary>
          <ul>
            {recipe.items.map((i) => {
              const stock = stocks.find((s) => s.id === i.ingredientId);
              return (
                <li key={i.ingredientId}>
                  {stock?.name ?? i.ingredientId} {i.amount}
                  {stock?.unit}{" "}
                  <small>
                    在庫 {stock?.quantity ?? 0}
                    {stock?.unit} / 単独の不足{" "}
                    {Math.max(0, i.amount - (stock?.quantity ?? 0))}
                    {stock?.unit}
                  </small>
                </li>
              );
            })}
          </ul>
          <ol>
            {(JSON.parse(recipe.instructions_json) as string[]).map(
              (step, i) => (
                <li key={i}>{step}</li>
              ),
            )}
          </ol>
          <p className="muted">
            栄養は食品成分表に基づく概算。ご飯は炊飯済みの重量です。
          </p>
        </details>
        {p.status === "planned" && (
          <div className="actions">
            <button
              disabled={busy || p.local_date > (today?.date ?? "")}
              onClick={() => reviewPlan(p)}
            >
              使用量を確認して完了
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api("/plans/" + p.id + "/regenerate", {
                      version: p.version,
                      allowPurchase: purchase,
                    }),
                  "献立を変更しました。期間内の後続献立と不足量も更新しました",
                )
              }
            >
              別の献立
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () => api("/plans/" + p.id + "/skip", { version: p.version }),
                  "スキップしました。在庫は消費していません",
                )
              }
            >
              スキップ
            </button>
          </div>
        )}
      </article>
    );
  }
  if (checking)
    return (
      <main>
        <p role="status">読み込み中…</p>
      </main>
    );
  if (!logged)
    return (
      <main className="login">
        <p className="eyebrow">DINNER PLANNER</p>
        <h1>夕食の献立帳</h1>
        <p>在庫から、今夜の一皿を。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/auth/login", { password });
              setPassword("");
            }, "ログインしました");
          }}
        >
          <label>
            パスワード
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button disabled={busy}>ログイン</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    );
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">DINNER PLANNER</p>
          <h1>夕食の献立帳</h1>
        </div>
        <small>{today?.date} · 東京</small>
      </header>
      <nav aria-label="メインメニュー">
        {(["今日", "献立", "買い物", "在庫", "記録", "設定"] as Screen[]).map(
          (s) => (
            <button
              key={s}
              className={s === screen ? "active" : ""}
              onClick={() => {
                setScreen(s);
                setReview(null);
              }}
              aria-current={s === screen ? "page" : undefined}
            >
              {s}
            </button>
          ),
        )}
      </nav>
      <main>
        <div aria-live="polite">
          {message && <p className="notice">{message}</p>}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
            <button
              className="secondary"
              disabled={busy}
              onClick={() => run(reload, "最新の状態を読み込みました")}
            >
              再読込
            </button>
          </p>
        )}
        {(screen === "今日" || screen === "献立") && (
          <section className="generate">
            <label className="check">
              <input
                type="checkbox"
                checked={purchase}
                onChange={(e) => setPurchase(e.target.checked)}
              />
              買い物日以外も買い足しを許可する
            </label>
            <button
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api("/plans/generate", {
                      startDate: today?.date,
                      allowPurchase: purchase,
                    }),
                  "次の買い物日前日までの献立を生成しました",
                )
              }
            >
              買い物日までの夕食を生成
            </button>
            <p className="muted">
              買い物日は
              {settings?.shoppingDays
                .map((d) => "日月火水木金土"[d])
                .join("・")}
              曜日。在庫は食事完了時に消費します。
            </p>
          </section>
        )}
        {screen === "今日" && (
          <>
            <h2>今夜の夕食</h2>
            {today?.plan ? (
              recipeCard(today.plan)
            ) : (
              <p className="empty">今夜の献立はまだありません。</p>
            )}
            <section className="card">
              <h2>今日の栄養</h2>
              <p>
                <span className="badge completed">確認済み</span>{" "}
                {number(today?.nutrition.confirmed.kcal ?? 0)} kcal / P{" "}
                {number(today?.nutrition.confirmed.protein ?? 0)} g
              </p>
              <p>
                <span className="badge planned">予定・プリセット</span>{" "}
                {number(today?.nutrition.projected.kcal ?? 0)} kcal / P{" "}
                {number(today?.nutrition.projected.protein ?? 0)} g
              </p>
              <p className="muted">
                1日の目標 {settings?.dailyKcal} kcal / P{" "}
                {settings?.dailyProtein} g（初期推定）
              </p>
              <p>
                未確認：
                {today?.nutrition.unknown
                  .map(
                    (s) =>
                      ({
                        breakfast: "朝食",
                        lunch: "昼食",
                        snack: "間食",
                        bedtime: "就寝前",
                        dinner: "夕食",
                      })[s as "lunch"],
                  )
                  .join("・") || "なし"}
              </p>
              <p className="muted">
                プリセットは食べた記録ではありません。昼食などが未記録の場合、1日の摂取量は未確定です。
              </p>
            </section>
          </>
        )}
        {screen === "献立" && (
          <>
            <h2>夕食の予定</h2>
            {plans.length ? (
              plans.map(recipeCard)
            ) : (
              <p className="empty">献立を生成して始めましょう。</p>
            )}
          </>
        )}
        {review && (
          <section className="card review" aria-label="食事完了の確認">
            <h2>実際に使った量を確認</h2>
            <p>
              {review.recipe.title} —
              全ての使用量を確認してから完了してください。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const value = {
                  version: review.version,
                  items: Object.entries(amounts).map(
                    ([ingredientId, amount]) => ({ ingredientId, amount }),
                  ),
                };
                run(async () => {
                  await api("/plans/" + review.id + "/complete", {
                    ...value,
                    idempotencyKey: keyFor({ planId: review.id, ...value }),
                  });
                  setReview(null);
                }, "食事を記録し、使用分の在庫を消費しました");
              }}
            >
              {review.recipe.items.map((i) => {
                const st = stocks.find((s) => s.id === i.ingredientId);
                return (
                  <label key={i.ingredientId}>
                    {st?.name}（{st?.unit}） · 在庫 {st?.quantity}
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="1"
                      required
                      value={amounts[i.ingredientId]}
                      onChange={(e) =>
                        setAmounts({
                          ...amounts,
                          [i.ingredientId]: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                );
              })}
              <div className="actions">
                <button disabled={busy}>確認して食事完了</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setReview(null)}
                >
                  キャンセル
                </button>
              </div>
            </form>
          </section>
        )}
        {screen === "在庫" && (
          <>
            <h2>在庫管理</h2>
            <p>数量は g / ml で管理します。期限の追跡は行いません。</p>
            <section className="card">
              <h3>在庫の追加・補正</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = {
                    ingredientId: adjustIngredient,
                    delta,
                    version: selected?.version,
                    displayUnit,
                  };
                  run(
                    () =>
                      api("/inventory/adjust", {
                        ...value,
                        idempotencyKey: keyFor(value),
                      }),
                    "在庫を更新しました",
                  );
                }}
              >
                <label>
                  食材
                  <select
                    value={adjustIngredient}
                    onChange={(e) => {
                      setAdjustIngredient(e.target.value);
                      setDisplayUnit(false);
                    }}
                  >
                    {stocks.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {selected?.grams_per_display_unit && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={displayUnit}
                      onChange={(e) => setDisplayUnit(e.target.checked)}
                    />
                    {selected.display_unit}で入力（1{selected.display_unit} ≈{" "}
                    {selected.grams_per_display_unit}
                    {selected.unit}）
                  </label>
                )}
                <label>
                  増減量（
                  {displayUnit ? selected?.display_unit : selected?.unit}
                  、減らす時は負の値）
                  <input
                    type="number"
                    min="-1000000"
                    max="1000000"
                    step="1"
                    required
                    value={delta}
                    onChange={(e) => setDelta(Number(e.target.value))}
                  />
                </label>
                <p>
                  更新後：
                  {(selected?.quantity ?? 0) +
                    delta *
                      (displayUnit
                        ? (selected?.grams_per_display_unit ?? 1)
                        : 1)}{" "}
                  {selected?.unit}
                </p>
                <button disabled={busy || delta === 0}>
                  確認して在庫を更新
                </button>
              </form>
            </section>
            <div className="stock-list">
              {stocks.map((s) => (
                <div className="stock-row" key={s.id}>
                  <span>{s.name}</span>
                  <strong>
                    {s.quantity} <small>{s.unit}</small>
                  </strong>
                </div>
              ))}
            </div>
          </>
        )}
        {screen === "買い物" && (
          <>
            <h2>買い物リスト</h2>
            {cycle ? (
              <section className="card">
                <p>
                  {cycle.starts_on} 〜 {cycle.ends_on} ·{" "}
                  {cycle.status === "confirmed"
                    ? "購入確定済み"
                    : "未購入・確認待ち"}
                </p>
                <p className="muted">
                  献立全体の不足量です。購入しなかった項目は0に変更してください。
                </p>
                {cycle.items.length ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = {
                        version: cycle.version,
                        items: cycle.items.map((i) => ({
                          ingredientId: i.ingredient_id,
                          amount: shopAmounts[i.ingredient_id],
                        })),
                      };
                      run(
                        () =>
                          api("/shopping/" + cycle.id + "/confirm", {
                            ...value,
                            idempotencyKey: keyFor({
                              cycleId: cycle.id,
                              ...value,
                            }),
                          }),
                        "購入を確定し、在庫に追加しました",
                      );
                    }}
                  >
                    {cycle.items.map((i) => (
                      <label key={i.ingredient_id}>
                        {i.name} · 必要な買い足し {i.proposed_amount}
                        {i.unit}
                        <input
                          type="number"
                          required
                          min="0"
                          step="1"
                          max="1000000"
                          disabled={cycle.status === "confirmed"}
                          value={
                            cycle.status === "confirmed"
                              ? (i.actual_amount ?? 0)
                              : (shopAmounts[i.ingredient_id] ?? 0)
                          }
                          onChange={(e) =>
                            setShopAmounts({
                              ...shopAmounts,
                              [i.ingredient_id]: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    ))}
                    {cycle.status === "review" && (
                      <button disabled={busy}>
                        実際の購入量を確認して確定
                      </button>
                    )}
                  </form>
                ) : (
                  <p>買い足しは不要です。</p>
                )}
              </section>
            ) : (
              <p className="empty">
                買い物日、または買い足しを許可して献立を生成すると、不足量を表示します。
              </p>
            )}
          </>
        )}
        {screen === "記録" && (
          <>
            <h2>食べた夕食</h2>
            {logs.length ? (
              logs.map((l) => (
                <article className="card" key={l.id}>
                  <p>
                    {new Date(l.completed_at).toLocaleString("ja-JP", {
                      timeZone: "Asia/Tokyo",
                    })}{" "}
                    <span className="badge completed">確認済み</span>
                  </p>
                  <h3>{JSON.parse(l.recipe_snapshot).title}</h3>
                  <p>
                    約{number(l.total_kcal)} kcal / P{" "}
                    {number(l.total_protein_g)} g
                  </p>
                  <p className="muted">
                    実際の使用量から計算した栄養・レシピの保存時点の記録です。
                  </p>
                </article>
              ))
            ) : (
              <p className="empty">食事を完了すると、ここに記録されます。</p>
            )}
          </>
        )}
        {screen === "設定" && settings && (
          <SettingsForm
            settings={settings}
            busy={busy}
            save={(value) =>
              run(
                () => api("/settings", value, "PUT"),
                "設定を保存しました。新しい条件は次の献立生成から適用されます",
              )
            }
          />
        )}
        <footer>
          <p>夕食のみ自動計画 · 栄養は概算</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              run(
                async () => {
                  await api("/auth/logout", {});
                  setLogged(false);
                },
                "ログアウトしました",
                false,
              )
            }
          >
            ログアウト
          </button>
        </footer>
      </main>
    </>
  );
}
function SettingsForm({
  settings,
  busy,
  save,
}: {
  settings: Settings;
  busy: boolean;
  save: (s: Settings) => void;
}) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const fields: [keyof Settings, string][] = [
    ["dailyKcal", "1日の目標 kcal"],
    ["dailyProtein", "1日の目標たんぱく質 g"],
    ["dinnerKcal", "夕食の目標 kcal"],
    ["dinnerProtein", "夕食の目標たんぱく質 g"],
    ["maxMinutes", "調理時間の上限（30分まで）"],
  ];
  return (
    <section className="card">
      <h2>設定</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(s);
        }}
      >
        {fields.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min="1"
              max={key === "maxMinutes" ? 30 : 6000}
              required
              value={Number(s[key])}
              onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
        <fieldset>
          <legend>買い物曜日（2つ選択）</legend>
          <div className="weekdays">
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <label className="check" key={d}>
                <input
                  type="checkbox"
                  checked={s.shoppingDays.includes(d)}
                  onChange={(e) =>
                    setS({
                      ...s,
                      shoppingDays: e.target.checked
                        ? [...s.shoppingDays, d].sort()
                        : s.shoppingDays.filter((v) => v !== d),
                    })
                  }
                />
                {"日月火水木金土"[d]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>使える設備</legend>
          {["フライパン", "鍋", "電子レンジ"].map((v) => (
            <label className="check" key={v}>
              <input
                type="checkbox"
                checked={s.equipment.includes(v)}
                onChange={(e) =>
                  setS({
                    ...s,
                    equipment: e.target.checked
                      ? [...s.equipment, v]
                      : s.equipment.filter((x) => x !== v),
                  })
                }
              />
              {v}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>避けるアレルゲン（登録済みカタログ）</legend>
          {["卵", "大豆", "小麦", "さけ"].map((v) => (
            <label className="check" key={v}>
              <input
                type="checkbox"
                checked={s.allergies.includes(v)}
                onChange={(e) =>
                  setS({
                    ...s,
                    allergies: e.target.checked
                      ? [...s.allergies, v]
                      : s.allergies.filter((x) => x !== v),
                  })
                }
              />
              {v}
            </label>
          ))}
        </fieldset>
        <button disabled={busy || s.shoppingDays.length !== 2}>
          設定を保存
        </button>
      </form>
      <p className="muted">
        日本時間（Asia/Tokyo）。朝食なし・就寝前プロテインは未確認の予測です。プリセット編集と写真取り込みは後続の実装範囲です。
      </p>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
