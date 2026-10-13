import { useEffect, useState, useRef } from "react";
import type {
  Stock,
  Ingredient,
  Recipe,
  RecipeCandidates,
  Plan,
  Cycle,
  MealLog,
  Settings,
  NutritionSummary,
} from "../worker/contracts";
import { RecipeDetails } from "./RecipeDetails";
import { RecipeCandidatePicker } from "./RecipeCandidatePicker";
import { useAutoRefresh } from "./useAutoRefresh";
import { sameShoppingDays } from "../worker/planner";
type Screen = "今日" | "献立" | "買い物" | "在庫" | "レシピ" | "設定";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
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
    const error = (data as { error?: { message: string; code: string } }).error;
    throw new ApiError(
      error?.message ?? "通信に失敗しました",
      res.status,
      error?.code,
    );
  }
  return data as T;
}
const number = (n: number) => Math.round(n * 10) / 10;
export function App() {
  const [logged, setLogged] = useState(false),
    [checking, setChecking] = useState(true),
    [password, setPassword] = useState("");
  const [screen, setScreen] = useState<Screen>("今日"),
    [stocks, setStocks] = useState<Stock[]>([]),
    [plans, setPlans] = useState<Plan[]>([]),
    [ingredients, setIngredients] = useState<Ingredient[]>([]),
    [catalog, setCatalog] = useState<Recipe[]>([]),
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
    [busy, setBusy] = useState(false);
  const requestLock = useRef(false);
  const refreshPromise = useRef<Promise<Plan[]> | null>(null);
  const shoppingVersion = useRef("");
  const candidateAnchor = useRef<{ id: string; top: number } | null>(null);
  const [shoppingEdited, setShoppingEdited] = useState(false);
  const shoppingDirty = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const [review, setReview] = useState<Plan | null>(null),
    [amounts, setAmounts] = useState<Record<string, number>>({}),
    [shopAmounts, setShopAmounts] = useState<Record<string, number>>({});
  const [adjustIngredient, setAdjustIngredient] = useState(""),
    [delta, setDelta] = useState(0),
    [displayUnit, setDisplayUnit] = useState(false);
  // Keys remain unchanged after a failed request, allowing safe retries after lost responses.
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  function keyFor(value: unknown) {
    const fingerprint = JSON.stringify(value);
    if (pending.current?.fingerprint === fingerprint)
      return pending.current.key;
    const key = crypto.randomUUID();
    pending.current = { fingerprint, key };
    return key;
  }
  function reload(): Promise<Plan[]> {
    if (refreshPromise.current) return refreshPromise.current;
    const task = fetchLatest();
    refreshPromise.current = task;
    void task
      .finally(() => {
        if (refreshPromise.current === task) refreshPromise.current = null;
      })
      .catch(() => {});
    return task;
  }
  async function fetchLatest() {
    const [st, pl, sh, lo, se, to, ing, recipes] = await Promise.all([
      api<Stock[]>("/inventory"),
      api<Plan[]>("/plans"),
      api<Cycle | null>("/shopping/current"),
      api<MealLog[]>("/meal-logs"),
      api<Settings>("/settings"),
      api<NonNullable<typeof today>>("/today"),
      api<Ingredient[]>("/ingredients"),
      api<Recipe[]>("/recipes"),
    ]);
    setStocks(st);
    setIngredients(ing);
    setCatalog(recipes);
    setPlans(pl);
    if (!shoppingDirty.current || requestLock.current) setCycle(sh);
    setLogs(lo);
    setSettings((old) => (old?.version === se.version ? old : se));
    setToday(to);
    setLogged(true);
    const version = sh ? sh.id + ":" + sh.version : "";
    if (
      version !== shoppingVersion.current &&
      (!shoppingDirty.current || requestLock.current)
    ) {
      shoppingVersion.current = version;
      setShopAmounts(
        Object.fromEntries(
          sh?.items.map((i) => [i.ingredient_id, i.proposed_amount]) ?? [],
        ),
      );
      shoppingDirty.current = false;
      setShoppingEdited(false);
    }
    setAdjustIngredient((current) => current || st[0]?.id || "");
    return pl;
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
    if (requestLock.current) return;
    requestLock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (refreshPromise.current) await refreshPromise.current.catch(() => {});
      await action();
      pending.current = null;
      if (refresh) await reload();
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
      try {
        const latest = await reload();
        if (
          candidatePlan &&
          e instanceof ApiError &&
          [409, 422].includes(e.status)
        ) {
          const target = latest.find((p) => p.id === candidatePlan.id);
          if (target?.status === "planned") await openCandidates(target);
          else setCandidatePlan(null);
          setMessage(
            "最新の状態を取得しました。候補を確認して選び直してください",
          );
        }
        if (review && e instanceof ApiError && e.status === 409) {
          const target = latest.find((p) => p.id === review.id);
          if (
            target?.status === "planned" &&
            target.recipe.id === review.recipe.id
          )
            setReview(target);
          else setReview(null);
        }
      } catch {
        /* The online/focus refresh will recover after connection returns. */
      }
    } finally {
      requestLock.current = false;
      setBusy(false);
    }
  }
  function reviewPlan(p: Plan) {
    setReview(p);
    setAmounts(
      Object.fromEntries(
        p.recipe.items
          .filter((i) => !i.inventory_exempt)
          .map((i) => [i.ingredientId, i.amount]),
      ),
    );
    pending.current = null;
  }
  const [candidatePlan, setCandidatePlan] = useState<Plan | null>(null);
  const [candidatePage, setCandidatePage] = useState<RecipeCandidates | null>(
    null,
  );
  const [seenCandidates, setSeenCandidates] = useState<string[]>([]);
  async function openCandidates(p: Plan, exclude: string[] = []) {
    const page = await api<RecipeCandidates>("/plans/" + p.id + "/candidates", {
      version: p.version,
      allowPurchase: true,
      exclude,
    });
    setCandidatePlan(p);
    setCandidatePage(page);
    setSeenCandidates([...exclude, ...page.candidates.map((c) => c.recipe.id)]);
  }
  useAutoRefresh(
    async () => {
      try {
        await reload();
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "通信に失敗しました");
      }
    },
    () =>
      logged &&
      !requestLock.current &&
      !review &&
      !candidatePlan &&
      (screen !== "買い物" || !shoppingEdited) &&
      delta === 0 &&
      screen !== "設定",
  );
  const upcomingPlans = plans.filter(
    (p) => p.local_date >= (today?.date ?? "9999-99-99"),
  );
  const selected = stocks.find((s) => s.id === adjustIngredient);
  function closeCandidates(id: string) {
    returnFocus.current = id;
    setCandidatePlan(null);
    setCandidatePage(null);
  }
  useEffect(() => {
    if (busy || candidatePlan || !returnFocus.current) return;
    const id = returnFocus.current;
    const timer = window.requestAnimationFrame(() => {
      const button = document.getElementById("change-" + id);
      const anchor = candidateAnchor.current;
      if (button && anchor?.id === id) {
        const shift = button.getBoundingClientRect().top - anchor.top;
        if (Math.abs(shift) > 1)
          window.scrollBy({ top: shift, behavior: "auto" });
      }
      button?.focus({ preventScroll: true });
      candidateAnchor.current = null;
      returnFocus.current = null;
    });
    return () => window.cancelAnimationFrame(timer);
  }, [busy, candidatePlan]);
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
        {p.status === "planned" && (
          <button
            className="secondary"
            id={"change-" + p.id}
            aria-expanded={candidatePlan?.id === p.id}
            aria-controls={"candidates-" + p.id}
            disabled={busy}
            onClick={() =>
              run(
                async () => {
                  candidateAnchor.current = {
                    id: p.id,
                    top:
                      document
                        .getElementById("change-" + p.id)
                        ?.getBoundingClientRect().top ?? 0,
                  };
                  setCandidatePlan(p);
                  setCandidatePage(null);
                  await openCandidates(p);
                },
                "候補を比較して選んでください",
                false,
              )
            }
          >
            別の料理に変更
          </button>
        )}
        {candidatePlan?.id === p.id && (
          <div
            id={"candidates-" + p.id}
            aria-live="polite"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) closeCandidates(p.id);
            }}
          >
            {!candidatePage ? (
              <p role="status">候補を取得中…</p>
            ) : (
              <RecipeCandidatePicker
                plan={p}
                page={candidatePage}
                busy={busy}
                next={() =>
                  run(() => openCandidates(p, seenCandidates), "", false)
                }
                cancel={() => closeCandidates(p.id)}
                select={(recipeId) =>
                  run(
                    async () => {
                      await api("/plans/" + p.id + "/regenerate", {
                        version: candidatePage.version,
                        recipeId,
                        allowPurchase: true,
                      });
                      await reload();
                      closeCandidates(p.id);
                    },
                    "料理と買い物リストを更新しました",
                    false,
                  )
                }
              />
            )}
          </div>
        )}
        <p className="metrics">
          約{number(completedLog?.total_kcal ?? recipe.kcal)} kcal · たんぱく質{" "}
          {number(completedLog?.total_protein_g ?? recipe.protein)} g ·{" "}
          {recipe.total_minutes}分
        </p>
        <details>
          <summary>
            {completedLog ? "計画時の食材・作り方を見る" : "食材・作り方を見る"}
          </summary>
          <RecipeDetails
            recipe={recipe}
            ingredients={ingredients}
            stocks={stocks}
          />
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
                  () => api("/plans/" + p.id + "/skip", { version: p.version }),
                  "スキップしました。在庫は消費していません",
                )
              }
            >
              スキップ
            </button>
          </div>
        )}
        {p.status === "skipped" && p.local_date >= (today?.date ?? "") && (
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api("/plans/" + p.id + "/unskip", { version: p.version }),
                  "スキップを取り消しました。未確定の買い物リストも更新しました。確定済みの買い物リストは変更されないため、必要な食材を確認してください。",
                )
              }
            >
              スキップを取り消す
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
        <div>
          <small>{today?.date} · 東京</small>
          <button
            className="secondary settings-button"
            aria-label="設定"
            aria-pressed={screen === "設定"}
            disabled={busy}
            onClick={() => {
              setScreen("設定");
              setReview(null);
              setCandidatePlan(null);
            }}
          >
            ⚙
          </button>
        </div>
      </header>
      <nav aria-label="メインメニュー">
        {(["今日", "献立", "買い物", "在庫", "レシピ"] as Screen[]).map((s) => (
          <button
            key={s}
            disabled={busy}
            className={s === screen ? "active" : ""}
            onClick={() => {
              setScreen(s);
              setReview(null);
              setCandidatePlan(null);
            }}
            aria-current={s === screen ? "page" : undefined}
          >
            {s}
          </button>
        ))}
      </nav>
      <main aria-busy={busy}>
        {busy && (
          <p role="status" className="processing">
            処理中…
          </p>
        )}
        <div className="feedback" aria-live="polite">
          {message && <p className="notice">{message}</p>}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
            <small>
              状態は自動で確認します。通信が戻ったらもう一度操作できます。
            </small>
          </p>
        )}
        {(screen === "今日" || screen === "献立") &&
          (screen === "今日" ? !today?.plan : !upcomingPlans.length) && (
            <section className="generate">
              <button
                disabled={busy}
                onClick={() =>
                  run(
                    () => api("/shopping/today", {}),
                    "献立を作成しました。買い物タブで不足分を確認できます",
                  )
                }
              >
                今日からの献立を作る
              </button>
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
            {upcomingPlans.length ? (
              upcomingPlans.map(recipeCard)
            ) : (
              <p className="empty">献立を生成して始めましょう。</p>
            )}
          </>
        )}
        {screen === "レシピ" && (
          <>
            {catalog.length ? "" : <p>レシピを読み込み中…</p>}
            <h2>レシピ一覧（{catalog.length}件）</h2>
            {catalog.map((recipe) => (
              <details key={recipe.id} className="card">
                <summary>{recipe.title}</summary>
                <p className="metrics">
                  約{number(recipe.kcal)} kcal · たんぱく質{" "}
                  {number(recipe.protein)} g · {recipe.total_minutes}分
                </p>
                <RecipeDetails
                  recipe={recipe}
                  ingredients={ingredients}
                  stocks={stocks}
                />
              </details>
            ))}
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
              {review.recipe.items
                .filter((i) => !i.inventory_exempt)
                .map((i) => {
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
              <p className="muted">
                調味料は下記のレシピ既定量を栄養に自動計上し、在庫は消費しません。
              </p>
              <ul>
                {review.recipe.items
                  .filter((i) => i.inventory_exempt)
                  .map((i) => (
                    <li key={i.ingredientId}>
                      {i.name} {i.amount}
                      {i.unit}（既定量）
                    </li>
                  ))}
              </ul>
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
            <h2>今日の買い物</h2>
            <button
              disabled={busy}
              onClick={() =>
                run(
                  () => api("/shopping/today", {}),
                  "今日買う食材を更新しました",
                )
              }
            >
              今日買う食材を表示
            </button>
            <p className="muted">
              いつでも買い物できます。目安は
              {settings?.shoppingDays
                .map((d) => "日月火水木金土"[d])
                .join("・")}
              曜日。予定の料理は変えず、不足分だけ計算します。
            </p>
            {cycle ? (
              <section className="card">
                <p>
                  買い物日：{cycle.shopping_on}（
                  {
                    "日月火水木金土"[
                      new Date(cycle.shopping_on + "T00:00:00Z").getUTCDay()
                    ]
                  }
                  ） · 対象：{cycle.starts_on} 〜 {cycle.ends_on} ·{" "}
                  {cycle.status === "confirmed"
                    ? "購入確定済み"
                    : "未購入・確認待ち"}
                </p>
                {!!cycle.unplanned_dates?.length && (
                  <p role="status" className="notice">
                    献立未作成の日：{cycle.unplanned_dates.join("・")}
                    。上のボタンで未作成の日だけ補います。
                  </p>
                )}
                <p className="muted">
                  献立全体の不足量です。購入済みの量だけ確定してください。購入しなかった項目は0に変更してください。
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
                          onChange={(e) => {
                            shoppingDirty.current = true;
                            setShoppingEdited(true);
                            setShopAmounts({
                              ...shopAmounts,
                              [i.ingredient_id]: Number(e.target.value),
                            });
                          }}
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
                「今日買う食材を表示」で、次の目安買い物日前日までの不足分を表示します。
              </p>
            )}
          </>
        )}
        {screen === "設定" && settings && (
          <SettingsForm
            settings={settings}
            busy={busy}
            save={(value) =>
              run(async () => {
                try {
                  return await api("/settings", value, "PUT");
                } catch (e) {
                  if (
                    e instanceof ApiError &&
                    e.code === "SHOPPING_RESET_REQUIRED" &&
                    window.confirm(
                      "古い買い物リストを更新します。在庫・料理・購入済み履歴は保持します。続けますか？",
                    )
                  )
                    return api(
                      "/settings",
                      { ...value, discardPendingShopping: true },
                      "PUT",
                    );
                  throw e;
                }
              }, "設定を保存しました")
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
  save: (s: Settings & { discardPendingShopping?: boolean }) => void;
}) {
  const [s, setS] = useState(settings);
  useEffect(() => {
    setS(settings);
  }, [settings]);
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
          const changed = !sameShoppingDays(
            s.shoppingDays,
            settings.shoppingDays,
          );
          const discardPendingShopping = changed;
          if (
            discardPendingShopping &&
            !window.confirm(
              changed
                ? "古い買い物リストを更新します。在庫・料理・購入済み履歴は保持します。続けますか？"
                : "買い物曜日は変更せず、旧設定で作成された未確定買い物リストを整理して再計算します。既存の献立・在庫・食事記録・確定済み購入は保持します。続けますか？",
            )
          )
            return;
          save({ ...s, discardPendingShopping });
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
          <legend>まとめ買いの目安（2曜日）</legend>
          <p className="muted">
            次の目安買い物日前日までの不足分を計算します。曜日に関係なく、いつでも買い物できます。
            火・土の運用では、火〜金の4日分と土〜月の3日分です。
          </p>
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
