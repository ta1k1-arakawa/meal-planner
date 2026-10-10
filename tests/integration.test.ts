import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import app, { type Env } from "../worker/index";
import { tokyoDate, cycleEnd, addDays } from "../worker/planner";
import type { Plan, Cycle, Stock, Settings } from "../worker/contracts";
let mf: Miniflare, database: D1Database, cookie: string, env: Env;
let databaseIndex = 0;
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
beforeEach(async () => {
  database = (await mf.getD1Database(
    "DB_" + databaseIndex++,
  )) as unknown as D1Database;
  env.DB = database;
  for (const file of [
    "0001_schema.sql",
    "0002_seed.sql",
    "0003_corrections.sql",
  ]) {
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
});
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
      for (const i of p.recipe.items)
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
    const items = p.recipe.items.map((i) => ({
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
      items: p.recipe.items,
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
      items: p.recipe.items,
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
          items: p.recipe.items,
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
