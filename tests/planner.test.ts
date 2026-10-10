import { describe, expect, it } from "vitest";
import {
  addDays,
  tokyoDate,
  cycleEnd,
  allocate,
  eligible,
  chooseRecipe,
  nutrition,
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
};
const recipe: Recipe = {
  id: "rice",
  title: "テスト専用レシピ",
  total_minutes: 20,
  equipment_json: '["フライパン"]',
  instructions_json: "[]",
  preference_weight: 0,
  items: [{ ingredientId: "rice", amount: 350 }],
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
