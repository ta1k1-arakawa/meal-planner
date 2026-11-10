import { describe, expect, it } from "vitest";
import {
  addDays,
  tokyoDate,
  cycleEnd,
  nextShoppingDate,
  allocate,
  eligible,
  chooseRecipe,
  nutrition,
  rankSlotRecipes,
  slotTargetFor,
  weightAdvice,
  DEFAULT_SLOT_TARGETS,
} from "../worker/planner";
import type { Ingredient, Recipe, Settings } from "../worker/contracts";
const ingredients: Ingredient[] = [
  {
    id: "rice",
    name: "ご飯",
    unit: "g",
    kcal_per_100: 156,
    protein_per_100: 2.5,
    source: "MEXT2020 reference",
    food_code: "mext2020:ご飯",
    state: "cooked",
    allergens_json: "[]",
    display_unit: null,
    grams_per_display_unit: null,
    inventory_exempt: 0,
  },
];
const settings: Settings = {
  version: 0,
  dailyKcal: 2800,
  dailyProtein: 110,
  dinnerKcal: 950,
  dinnerProtein: 40,
  maxMinutes: 30,
  shoppingDays: [0, 3],
  equipment: ["フライパン"],
  allergies: [],
  excludedIngredients: [],
  monthlyBudgetYen: 25000,
  slotTargets: {
    lunch: { kcal: 1150, protein: 50 },
    snack: { kcal: 450, protein: 18 },
    nightSnack: { kcal: 325, protein: 13 },
    morningDrink: { kcal: 200, protein: 7 },
  },
};
const recipe: Recipe = {
  id: "rice",
  slot: "dinner",
  title: "テスト専用レシピ",
  total_minutes: 20,
  equipment_json: '["フライパン"]',
  instructions_json: "[]",
  preference_weight: 0,
  items: [
    {
      ...ingredients[0],
      ingredientId: "rice",
      amount: 350,
      inventory_exempt: false,
    },
  ],
  kcal: 546,
  protein: 8.75,
};
describe("deterministic planner rules", () => {
  it("uses Tokyo calendar boundaries and leap dates", () => {
    expect(tokyoDate(new Date("2026-10-09T15:00:00Z"))).toBe("2026-10-10");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("alternates 3 and 4 dinner days for twice-weekly shopping", () => {
    expect(cycleEnd("2026-10-11", [0, 3])).toBe("2026-10-13");
    expect(cycleEnd("2026-10-14", [0, 3])).toBe("2026-10-17");
  });
  it("previews Tue-Fri four dinners and Sat-Mon three before the shopping day", () => {
    expect(nextShoppingDate("2026-10-12", [2, 6])).toBe("2026-10-13");
    expect(cycleEnd("2026-10-13", [2, 6])).toBe("2026-10-16");
    expect(nextShoppingDate("2026-10-16", [2, 6])).toBe("2026-10-17");
    expect(cycleEnd("2026-10-17", [2, 6])).toBe("2026-10-19");
  });
  it("computes cumulative shortages rather than per-recipe independent deficits", () => {
    const stock = new Map([["rice", 400]]),
      deficits = new Map<string, number>();
    for (let i = 0; i < 4; i++) allocate(recipe, stock, deficits);
    expect(deficits.get("rice")).toBe(1000);
    expect(stock.get("rice")).toBe(0);
  });
  it("filters equipment, time, allergy and excluded ingredient constraints", () => {
    expect(eligible(recipe, settings, ingredients)).toBe(true);
    expect(eligible(recipe, { ...settings, maxMinutes: 19 }, ingredients)).toBe(
      false,
    );
    expect(eligible(recipe, { ...settings, equipment: [] }, ingredients)).toBe(
      false,
    );
    expect(
      eligible(
        recipe,
        { ...settings, excludedIngredients: ["rice"] },
        ingredients,
      ),
    ).toBe(false);
    expect(
      eligible(recipe, { ...settings, allergies: ["卵"] }, [
        { ...ingredients[0], allergens_json: '["卵"]' },
      ]),
    ).toBe(false);
  });
  it("explains infeasibility and chooses deterministically", () => {
    expect(() =>
      chooseRecipe([recipe], new Map(), [], settings, false),
    ).toThrow("条件を満たす");
    expect(chooseRecipe([recipe], new Map(), [], settings, true).id).toBe(
      "rice",
    );
  });
  it("calculates explicit amounts and rejects unknown foods", () => {
    expect(
      nutrition([{ ingredientId: "rice", amount: 100 }], ingredients),
    ).toEqual({ kcal: 156, protein: 2.5 });
    expect(() =>
      nutrition([{ ingredientId: "unknown", amount: 100 }], ingredients),
    ).toThrow("未知の食材");
  });
});

describe("pantry is nutrition, not virtual inventory", () => {
  it("keeps oil energy while excluding its absent stock from allocation and feasibility", () => {
    const oil: Ingredient = {
      ...ingredients[0],
      id: "oil",
      name: "油（テスト用）",
      kcal_per_100: 887,
      protein_per_100: 0,
      inventory_exempt: 1,
    };
    const items = [
      ...recipe.items,
      { ...oil, ingredientId: "oil", amount: 15, inventory_exempt: true },
    ];
    const dish = {
      ...recipe,
      items,
      ...nutrition(items, [...ingredients, oil]),
    };
    expect(dish.kcal).toBe(679.1);
    const stocks = new Map([["rice", 350]]),
      missing = new Map<string, number>();
    expect(chooseRecipe([dish], stocks, [], settings, false)).toEqual(dish);
    allocate(dish, stocks, missing);
    expect(missing.size).toBe(0);
    expect(stocks.has("oil")).toBe(false);
  });
});

describe("bulking slot ranking", () => {
  const snackRecipe = (id: string, amount: number, kcal: number, protein: number): Recipe => ({
    ...recipe,
    id,
    slot: "snack",
    title: id,
    kcal,
    protein,
    items: [
      {
        ...ingredients[0],
        ingredientId: "rice",
        amount,
        inventory_exempt: false,
        kcal_per_100: kcal / (amount / 100),
        protein_per_100: protein / (amount / 100),
      },
    ],
  });
  it("prefers the recipe closest to the slot target", () => {
    const close = snackRecipe("close", 100, 450, 18);
    const far = snackRecipe("far", 100, 250, 5);
    const stock = new Map([["rice", 10000]]);
    expect(
      rankSlotRecipes([far, close], stock, [], DEFAULT_SLOT_TARGETS.snack, false)[0].id,
    ).toBe("close");
  });
  it("maps slot names to the bulking targets and never targets breakfast", () => {
    const s: Settings = { ...settings, slotTargets: DEFAULT_SLOT_TARGETS };
    expect(slotTargetFor(s, "lunch")).toEqual({ kcal: 1150, protein: 50 });
    expect(slotTargetFor(s, "snack")).toEqual({ kcal: 450, protein: 18 });
    expect(slotTargetFor(s, "night_snack")).toEqual({ kcal: 325, protein: 13 });
    expect(slotTargetFor(s, "morning_drink")).toEqual({ kcal: 200, protein: 7 });
  });
});

describe("weight advice from 7-day averages", () => {
  const logs = (weights: number[], start = "2026-10-01") =>
    weights.map((weightKg, i) => ({ localDate: addDays(start, i), weightKg }));
  const week = (w: number) => Array.from({ length: 7 }, () => w);
  it("suggests +200 kcal at the night snack after two slow weeks", () => {
    const summary = weightAdvice(logs([...week(60), ...week(60.1), ...week(60.2)]));
    expect(summary.weeklyChangeKg).toBe(0.1);
    expect(summary.previousWeeklyChangeKg).toBe(0.1);
    expect(summary.advice.action).toBe("increase");
    expect(summary.advice.deltaKcal).toBe(200);
    expect(summary.advice.targetSlot).toBe("night_snack");
  });
  it("maintains inside the +0.2 to +0.4 kg/week band", () => {
    const summary = weightAdvice(logs([...week(60), ...week(60.3), ...week(60.6)]));
    expect(summary.advice.action).toBe("maintain");
  });
  it("suggests -200 kcal from the snack when gaining too fast", () => {
    const summary = weightAdvice(logs([...week(60), ...week(60.6), ...week(61.2)]));
    expect(summary.weeklyChangeKg).toBe(0.6);
    expect(summary.advice.action).toBe("decrease");
    expect(summary.advice.deltaKcal).toBe(-200);
    expect(summary.advice.targetSlot).toBe("snack");
  });
  it("waits for a second week before increasing", () => {
    const summary = weightAdvice(logs([...week(60), ...week(60.1)]));
    expect(summary.advice.action).toBe("watch");
  });
  it("reports insufficient data honestly", () => {
    expect(weightAdvice(logs([60, 60.2])).advice.action).toBe("insufficient");
    expect(weightAdvice([]).latestWeightKg).toBeNull();
  });
});
