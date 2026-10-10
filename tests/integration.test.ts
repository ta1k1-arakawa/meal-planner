import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecipeDetails } from "../src/RecipeDetails";
import { ingredients as loadIngredients } from "../worker/db";
import { eligible, nutrition } from "../worker/planner";
import type { RecipeItem } from "../worker/contracts";
import app, { type Env } from "../worker/index";
import { tokyoDate, cycleEnd, addDays } from "../worker/planner";
import type { Plan, Cycle, Stock, Settings } from "../worker/contracts";
let mf: Miniflare, database: D1Database, cookie: string, env: Env;
let databaseIndex = 0;
const managedItems = (recipe: Plan["recipe"]) =>
  recipe.items
    .filter((i) => !i.inventory_exempt)
    .map(({ ingredientId, amount }) => ({ ingredientId, amount }));
async function request(
  path: string,
  body?: unknown,
  method = "POST",
  auth = true,
) {
  return app.request(
    "https://dinner.test/api" + path,
    {
      method: body === undefined ? "GET" : method,
      headers: {
        ...(auth ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function get<T>(path: string): Promise<T> {
  const r = await request(path);
  expect(r.status).toBe(200);
  return r.json() as Promise<T>;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await request(path, body);
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json() as Promise<T>;
}
async function fill(amount = 10000) {
  const stocks = await get<Stock[]>("/inventory");
  for (const s of stocks)
    await post("/inventory/adjust", {
      ingredientId: s.id,
      delta: amount,
      version: s.version,
      idempotencyKey: crypto.randomUUID(),
    });
}
async function generation(allowPurchase = true) {
  await post("/plans/generate", { startDate: tokyoDate(), allowPurchase });
  return get<Plan[]>("/plans");
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    d1Databases: Array.from({ length: 30 }, (_, i) => "DB_" + i),
    compatibilityDate: "2026-08-01",
  });
  database = (await mf.getD1Database("DB_0")) as unknown as D1Database;
  env = {
    DB: database,
    APP_PASSWORD: "test-password-with-at-least-32-characters",
    ASSETS: { fetch: async () => new Response("app") } as unknown as Fetcher,
  };
  const response = await request(
    "/auth/login",
    { password: env.APP_PASSWORD },
    "POST",
    false,
  );
  expect(response.status).toBe(200);
  cookie = response.headers.get("Set-Cookie")!.split(";")[0];
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async (context) => {
  database = (await mf.getD1Database(
    "DB_" + databaseIndex++,
  )) as unknown as D1Database;
  env.DB = database;
  for (const file of [
    "0001_schema.sql",
    "0002_seed.sql",
    "0003_corrections.sql",
    "0004_pantry_recipe_details.sql",
  ]) {
    if (
      file.startsWith("0004") &&
      context.task.name.startsWith("upgrades populated")
    )
      continue;
    await applyMigration(file);
  }
});
async function applyMigration(file: string) {
  // D1 exec splits lines; individual prepared statements preserve trigger bodies.
  const sql = readFileSync(
    new URL("../migrations/" + file, import.meta.url),
    "utf8",
  );
  const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
  const plain = sql
    .replace(/--[^\n]*/g, "")
    .replace(/CREATE TRIGGER[\s\S]*?END;/g, "");
  const statements = [
    ...plain
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...triggers,
  ].map((sql) => database.prepare(sql));
  for (let i = 0; i < statements.length; i += 80)
    await database.batch(statements.slice(i, i + 80));
}
describe("private API and validation", () => {
  it("protects every private route, including unknown routes", async () => {
    for (const route of [
      "/today",
      "/plans",
      "/inventory",
      "/shopping/current",
      "/meal-logs",
      "/settings",
      "/daily-nutrition",
      "/not-real",
    ])
      expect((await request(route, undefined, "GET", false)).status).toBe(401);
    expect(
      (await request("/auth/login", { password: "bad" }, "POST", false)).status,
    ).toBe(401);
  });
  it("rejects cross-origin writes and invalid inputs without stock mutation", async () => {
    const response = await app.request(
      "https://dinner.test/api/inventory/adjust",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://attacker.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(
      (
        await request("/inventory/adjust", {
          ingredientId: "rice",
          delta: 0.5,
          version: 0,
          idempotencyKey: "abcdefgh",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/plans/generate", { startDate: "2026-02-30" })).status,
    ).toBe(400);
    expect(
      (await get<Stock[]>("/inventory")).every((s) => s.quantity === 0),
    ).toBe(true);
  });
});
describe("inventory and immutable ledger", () => {
  it("converts pieces, retries safely and detects mismatched payloads", async () => {
    const body = {
      ingredientId: "egg",
      delta: 2,
      displayUnit: true,
      version: 0,
      idempotencyKey: "piece-adjust-key",
    };
    const first = await post("/inventory/adjust", body);
    expect(await post("/inventory/adjust", body)).toEqual(first);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "egg")?.quantity,
    ).toBe(100);
    expect(
      (await request("/inventory/adjust", { ...body, delta: 3 })).status,
    ).toBe(409);
    await expect(
      database.prepare("UPDATE inventory_movements SET delta=1").run(),
    ).rejects.toThrow();
  });
  it("guards concurrent adjustments and rolls back insufficient stock", async () => {
    const responses = await Promise.all(
      ["first-key", "second-key"].map((idempotencyKey) =>
        request("/inventory/adjust", {
          ingredientId: "rice",
          delta: 100,
          version: 0,
          idempotencyKey,
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await request("/inventory/adjust", {
          ingredientId: "rice",
          delta: -101,
          version: 1,
          idempotencyKey: "negative-stock-key",
        })
      ).status,
    ).toBe(409);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(100);
  });
});
describe("cycle planner and shopping", () => {
  it("does not purchase an earlier cycle shortage again when projecting the next shopping date", async () => {
    const date = tokyoDate(),
      day = new Date(date + "T00:00:00Z").getUTCDay();
    const s = await get<Settings>("/settings");
    await request(
      "/settings",
      { ...s, shoppingDays: [day, (day + 4) % 7] },
      "PUT",
    );
    await post("/inventory/adjust", {
      ingredientId: "rice",
      delta: 400,
      version: 0,
      idempotencyKey: "two-cycle-rice-key",
    });
    await generation();
    const first = await get<Cycle>("/shopping/current");
    expect(
      first.items.find((i) => i.ingredient_id === "rice")?.proposed_amount,
    ).toBe(1000);
    await post("/plans/generate", {
      startDate: addDays(date, 4),
      allowPurchase: true,
    });
    const second = await database
      .prepare("SELECT id FROM shopping_cycles WHERE starts_on=?")
      .bind(addDays(date, 4))
      .first<{ id: string }>();
    expect(second).not.toBeNull();
    const deficit = await database
      .prepare(
        "SELECT proposed_amount FROM shopping_items WHERE cycle_id=? AND ingredient_id='rice'",
      )
      .bind(second!.id)
      .first<{ proposed_amount: number }>();
    expect(deficit?.proposed_amount).toBe(1050);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(400);
    const plan = (await get<Plan[]>("/plans"))[0];
    await post("/plans/" + plan.id + "/skip", { version: plan.version });
    const after = await database
      .prepare(
        "SELECT proposed_amount FROM shopping_items WHERE cycle_id=? AND ingredient_id='rice'",
      )
      .bind(second!.id)
      .first<{ proposed_amount: number }>();
    expect(after?.proposed_amount).toBe(1050);
  });
  it("contains 30 plausible dinner recipes with explicitly sourced nutrition", async () => {
    const recipes = await get<Plan["recipe"][]>("/recipes");
    expect(recipes).toHaveLength(30);
    for (const r of recipes) {
      expect(r.total_minutes).toBeLessThanOrEqual(30);
      expect(r.kcal).toBeGreaterThan(650);
      expect(r.protein).toBeGreaterThan(30);
      expect(
        r.items.every((i) => Number.isInteger(i.amount) && i.amount > 0),
      ).toBe(true);
    }
    expect(
      (await get<Stock[]>("/inventory")).every(
        (i) => !!i.source && !!i.food_code,
      ),
    ).toBe(true);
  });
  it("allocates shared ingredients cumulatively across a 3/4-day shopping cycle without changing stock", async () => {
    const date = tokyoDate(),
      day = new Date(date + "T00:00:00Z").getUTCDay();
    const s = await get<Settings>("/settings");
    await request(
      "/settings",
      { ...s, shoppingDays: [day, (day + 4) % 7] },
      "PUT",
    );
    await post("/inventory/adjust", {
      ingredientId: "rice",
      delta: 400,
      version: 0,
      idempotencyKey: "initial-rice-key",
    });
    const plans = await generation();
    expect(plans).toHaveLength(4);
    const cycle = await get<Cycle>("/shopping/current");
    expect(cycle.ends_on).toBe(addDays(date, 3));
    expect(
      cycle.items.find((i) => i.ingredient_id === "rice")?.proposed_amount,
    ).toBe(1000);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(400);
    expect(new Set(plans.map((p) => p.recipe.id)).size).toBeGreaterThan(1);
    const body = {
      version: cycle.version,
      idempotencyKey: "purchase-cycle-key",
      items: cycle.items.map((i) => ({
        ingredientId: i.ingredient_id,
        amount: i.proposed_amount,
      })),
    };
    const first = await post("/shopping/" + cycle.id + "/confirm", body);
    expect(await post("/shopping/" + cycle.id + "/confirm", body)).toEqual(
      first,
    );
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(1400);
    expect(
      (
        await request("/shopping/" + cycle.id + "/confirm", {
          ...body,
          idempotencyKey: "other-purchase-key",
        })
      ).status,
    ).toBe(409);
  });
  it("explains unsatisfiable equipment/allergy rules and preserves all data", async () => {
    const s = await get<Settings>("/settings");
    await request("/settings", { ...s, equipment: [] }, "PUT");
    expect(
      (
        await request("/plans/generate", {
          startDate: tokyoDate(),
          allowPurchase: true,
        })
      ).status,
    ).toBe(422);
    expect(await get("/plans")).toEqual([]);
    expect(await get("/shopping/current")).toBeNull();
  });
  it("rebuilds shortages after skip and after replacing a later dinner", async () => {
    const s = await get<Settings>("/settings"),
      day = new Date(tokyoDate() + "T00:00:00Z").getUTCDay();
    await request(
      "/settings",
      { ...s, shoppingDays: [day, (day + 4) % 7] },
      "PUT",
    );
    const ps = await generation();
    const first = ps[0];
    const cycle = await get<Cycle>("/shopping/current");
    const originalRice = cycle.items.find(
      (i) => i.ingredient_id === "rice",
    )!.proposed_amount;
    await post("/plans/" + first.id + "/skip", { version: first.version });
    const skipped = await get<Cycle>("/shopping/current");
    expect(
      skipped.items.find((i) => i.ingredient_id === "rice")?.proposed_amount ??
        0,
    ).toBe(originalRice - 350);
    const later = ps[1];
    await post("/plans/" + later.id + "/regenerate", {
      version: later.version,
      allowPurchase: true,
    });
    const changed = await get<Plan[]>("/plans");
    expect(changed.find((p) => p.id === first.id)?.status).toBe("skipped");
    expect(changed.find((p) => p.id === later.id)?.recipe.id).not.toBe(
      later.recipe.id,
    );
    const updated = await get<Cycle>("/shopping/current");
    const requirements = new Map<string, number>();
    for (const p of changed.filter((p) => p.status === "planned"))
      for (const i of managedItems(p.recipe))
        requirements.set(
          i.ingredientId,
          (requirements.get(i.ingredientId) ?? 0) + i.amount,
        );
    for (const [ingredient, amount] of requirements)
      expect(
        updated.items.find((i) => i.ingredient_id === ingredient)
          ?.proposed_amount,
      ).toBe(amount);
  });
  it("uses stock-only planning on non-shopping days and reserves earlier plans", async () => {
    const date = tokyoDate(),
      day = new Date(date + "T00:00:00Z").getUTCDay(),
      s = await get<Settings>("/settings");
    await request(
      "/settings",
      { ...s, shoppingDays: [(day + 3) % 7, (day + 6) % 7] },
      "PUT",
    );
    expect(
      (
        await request("/plans/generate", {
          startDate: date,
          allowPurchase: false,
        })
      ).status,
    ).toBe(422);
    await fill();
    const plans = await generation(false);
    expect(plans).toHaveLength(3);
    const stocks = await get<Stock[]>("/inventory");
    await post("/inventory/adjust", {
      ingredientId: "rice",
      delta: 350 - stocks.find((s) => s.id === "rice")!.quantity,
      version: stocks.find((s) => s.id === "rice")!.version,
      idempotencyKey: "reduce-rice-key",
    });
    expect(
      (
        await request("/plans/" + plans[1].id + "/regenerate", {
          version: plans[1].version,
          allowPurchase: false,
        })
      ).status,
    ).toBe(422);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(350);
  });
});
describe("meal completion, concurrency and snapshots", () => {
  async function ready() {
    await fill();
    return (await generation(false))[0];
  }
  it("uses actual grams, completes once, and keeps historical data immutable", async () => {
    const p = await ready();
    const items = managedItems(p.recipe).map((i) => ({
      ...i,
      amount: i.ingredientId === "rice" ? 100 : i.amount,
    }));
    const body = {
      version: p.version,
      idempotencyKey: "completion-key-1",
      items,
    };
    const log = await post<{ id: string; total_kcal: number }>(
      "/plans/" + p.id + "/complete",
      body,
    );
    expect(log.total_kcal).toBeLessThan(p.recipe.kcal);
    expect(await post("/plans/" + p.id + "/complete", body)).toEqual(log);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(9900);
    expect(await get<unknown[]>("/meal-logs")).toHaveLength(1);
    expect(
      (
        await request("/plans/" + p.id + "/complete", {
          ...body,
          idempotencyKey: "different-key",
        })
      ).status,
    ).toBe(409);
    await database
      .prepare("UPDATE recipes SET title='変更後' WHERE id=?")
      .bind(p.recipe.id)
      .run();
    const saved = await get<{ recipe_snapshot: string }>(
      "/meal-logs/" + log.id,
    );
    expect(JSON.parse(saved.recipe_snapshot).title).toBe(p.recipe.title);
    await expect(
      database.prepare("UPDATE meal_logs SET total_kcal=0").run(),
    ).rejects.toThrow();
    const correction = {
      version: 0,
      idempotencyKey: "correction-key-1",
      items: items.map((i) => ({
        ...i,
        amount: i.ingredientId === "rice" ? 50 : i.amount,
      })),
    };
    await post("/meal-logs/" + log.id + "/correct", correction);
    await post("/meal-logs/" + log.id + "/correct", correction);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(9950);
    expect(
      (await get<{ total_kcal: number }>("/meal-logs/" + log.id)).total_kcal,
    ).toBe(log.total_kcal);
  });
  it("rejects insufficient stock before writing any partial completion", async () => {
    const p = (await generation())[0];
    const response = await request("/plans/" + p.id + "/complete", {
      version: p.version,
      idempotencyKey: "insufficient-key",
      items: managedItems(p.recipe),
    });
    expect(response.status).toBe(409);
    expect(await get("/meal-logs")).toEqual([]);
    expect((await get<Plan[]>("/plans"))[0].status).toBe("planned");
    expect(
      (
        await database
          .prepare("SELECT COUNT(*) AS n FROM operations")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("handles simultaneous same-key and conflicting completions without double consumption", async () => {
    const p = await ready();
    const body = {
      version: p.version,
      idempotencyKey: "concurrent-same-key",
      items: managedItems(p.recipe),
    };
    const responses = await Promise.all([
      request("/plans/" + p.id + "/complete", body),
      request("/plans/" + p.id + "/complete", body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(9650);
    expect(await get<unknown[]>("/meal-logs")).toHaveLength(1);
  });
  it("rolls back a multi-movement transaction when a later item would go negative", async () => {
    await post("/inventory/adjust", {
      ingredientId: "rice",
      delta: 100,
      version: 0,
      idempotencyKey: "rollback-setup-key",
    });
    const key = "rollback-batch-key";
    await expect(
      database.batch([
        database
          .prepare(
            "INSERT INTO operations(idempotency_key,kind,payload,result_id) VALUES (?,'complete','{}','test')",
          )
          .bind(key),
        database
          .prepare(
            "INSERT INTO inventory_movements VALUES ('rollback-rice','rice',-50,'meal_consumption','test',?,CURRENT_TIMESTAMP)",
          )
          .bind(key),
        database
          .prepare(
            "INSERT INTO inventory_movements VALUES ('rollback-egg','egg',-1,'meal_consumption','test',?,CURRENT_TIMESTAMP)",
          )
          .bind(key),
      ]),
    ).rejects.toThrow();
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(100);
    expect(
      await database
        .prepare("SELECT * FROM operations WHERE idempotency_key=?")
        .bind(key)
        .first(),
    ).toBeNull();
    expect(
      await database
        .prepare("SELECT * FROM inventory_movements WHERE id='rollback-rice'")
        .first(),
    ).toBeNull();
  });
  it("allows only one of two competing completion keys", async () => {
    const p = await ready();
    const responses = await Promise.all(
      ["conflicting-key-a", "conflicting-key-b"].map((idempotencyKey) =>
        request("/plans/" + p.id + "/complete", {
          version: p.version,
          idempotencyKey,
          items: managedItems(p.recipe),
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")?.quantity,
    ).toBe(9650);
    expect(await get<unknown[]>("/meal-logs")).toHaveLength(1);
  });
  it("skips without consumption and protects locked dates during generation", async () => {
    const p = await ready();
    const before = await get("/inventory");
    await post("/plans/" + p.id + "/skip", { version: p.version });
    expect(await get("/inventory")).toEqual(before);
    if (
      cycleEnd(tokyoDate(), (await get<Settings>("/settings")).shoppingDays) >
      tokyoDate()
    )
      await generation(false);
    expect(
      (await get<Plan[]>("/plans")).find((v) => v.id === p.id)?.status,
    ).toBe("skipped");
    expect(await get("/meal-logs")).toEqual([]);
  });
  it("distinguishes planned presets from consumed nutrition and unknown lunch", async () => {
    const summary = await get<{
      confirmed: { kcal: number };
      projected: { kcal: number };
      unknown: string[];
    }>("/daily-nutrition");
    expect(summary.confirmed.kcal).toBe(0);
    expect(summary.projected.kcal).toBe(120);
    expect(summary.unknown).toContain("lunch");
    await request(
      "/daily-food-entries/" + tokyoDate(),
      [
        { mealType: "breakfast", status: "confirmed", kcal: 223, protein: 4 },
        { mealType: "bedtime", status: "confirmed", kcal: 0, protein: 0 },
      ],
      "PUT",
    );
    const changed = await get<typeof summary>("/daily-nutrition");
    expect(changed.confirmed.kcal).toBe(223);
    expect(changed.projected.kcal).toBe(0);
    expect(changed.unknown).toContain("lunch");
  });
});

describe("pantry classification and recipe detail acceptance", () => {
  const exempt = ["oil", "soy", "miso", "sugar", "curry"];
  it("shows names, canonical amounts and specific steps for every one of the 30 recipes", async () => {
    const catalog = await get<Plan["recipe"][]>("/recipes"),
      ingredients = await loadIngredients(database),
      stocks = await get<Stock[]>("/inventory");
    expect(catalog).toHaveLength(30);
    for (const recipe of catalog) {
      const steps = JSON.parse(recipe.instructions_json).join("\n");
      expect(steps).not.toContain("{{");
      expect(steps).not.toContain("主材料");
      for (const item of recipe.items)
        expect(steps).toContain(`${item.name} ${item.amount}${item.unit}`);
      if (
        recipe.id.startsWith("chicken") ||
        recipe.id.startsWith("pork") ||
        recipe.id.startsWith("salmon")
      ) {
        expect(steps).not.toContain("木綿豆腐");
        expect(steps).not.toContain("鶏卵");
      }
      expect(steps).toContain("75℃");
      expect(steps).toContain("1分以上");
      expect(recipe.total_minutes).toBeLessThanOrEqual(30);
      const html = renderToStaticMarkup(
        createElement(RecipeDetails, { recipe, ingredients, stocks }),
      );
      expect(html).toContain("在庫管理する食材");
      expect(html).toContain("調味料（在庫登録不要）");
      for (const item of recipe.items) {
        expect(html).toContain(item.name);
        expect(html).toContain(`${item.amount}${item.unit}`);
      }
      const condiments = html
        .split("調味料（在庫登録不要）")[1]
        .split("作り方")[0];
      expect(condiments).not.toContain("単独の不足");
    }
    await database
      .prepare(
        "UPDATE recipe_ingredients SET amount=400 WHERE recipe_id='chicken-ginger' AND ingredient_id='rice'",
      )
      .run();
    const updated = (await get<Plan["recipe"][]>("/recipes")).find(
      (r) => r.id === "chicken-ginger",
    )!;
    expect(updated.instructions_json).toContain("ご飯（炊飯済み） 400g");
    expect(updated.instructions_json).not.toContain("350g");
  });
  it("plans and completes with zero condiment stocks, snapshots nutrition and corrects/retries without consuming condiments", async () => {
    const day = new Date(tokyoDate() + "T00:00:00Z").getUTCDay(),
      s = await get<Settings>("/settings");
    await request(
      "/settings",
      { ...s, shoppingDays: [(day + 3) % 7, (day + 6) % 7] },
      "PUT",
    );
    await fill();
    const p = (await generation(false))[0],
      ingredients = await loadIngredients(database);
    const body = {
      version: p.version,
      idempotencyKey: "pantry-completion-key",
      items: managedItems(p.recipe),
    };
    const log = await post<{
      id: string;
      total_kcal: number;
      recipe_snapshot: string;
    }>("/plans/" + p.id + "/complete", body);
    expect(log.total_kcal).toBe(p.recipe.kcal);
    expect(
      log.total_kcal - nutrition(body.items, ingredients).kcal,
    ).toBeGreaterThan(130);
    expect(await post("/plans/" + p.id + "/complete", body)).toEqual(log);
    const detail = await get<{
      items: { ingredient_id: string; amount: number; amount_source: string }[];
    }>("/meal-logs/" + log.id);
    for (const item of p.recipe.items.filter((i) => i.inventory_exempt))
      expect(
        detail.items.find((i) => i.ingredient_id === item.ingredientId),
      ).toMatchObject({ amount: item.amount, amount_source: "recipe_default" });
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS n FROM inventory_movements WHERE ingredient_id IN ('oil','soy','miso','sugar','curry')",
        )
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    const rice = (await get<Stock[]>("/inventory")).find(
      (i) => i.id === "rice",
    )!.quantity;
    await database
      .prepare(
        "UPDATE recipe_ingredients SET amount=30 WHERE recipe_id=? AND ingredient_id='oil'",
      )
      .bind(p.recipe.id)
      .run();
    await database
      .prepare("UPDATE ingredients SET kcal_per_100=1 WHERE id='oil'")
      .run();
    const correction = {
      version: 0,
      idempotencyKey: "pantry-correction-key",
      items: body.items.map((i) => ({
        ...i,
        amount: i.ingredientId === "rice" ? i.amount - 50 : i.amount,
      })),
    };
    const corrected = await post<{
      items_snapshot: string;
      total_kcal: number;
    }>("/meal-logs/" + log.id + "/correct", correction);
    expect(
      JSON.parse(corrected.items_snapshot).find(
        (i: RecipeItem) => i.ingredientId === "oil",
      ),
    ).toMatchObject({
      amount: 15,
      kcal_per_100: 887,
      amountSource: "recipe_default",
    });
    expect(corrected.total_kcal).toBeCloseTo(log.total_kcal - 78, 1);
    expect(await post("/meal-logs/" + log.id + "/correct", correction)).toEqual(
      corrected,
    );
    expect(
      (await get<Stock[]>("/inventory")).find((i) => i.id === "rice")!.quantity,
    ).toBe(rice + 50);
    expect(
      (await get<{ recipe_snapshot: string }>("/meal-logs/" + log.id))
        .recipe_snapshot,
    ).toBe(log.recipe_snapshot);
    expect(
      await database
        .prepare(
          "SELECT COUNT(*) AS n FROM inventory_movements WHERE ingredient_id IN ('oil','soy','miso','sugar','curry')",
        )
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
  it("excludes condiments from shortages and purchase confirmation but keeps ginger managed and allergens active", async () => {
    const ingredients = await loadIngredients(database),
      stocks = await get<Stock[]>("/inventory");
    expect(stocks).toHaveLength(13);
    expect(stocks.map((i) => i.id)).toContain("ginger");
    expect(stocks.some((i) => exempt.includes(i.id))).toBe(false);
    const ps = await generation(),
      cycle = await get<Cycle>("/shopping/current");
    expect(cycle.items.every((i) => !exempt.includes(i.ingredient_id))).toBe(
      true,
    );
    const body = {
      version: cycle.version,
      idempotencyKey: "pantry-purchase-key",
      items: cycle.items.map((i) => ({
        ingredientId: i.ingredient_id,
        amount: i.proposed_amount,
      })),
    };
    await post("/shopping/" + cycle.id + "/confirm", body);
    await post("/shopping/" + cycle.id + "/confirm", body);
    expect(
      await database
        .prepare(
          "SELECT quantity FROM inventory_stocks WHERE ingredient_id='oil'",
        )
        .first(),
    ).toEqual({ quantity: 0 });
    const soyRecipe = (await get<Plan["recipe"][]>("/recipes")).find((r) =>
      r.items.some((i) => i.ingredientId === "soy"),
    )!;
    const s = await get<Settings>("/settings");
    expect(
      eligible(soyRecipe, { ...s, allergies: ["小麦"] }, ingredients),
    ).toBe(false);
    const p = ps[0];
    expect(
      (
        await request("/plans/" + p.id + "/complete", {
          version: p.version,
          idempotencyKey: "invalid-seasoning-key",
          items: [
            ...managedItems(p.recipe),
            { ingredientId: "oil", amount: 15 },
          ],
        })
      ).status,
    ).toBe(422);
    for (const id of exempt)
      expect(
        (
          await request("/inventory/adjust", {
            ingredientId: id,
            delta: 1,
            version: 0,
            idempotencyKey: "no-pantry-update-" + id,
          })
        ).status,
      ).toBe(422);
    const newPs = await generation(false);
    const first = newPs[0];
    await post("/plans/" + first.id + "/skip", { version: first.version });
    expect(
      (await get<Cycle>("/shopping/current")).items.every(
        (i) => !exempt.includes(i.ingredient_id),
      ),
    ).toBe(true);
  });
  it("upgrades populated 0001-0003 without altering stocks, movement history, meal snapshots or legacy shopping rows", async () => {
    const oldIngredients = await loadIngredients(database);
    const oldRecipe = await database
      .prepare("SELECT * FROM recipes WHERE id='chicken-miso'")
      .first<Plan["recipe"]>();
    const oldItems = (
      await database
        .prepare(
          "SELECT ingredient_id,amount FROM recipe_ingredients WHERE recipe_id='chicken-miso'",
        )
        .all<{ ingredient_id: string; amount: number }>()
    ).results.map((i) => ({ ingredientId: i.ingredient_id, amount: i.amount }));
    const total = nutrition(oldItems, oldIngredients),
      snapshot = JSON.stringify({ ...oldRecipe, items: oldItems });
    const legacyRequest = {
      version: 0,
      idempotencyKey: "legacy-complete-key",
      items: oldItems,
    };
    const setup = [
      database.prepare(
        "INSERT INTO operations(idempotency_key,kind,payload,result_id) VALUES ('legacy-fill-key','adjust','{}','legacy-fill')",
      ),
    ];
    for (const i of oldIngredients)
      setup.push(
        database
          .prepare(
            "INSERT INTO inventory_movements(id,ingredient_id,delta,reason,source_id,idempotency_key) VALUES (?, ?,10000,'manual_adjustment','legacy-fill','legacy-fill-key')",
          )
          .bind("legacy-fill-" + i.id, i.id),
      );
    setup.push(
      database.prepare(
        "INSERT INTO meal_plans(id,local_date,status) VALUES ('legacy-plan','2026-01-01','completed')",
      ),
      database.prepare(
        "INSERT INTO meal_plan_dishes VALUES ('legacy-dish','legacy-plan','chicken-miso',1)",
      ),
      database
        .prepare(
          "INSERT INTO operations(idempotency_key,kind,payload,result_id) VALUES ('legacy-complete-key','complete',?,'legacy-log')",
        )
        .bind(JSON.stringify({ planId: "legacy-plan", ...legacyRequest })),
      database
        .prepare(
          "INSERT INTO meal_logs(id,plan_id,total_kcal,total_protein_g,recipe_snapshot,idempotency_key) VALUES ('legacy-log','legacy-plan',?,?,?,'legacy-complete-key')",
        )
        .bind(total.kcal, total.protein, snapshot),
    );
    for (const item of oldItems) {
      const ing = oldIngredients.find((i) => i.id === item.ingredientId)!;
      setup.push(
        database
          .prepare(
            "INSERT INTO meal_log_items VALUES (?,'legacy-log',?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            "legacy-item-" + ing.id,
            ing.id,
            ing.name,
            item.amount,
            ing.unit,
            (item.amount * ing.kcal_per_100) / 100,
            (item.amount * ing.protein_per_100) / 100,
            ing.source,
            ing.food_code,
            ing.state,
          ),
        database
          .prepare(
            "INSERT INTO inventory_movements(id,ingredient_id,delta,reason,source_id,idempotency_key) VALUES (?, ?,?,'meal_consumption','legacy-log','legacy-complete-key')",
          )
          .bind("legacy-eaten-" + ing.id, ing.id, -item.amount),
      );
    }
    setup.push(
      database
        .prepare(
          "INSERT INTO shopping_cycles(id,starts_on,ends_on,shopping_on,status) VALUES ('legacy-cycle',?,?,?,'review')",
        )
        .bind(tokyoDate(), addDays(tokyoDate(), 3), tokyoDate()),
      database.prepare(
        "INSERT INTO shopping_items VALUES ('legacy-shop-oil','legacy-cycle','oil',45,45,NULL,'g','review')",
      ),
    );
    setup.push(
      database.prepare(
        "INSERT INTO operations(idempotency_key,kind,payload,result_id) VALUES ('legacy-previous-correction','correction','{}','legacy-correction')",
      ),
      database
        .prepare(
          "INSERT INTO meal_log_corrections(id,log_id,version,items_snapshot,total_kcal,total_protein_g,idempotency_key) VALUES ('legacy-correction','legacy-log',1,?,?,?,'legacy-previous-correction')",
        )
        .bind(JSON.stringify(oldItems), total.kcal, total.protein),
    );
    await database.batch(setup);
    const tables = [
      "inventory_stocks",
      "inventory_movements",
      "meal_logs",
      "meal_log_items",
      "meal_log_corrections",
      "meal_plans",
      "meal_plan_dishes",
      "operations",
      "shopping_cycles",
      "shopping_items",
      "recipe_ingredients",
      "app_settings",
    ];
    const before: Record<string, Record<string, unknown>[]> = {};
    for (const table of tables)
      before[table] = (
        await database
          .prepare("SELECT * FROM " + table + " ORDER BY rowid")
          .all<Record<string, unknown>>()
      ).results;
    await applyMigration("0004_pantry_recipe_details.sql");
    for (const table of tables) {
      const after = (
        await database
          .prepare("SELECT * FROM " + table + " ORDER BY rowid")
          .all<Record<string, unknown>>()
      ).results;
      expect(after).toHaveLength(before[table].length);
      after.forEach((row, index) =>
        expect(row).toMatchObject(before[table][index]),
      );
    }
    expect((await get<Cycle>("/shopping/current")).items).toEqual([]);
    expect((await get<Stock[]>("/inventory")).some((i) => i.id === "oil")).toBe(
      false,
    );
    expect(
      await post("/plans/legacy-plan/complete", legacyRequest),
    ).toMatchObject(before.meal_logs[0]);
    expect(
      (
        await database
          .prepare("SELECT * FROM inventory_movements ORDER BY rowid")
          .all()
      ).results,
    ).toEqual(before.inventory_movements);
    const legacyCorrection = {
      version: 1,
      idempotencyKey: "legacy-correction-key",
      items: oldItems
        .filter((i) => !exempt.includes(i.ingredientId))
        .map((i) => ({
          ...i,
          amount: i.ingredientId === "rice" ? 100 : i.amount,
        })),
    };
    const oilBefore = await database
      .prepare("SELECT * FROM inventory_stocks WHERE ingredient_id='oil'")
      .first();
    await post("/meal-logs/legacy-log/correct", legacyCorrection);
    await post("/meal-logs/legacy-log/correct", legacyCorrection);
    expect(
      await database
        .prepare("SELECT * FROM inventory_stocks WHERE ingredient_id='oil'")
        .first(),
    ).toEqual(oilBefore);
    expect(
      (await get<{ recipe_snapshot: string }>("/meal-logs/legacy-log"))
        .recipe_snapshot,
    ).toBe(snapshot);
    await post("/shopping/legacy-cycle/confirm", {
      version: 1,
      idempotencyKey: "legacy-empty-purchase",
      items: [],
    });
    expect(
      await database
        .prepare("SELECT * FROM shopping_items WHERE id='legacy-shop-oil'")
        .first(),
    ).toMatchObject(before.shopping_items[0]);
    expect(
      await database
        .prepare(
          "SELECT quantity FROM inventory_stocks WHERE ingredient_id='oil'",
        )
        .first(),
    ).toEqual({ quantity: 10000 - 15 });
    await expect(
      database
        .prepare(
          "INSERT INTO inventory_movements(id,ingredient_id,delta,reason,source_id,idempotency_key) VALUES ('blocked-pantry','oil',1,'manual_adjustment','test','legacy-fill-key')",
        )
        .run(),
    ).rejects.toThrow();
  });
});
