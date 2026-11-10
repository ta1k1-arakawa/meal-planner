import type {
  Ingredient,
  Stock,
  Recipe,
  RecipeSlot,
  Settings,
  Plan,
  Cycle,
  ShoppingItem,
  RecipeCandidates,
  SlotPlan,
  SlotPlanSlot,
  CostSummary,
} from "./contracts";
import { PRICE_CAPS } from "./price-caps";
import { recipeItem, renderInstructions } from "./recipe";
import {
  DomainError,
  nutrition,
  addDays,
  cycleEnd,
  eligible,
  chooseRecipe,
  chooseSlotRecipe,
  allocate,
  tokyoDate,
  currentSchedule,
  nextShoppingDate,
  rankRecipes,
  slotTargetFor,
  DEFAULT_SLOT_TARGETS,
} from "./planner";
export const stmt = (
  db: D1Database,
  sql: string,
  ...args: (string | number | null)[]
) => db.prepare(sql).bind(...args);
export async function rows<T>(
  db: D1Database,
  sql: string,
  ...args: (string | number | null)[]
): Promise<T[]> {
  return (await stmt(db, sql, ...args).all<T>()).results;
}
export async function ingredients(db: D1Database) {
  return rows<Ingredient>(db, "SELECT * FROM ingredients ORDER BY name");
}
export async function inventory(db: D1Database) {
  return rows<Stock>(
    db,
    "SELECT i.*,s.quantity,s.version FROM ingredients i JOIN inventory_stocks s ON s.ingredient_id=i.id WHERE i.inventory_exempt=0 ORDER BY i.name",
  );
}
export async function settings(db: D1Database): Promise<Settings> {
  const s = await db
    .prepare("SELECT * FROM app_settings WHERE id=1")
    .first<Record<string, string | number>>();
  if (!s)
    throw new DomainError(
      "SETUP_REQUIRED",
      "データベースの初期化が必要です",
      503,
    );
  // Bulking columns arrive with migration 0008. Tolerate their absence so
  // populated pre-0008 databases still answer settings reads during upgrade.
  const slotTargets = (() => {
    if (!s.slot_targets_json) return DEFAULT_SLOT_TARGETS;
    try {
      const parsed = JSON.parse(String(s.slot_targets_json));
      return {
        lunch: parsed.lunch ?? DEFAULT_SLOT_TARGETS.lunch,
        snack: parsed.snack ?? DEFAULT_SLOT_TARGETS.snack,
        nightSnack:
          parsed.nightSnack ??
          parsed.night_snack ??
          DEFAULT_SLOT_TARGETS.nightSnack,
        morningDrink:
          parsed.morningDrink ??
          parsed.morning_drink ??
          DEFAULT_SLOT_TARGETS.morningDrink,
      };
    } catch {
      return DEFAULT_SLOT_TARGETS;
    }
  })();
  return {
    version: Number(s.version),
    dailyKcal: Number(s.daily_kcal),
    dailyProtein: Number(s.daily_protein_g),
    dinnerKcal: Number(s.dinner_kcal),
    dinnerProtein: Number(s.dinner_protein_g),
    maxMinutes: Number(s.max_minutes),
    shoppingDays: JSON.parse(String(s.shopping_days_json)),
    equipment: JSON.parse(String(s.equipment_json)),
    allergies: JSON.parse(String(s.allergies_json)),
    excludedIngredients: JSON.parse(String(s.excluded_ingredients_json)),
    monthlyBudgetYen:
      s.monthly_budget_yen === undefined || s.monthly_budget_yen === null
        ? 25000
        : Number(s.monthly_budget_yen),
    slotTargets,
  };
}
export async function recipes(db: D1Database): Promise<Recipe[]> {
  const [rs, lines, ings] = await Promise.all([
    rows<Omit<Recipe, "items" | "kcal" | "protein">>(
      db,
      "SELECT * FROM recipes ORDER BY id",
    ),
    rows<{ recipe_id: string; ingredient_id: string; amount: number }>(
      db,
      "SELECT * FROM recipe_ingredients ORDER BY ingredient_id",
    ),
    ingredients(db),
  ]);
  return rs.map((r) => {
    const items = lines
      .filter((l) => l.recipe_id === r.id)
      .map((l) =>
        recipeItem({ ingredientId: l.ingredient_id, amount: l.amount }, ings),
      );
    return {
      ...r,
      // The slot column arrives with migration 0008; older rows are dinners.
      slot: ((r as { slot?: RecipeSlot }).slot ?? "dinner") as RecipeSlot,
      instructions_json: renderInstructions(r.instructions_json, items),
      items,
      ...nutrition(items, ings),
    };
  });
}
export async function plans(db: D1Database): Promise<Plan[]> {
  const [ps, ds, rs] = await Promise.all([
    rows<Omit<Plan, "recipe">>(
      db,
      "SELECT * FROM meal_plans ORDER BY local_date",
    ),
    rows<{ plan_id: string; recipe_id: string }>(
      db,
      "SELECT * FROM meal_plan_dishes",
    ),
    recipes(db),
  ]);
  return ps.map((p) => ({
    ...p,
    recipe: rs.find(
      (r) => r.id === ds.find((d) => d.plan_id === p.id)?.recipe_id,
    )!,
  }));
}
export const cycleTable = (cycle: Pick<Cycle, "kind">) =>
  cycle.kind === "run" ? "shopping_runs" : "shopping_cycles";
export const cycleItemTable = (cycle: Pick<Cycle, "kind">) =>
  cycle.kind === "run" ? "shopping_run_items" : "shopping_items";
// Filter expressions come exclusively from server code, never request input.
export function cycleEntries(db: D1Database, filter = "1=1") {
  return rows<Omit<Cycle, "items">>(
    db,
    `SELECT *, 'cycle' AS kind FROM shopping_cycles WHERE ${filter} UNION ALL SELECT *, 'run' AS kind FROM shopping_runs WHERE ${filter} ORDER BY starts_on`,
  );
}
export async function cycleById(db: D1Database, id: string) {
  return stmt(
    db,
    "SELECT *, 'cycle' AS kind FROM shopping_cycles WHERE id=? UNION ALL SELECT *, 'run' AS kind FROM shopping_runs WHERE id=?",
    id,
    id,
  ).first<Cycle>();
}
export function cycleItems(db: D1Database, cycle: Pick<Cycle, "id" | "kind">) {
  return rows<ShoppingItem>(
    db,
    `SELECT si.*,i.name FROM ${cycleItemTable(cycle)} si JOIN ingredients i ON i.id=si.ingredient_id WHERE cycle_id=? AND i.inventory_exempt=0 ORDER BY i.name`,
    cycle.id,
  );
}

export async function shopping(
  db: D1Database,
  date: string,
): Promise<Cycle | null> {
  const config = await settings(db);
  const cycles = await cycleEntries(db, "obsolete=0");
  const next = nextShoppingDate(date, config.shoppingDays);
  const cycle =
    cycles.find(
      (c) =>
        c.kind === "run" &&
        c.status === "review" &&
        c.shopping_on === date &&
        currentSchedule(c, config.shoppingDays),
    ) ??
    cycles.find(
      (c) =>
        currentSchedule(c, config.shoppingDays) &&
        c.status === "review" &&
        c.shopping_on >= date &&
        c.shopping_on <= next,
    ) ??
    cycles.find(
      (c) => currentSchedule(c, config.shoppingDays) && c.starts_on === next,
    ) ??
    cycles.find(
      (c) =>
        currentSchedule(c, config.shoppingDays) &&
        c.starts_on <= date &&
        c.ends_on >= date,
    );
  if (!cycle) return null;
  const items = await cycleItems(db, cycle);
  const existing = await plans(db);
  const unplanned_dates: string[] = [];
  for (
    let date = cycle.starts_on;
    date <= cycle.ends_on;
    date = addDays(date, 1)
  )
    if (!existing.some((p) => p.local_date === date))
      unplanned_dates.push(date);
  return { ...cycle, items, unplanned_dates };
}
export function guard(
  db: D1Database,
  condition: string,
  ...args: (string | number | null)[]
) {
  return stmt(
    db,
    `INSERT INTO transaction_guards(ok) SELECT CASE WHEN (${condition}) THEN 1 ELSE 0 END`,
    ...args,
  );
}
export async function atomic(
  db: D1Database,
  statements: D1PreparedStatement[],
) {
  try {
    await db.batch([
      ...statements,
      db.prepare("DELETE FROM transaction_guards"),
    ]);
  } catch {
    throw new DomainError(
      "CONFLICT",
      "在庫不足、または別の操作で更新されました。再読込して数量を確認してください。",
      409,
    );
  }
}
export async function replay(
  db: D1Database,
  key: string,
  kind: string,
  payload: string,
) {
  const op = await stmt(
    db,
    "SELECT * FROM operations WHERE idempotency_key=?",
    key,
  ).first<{ kind: string; payload: string; result_id: string }>();
  if (!op) return null;
  if (op.kind !== kind || op.payload !== payload)
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "同じ再送キーで異なる操作は実行できません",
      409,
    );
  return op.result_id;
}
export function operation(
  db: D1Database,
  key: string,
  kind: string,
  payload: string,
  resultId: string,
) {
  return stmt(
    db,
    "INSERT INTO operations(idempotency_key,kind,payload,result_id) VALUES (?,?,?,?)",
    key,
    kind,
    payload,
    resultId,
  );
}
export function movement(
  db: D1Database,
  ingredient: string,
  delta: number,
  reason: string,
  source: string,
  key: string,
) {
  return stmt(
    db,
    "INSERT INTO inventory_movements(id,ingredient_id,delta,reason,source_id,idempotency_key) VALUES (?,?,?,?,?,?)",
    crypto.randomUUID(),
    ingredient,
    delta,
    reason,
    source,
    key,
  );
}
export async function idempotentBatch(
  db: D1Database,
  key: string,
  kind: string,
  payload: string,
  resultId: string,
  statements: D1PreparedStatement[],
) {
  try {
    await atomic(db, [
      operation(db, key, kind, payload, resultId),
      ...statements,
    ]);
  } catch (error) {
    const previous = await replay(db, key, kind, payload);
    if (previous) return previous;
    throw error;
  }
  return resultId;
}
// Rebuild pending purchase projections in the same batch as a stock/plan mutation.
export async function reconcileShopping(
  db: D1Database,
  options: {
    skipPlan?: string;
    skipSlotPlan?: string;
    stockDeltas?: Map<string, number>;
    skipCycle?: string;
    projectedPlans?: Plan[];
    newCycle?: Omit<Cycle, "items">;
    settingsOverride?: Settings;
    obsoleteCycles?: string[];
  } = {},
) {
  const [ps, stocks, cycles, savedSettings] = await Promise.all([
    plans(db),
    inventory(db),
    cycleEntries(db, "status='review'"),
    settings(db),
  ]);
  // Whole-day slot plans (lunch/snack/night/morning) share the same stock and
  // shopping deficits as dinners. The table arrives with migration 0008, so
  // tolerate its absence on pre-0008 databases used by upgrade flows.
  let slotPseudoPlans: Plan[] = [];
  try {
    const sps = await slotPlans(db);
    slotPseudoPlans = sps
      .filter(
        (sp) => sp.status === "planned" && sp.id !== options.skipSlotPlan,
      )
      .map((sp) => ({
        id: sp.id,
        local_date: sp.local_date,
        status: "planned" as const,
        version: sp.version,
        recipe: sp.recipe,
      }));
  } catch {
    slotPseudoPlans = [];
  }
  const config = options.settingsOverride ?? savedSettings;
  const statements: D1PreparedStatement[] = [
    guard(
      db,
      "EXISTS(SELECT 1 FROM app_settings WHERE version=?)",
      savedSettings.version,
    ),
    guard(db, "(SELECT COUNT(*) FROM meal_plans)=?", ps.length),
    guard(
      db,
      "((SELECT COUNT(*) FROM shopping_cycles WHERE status='review')+(SELECT COUNT(*) FROM shopping_runs WHERE status='review'))=?",
      cycles.length,
    ),
  ];
  for (const p of ps)
    statements.push(
      guard(
        db,
        "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=?)",
        p.id,
        p.version,
      ),
    );
  for (const stock of stocks)
    statements.push(
      guard(
        db,
        "EXISTS(SELECT 1 FROM inventory_stocks WHERE ingredient_id=? AND version=?)",
        stock.id,
        stock.version,
      ),
    );
  for (const c of cycles)
    statements.push(
      guard(
        db,
        `EXISTS(SELECT 1 FROM ${cycleTable(c)} WHERE id=? AND version=? AND status='review')`,
        c.id,
        c.version,
      ),
    );
  for (const id of options.obsoleteCycles ?? [])
    statements.push(
      stmt(
        db,
        `UPDATE ${cycleTable(cycles.find((c) => c.id === id)!)} SET obsolete=1,version=version+1 WHERE id=? AND status='review'`,
        id,
      ),
    );
  if (options.newCycle) {
    const n = options.newCycle;
    const previous = await stmt(
      db,
      `SELECT * FROM ${cycleTable(n)} WHERE starts_on=? ${n.kind === "run" ? "AND status='review' AND obsolete=0" : ""}`,
      n.starts_on,
    ).first<Omit<Cycle, "items">>();
    if (previous) {
      if (previous.status === "confirmed")
        throw new DomainError(
          "CONFIRMED_PERIOD_CONFLICT",
          "同じ買い物日の購入履歴があります。在庫を確認し、追加分は在庫画面から登録してください",
          409,
        );
      if (!previous.obsolete && !options.obsoleteCycles?.includes(previous.id))
        throw new DomainError(
          "SHOPPING_RESET_REQUIRED",
          "旧リストを設定画面で確認して作り直してください",
          409,
        );
      n.id = previous.id;
      n.version =
        previous.version +
        (options.obsoleteCycles?.includes(previous.id) ? 2 : 1);
      statements.unshift(
        guard(
          db,
          `EXISTS(SELECT 1 FROM ${cycleTable(n)} WHERE id=? AND version=? AND status='review')`,
          previous.id,
          previous.version,
        ),
      );
      statements.push(
        stmt(
          db,
          `UPDATE ${cycleTable(n)} SET ends_on=?,shopping_on=?,shopping_days_json=?,obsolete=0,version=? WHERE id=?`,
          n.ends_on,
          n.shopping_on,
          n.shopping_days_json,
          n.version,
          n.id,
        ),
      );
    } else
      statements.push(
        stmt(
          db,
          `INSERT INTO ${cycleTable(n)}(id,starts_on,ends_on,shopping_on,status,shopping_days_json) VALUES (?,?,?,?,'review',?)`,
          n.id,
          n.starts_on,
          n.ends_on,
          n.shopping_on,
          n.shopping_days_json,
        ),
      );
  }
  const projections = new Map<string, Map<string, number>>();
  const activeCycles = [
    ...cycles.filter((c) => c.id !== options.newCycle?.id),
    ...(options.newCycle ? [options.newCycle] : []),
  ]
    .filter(
      (c) =>
        c.id !== options.skipCycle &&
        currentSchedule(c, config.shoppingDays) &&
        (!options.obsoleteCycles?.includes(c.id) || c === options.newCycle),
    )
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  for (const cycle of activeCycles) {
    const virtual = new Map(
      stocks.map((s) => [
        s.id,
        s.quantity + (options.stockDeltas?.get(s.id) ?? 0),
      ]),
    );
    // Earlier proposed purchases are available only in future projections, never in actual stock.
    for (const earlier of activeCycles.filter(
      (c) => c.ends_on < cycle.starts_on && c.shopping_on >= tokyoDate(),
    )) {
      for (const [ingredient, amount] of projections.get(earlier.id) ?? [])
        virtual.set(ingredient, (virtual.get(ingredient) ?? 0) + amount);
    }
    const deficits = new Map<string, number>(),
      requirements = new Map<string, number>();
    for (const p of [
      ...(options.projectedPlans ?? ps),
      ...slotPseudoPlans,
    ].filter(
      (p) =>
        p.id !== options.skipPlan &&
        p.status === "planned" &&
        p.local_date >= tokyoDate() &&
        p.local_date <= cycle.ends_on,
    )) {
      if (p.local_date < cycle.starts_on) {
        for (const i of p.recipe.items.filter((i) => !i.inventory_exempt))
          virtual.set(
            i.ingredientId,
            Math.max(0, (virtual.get(i.ingredientId) ?? 0) - i.amount),
          );
      } else {
        for (const i of p.recipe.items.filter((i) => !i.inventory_exempt))
          requirements.set(
            i.ingredientId,
            (requirements.get(i.ingredientId) ?? 0) + i.amount,
          );
        allocate(p.recipe, virtual, deficits);
      }
    }
    projections.set(cycle.id, deficits);
    statements.push(
      guard(
        db,
        `EXISTS(SELECT 1 FROM ${cycleTable(cycle)} WHERE id=? AND version=? AND status='review' AND obsolete=0)`,
        cycle.id,
        cycle.version,
      ),
      stmt(
        db,
        `DELETE FROM ${cycleItemTable(cycle)} WHERE cycle_id=? AND ingredient_id IN (SELECT id FROM ingredients WHERE inventory_exempt=0)`,
        cycle.id,
      ),
      stmt(
        db,
        `UPDATE ${cycleTable(cycle)} SET version=version+1 WHERE id=?`,
        cycle.id,
      ),
    );
    for (const [ingredient, amount] of deficits) {
      const stock = stocks.find((s) => s.id === ingredient)!;
      statements.push(
        stmt(
          db,
          `INSERT INTO ${cycleItemTable(cycle)}(id,cycle_id,ingredient_id,requested_amount,proposed_amount,unit,status) VALUES (?,?,?,?,?,?,'review')`,
          crypto.randomUUID(),
          cycle.id,
          ingredient,
          requirements.get(ingredient) ?? amount,
          amount,
          stock.unit,
        ),
      );
    }
  }
  return statements;
}
/**
 * Restore a skipped dinner without selecting a different recipe.
 * Keep historical completed meals immutable, and recompute all pending shopping
 * reviews atomically with the status change. Confirmed purchases stay immutable.
 */
export async function unskip(db: D1Database, id: string, version: number) {
  const existingPlans = await plans(db);
  const target = existingPlans.find((p) => p.id === id);
  if (!target || target.status !== "skipped" || target.version !== version)
    throw new DomainError(
      "PLAN_CONFLICT",
      "この献立は変更済みか、スキップされていません。再読込してください。",
      409,
    );
  if (target.local_date < tokyoDate())
    throw new DomainError("PAST_DATE", "過去のスキップは取り消せません。", 422);
  const projectedPlans = existingPlans.map((p) =>
    p.id === id
      ? { ...p, status: "planned" as const, version: p.version + 1 }
      : p,
  );
  const projections = await reconcileShopping(db, { projectedPlans });
  await atomic(db, [
    ...projections,
    guard(
      db,
      "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=? AND status='skipped' AND local_date>=?)",
      id,
      version,
      tokyoDate(),
    ),
    stmt(
      db,
      "UPDATE meal_plans SET status='planned', version=version+1 WHERE id=?",
      id,
    ),
  ]);
  return { ok: true };
}

export async function generate(
  db: D1Database,
  start: string,
  allowPurchase: boolean,
) {
  const [s, stocks, catalog, allPlans, ings] = await Promise.all([
    settings(db),
    inventory(db),
    recipes(db),
    plans(db),
    ingredients(db),
  ]);
  const end = cycleEnd(start, s.shoppingDays);
  const purchase =
    allowPurchase ||
    s.shoppingDays.includes(new Date(start + "T00:00:00Z").getUTCDay());
  const valid = catalog.filter((r) => r.slot === "dinner" && eligible(r, s, ings));
  const virtual = new Map(stocks.map((i) => [i.id, i.quantity]));
  const reviewCycles = await cycleEntries(db, "status='review' AND obsolete=0");
  for (const cycle of reviewCycles.filter(
    (c) =>
      currentSchedule(c, s.shoppingDays) &&
      c.ends_on < start &&
      c.shopping_on >= tokyoDate(),
  )) {
    const earlierPurchases = await cycleItems(db, cycle);
    for (const item of earlierPurchases)
      virtual.set(
        item.ingredient_id,
        (virtual.get(item.ingredient_id) ?? 0) + item.proposed_amount,
      );
  }
  const deficits = new Map<string, number>();
  const used: string[] = [];
  // Earlier pending dinners reserve actual stock, even when replacing a later dinner.
  for (const p of allPlans.filter(
    (p) =>
      p.local_date >= tokyoDate() &&
      p.local_date < start &&
      ["draft", "planned"].includes(p.status),
  )) {
    for (const item of p.recipe.items.filter((i) => !i.inventory_exempt))
      virtual.set(
        item.ingredientId,
        (virtual.get(item.ingredientId) ?? 0) - item.amount,
      );
    used.push(p.recipe.id);
  }
  if (!purchase && [...virtual.values()].some((n) => n < 0))
    throw new DomainError(
      "EARLIER_SHORTFALL",
      "先の献立に必要な在庫が不足しています。在庫を確認して買い足しを許可してください。",
      422,
    );
  if (purchase)
    for (const [ingredient, quantity] of virtual)
      virtual.set(ingredient, Math.max(0, quantity));
  const selected: { date: string; recipe: Recipe; existing?: Plan }[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const existing = allPlans.find((p) => p.local_date === date);
    if (existing && ["completed", "skipped"].includes(existing.status))
      continue;
    const recipe = chooseRecipe(valid, virtual, used, s, purchase);
    allocate(recipe, virtual, deficits);
    used.push(recipe.id);
    selected.push({ date, recipe, existing });
  }
  if (!selected.length)
    throw new DomainError(
      "NO_OPEN_DATES",
      "この期間の夕食は完了またはスキップ済みです",
      422,
    );
  const statements: D1PreparedStatement[] = [
    guard(db, "EXISTS(SELECT 1 FROM app_settings WHERE version=?)", s.version),
  ];
  for (const c of reviewCycles)
    statements.push(
      guard(
        db,
        `EXISTS(SELECT 1 FROM ${cycleTable(c)} WHERE id=? AND version=? AND status='review' AND obsolete=0)`,
        c.id,
        c.version,
      ),
    );
  // Snapshot guards prevent concurrent adjustments/completions/generation invalidating projections.
  for (const stock of stocks)
    statements.push(
      guard(
        db,
        "EXISTS(SELECT 1 FROM inventory_stocks WHERE ingredient_id=? AND version=?)",
        stock.id,
        stock.version,
      ),
    );
  statements.push(
    guard(db, "(SELECT COUNT(*) FROM meal_plans)=?", allPlans.length),
  );
  for (const p of allPlans)
    statements.push(
      guard(
        db,
        "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=?)",
        p.id,
        p.version,
      ),
    );
  const planMutations: D1PreparedStatement[] = [];
  const nextPlans = [...allPlans];
  for (const item of selected) {
    const id = item.existing?.id ?? crypto.randomUUID();
    const projected: Plan = {
      id,
      local_date: item.date,
      status: "planned",
      version: (item.existing?.version ?? -1) + 1,
      recipe: item.recipe,
    };
    const position = nextPlans.findIndex((p) => p.id === id);
    if (position >= 0) nextPlans[position] = projected;
    else nextPlans.push(projected);
    if (item.existing)
      planMutations.push(
        stmt(
          db,
          "UPDATE meal_plans SET version=version+1,status='planned' WHERE id=?",
          id,
        ),
        stmt(db, "DELETE FROM meal_plan_dishes WHERE plan_id=?", id),
      );
    else
      planMutations.push(
        stmt(
          db,
          "INSERT INTO meal_plans(id,local_date,status) VALUES (?,?,'planned')",
          id,
          item.date,
        ),
      );
    planMutations.push(
      stmt(
        db,
        "INSERT INTO meal_plan_dishes(id,plan_id,recipe_id) VALUES (?,?,?)",
        crypto.randomUUID(),
        id,
        item.recipe.id,
      ),
    );
  }
  const cycle = (await cycleEntries(db, "obsolete=0")).find(
    (c) =>
      c.starts_on <= start &&
      c.ends_on >= start &&
      currentSchedule(c, s.shoppingDays),
  );
  if (purchase && cycle?.status === "confirmed" && deficits.size)
    throw new DomainError(
      "PURCHASE_ALREADY_CONFIRMED",
      "この期間の買い物は確定済みです。不足分を在庫画面で追加してから生成してください。",
      422,
    );
  const newCycle: Omit<Cycle, "items"> | undefined =
    purchase && !cycle
      ? {
          id: crypto.randomUUID(),
          starts_on: start,
          ends_on: end,
          shopping_on: start,
          status: "review",
          version: 0,
          obsolete: 0,
          shopping_days_json: JSON.stringify([...s.shoppingDays].sort()),
        }
      : undefined;
  const projectionStatements = await reconcileShopping(db, {
    projectedPlans: nextPlans.sort((a, b) =>
      a.local_date.localeCompare(b.local_date),
    ),
    newCycle,
  });
  statements.push(...projectionStatements, ...planMutations);
  await atomic(db, statements);
  return {
    startDate: start,
    endDate: end,
    plans: await plans(db),
    deficits: [...deficits].map(([ingredientId, amount]) => ({
      ingredientId,
      amount,
    })),
    purchaseRequired: deficits.size > 0,
  };
}

async function candidateContext(
  db: D1Database,
  id: string,
  version: number,
  allowPurchase: boolean,
) {
  const [config, stocks, catalog, ps, ings, cycles, rejected] =
    await Promise.all([
      settings(db),
      inventory(db),
      recipes(db),
      plans(db),
      ingredients(db),
      cycleEntries(db, "obsolete=0"),
      rows<{ recipe_id: string }>(
        db,
        "SELECT recipe_id FROM plan_recipe_rejections WHERE plan_id=?",
        id,
      ),
    ]);
  const target = ps.find((p) => p.id === id);
  if (!target) throw new DomainError("NOT_FOUND", "献立がありません", 404);
  if (target.version !== version || target.status !== "planned")
    throw new DomainError(
      "PLAN_CONFLICT",
      "献立は変更済みか完了しています。再読込してください",
      409,
    );
  if (target.local_date < tokyoDate())
    throw new DomainError("PAST_DATE", "過去の献立は変更できません", 422);
  const active = cycles.filter((c) => currentSchedule(c, config.shoppingDays));
  const cycle = [...active]
    .sort(
      (a, b) => Number(b.status === "review") - Number(a.status === "review"),
    )
    .find(
      (c) => c.starts_on <= target.local_date && c.ends_on >= target.local_date,
    );
  const purchase =
    allowPurchase ||
    !!(cycle?.status === "review" && cycle.shopping_on >= tokyoDate());
  const virtual = new Map(stocks.map((s) => [s.id, s.quantity]));
  for (const c of active.filter(
    (c) =>
      c.status === "review" &&
      c.ends_on < target.local_date &&
      c.shopping_on >= tokyoDate(),
  )) {
    for (const i of await cycleItems(db, c))
      virtual.set(
        i.ingredient_id,
        (virtual.get(i.ingredient_id) ?? 0) + i.proposed_amount,
      );
  }
  for (const p of ps.filter(
    (p) =>
      p.local_date >= tokyoDate() &&
      p.local_date < target.local_date &&
      ["planned", "draft"].includes(p.status),
  ))
    for (const i of p.recipe.items.filter((i) => !i.inventory_exempt))
      virtual.set(
        i.ingredientId,
        (virtual.get(i.ingredientId) ?? 0) - i.amount,
      );
  if (!purchase && [...virtual.values()].some((n) => n < 0))
    throw new DomainError(
      "EARLIER_SHORTFALL",
      "先の献立の在庫が不足しています。在庫や買い物を確認してください",
      422,
    );
  const excluded = new Set([
    target.recipe.id,
    ...rejected.map((r) => r.recipe_id),
  ]);
  const used = ps
    .filter((p) => p.id !== id && p.status !== "skipped")
    .map((p) => p.recipe.id);
  const ranked = rankRecipes(
    catalog.filter((r) => r.slot === "dinner" && !excluded.has(r.id) && eligible(r, config, ings)),
    virtual,
    used,
    config,
    purchase,
  );
  // Stock-only replacements must also leave every later open dinner feasible.
  const feasible = ranked.filter((r) => {
    if (purchase) return true;
    const available = new Map(virtual),
      deficits = new Map<string, number>();
    allocate(r, available, deficits);
    for (const p of ps.filter(
      (p) =>
        p.local_date > target.local_date &&
        p.local_date <= cycleEnd(target.local_date, config.shoppingDays) &&
        p.status === "planned",
    ))
      allocate(p.recipe, available, deficits);
    return deficits.size === 0;
  });
  return {
    config,
    target,
    ps,
    stocks,
    virtual,
    purchase,
    cycle,
    cycles,
    feasible,
  };
}

export async function recipeCandidates(
  db: D1Database,
  id: string,
  version: number,
  allowPurchase: boolean,
  exclude: string[] = [],
): Promise<RecipeCandidates> {
  const context = await candidateContext(db, id, version, allowPurchase);
  const ranked = context.feasible.filter((r) => !exclude.includes(r.id));
  // Prefer different ingredient combinations before offering another seasoning variant.
  const groups = new Set<string>(),
    diverse: Recipe[] = [],
    remaining: Recipe[] = [];
  for (const recipe of ranked) {
    const group = recipe.items
      .filter((i) => !i.inventory_exempt)
      .map((i) => i.ingredientId)
      .sort()
      .join(",");
    if (groups.has(group)) remaining.push(recipe);
    else {
      groups.add(group);
      diverse.push(recipe);
    }
  }
  const ordered = [...diverse, ...remaining];
  return {
    planId: id,
    version,
    hasMore: ordered.length > 5,
    candidates: ordered.slice(0, 5).map((recipe) => ({
      recipe,
      missing: recipe.items
        .filter((i) => !i.inventory_exempt)
        .map((i) => ({
          ingredientId: i.ingredientId,
          name: i.name,
          unit: i.unit,
          amount: Math.max(
            0,
            i.amount - (context.virtual.get(i.ingredientId) ?? 0),
          ),
        }))
        .filter((i) => i.amount > 0),
    })),
  };
}

export async function selectRecipe(
  db: D1Database,
  id: string,
  version: number,
  recipeId: string,
  allowPurchase: boolean,
) {
  const context = await candidateContext(db, id, version, allowPurchase);
  const recipe = context.feasible.find((r) => r.id === recipeId);
  if (!recipe)
    throw new DomainError(
      "INVALID_CANDIDATE",
      "この候補は現在の条件で選べません。候補を再取得してください",
      422,
    );
  const nextPlans = context.ps.map((p) =>
    p.id === id ? { ...p, recipe, version: p.version + 1 } : p,
  );
  const newCycle =
    context.purchase && (!context.cycle || context.cycle.status === "confirmed")
      ? {
          kind: "run" as const,
          id: "run_" + crypto.randomUUID(),
          starts_on: context.target.local_date,
          ends_on: cycleEnd(
            context.target.local_date,
            context.config.shoppingDays,
          ),
          shopping_on: context.target.local_date,
          status: "review" as const,
          version: 0,
          obsolete: 0,
          shopping_days_json: JSON.stringify(
            [...context.config.shoppingDays].sort(),
          ),
        }
      : undefined;
  const projections = await reconcileShopping(db, {
    projectedPlans: nextPlans,
    newCycle,
  });
  await atomic(db, [
    guard(
      db,
      "EXISTS(SELECT 1 FROM app_settings WHERE version=?)",
      context.config.version,
    ),
    guard(db, "(SELECT COUNT(*) FROM meal_plans)=?", context.ps.length),
    ...context.ps.map((p) =>
      guard(
        db,
        "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=?)",
        p.id,
        p.version,
      ),
    ),
    ...context.cycles.map((c) =>
      guard(
        db,
        `EXISTS(SELECT 1 FROM ${cycleTable(c)} WHERE id=? AND version=? AND obsolete=0)`,
        c.id,
        c.version,
      ),
    ),
    ...context.stocks.map((s) =>
      guard(
        db,
        "EXISTS(SELECT 1 FROM inventory_stocks WHERE ingredient_id=? AND version=?)",
        s.id,
        s.version,
      ),
    ),
    ...projections,
    guard(
      db,
      "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=? AND status='planned')",
      id,
      version,
    ),
    stmt(
      db,
      "INSERT INTO plan_recipe_rejections(plan_id,recipe_id) VALUES (?,?)",
      id,
      context.target.recipe.id,
    ),
    stmt(db, "UPDATE meal_plans SET version=version+1 WHERE id=?", id),
    stmt(db, "DELETE FROM meal_plan_dishes WHERE plan_id=?", id),
    stmt(
      db,
      "INSERT INTO meal_plan_dishes(id,plan_id,recipe_id) VALUES (?,?,?)",
      crypto.randomUUID(),
      id,
      recipeId,
    ),
  ]);
  return { ok: true };
}

/** Explicit 'shop today': preserve existing dinners and all completed purchases. */
export async function prepareShoppingToday(db: D1Database) {
  const start = tokyoDate();
  const [config, stocks, catalog, ps, ings, cycles] = await Promise.all([
    settings(db),
    inventory(db),
    recipes(db),
    plans(db),
    ingredients(db),
    cycleEntries(db),
  ]);
  const end = cycleEnd(start, config.shoppingDays);
  const pending = cycles.find(
    (c) =>
      c.kind === "run" &&
      c.status === "review" &&
      c.starts_on === start &&
      currentSchedule(c, config.shoppingDays),
  );
  // Keep old proposals for audit, but never project or confirm an overlapping list twice.
  const obsoleteCycles = cycles
    .filter(
      (c) =>
        c.status === "review" &&
        !c.obsolete &&
        c.id !== pending?.id &&
        (!currentSchedule(c, config.shoppingDays) ||
          c.ends_on < start ||
          (c.starts_on <= end && c.ends_on >= start)),
    )
    .map((c) => c.id);
  const nextPlans = [...ps];
  const virtual = new Map(stocks.map((s) => [s.id, s.quantity]));
  const deficits = new Map<string, number>();
  const valid = catalog.filter((r) => r.slot === "dinner" && eligible(r, config, ings));
  const used = ps.filter((p) => p.local_date >= start).map((p) => p.recipe.id);
  const mutations: D1PreparedStatement[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const existing = ps.find((p) => p.local_date === date);
    if (existing) {
      if (["planned", "draft"].includes(existing.status))
        allocate(existing.recipe, virtual, deficits);
      continue;
    }
    const recipe = chooseRecipe(valid, virtual, used, config, true);
    allocate(recipe, virtual, deficits);
    used.push(recipe.id);
    const id = crypto.randomUUID();
    nextPlans.push({
      id,
      local_date: date,
      status: "planned",
      version: 0,
      recipe,
    });
    mutations.push(
      stmt(
        db,
        "INSERT INTO meal_plans(id,local_date,status) VALUES (?,?,'planned')",
        id,
        date,
      ),
      stmt(
        db,
        "INSERT INTO meal_plan_dishes(id,plan_id,recipe_id) VALUES (?,?,?)",
        crypto.randomUUID(),
        id,
        recipe.id,
      ),
    );
  }
  const newCycle: Omit<Cycle, "items"> | undefined = pending
    ? undefined
    : {
        kind: "run",
        id: "run_" + crypto.randomUUID(),
        starts_on: start,
        ends_on: end,
        shopping_on: start,
        status: "review",
        version: 0,
        obsolete: 0,
        shopping_days_json: JSON.stringify([...config.shoppingDays].sort()),
      };
  const projections = await reconcileShopping(db, {
    projectedPlans: nextPlans.sort((a, b) =>
      a.local_date.localeCompare(b.local_date),
    ),
    obsoleteCycles,
    newCycle,
  });
  await atomic(db, [
    guard(
      db,
      "EXISTS(SELECT 1 FROM app_settings WHERE version=?)",
      config.version,
    ),
    guard(db, "(SELECT COUNT(*) FROM meal_plans)=?", ps.length),
    ...ps.map((p) =>
      guard(
        db,
        "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=?)",
        p.id,
        p.version,
      ),
    ),
    ...stocks.map((s) =>
      guard(
        db,
        "EXISTS(SELECT 1 FROM inventory_stocks WHERE ingredient_id=? AND version=?)",
        s.id,
        s.version,
      ),
    ),
    ...cycles.map((c) =>
      guard(
        db,
        `EXISTS(SELECT 1 FROM ${cycleTable(c)} WHERE id=? AND version=?)`,
        c.id,
        c.version,
      ),
    ),
    ...projections,
    ...mutations,
  ]);
  return shopping(db, start);
}

export async function slotPlans(db: D1Database): Promise<SlotPlan[]> {
  const [rs, catalog] = await Promise.all([
    rows<Omit<SlotPlan, "recipe">>(
      db,
      "SELECT id, local_date, slot, status, version, recipe_id FROM meal_slot_plans ORDER BY local_date, slot",
    ),
    recipes(db),
  ]);
  const byId = new Map(catalog.map((r) => [r.id, r]));
  return rs.map((r) => {
    const recipe = byId.get(
      (r as unknown as { recipe_id: string }).recipe_id,
    );
    if (!recipe)
      throw new DomainError("INVALID_RECIPE", "レシピがありません", 422);
    return {
      id: r.id,
      local_date: r.local_date,
      slot: r.slot,
      status: r.status,
      version: r.version,
      recipe,
    };
  });
}

const SLOT_ORDER: SlotPlanSlot[] = [
  "morning_drink",
  "lunch",
  "snack",
  "night_snack",
];

/**
 * Generate the non-dinner slots for one shopping cycle. Dinner stays in
 * meal_plans; its planned recipes reserve virtual stock here in date order.
 * Existing slot plans are preserved, completed/skipped dinners keep their
 * reservations out, and shopping deficits are reconciled afterwards so the
 * shopping list covers the whole day, not only dinner.
 */
export async function generateDayPlans(
  db: D1Database,
  start: string,
  includeMorningDrink: boolean,
) {
  const [s, stocks, catalog, ings, dinners, existing] = await Promise.all([
    settings(db),
    inventory(db),
    recipes(db),
    ingredients(db),
    plans(db),
    slotPlans(db),
  ]);
  const end = cycleEnd(start, s.shoppingDays);
  // Same rule as dinner generation: purchases may be assumed on a shopping
  // day, otherwise the day must be coverable from stock alone.
  const allowPurchase = s.shoppingDays.includes(
    new Date(start + "T00:00:00Z").getUTCDay(),
  );
  const virtual = new Map(stocks.map((i) => [i.id, i.quantity]));
  const deficits = new Map<string, number>();
  const reserve = (recipe: Recipe) => allocate(recipe, virtual, deficits);
  const used: string[] = [];
  for (const p of dinners.filter(
    (p) =>
      p.local_date >= tokyoDate() &&
      p.local_date < start &&
      ["draft", "planned"].includes(p.status),
  )) {
    reserve(p.recipe);
    used.push(p.recipe.id);
  }
  for (const sp of existing.filter(
    (sp) =>
      sp.local_date >= tokyoDate() &&
      sp.local_date < start &&
      sp.status === "planned",
  )) {
    reserve(sp.recipe);
    used.push(sp.recipe.id);
  }
  const slots = SLOT_ORDER.filter(
    (slot) => includeMorningDrink || slot !== "morning_drink",
  );
  const inserts: D1PreparedStatement[] = [];
  const created: { date: string; slot: SlotPlanSlot; recipe: Recipe }[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    for (const slot of slots) {
      const kept = existing.find(
        (sp) => sp.local_date === date && sp.slot === slot,
      );
      if (kept) {
        if (kept.status === "planned") reserve(kept.recipe);
        used.push(kept.recipe.id);
        if (slot === "snack") {
          const dinner = dinners.find((p) => p.local_date === date);
          if (dinner && ["draft", "planned"].includes(dinner.status))
            reserve(dinner.recipe);
        }
        continue;
      }
      const recipe = chooseSlotRecipe(
        catalog.filter((r) => r.slot === slot && eligible(r, s, ings)),
        virtual,
        used,
        slotTargetFor(s, slot),
        allowPurchase,
      );
      reserve(recipe);
      used.push(recipe.id);
      const id = crypto.randomUUID();
      created.push({ date, slot, recipe });
      inserts.push(
        stmt(
          db,
          "INSERT INTO meal_slot_plans(id,local_date,slot,recipe_id) VALUES (?,?,?,?)",
          id,
          date,
          slot,
          recipe.id,
        ),
      );
      if (slot === "snack") {
        const dinner = dinners.find((p) => p.local_date === date);
        if (dinner && ["draft", "planned"].includes(dinner.status))
          reserve(dinner.recipe);
      }
    }
  }
  if (inserts.length) {
    await atomic(db, [
      guard(db, "EXISTS(SELECT 1 FROM app_settings WHERE version=?)", s.version),
      guard(db, "(SELECT COUNT(*) FROM meal_slot_plans)=?", existing.length),
      ...existing.map((sp) =>
        guard(
          db,
          "EXISTS(SELECT 1 FROM meal_slot_plans WHERE id=? AND version=?)",
          sp.id,
          sp.version,
        ),
      ),
      ...inserts,
    ]);
    const projections = await reconcileShopping(db);
    await atomic(db, projections);
  }
  return {
    startDate: start,
    endDate: end,
    created: created.length,
    slotPlans: (await slotPlans(db)).filter(
      (sp) => sp.local_date >= start && sp.local_date <= end,
    ),
  };
}

/** Latest confirmed unit price (yen per canonical unit) per ingredient. */
export async function latestUnitPrices(db: D1Database) {
  let priced: {
    ingredient_id: string;
    price_yen: number;
    amount: number;
    day: string;
  }[] = [];
  try {
    priced = await rows(
      db,
      `SELECT pp.ingredient_id AS ingredient_id, pp.price_yen AS price_yen,
              COALESCE(si.actual_amount, ri.actual_amount) AS amount,
              COALESCE(c.shopping_on, r.shopping_on) AS day
       FROM purchase_prices pp
       LEFT JOIN shopping_cycles c ON c.id = pp.cycle_id
       LEFT JOIN shopping_runs r ON r.id = pp.cycle_id
       LEFT JOIN shopping_items si ON si.cycle_id = pp.cycle_id AND si.ingredient_id = pp.ingredient_id
       LEFT JOIN shopping_run_items ri ON ri.cycle_id = pp.cycle_id AND ri.ingredient_id = pp.ingredient_id
       ORDER BY day DESC`,
    );
  } catch {
    priced = [];
  }
  const latest = new Map<string, number>();
  for (const row of priced) {
    if (!row.amount || latest.has(row.ingredient_id)) continue;
    latest.set(row.ingredient_id, row.price_yen / row.amount);
  }
  return latest;
}

export async function costSummary(
  db: D1Database,
  month: string,
): Promise<CostSummary> {
  const config = await settings(db);
  let spendRows: { day: string; yen: number }[] = [];
  try {
    spendRows = await rows(
      db,
      `SELECT COALESCE(c.shopping_on, r.shopping_on) AS day,
              SUM(pp.price_yen) AS yen
       FROM purchase_prices pp
       LEFT JOIN shopping_cycles c ON c.id = pp.cycle_id
       LEFT JOIN shopping_runs r ON r.id = pp.cycle_id
       GROUP BY day ORDER BY day`,
    );
  } catch {
    spendRows = [];
  }
  const inMonth = spendRows.filter((r) => r.day?.startsWith(month));
  const spentYen = inMonth.reduce((sum, r) => sum + Number(r.yen ?? 0), 0);
  const perDay = new Map<string, number>();
  for (const r of inMonth)
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + Number(r.yen));
  const prices = await latestUnitPrices(db);
  const today = tokyoDate();
  const [dinnerPlans, sps] = await Promise.all([plans(db), slotPlans(db).catch(() => [] as SlotPlan[])]);
  const todaysRecipes: Recipe[] = [];
  const dinner = dinnerPlans.find(
    (p) => p.local_date === today && p.status !== "skipped",
  );
  if (dinner) todaysRecipes.push(dinner.recipe);
  for (const sp of sps)
    if (sp.local_date === today && sp.status !== "skipped")
      todaysRecipes.push(sp.recipe);
  let estimated = 0;
  const unknown = new Set<string>();
  for (const recipe of todaysRecipes)
    for (const item of recipe.items.filter((i) => !i.inventory_exempt)) {
      const unit = prices.get(item.ingredientId);
      if (unit === undefined) unknown.add(item.name);
      else estimated += item.amount * unit;
    }
  return {
    month,
    budgetYen: config.monthlyBudgetYen,
    spentYen,
    remainingYen: config.monthlyBudgetYen - spentYen,
    perDayYen: [...perDay].map(([date, yen]) => ({ date, yen })),
    today: {
      date: today,
      estimatedYen: Math.round(estimated),
      unknownIngredients: [...unknown],
    },
    priceCaps: PRICE_CAPS,
  };
}

/** Price rows are only written for items that carry an explicit price. */
export function purchasePriceStatements(
  db: D1Database,
  cycleId: string,
  items: { ingredientId: string; priceYen?: number }[],
) {
  return items
    .filter((i) => i.priceYen !== undefined)
    .map((i) =>
      stmt(
        db,
        "INSERT INTO purchase_prices(cycle_id,ingredient_id,price_yen) VALUES (?,?,?) ON CONFLICT(cycle_id,ingredient_id) DO UPDATE SET price_yen=excluded.price_yen",
        cycleId,
        i.ingredientId,
        i.priceYen!,
      ),
    );
}
