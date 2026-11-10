import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import app, { type Env } from "../worker/index";
import { tokyoDate, cycleEnd, addDays, nextShoppingDate, chooseSlotRecipe } from "../worker/planner";
import { exceedsCap, unitPriceYenPer100 } from "../worker/price-caps";
import type {
  Cycle,
  Plan,
  Settings,
  SlotPlan,
  Stock,
  WeightSummary,
  CostSummary,
} from "../worker/contracts";

let mf: Miniflare, database: D1Database, cookie: string, env: Env;
let databaseIndex = 0;
const MIGRATIONS = [
  "0001_schema.sql",
  "0002_seed.sql",
  "0003_corrections.sql",
  "0004_pantry_recipe_details.sql",
  "0005_shopping_schedule_candidates.sql",
  "0006_anytime_shopping.sql",
  "0007_photo_purchases.sql",
  "0008_bulking.sql",
  "0009_more_bulking_recipes.sql",
];
async function applyMigration(file: string, db: D1Database) {
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
  ].map((sql) => db.prepare(sql));
  for (let i = 0; i < statements.length; i += 80)
    await db.batch(statements.slice(i, i + 80));
}
async function request(path: string, body?: unknown, method = "POST") {
  return app.request(
    "https://dinner.test/api" + path,
    {
      method: body === undefined ? "GET" : method,
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function get<T>(path: string): Promise<T> {
  const r = await request(path);
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json() as Promise<T>;
}
async function post<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const r = await request(path, body, method);
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
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    d1Databases: Array.from({ length: 16 }, (_, i) => "DB_" + i),
    compatibilityDate: "2026-08-01",
  });
  database = (await mf.getD1Database("DB_0")) as unknown as D1Database;
  env = {
    DB: database,
    APP_PASSWORD: "bulking-test-password-0123456789abcdef",
    ASSETS: { fetch: async () => new Response("app") } as unknown as Fetcher,
  };
  const response = await app.request(
    "https://dinner.test/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.APP_PASSWORD }),
    },
    env,
  );
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  database = (await mf.getD1Database(
    "DB_" + databaseIndex++,
  )) as unknown as D1Database;
  env.DB = database;
  for (const file of MIGRATIONS) await applyMigration(file, database);
});

describe("bulking v2 profile and catalog", () => {
  it("defaults settings to the no-breakfast bulking profile", async () => {
    const s = await get<Settings>("/settings");
    expect(s.dailyKcal).toBe(3000);
    expect(s.dailyProtein).toBe(120);
    expect(s.dinnerKcal).toBe(1100);
    expect(s.dinnerProtein).toBe(50);
    expect(s.monthlyBudgetYen).toBe(25000);
    expect(s.shoppingDays).toEqual([2, 6]);
    expect(s.slotTargets.lunch).toEqual({ kcal: 1150, protein: 50 });
    expect(s.slotTargets.snack).toEqual({ kcal: 450, protein: 18 });
    expect(s.slotTargets.nightSnack).toEqual({ kcal: 325, protein: 13 });
    expect(s.slotTargets.morningDrink).toEqual({ kcal: 200, protein: 7 });
    expect(s.excludedIngredients).toContain("oatmeal");
    expect(s.excludedIngredients).toContain("peanut_butter");
  });

  it("seeds bulking recipes per slot near their targets, with every item in the steps", async () => {
    const catalog = await get<Plan["recipe"][]>("/recipes");
    expect(catalog).toHaveLength(62);
    const bySlot = (slot: string) => catalog.filter((r) => r.slot === slot);
    expect(bySlot("lunch").map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "bulk-oyakodon",
        "bulk-curry-rice",
        "bulk-teriyaki-don",
        "bulk-yakisoba",
        "bulk-tuna-natto-don",
        "bulk2-chicken-soboro-don",
        "bulk2-tuna-egg-cheese-don",
        "bulk2-salmon-mayo-don",
        "bulk2-keema-curry-don",
      ]),
    );
    expect(bySlot("dinner").map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "bulk-saba-pasta",
        "bulk-mabo-don",
        "bulk-pork-ginger",
        "bulk-chicken-nanban",
        "bulk-niku-udon",
        "bulk2-saba-miso-set",
        "bulk2-chicken-hoikoro-don",
        "bulk2-tofu-hamburg-don",
        "bulk2-tuna-tomato-pasta",
        "bulk2-pork-sukiyaki-don",
      ]),
    );
    expect(bySlot("snack").map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "bulk2-natto-cheese-toast",
        "bulk2-egg-banana-milk",
        "bulk2-egg-sandwich",
      ]),
    );
    expect(bySlot("night_snack").map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "bulk2-night-miso-soup-rice",
        "bulk2-night-banana-yogurt",
        "bulk2-night-natto-egg-rice",
      ]),
    );
    for (const r of bySlot("lunch")) {
      expect(r.kcal).toBeGreaterThanOrEqual(1000);
      expect(r.kcal).toBeLessThanOrEqual(1250);
      expect(r.protein).toBeGreaterThanOrEqual(40);
    }
    for (const r of bySlot("dinner").filter((x) => x.id.includes("bulk"))) {
      expect(r.kcal).toBeGreaterThanOrEqual(1000);
      expect(r.kcal).toBeLessThanOrEqual(1250);
      expect(r.protein).toBeGreaterThanOrEqual(40);
    }
    for (const r of bySlot("snack")) {
      expect(r.kcal).toBeGreaterThanOrEqual(400);
      expect(r.kcal).toBeLessThanOrEqual(500);
      expect(r.protein).toBeGreaterThanOrEqual(14);
    }
    for (const r of bySlot("night_snack")) {
      expect(r.kcal).toBeGreaterThanOrEqual(280);
      expect(r.kcal).toBeLessThanOrEqual(380);
      expect(r.protein).toBeGreaterThanOrEqual(11);
    }
    for (const r of catalog.filter((x) => x.id.includes("bulk") || x.slot !== "dinner" || x.id.startsWith("snack") || x.id.startsWith("night") || x.id.startsWith("morning"))) {
      const steps = JSON.parse(r.instructions_json).join("\n");
      expect(steps).not.toContain("{{");
      for (const item of r.items)
        expect(steps).toContain(`${item.name} ${item.amount}${item.unit}`);
    }
    // Disliked ingredients exist in the catalog data but in no recipe.
    for (const r of catalog)
      expect(
        r.items.some((i) =>
          ["oatmeal", "peanut_butter"].includes(i.ingredientId),
        ),
      ).toBe(false);
  });

  it("selects a new 0009 recipe when only its ingredients are in stock", async () => {
    const catalog = await get<Plan["recipe"][]>("/recipes");
    const s = await get<Settings>("/settings");
    // Stock-only selection (no purchases): the new salmon lunch is the only
    // lunch whose managed ingredients are fully covered by this stock.
    const lunch = chooseSlotRecipe(
      catalog.filter((r) => r.slot === "lunch"),
      new Map([
        ["rice", 400],
        ["salmon", 150],
        ["egg", 50],
        ["broccoli", 100],
      ]),
      [],
      s.slotTargets.lunch,
      false,
    );
    expect(lunch.id).toBe("bulk2-salmon-mayo-don");
    // Same for the new banana-yogurt night snack (the older yogurt recipe
    // needs 400 g of yogurt, more than the 320 g stocked here).
    const night = chooseSlotRecipe(
      catalog.filter((r) => r.slot === "night_snack"),
      new Map([
        ["yogurt", 320],
        ["banana", 90],
        ["honey", 15],
      ]),
      [],
      s.slotTargets.nightSnack,
      false,
    );
    expect(night.id).toBe("bulk2-night-banana-yogurt");
  });
});

describe("whole-day generation without breakfast", () => {
  it("creates lunch, snack and night plans for the cycle and completes them against stock", async () => {
    await fill();
    const today = tokyoDate();
    const end = cycleEnd(today, [2, 6]);
    const result = await post<{
      created: number;
      slotPlans: SlotPlan[];
    }>("/day-plans/generate", { startDate: today, includeMorningDrink: false });
    const days: string[] = [];
    for (let d = today; d <= end; d = addDays(d, 1)) days.push(d);
    expect(result.slotPlans).toHaveLength(days.length * 3);
    expect(
      result.slotPlans.every((sp) => sp.slot !== ("morning_drink" as string)),
    ).toBe(true);
    for (const day of days) {
      const slots = result.slotPlans
        .filter((sp) => sp.local_date === day)
        .map((sp) => sp.slot)
        .sort();
      expect(slots).toEqual(["lunch", "night_snack", "snack"]);
      for (const sp of result.slotPlans.filter((sp) => sp.local_date === day))
        expect(sp.recipe.slot).toBe(sp.slot);
    }
    const lunch = result.slotPlans.find(
      (sp) => sp.local_date === today && sp.slot === "lunch",
    )!;
    expect(lunch.recipe.kcal).toBeGreaterThanOrEqual(950);
    expect(lunch.recipe.kcal).toBeLessThanOrEqual(1300);
    // Shopping deficits must cover slot plans too: rice for today's lunch is
    // part of the pending shopping list after generating on a shopping day
    // is not asserted here; stock was full, so instead verify completion.
    const riceBefore = (await get<Stock[]>("/inventory")).find(
      (s) => s.id === "rice",
    )!;
    const managed = lunch.recipe.items
      .filter((i) => !i.inventory_exempt)
      .map((i) => ({ ingredientId: i.ingredientId, amount: i.amount }));
    const body = {
      version: lunch.version,
      items: managed,
      idempotencyKey: "bulking-lunch-complete",
    };
    const done = await post<{ ok: boolean; totals: { kcal: number } }>(
      "/day-plans/" + lunch.id + "/complete",
      body,
    );
    expect(done.totals.kcal).toBeCloseTo(lunch.recipe.kcal, 0);
    const riceAfter = (await get<Stock[]>("/inventory")).find(
      (s) => s.id === "rice",
    )!;
    const riceUsed =
      managed.find((i) => i.ingredientId === "rice")?.amount ?? 0;
    expect(riceAfter.quantity).toBe(riceBefore.quantity - riceUsed);
    // Replay with the same key does not consume twice.
    const replayed = await post<{ replayed?: boolean }>(
      "/day-plans/" + lunch.id + "/complete",
      body,
    );
    expect(replayed.replayed).toBe(true);
    expect(
      (await get<Stock[]>("/inventory")).find((s) => s.id === "rice")!
        .quantity,
    ).toBe(riceAfter.quantity);
    const nutrition = await get<{
      confirmed: { kcal: number; protein: number };
      projected: { kcal: number };
    }>("/daily-nutrition?date=" + today);
    expect(nutrition.confirmed.kcal).toBeCloseTo(lunch.recipe.kcal, 0);
    // Skip consumes nothing.
    const snack = result.slotPlans.find(
      (sp) => sp.local_date === today && sp.slot === "snack",
    )!;
    const beforeSkip = await get<Stock[]>("/inventory");
    await post("/day-plans/" + snack.id + "/skip", { version: snack.version });
    expect(await get<Stock[]>("/inventory")).toEqual(beforeSkip);
    expect(
      (await get<SlotPlan[]>("/day-plans")).find((sp) => sp.id === snack.id)!
        .status,
    ).toBe("skipped");
  });

  it("adds the optional morning drink only when requested", async () => {
    await fill();
    const today = tokyoDate();
    await post("/day-plans/generate", {
      startDate: today,
      includeMorningDrink: false,
    });
    expect(
      (await get<SlotPlan[]>("/day-plans")).some(
        (sp) => sp.slot === "morning_drink",
      ),
    ).toBe(false);
    await post("/day-plans/generate", {
      startDate: today,
      includeMorningDrink: true,
    });
    const mornings = (await get<SlotPlan[]>("/day-plans")).filter(
      (sp) => sp.slot === "morning_drink" && sp.local_date === today,
    );
    expect(mornings).toHaveLength(1);
    expect(mornings[0].recipe.id).toBe("morning-cocoa-milk");
  });

  it("never generates recipes using a disliked ingredient added in settings", async () => {
    await fill();
    const s = await get<Settings>("/settings");
    await post(
      "/settings",
      { ...s, excludedIngredients: [...s.excludedIngredients, "milk"] },
      "PUT",
    );
    const start = nextShoppingDate(tokyoDate(), [2, 6]);
    // Move to the following cycle so earlier plans do not mask the check.
    const freshStart =
      start === tokyoDate() ? addDays(cycleEnd(start, [2, 6]), 1) : start;
    await post("/day-plans/generate", {
      startDate: freshStart,
      includeMorningDrink: false,
    });
    const created = (await get<SlotPlan[]>("/day-plans")).filter(
      (sp) => sp.local_date >= freshStart,
    );
    expect(created.length).toBeGreaterThan(0);
    for (const sp of created)
      expect(
        sp.recipe.items.some((i) => i.ingredientId === "milk"),
      ).toBe(false);
  });
});

describe("weight tracking", () => {
  it("stores daily weights and advises +200 kcal after two slow weeks", async () => {
    const today = tokyoDate();
    const start = addDays(today, -20);
    const weights = [
      ...Array.from({ length: 7 }, () => 60),
      ...Array.from({ length: 7 }, () => 60.1),
      ...Array.from({ length: 7 }, () => 60.2),
    ];
    for (let i = 0; i < weights.length; i++)
      await post("/body-weight-logs", {
        localDate: addDays(start, i),
        weightKg: weights[i],
      });
    const payload = await get<{
      logs: { local_date: string; weight_kg: number }[];
      summary: WeightSummary;
    }>("/body-weight-logs");
    expect(payload.logs).toHaveLength(21);
    expect(payload.summary.currentWeekAverageKg).toBe(60.2);
    expect(payload.summary.weeklyChangeKg).toBe(0.1);
    expect(payload.summary.advice.action).toBe("increase");
    expect(payload.summary.advice.deltaKcal).toBe(200);
    expect(payload.summary.advice.targetSlot).toBe("night_snack");
    // Same-date entry overwrites instead of duplicating.
    await post("/body-weight-logs", { localDate: today, weightKg: 60.4 });
    const after = await get<{ logs: unknown[] }>("/body-weight-logs");
    expect(after.logs).toHaveLength(21);
  });

  it("reports a partial average over the recorded days before 3 days exist", async () => {
    const today = tokyoDate();
    await post("/body-weight-logs", {
      localDate: addDays(today, -1),
      weightKg: 60,
    });
    await post("/body-weight-logs", { localDate: today, weightKg: 60.4 });
    const payload = await get<{ summary: WeightSummary }>("/body-weight-logs");
    expect(payload.summary.latestWeightKg).toBe(60.4);
    expect(payload.summary.currentWeekAverageKg).toBeNull();
    expect(payload.summary.recentLogDays).toBe(2);
    expect(payload.summary.recentAverageKg).toBe(60.2);
    expect(payload.summary.advice.action).toBe("insufficient");
  });
});

describe("daily nutrition unknown list", () => {
  it("follows the slot model: no breakfast unless a morning drink is present", async () => {
    await fill();
    const today = tokyoDate();
    const plain = await get<{ unknown: string[] }>(
      "/daily-nutrition?date=" + today,
    );
    expect(plain.unknown).toEqual(["lunch", "snack", "dinner", "bedtime"]);
    await post("/day-plans/generate", {
      startDate: today,
      includeMorningDrink: true,
    });
    const withDrink = await get<{ unknown: string[] }>(
      "/daily-nutrition?date=" + today,
    );
    expect(withDrink.unknown).toEqual([
      "breakfast",
      "lunch",
      "snack",
      "dinner",
      "bedtime",
    ]);
  });
});

describe("cost tracking and price caps", () => {
  it("compares unit prices against the caps", () => {
    expect(unitPriceYenPer100(1100, 1000)).toBe(110);
    expect(exceedsCap("chicken", 1100, 1000)).toBe(false);
    expect(exceedsCap("chicken", 1200, 1000)).toBe(true);
    expect(exceedsCap("egg", 350, 500)).toBe(true);
    expect(exceedsCap("milk", 240, 1000)).toBe(false);
    expect(exceedsCap("milk", 260, 1000)).toBe(true);
  });

  it("records purchase prices and reports month spend against the budget", async () => {
    // Stock starts empty, so the generated cycle has real purchase items.
    const cycle = await post<Cycle>("/shopping/today", {});
    expect(cycle.items.length).toBeGreaterThan(0);
    const pricePerItem = 100;
    await post("/shopping/" + cycle.id + "/confirm", {
      version: cycle.version,
      idempotencyKey: crypto.randomUUID(),
      amountPolicy: "remaining",
      items: cycle.items.map((i) => ({
        ingredientId: i.ingredient_id,
        amount: i.proposed_amount,
        priceYen: pricePerItem,
      })),
    });
    const month = tokyoDate().slice(0, 7);
    const summary = await get<CostSummary>("/costs/summary?month=" + month);
    expect(summary.budgetYen).toBe(25000);
    expect(summary.spentYen).toBe(pricePerItem * cycle.items.length);
    expect(summary.remainingYen).toBe(25000 - summary.spentYen);
    expect(summary.perDayYen).toEqual([
      { date: cycle.shopping_on, yen: summary.spentYen },
    ]);
    expect(
      summary.priceCaps.find((c) => c.ingredientId === "chicken")?.yenPer100,
    ).toBe(110);
    expect(
      summary.priceCaps.find((c) => c.ingredientId === "rice")?.yenPer100,
    ).toBe(29);
  });
});

describe("migration 0008 upgrade safety", () => {
  it("preserves populated 0007 data while adding the bulking profile", async () => {
    const upgradeDb = (await mf.getD1Database(
      "DB_15",
    )) as unknown as D1Database;
    for (const file of MIGRATIONS.slice(0, 7))
      await applyMigration(file, upgradeDb);
    await upgradeDb.batch([
      upgradeDb
        .prepare(
          "UPDATE inventory_stocks SET quantity=1234 WHERE ingredient_id='rice'",
        ),
      upgradeDb
        .prepare(
          "INSERT INTO body_weight_logs(id,local_date,weight_kg) VALUES ('w-before','2026-11-09',59.8)",
        ),
      upgradeDb
        .prepare(
          "INSERT INTO meal_plans(id,local_date,status) VALUES ('plan-before','2026-11-09','planned')",
        ),
      upgradeDb
        .prepare(
          "INSERT INTO meal_plan_dishes(id,plan_id,recipe_id) VALUES ('dish-before','plan-before','chicken-ginger')",
        ),
    ]);
    const beforeSettings = await upgradeDb
      .prepare("SELECT daily_kcal FROM app_settings WHERE id=1")
      .first<{ daily_kcal: number }>();
    expect(beforeSettings?.daily_kcal).toBe(2800);
    await applyMigration("0008_bulking.sql", upgradeDb);
    env.DB = upgradeDb;
    try {
      const s = await get<Settings>("/settings");
      expect(s.dailyKcal).toBe(3000);
      expect(s.monthlyBudgetYen).toBe(25000);
      const rice = await upgradeDb
        .prepare(
          "SELECT quantity FROM inventory_stocks WHERE ingredient_id='rice'",
        )
        .first<{ quantity: number }>();
      expect(rice?.quantity).toBe(1234);
      const weight = await upgradeDb
        .prepare("SELECT weight_kg FROM body_weight_logs WHERE id='w-before'")
        .first<{ weight_kg: number }>();
      expect(weight?.weight_kg).toBe(59.8);
      const plan = (await get<Plan[]>("/plans")).find(
        (p) => p.id === "plan-before",
      );
      expect(plan?.recipe.id).toBe("chicken-ginger");
      expect(plan?.recipe.slot).toBe("dinner");
      expect(await get<SlotPlan[]>("/day-plans")).toEqual([]);
      // Migration 0009 then adds the second bulking recipe batch without
      // touching the preserved data.
      await applyMigration("0009_more_bulking_recipes.sql", upgradeDb);
      expect(await get<Plan["recipe"][]>("/recipes")).toHaveLength(62);
      const riceAfter = await upgradeDb
        .prepare(
          "SELECT quantity FROM inventory_stocks WHERE ingredient_id='rice'",
        )
        .first<{ quantity: number }>();
      expect(riceAfter?.quantity).toBe(1234);
    } finally {
      env.DB = database;
    }
  });
});
