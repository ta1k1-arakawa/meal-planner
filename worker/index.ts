import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { z, ZodError } from "zod";
import {
  adjustSchema,
  completeSchema,
  purchaseSchema,
  generateSchema,
  versionSchema,
  candidatesSchema,
  selectRecipeSchema,
  settingsSchema,
  dateSchema,
  type RecipeItem,
  type AmountItem,
  type NutritionSummary,
} from "./contracts";
import {
  DomainError,
  tokyoDate,
  addDays,
  nutrition,
  sameShoppingDays,
  nextShoppingDate,
  cycleEnd,
  currentSchedule,
} from "./planner";
import * as db from "./db";
import { actualItems, recipeItem } from "./recipe";
export interface Env {
  DB: D1Database;
  APP_PASSWORD: string;
  ASSETS: Fetcher;
}
const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) => {
  if (error instanceof ZodError)
    return c.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "入力を確認してください",
          details: error.issues,
        },
      },
      400,
    );
  if (error instanceof DomainError)
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      error.status,
    );
  if (error instanceof SyntaxError)
    return c.json(
      {
        error: { code: "INVALID_JSON", message: "JSON入力を確認してください" },
      },
      400,
    );
  console.error("API failure", error.name);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "処理に失敗しました。時間を置いて再試行してください",
      },
    },
    500,
  );
});
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.env.APP_PASSWORD || c.env.APP_PASSWORD.length < 32)
    throw new DomainError(
      "AUTH_NOT_CONFIGURED",
      "サーバーの認証設定が必要です",
      503,
    );
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin)
      throw new DomainError(
        "INVALID_ORIGIN",
        "この送信元は許可されていません",
        403,
      );
    const declared = Number(c.req.header("Content-Length") ?? 0);
    if (declared > 65536)
      throw new DomainError("PAYLOAD_TOO_LARGE", "入力が大きすぎます", 422);
    // Read and bound actual body as well (Content-Length can be absent or forged).
    if (new TextEncoder().encode(await c.req.raw.clone().text()).length > 65536)
      throw new DomainError("PAYLOAD_TOO_LARGE", "入力が大きすぎます", 422);
    if (
      c.req.method !== "DELETE" &&
      !c.req.header("Content-Type")?.startsWith("application/json")
    )
      throw new DomainError("JSON_REQUIRED", "JSONで送信してください", 400);
  }
  if (c.req.path === "/api/auth/login") return next();
  const token = getCookie(c, "dinner_session");
  try {
    if (!token) throw new Error("missing");
    await verify(token, c.env.APP_PASSWORD, "HS256");
  } catch {
    throw new DomainError("UNAUTHENTICATED", "ログインしてください", 401);
  }
  await next();
});
app.post("/api/auth/login", async (c) => {
  const { password } = z
    .object({ password: z.string().max(512) })
    .strict()
    .parse(await c.req.json());
  const enc = new TextEncoder();
  const hash = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  const [a, b] = await Promise.all([hash(password), hash(c.env.APP_PASSWORD)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference)
    throw new DomainError("BAD_PASSWORD", "パスワードが違います", 401);
  const token = await sign(
    { sub: "owner", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12 },
    c.env.APP_PASSWORD,
    "HS256",
  );
  setCookie(c, "dinner_session", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/api",
    maxAge: 43200,
  });
  return c.json({ ok: true });
});
app.post("/api/auth/logout", (c) => {
  deleteCookie(c, "dinner_session", { path: "/api" });
  return c.json({ ok: true });
});
app.get("/api/inventory", async (c) => c.json(await db.inventory(c.env.DB)));
app.get("/api/ingredients", async (c) =>
  c.json(await db.ingredients(c.env.DB)),
);
app.get("/api/inventory/movements", async (c) =>
  c.json(
    await db.rows(
      c.env.DB,
      "SELECT m.*,i.name,i.unit FROM inventory_movements m JOIN ingredients i ON i.id=m.ingredient_id ORDER BY m.created_at DESC LIMIT 100",
    ),
  ),
);
app.put("/api/ingredients/:id/conversion", async (c) => {
  const b = z
    .object({
      displayUnit: z.string().min(1).max(20),
      amountPerUnit: z.number().int().min(1).max(100000),
    })
    .strict()
    .parse(await c.req.json());
  if (
    !(await db
      .stmt(
        c.env.DB,
        "SELECT id FROM ingredients WHERE id=? AND inventory_exempt=0",
        c.req.param("id"),
      )
      .first())
  )
    throw new DomainError("NOT_FOUND", "食材がありません", 404);
  await db.atomic(c.env.DB, [
    db.stmt(
      c.env.DB,
      "UPDATE ingredients SET display_unit=?,grams_per_display_unit=? WHERE id=?",
      b.displayUnit,
      b.amountPerUnit,
      c.req.param("id"),
    ),
    db.stmt(
      c.env.DB,
      "UPDATE inventory_stocks SET version=version+1 WHERE ingredient_id=?",
      c.req.param("id"),
    ),
  ]);
  return c.json({ ok: true });
});
app.post("/api/inventory/adjust", async (c) => {
  const body = adjustSchema.parse(await c.req.json());
  const payload = JSON.stringify(body);
  const old = await db.replay(c.env.DB, body.idempotencyKey, "adjust", payload);
  if (old) return c.json({ operationId: old });
  const ing = (await db.inventory(c.env.DB)).find(
    (i) => i.id === body.ingredientId,
  );
  const retried = await db.replay(
    c.env.DB,
    body.idempotencyKey,
    "adjust",
    payload,
  );
  if (retried) return c.json({ operationId: retried });
  if (!ing)
    throw new DomainError("UNKNOWN_INGREDIENT", "食材がありません", 422);
  if (body.displayUnit && !ing.grams_per_display_unit)
    throw new DomainError(
      "NO_CONVERSION",
      "この食材の個数換算は未設定です",
      422,
    );
  const delta =
    body.delta * (body.displayUnit ? ing.grams_per_display_unit! : 1);
  if (Math.abs(delta) > 1000000)
    throw new DomainError("INVALID_AMOUNT", "数量が大きすぎます", 422);
  if (ing.quantity + delta < 0)
    throw new DomainError("INSUFFICIENT_STOCK", "在庫が不足しています", 409);
  const id = crypto.randomUUID();
  const projections = await db.reconcileShopping(c.env.DB, {
    stockDeltas: new Map([[ing.id, delta]]),
  });
  const result = await db.idempotentBatch(
    c.env.DB,
    body.idempotencyKey,
    "adjust",
    payload,
    id,
    [
      ...projections,
      db.guard(
        c.env.DB,
        "EXISTS(SELECT 1 FROM inventory_stocks WHERE ingredient_id=? AND version=?)",
        ing.id,
        body.version,
      ),
      db.movement(
        c.env.DB,
        ing.id,
        delta,
        delta > 0 ? "manual_adjustment" : "correction",
        id,
        body.idempotencyKey,
      ),
    ],
  );
  return c.json({ operationId: result });
});
app.get("/api/recipes", async (c) => c.json(await db.recipes(c.env.DB)));
app.get("/api/plans", async (c) => c.json(await db.plans(c.env.DB)));
app.post("/api/plans/generate", async (c) => {
  const b = generateSchema.parse(await c.req.json());
  if (b.startDate < tokyoDate() || b.startDate > addDays(tokyoDate(), 7))
    throw new DomainError(
      "INVALID_DATE",
      "今日から7日以内の日付を指定してください",
      422,
    );
  return c.json(await db.generate(c.env.DB, b.startDate, b.allowPurchase));
});
app.post("/api/plans/:id/candidates", async (c) => {
  const b = candidatesSchema.parse(await c.req.json());
  return c.json(
    await db.recipeCandidates(
      c.env.DB,
      c.req.param("id"),
      b.version,
      b.allowPurchase,
      b.exclude,
    ),
  );
});
app.post("/api/plans/:id/regenerate", async (c) => {
  const b = selectRecipeSchema.parse(await c.req.json());
  return c.json(
    await db.selectRecipe(
      c.env.DB,
      c.req.param("id"),
      b.version,
      b.recipeId,
      b.allowPurchase,
    ),
  );
});
app.post("/api/plans/:id/skip", async (c) => {
  const { version } = versionSchema.parse(await c.req.json());
  const id = c.req.param("id");
  const projections = await db.reconcileShopping(c.env.DB, { skipPlan: id });
  await db.atomic(c.env.DB, [
    ...projections,
    db.guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=? AND status IN ('draft','planned'))",
      id,
      version,
    ),
    db.stmt(
      c.env.DB,
      "UPDATE meal_plans SET status='skipped',version=version+1 WHERE id=?",
      id,
    ),
  ]);
  return c.json({ ok: true });
});
app.post("/api/plans/:id/unskip", async (c) => {
  const { version } = versionSchema.parse(await c.req.json());
  return c.json(await db.unskip(c.env.DB, c.req.param("id"), version));
});
app.post("/api/plans/:id/complete", async (c) => {
  const body = completeSchema.parse(await c.req.json());
  const planId = c.req.param("id");
  const payload = JSON.stringify({ planId, ...body });
  const old = await db.replay(
    c.env.DB,
    body.idempotencyKey,
    "complete",
    payload,
  );
  if (old)
    return c.json(
      await db
        .stmt(c.env.DB, "SELECT * FROM meal_logs WHERE id=?", old)
        .first(),
    );
  const [ps, ings, stock] = await Promise.all([
    db.plans(c.env.DB),
    db.ingredients(c.env.DB),
    db.inventory(c.env.DB),
  ]);
  const retried = await db.replay(
    c.env.DB,
    body.idempotencyKey,
    "complete",
    payload,
  );
  if (retried)
    return c.json(
      await db
        .stmt(c.env.DB, "SELECT * FROM meal_logs WHERE id=?", retried)
        .first(),
    );
  const plan = ps.find((p) => p.id === planId);
  if (!plan) throw new DomainError("NOT_FOUND", "献立がありません", 404);
  if (plan.status !== "planned" || plan.version !== body.version)
    throw new DomainError(
      "PLAN_CONFLICT",
      "この献立は更新済みか完了しています",
      409,
    );
  if (plan.local_date > tokyoDate())
    throw new DomainError("FUTURE_MEAL", "未来の夕食はまだ完了できません", 422);
  const items = actualItems(body.items, plan.recipe.items, ings);
  const shortages = body.items.filter(
    (i) =>
      i.amount > (stock.find((s) => s.id === i.ingredientId)?.quantity ?? 0),
  );
  if (shortages.length)
    throw new DomainError(
      "INSUFFICIENT_STOCK",
      "在庫が不足しています。在庫補正または使用量を変更してください",
      409,
      shortages,
    );
  const totals = nutrition(items, ings);
  const logId = crypto.randomUUID();
  const projections = await db.reconcileShopping(c.env.DB, {
    skipPlan: planId,
    stockDeltas: new Map(body.items.map((i) => [i.ingredientId, -i.amount])),
  });
  const statements = [
    ...projections,
    db.guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM meal_plans WHERE id=? AND version=? AND status='planned')",
      planId,
      body.version,
    ),
    db.stmt(
      c.env.DB,
      "UPDATE meal_plans SET status='completed',version=version+1 WHERE id=?",
      planId,
    ),
    db.stmt(
      c.env.DB,
      "INSERT INTO meal_logs(id,plan_id,total_kcal,total_protein_g,recipe_snapshot,idempotency_key) VALUES (?,?,?,?,?,?)",
      logId,
      planId,
      totals.kcal,
      totals.protein,
      JSON.stringify(plan.recipe),
      body.idempotencyKey,
    ),
  ];
  for (const item of items) {
    const ing = ings.find((i) => i.id === item.ingredientId)!;
    statements.push(
      db.stmt(
        c.env.DB,
        "INSERT INTO meal_log_items(id,log_id,ingredient_id,ingredient_name,amount,unit,kcal,protein_g,source,food_code,state,amount_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        crypto.randomUUID(),
        logId,
        ing.id,
        ing.name,
        item.amount,
        ing.unit,
        (item.amount * ing.kcal_per_100) / 100,
        (item.amount * ing.protein_per_100) / 100,
        ing.source,
        ing.food_code,
        ing.state,
        ing.inventory_exempt === 1 ? "recipe_default" : "actual",
      ),
    );
    if (item.amount && ing.inventory_exempt !== 1)
      statements.push(
        db.movement(
          c.env.DB,
          ing.id,
          -item.amount,
          "meal_consumption",
          logId,
          body.idempotencyKey,
        ),
      );
  }
  const result = await db.idempotentBatch(
    c.env.DB,
    body.idempotencyKey,
    "complete",
    payload,
    logId,
    statements,
  );
  return c.json(
    await db
      .stmt(c.env.DB, "SELECT * FROM meal_logs WHERE id=?", result)
      .first(),
  );
});
app.get("/api/shopping/current", async (c) =>
  c.json(await db.shopping(c.env.DB, tokyoDate())),
);
app.post("/api/shopping/today", async (c) => {
  z.object({})
    .strict()
    .parse(await c.req.json());
  return c.json(await db.prepareShoppingToday(c.env.DB));
});
app.post("/api/shopping/:id/confirm", async (c) => {
  const b = purchaseSchema.parse(await c.req.json());
  const id = c.req.param("id");
  const payload = JSON.stringify({ id, ...b });
  const old = await db.replay(c.env.DB, b.idempotencyKey, "purchase", payload);
  if (old) return c.json({ cycleId: old });
  const cycle = await db.cycleById(c.env.DB, id);
  const retried = await db.replay(
    c.env.DB,
    b.idempotencyKey,
    "purchase",
    payload,
  );
  if (retried) return c.json({ cycleId: retried });
  if (!cycle)
    throw new DomainError("NOT_FOUND", "買い物リストがありません", 404);
  const currentSettings = await db.settings(c.env.DB);
  if (!currentSchedule(cycle, currentSettings.shoppingDays))
    throw new DomainError(
      "OBSOLETE_SHOPPING",
      "旧曜日の買い物リストは確定できません。設定画面から作り直してください",
      409,
    );
  if (cycle.status !== "review" || cycle.version !== b.version)
    throw new DomainError(
      "SHOPPING_CONFLICT",
      "買い物リストは変更済みか確定済みです",
      409,
    );
  const si = await db.cycleItems(c.env.DB, cycle);
  if (
    b.items.length !== si.length ||
    b.items.some((i) => !si.some((s) => s.ingredient_id === i.ingredientId))
  )
    throw new DomainError(
      "INVALID_ITEMS",
      "買い物リストの全項目を確認してください。購入しない食材は0を指定します",
      422,
    );
  const projections = await db.reconcileShopping(c.env.DB, {
    skipCycle: id,
    stockDeltas: new Map(b.items.map((i) => [i.ingredientId, i.amount])),
  });
  const statements = [
    ...projections,
    db.guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM app_settings WHERE version=?)",
      currentSettings.version,
    ),
    db.guard(
      c.env.DB,
      `EXISTS(SELECT 1 FROM ${db.cycleTable(cycle)} WHERE id=? AND version=? AND status='review' AND obsolete=0)`,
      id,
      b.version,
    ),
    db.stmt(
      c.env.DB,
      `UPDATE ${db.cycleTable(cycle)} SET status='confirmed',version=version+1,idempotency_key=? WHERE id=?`,
      b.idempotencyKey,
      id,
    ),
  ];
  for (const item of b.items) {
    statements.push(
      db.stmt(
        c.env.DB,
        `UPDATE ${db.cycleItemTable(cycle)} SET actual_amount=?,status='confirmed' WHERE cycle_id=? AND ingredient_id=?`,
        item.amount,
        id,
        item.ingredientId,
      ),
    );
    if (item.amount)
      statements.push(
        db.movement(
          c.env.DB,
          item.ingredientId,
          item.amount,
          "purchase",
          id,
          b.idempotencyKey,
        ),
      );
  }
  const result = await db.idempotentBatch(
    c.env.DB,
    b.idempotencyKey,
    "purchase",
    payload,
    id,
    statements,
  );
  return c.json({ cycleId: result });
});
app.get("/api/meal-logs", async (c) =>
  c.json(
    await db.rows(
      c.env.DB,
      "SELECT l.*,p.local_date FROM meal_logs l JOIN meal_plans p ON p.id=l.plan_id ORDER BY p.local_date DESC LIMIT 100",
    ),
  ),
);
app.get("/api/meal-logs/:id", async (c) => {
  const log = await db
    .stmt(c.env.DB, "SELECT * FROM meal_logs WHERE id=?", c.req.param("id"))
    .first();
  if (!log) throw new DomainError("NOT_FOUND", "記録がありません", 404);
  return c.json({
    ...log,
    items: await db.rows(
      c.env.DB,
      "SELECT * FROM meal_log_items WHERE log_id=?",
      c.req.param("id"),
    ),
    corrections: await db.rows(
      c.env.DB,
      "SELECT * FROM meal_log_corrections WHERE log_id=? ORDER BY version",
      c.req.param("id"),
    ),
  });
});
app.post("/api/meal-logs/:id/correct", async (c) => {
  const body = completeSchema.parse(await c.req.json());
  const logId = c.req.param("id");
  const payload = JSON.stringify({ logId, ...body });
  const old = await db.replay(
    c.env.DB,
    body.idempotencyKey,
    "correction",
    payload,
  );
  if (old)
    return c.json(
      await db
        .stmt(c.env.DB, "SELECT * FROM meal_log_corrections WHERE id=?", old)
        .first(),
    );
  const log = await db
    .stmt(c.env.DB, "SELECT * FROM meal_logs WHERE id=?", logId)
    .first<{ recipe_snapshot: string }>();
  if (!log) throw new DomainError("NOT_FOUND", "記録がありません", 404);
  const latest = await db
    .stmt(
      c.env.DB,
      "SELECT * FROM meal_log_corrections WHERE log_id=? ORDER BY version DESC LIMIT 1",
      logId,
    )
    .first<{ version: number; items_snapshot: string }>();
  const retried = await db.replay(
    c.env.DB,
    body.idempotencyKey,
    "correction",
    payload,
  );
  if (retried)
    return c.json(
      await db
        .stmt(
          c.env.DB,
          "SELECT * FROM meal_log_corrections WHERE id=?",
          retried,
        )
        .first(),
    );
  const version = latest?.version ?? 0;
  if (body.version !== version)
    throw new DomainError(
      "CORRECTION_CONFLICT",
      "記録はすでに訂正されています",
      409,
    );
  const initial = await db.rows<{
    ingredient_id: string;
    amount: number;
    kcal: number;
    protein_g: number;
    source: string;
    food_code: string;
    state: string;
  }>(c.env.DB, "SELECT * FROM meal_log_items WHERE log_id=?", logId);
  const previous: { ingredientId: string; amount: number }[] = latest
    ? JSON.parse(latest.items_snapshot)
    : initial.map((i) => ({ ingredientId: i.ingredient_id, amount: i.amount }));
  const ingredients = await db.ingredients(c.env.DB);
  const defaults: (AmountItem & Partial<RecipeItem>)[] = JSON.parse(
    log.recipe_snapshot,
  ).items;
  const items = actualItems(body.items, defaults, ingredients);
  const snapshotItems = items.map((item) => {
    const current = recipeItem(item, ingredients);
    if (!current.inventory_exempt) return current;
    const saved = defaults.find((i) => i.ingredientId === item.ingredientId);
    const oldLine = initial.find((i) => i.ingredient_id === item.ingredientId);
    return {
      ...current,
      name: saved?.name ?? current.name,
      unit: saved?.unit ?? current.unit,
      source: saved?.source ?? oldLine?.source ?? current.source,
      food_code: saved?.food_code ?? oldLine?.food_code ?? current.food_code,
      state: saved?.state ?? oldLine?.state ?? current.state,
      kcal_per_100:
        saved?.kcal_per_100 ??
        (oldLine && oldLine.amount > 0
          ? (oldLine.kcal * 100) / oldLine.amount
          : current.kcal_per_100),
      protein_per_100:
        saved?.protein_per_100 ??
        (oldLine && oldLine.amount > 0
          ? (oldLine.protein_g * 100) / oldLine.amount
          : current.protein_per_100),
    };
  });
  const totals = {
    kcal:
      Math.round(
        snapshotItems.reduce(
          (n, i) => n + (i.amount * i.kcal_per_100) / 100,
          0,
        ) * 10,
      ) / 10,
    protein:
      Math.round(
        snapshotItems.reduce(
          (n, i) => n + (i.amount * i.protein_per_100) / 100,
          0,
        ) * 10,
      ) / 10,
  };
  const id = crypto.randomUUID();
  const snapshot = snapshotItems.map((item) => ({
    ...item,
    kcal: (item.amount * item.kcal_per_100) / 100,
    protein: (item.amount * item.protein_per_100) / 100,
    amountSource: item.inventory_exempt ? "recipe_default" : "actual",
  }));
  const changes = new Map<string, number>();
  for (const ingredientId of new Set([
    ...previous.map((i) => i.ingredientId),
    ...body.items.map((i) => i.ingredientId),
  ])) {
    const delta =
      (previous.find((i) => i.ingredientId === ingredientId)?.amount ?? 0) -
      (body.items.find((i) => i.ingredientId === ingredientId)?.amount ?? 0);
    if (
      delta &&
      ingredients.find((i) => i.id === ingredientId)?.inventory_exempt !== 1
    )
      changes.set(ingredientId, delta);
  }
  const projections = await db.reconcileShopping(c.env.DB, {
    stockDeltas: changes,
  });
  const statements = [
    ...projections,
    db.guard(
      c.env.DB,
      "COALESCE((SELECT MAX(version) FROM meal_log_corrections WHERE log_id=?),0)=?",
      logId,
      body.version,
    ),
    db.stmt(
      c.env.DB,
      "INSERT INTO meal_log_corrections(id,log_id,version,items_snapshot,total_kcal,total_protein_g,idempotency_key) VALUES (?,?,?,?,?,?,?)",
      id,
      logId,
      version + 1,
      JSON.stringify(snapshot),
      totals.kcal,
      totals.protein,
      body.idempotencyKey,
    ),
    ...[...changes].map(([ingredientId, delta]) =>
      db.movement(
        c.env.DB,
        ingredientId,
        delta,
        "correction",
        id,
        body.idempotencyKey,
      ),
    ),
  ];
  const result = await db.idempotentBatch(
    c.env.DB,
    body.idempotencyKey,
    "correction",
    payload,
    id,
    statements,
  );
  return c.json(
    await db
      .stmt(c.env.DB, "SELECT * FROM meal_log_corrections WHERE id=?", result)
      .first(),
  );
});
app.get("/api/settings", async (c) => c.json(await db.settings(c.env.DB)));
app.put("/api/settings", async (c) => {
  const s = settingsSchema.parse(await c.req.json());
  const saved = await db.settings(c.env.DB);
  const reviewCycles = await db.cycleEntries(c.env.DB, "status='review'");
  const changed = !sameShoppingDays(saved.shoppingDays, s.shoppingDays);
  const stale = reviewCycles.filter(
    (c) => !c.obsolete && !currentSchedule(c, s.shoppingDays),
  );
  if (
    ((changed && reviewCycles.some((c) => !c.obsolete)) || stale.length) &&
    !s.discardPendingShopping
  )
    throw new DomainError(
      "SHOPPING_RESET_REQUIRED",
      "旧曜日の未確定リストを破棄し、新しい曜日で不足量を再計算する確認が必要です。献立・在庫・確定済み購入・食事記録は保持します",
      409,
      { pendingLists: reviewCycles.filter((c) => !c.obsolete).length },
    );
  const reset = s.discardPendingShopping && (changed || stale.length > 0);
  const obsoleteCycles = reset
    ? reviewCycles.filter((c) => !c.obsolete).map((c) => c.id)
    : [];
  const start = nextShoppingDate(tokyoDate(), s.shoppingDays);
  const alreadyConfirmed = await db
    .stmt(
      c.env.DB,
      "SELECT id FROM shopping_cycles WHERE starts_on=? AND status='confirmed'",
      start,
    )
    .first();
  const newCycle =
    reset && !alreadyConfirmed
      ? {
          id: crypto.randomUUID(),
          starts_on: start,
          ends_on: cycleEnd(start, s.shoppingDays),
          shopping_on: start,
          status: "review" as const,
          version: 0,
          obsolete: 0,
          shopping_days_json: JSON.stringify([...s.shoppingDays].sort()),
        }
      : undefined;
  const projections = await db.reconcileShopping(c.env.DB, {
    settingsOverride: s,
    obsoleteCycles,
    newCycle,
  });
  await db.atomic(c.env.DB, [
    ...projections,
    db.guard(
      c.env.DB,
      "EXISTS(SELECT 1 FROM app_settings WHERE version=?)",
      s.version,
    ),
    db.stmt(
      c.env.DB,
      "UPDATE app_settings SET version=version+1,daily_kcal=?,daily_protein_g=?,dinner_kcal=?,dinner_protein_g=?,max_minutes=?,shopping_days_json=?,equipment_json=?,allergies_json=?,excluded_ingredients_json=? WHERE id=1",
      s.dailyKcal,
      s.dailyProtein,
      s.dinnerKcal,
      s.dinnerProtein,
      s.maxMinutes,
      JSON.stringify(s.shoppingDays),
      JSON.stringify(s.equipment),
      JSON.stringify(s.allergies),
      JSON.stringify(s.excludedIngredients),
    ),
  ]);
  return c.json(await db.settings(c.env.DB));
});
async function dailyNutrition(
  database: D1Database,
  date: string,
): Promise<NutritionSummary> {
  const entries = await db.rows<{
    meal_type: string;
    status: string;
    kcal: number;
    protein_g: number;
  }>(database, "SELECT * FROM daily_food_entries WHERE local_date=?", date);
  const log = await db
    .stmt(
      database,
      "SELECT COALESCE((SELECT total_kcal FROM meal_log_corrections WHERE log_id=l.id ORDER BY version DESC LIMIT 1),l.total_kcal) AS total_kcal,COALESCE((SELECT total_protein_g FROM meal_log_corrections WHERE log_id=l.id ORDER BY version DESC LIMIT 1),l.total_protein_g) AS total_protein_g FROM meal_logs l JOIN meal_plans p ON p.id=l.plan_id WHERE p.local_date=?",
      date,
    )
    .first<{ total_kcal: number; total_protein_g: number }>();
  const plan = (await db.plans(database)).find(
    (p) => p.local_date === date && p.status === "planned",
  );
  const presets = await db.rows<{
    id: string;
    kind: string;
    label: string;
    kcal: number;
    protein_g: number;
  }>(database, "SELECT * FROM food_presets WHERE enabled_by_default=1");
  const confirmed = {
    kcal: log?.total_kcal ?? 0,
    protein: log?.total_protein_g ?? 0,
  };
  const projected = {
    kcal: plan?.recipe.kcal ?? 0,
    protein: plan?.recipe.protein ?? 0,
  };
  for (const entry of entries) {
    const target = entry.status === "confirmed" ? confirmed : projected;
    target.kcal += entry.kcal;
    target.protein += entry.protein_g;
  }
  for (const preset of presets)
    if (!entries.some((e) => e.meal_type === preset.kind)) {
      projected.kcal += preset.kcal;
      projected.protein += preset.protein_g;
    }
  const unknown = ["breakfast", "lunch", "snack", "bedtime"].filter(
    (type) =>
      !entries.some((e) => e.meal_type === type && e.status === "confirmed"),
  );
  if (!log) unknown.push("dinner");
  return { confirmed, projected, unknown, presets };
}
app.get("/api/daily-nutrition", async (c) =>
  c.json(
    await dailyNutrition(
      c.env.DB,
      dateSchema.parse(c.req.query("date") ?? tokyoDate()),
    ),
  ),
);
app.put("/api/daily-food-entries/:date", async (c) => {
  const date = dateSchema.parse(c.req.param("date"));
  const entries = z
    .array(
      z
        .object({
          mealType: z.enum(["breakfast", "lunch", "snack", "bedtime"]),
          status: z.enum(["projected", "confirmed"]),
          kcal: z.number().min(0).max(10000),
          protein: z.number().min(0).max(1000),
        })
        .strict(),
    )
    .max(4)
    .refine((a) => new Set(a.map((e) => e.mealType)).size === a.length)
    .parse(await c.req.json());
  await db.atomic(c.env.DB, [
    db.stmt(
      c.env.DB,
      "DELETE FROM daily_food_entries WHERE local_date=?",
      date,
    ),
    ...entries.map((e) =>
      db.stmt(
        c.env.DB,
        "INSERT INTO daily_food_entries(id,local_date,meal_type,source,status,kcal,protein_g) VALUES (?,?,?,'manual',?,?,?)",
        crypto.randomUUID(),
        date,
        e.mealType,
        e.status,
        e.kcal,
        e.protein,
      ),
    ),
  ]);
  return c.json(await dailyNutrition(c.env.DB, date));
});
app.get("/api/today", async (c) => {
  const date = tokyoDate();
  return c.json({
    date,
    plan: (await db.plans(c.env.DB)).find((p) => p.local_date === date) ?? null,
    nutrition: await dailyNutrition(c.env.DB, date),
  });
});
app.all("/api/*", (c) =>
  c.json(
    { error: { code: "NOT_FOUND", message: "この機能は未実装です" } },
    404,
  ),
);
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
