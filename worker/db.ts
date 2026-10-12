import type {
  Ingredient,
  Stock,
  Recipe,
  Settings,
  Plan,
  Cycle,
  ShoppingItem,
  RecipeCandidates,
} from "./contracts";
import { recipeItem, renderInstructions } from "./recipe";
import {
  DomainError,
  nutrition,
  addDays,
  cycleEnd,
  eligible,
  chooseRecipe,
  allocate,
  tokyoDate,
  currentSchedule,
  nextShoppingDate,
  rankRecipes,
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
export async function shopping(
  db: D1Database,
  date: string,
): Promise<Cycle | null> {
  const config = await settings(db);
  const cycles = await rows<Omit<Cycle, "items">>(
    db,
    "SELECT * FROM shopping_cycles WHERE obsolete=0 ORDER BY shopping_on",
  );
  const next = nextShoppingDate(date, config.shoppingDays);
  const cycle =
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
  const items = await rows<ShoppingItem>(
    db,
    "SELECT si.*,i.name FROM shopping_items si JOIN ingredients i ON i.id=si.ingredient_id WHERE cycle_id=? AND i.inventory_exempt=0 ORDER BY i.name",
    cycle.id,
  );
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
    rows<Omit<Cycle, "items">>(
      db,
      "SELECT * FROM shopping_cycles WHERE status='review' ORDER BY starts_on",
    ),
    settings(db),
  ]);
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
      "(SELECT COUNT(*) FROM shopping_cycles WHERE status='review')=?",
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
        "EXISTS(SELECT 1 FROM shopping_cycles WHERE id=? AND version=? AND status='review')",
        c.id,
        c.version,
      ),
    );
  for (const id of options.obsoleteCycles ?? [])
    statements.push(
      stmt(
        db,
        "UPDATE shopping_cycles SET obsolete=1,version=version+1 WHERE id=? AND status='review'",
        id,
      ),
    );
  if (options.newCycle) {
    const n = options.newCycle;
    const previous = await stmt(
      db,
      "SELECT * FROM shopping_cycles WHERE starts_on=?",
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
          "EXISTS(SELECT 1 FROM shopping_cycles WHERE id=? AND version=? AND status='review')",
          previous.id,
          previous.version,
        ),
      );
      statements.push(
        stmt(
          db,
          "UPDATE shopping_cycles SET ends_on=?,shopping_on=?,shopping_days_json=?,obsolete=0,version=? WHERE id=?",
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
          "INSERT INTO shopping_cycles(id,starts_on,ends_on,shopping_on,status,shopping_days_json) VALUES (?,?,?,?,'review',?)",
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
    for (const p of (options.projectedPlans ?? ps).filter(
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
        "EXISTS(SELECT 1 FROM shopping_cycles WHERE id=? AND version=? AND status='review' AND obsolete=0)",
        cycle.id,
        cycle.version,
      ),
      stmt(
        db,
        "DELETE FROM shopping_items WHERE cycle_id=? AND ingredient_id IN (SELECT id FROM ingredients WHERE inventory_exempt=0)",
        cycle.id,
      ),
      stmt(
        db,
        "UPDATE shopping_cycles SET version=version+1 WHERE id=?",
        cycle.id,
      ),
    );
    for (const [ingredient, amount] of deficits) {
      const stock = stocks.find((s) => s.id === ingredient)!;
      statements.push(
        stmt(
          db,
          "INSERT INTO shopping_items(id,cycle_id,ingredient_id,requested_amount,proposed_amount,unit,status) VALUES (?,?,?,?,?,?,'review')",
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
  const valid = catalog.filter((r) => eligible(r, s, ings));
  const virtual = new Map(stocks.map((i) => [i.id, i.quantity]));
  const reviewCycles = await rows<Cycle>(
    db,
    "SELECT * FROM shopping_cycles WHERE status='review' AND obsolete=0",
  );
  for (const cycle of reviewCycles.filter(
    (c) =>
      currentSchedule(c, s.shoppingDays) &&
      c.ends_on < start &&
      c.shopping_on >= tokyoDate(),
  )) {
    const earlierPurchases = await rows<{
      ingredient_id: string;
      proposed_amount: number;
    }>(
      db,
      "SELECT si.* FROM shopping_items si JOIN ingredients i ON i.id=si.ingredient_id WHERE cycle_id=? AND i.inventory_exempt=0",
      cycle.id,
    );
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
  const cycle = (
    await rows<Omit<Cycle, "items">>(
      db,
      "SELECT * FROM shopping_cycles WHERE starts_on<=? AND ends_on>=? AND obsolete=0 ORDER BY starts_on DESC",
      start,
      start,
    )
  ).find((c) => currentSchedule(c, s.shoppingDays));
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
      rows<Omit<Cycle, "items">>(
        db,
        "SELECT * FROM shopping_cycles WHERE obsolete=0",
      ),
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
  const cycle = active.find(
    (c) => c.starts_on <= target.local_date && c.ends_on >= target.local_date,
  );
  const purchase =
    cycle?.status === "confirmed"
      ? false
      : allowPurchase ||
        !!(cycle?.status === "review" && cycle.shopping_on >= tokyoDate());
  const virtual = new Map(stocks.map((s) => [s.id, s.quantity]));
  for (const c of active.filter(
    (c) =>
      c.status === "review" &&
      c.ends_on < target.local_date &&
      c.shopping_on >= tokyoDate(),
  )) {
    for (const i of await rows<{
      ingredient_id: string;
      proposed_amount: number;
    }>(
      db,
      "SELECT si.* FROM shopping_items si JOIN ingredients i ON i.id=si.ingredient_id WHERE cycle_id=? AND i.inventory_exempt=0",
      c.id,
    ))
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
    catalog.filter((r) => !excluded.has(r.id) && eligible(r, config, ings)),
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
  return { config, target, ps, stocks, virtual, purchase, cycle, feasible };
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
    context.purchase && !context.cycle
      ? {
          id: crypto.randomUUID(),
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
