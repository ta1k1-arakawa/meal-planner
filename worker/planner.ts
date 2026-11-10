import type {
  Ingredient,
  Recipe,
  Settings,
  SlotPlanSlot,
  SlotTarget,
  SlotTargets,
  WeightSummary,
} from "./contracts";
export const DEFAULT_SLOT_TARGETS: SlotTargets = {
  lunch: { kcal: 1150, protein: 50 },
  snack: { kcal: 450, protein: 18 },
  nightSnack: { kcal: 325, protein: 13 },
  morningDrink: { kcal: 200, protein: 7 },
};
export function slotTargetFor(
  settings: Settings,
  slot: SlotPlanSlot,
): SlotTarget {
  return slot === "lunch"
    ? settings.slotTargets.lunch
    : slot === "snack"
      ? settings.slotTargets.snack
      : slot === "night_snack"
        ? settings.slotTargets.nightSnack
        : settings.slotTargets.morningDrink;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 503 = 409,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function tokyoDate(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
    now,
  );
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function cycleEnd(start: string, shoppingDays: number[]): string {
  for (let n = 1; n <= 7; n++)
    if (
      shoppingDays.includes(
        new Date(addDays(start, n) + "T00:00:00Z").getUTCDay(),
      )
    )
      return addDays(start, n - 1);
  throw new DomainError(
    "INVALID_SHOPPING_DAYS",
    "買い物曜日を設定してください",
    422,
  );
}
export function nextShoppingDate(date: string, days: number[]): string {
  for (let n = 0; n < 7; n++) {
    const candidate = addDays(date, n);
    if (days.includes(new Date(candidate + "T00:00:00Z").getUTCDay()))
      return candidate;
  }
  throw new DomainError(
    "INVALID_SHOPPING_DAYS",
    "買い物曜日を設定してください",
    422,
  );
}
export function sameShoppingDays(a: number[], b: number[]) {
  return [...a].sort().join(",") === [...b].sort().join(",");
}
export function currentSchedule(
  cycle: {
    obsolete: number;
    shopping_days_json: string;
    starts_on: string;
    ends_on: string;
    shopping_on: string;
  },
  days: number[],
) {
  return (
    !cycle.obsolete &&
    sameShoppingDays(JSON.parse(cycle.shopping_days_json), days) &&
    cycle.shopping_on === cycle.starts_on &&
    cycle.ends_on === cycleEnd(cycle.starts_on, days)
  );
}
export function nutrition(
  items: { ingredientId: string; amount: number }[],
  ingredients: Ingredient[],
) {
  let kcal = 0,
    protein = 0;
  for (const item of items) {
    const ing = ingredients.find((i) => i.id === item.ingredientId);
    if (!ing)
      throw new DomainError("UNKNOWN_INGREDIENT", "未知の食材です", 422);
    kcal += (item.amount * ing.kcal_per_100) / 100;
    protein += (item.amount * ing.protein_per_100) / 100;
  }
  return {
    kcal: Math.round(kcal * 10) / 10,
    protein: Math.round(protein * 10) / 10,
  };
}
export function eligible(
  recipe: Recipe,
  settings: Settings,
  ingredients: Ingredient[],
): boolean {
  return (
    recipe.total_minutes <= Math.min(30, settings.maxMinutes) &&
    (JSON.parse(recipe.equipment_json) as string[]).every((e) =>
      settings.equipment.includes(e),
    ) &&
    recipe.items.every((item) => {
      const ing = ingredients.find((i) => i.id === item.ingredientId);
      return (
        !!ing &&
        !settings.excludedIngredients.includes(ing.id) &&
        !(JSON.parse(ing.allergens_json) as string[]).some((a) =>
          settings.allergies.includes(a),
        )
      );
    })
  );
}
export function allocate(
  recipe: Recipe,
  stock: Map<string, number>,
  deficits: Map<string, number>,
) {
  for (const item of recipe.items.filter((i) => !i.inventory_exempt)) {
    const available = stock.get(item.ingredientId) ?? 0;
    const missing = Math.max(0, item.amount - available);
    if (missing)
      deficits.set(
        item.ingredientId,
        (deficits.get(item.ingredientId) ?? 0) + missing,
      );
    stock.set(item.ingredientId, Math.max(0, available - item.amount));
  }
}
export function rankRecipes(
  recipes: Recipe[],
  stock: Map<string, number>,
  used: string[],
  settings: Settings,
  allowPurchase: boolean,
): Recipe[] {
  const candidates = recipes
    .map((recipe) => {
      const managedItems = recipe.items.filter((i) => !i.inventory_exempt);
      const missing = managedItems.reduce(
        (sum, i) =>
          sum + Math.max(0, i.amount - (stock.get(i.ingredientId) ?? 0)),
        0,
      );
      const missingKinds = managedItems.filter(
        (i) => i.amount > (stock.get(i.ingredientId) ?? 0),
      ).length;
      const score =
        Math.abs(recipe.kcal - settings.dinnerKcal) / 5 +
        Math.abs(recipe.protein - settings.dinnerProtein) * 2 +
        Math.max(0, 35 - recipe.protein) * 10 +
        missing / 20 +
        missingKinds * 8 +
        used.filter((id) => id === recipe.id).length * 150 -
        recipe.preference_weight;
      return { recipe, missing, score };
    })
    .filter((c) => allowPurchase || c.missing === 0)
    .sort(
      (a, b) => a.score - b.score || a.recipe.id.localeCompare(b.recipe.id),
    );
  return candidates.map((c) => c.recipe);
}
export function rankSlotRecipes(
  recipes: Recipe[],
  stock: Map<string, number>,
  used: string[],
  target: SlotTarget,
  allowPurchase: boolean,
): Recipe[] {
  const candidates = recipes
    .map((recipe) => {
      const managedItems = recipe.items.filter((i) => !i.inventory_exempt);
      const missing = managedItems.reduce(
        (sum, i) =>
          sum + Math.max(0, i.amount - (stock.get(i.ingredientId) ?? 0)),
        0,
      );
      const missingKinds = managedItems.filter(
        (i) => i.amount > (stock.get(i.ingredientId) ?? 0),
      ).length;
      const score =
        Math.abs(recipe.kcal - target.kcal) / 5 +
        Math.abs(recipe.protein - target.protein) * 2 +
        Math.max(0, target.protein - 5 - recipe.protein) * 10 +
        missing / 20 +
        missingKinds * 8 +
        used.filter((id) => id === recipe.id).length * 150 -
        recipe.preference_weight;
      return { recipe, missing, score };
    })
    .filter((c) => allowPurchase || c.missing === 0)
    .sort(
      (a, b) => a.score - b.score || a.recipe.id.localeCompare(b.recipe.id),
    );
  return candidates.map((c) => c.recipe);
}
export function chooseSlotRecipe(
  recipes: Recipe[],
  stock: Map<string, number>,
  used: string[],
  target: SlotTarget,
  allowPurchase: boolean,
): Recipe {
  const candidates = rankSlotRecipes(recipes, stock, used, target, allowPurchase);
  if (!candidates.length)
    throw new DomainError(
      "NO_FEASIBLE_MEAL",
      "在庫・調理時間・設備・アレルギー・苦手食材の条件を満たす料理がありません。在庫を補正するか、買い足しを許可し、条件を見直してください。",
      422,
    );
  return candidates[0];
}
const round2 = (n: number) => Math.round(n * 100) / 100;
/**
 * 7-day-average weight advice. Averages need at least 3 logs inside a 7-day
 * window to count. Gain is judged week over week on those averages:
 * over +0.5kg/week trims the snack, under +0.2kg/week for two consecutive
 * weeks adds 200 kcal to the night snack.
 */
export function weightAdvice(
  logs: { localDate: string; weightKg: number }[],
): WeightSummary {
  const sorted = [...logs].sort((a, b) => a.localDate.localeCompare(b.localDate));
  const insufficient: WeightSummary["advice"] = {
    action: "insufficient",
    deltaKcal: 0,
    targetSlot: null,
    message:
      "体重データが足りません。毎朝同じ条件で測り、7日平均が3件以上たまると判定できます。",
  };
  if (!sorted.length)
    return {
      latestWeightKg: null,
      currentWeekAverageKg: null,
      previousWeekAverageKg: null,
      recentAverageKg: null,
      recentLogDays: 0,
      weeklyChangeKg: null,
      previousWeeklyChangeKg: null,
      advice: insufficient,
    };
  const latest = sorted[sorted.length - 1];
  // Display-only average over the recorded days in the current window.
  // The advice computation below keeps requiring >=3 days per window.
  const recentWindow = sorted.filter(
    (l) =>
      l.localDate > addDays(latest.localDate, -7) &&
      l.localDate <= latest.localDate,
  );
  const recentAverageKg = recentWindow.length
    ? round2(
        recentWindow.reduce((sum, l) => sum + l.weightKg, 0) /
          recentWindow.length,
      )
    : null;
  const average = (fromExclusive: string, toInclusive: string) => {
    const window = sorted.filter(
      (l) => l.localDate > fromExclusive && l.localDate <= toInclusive,
    );
    if (window.length < 3) return null;
    return round2(
      window.reduce((sum, l) => sum + l.weightKg, 0) / window.length,
    );
  };
  const current = average(addDays(latest.localDate, -7), latest.localDate);
  const previous = average(
    addDays(latest.localDate, -14),
    addDays(latest.localDate, -7),
  );
  const beforePrevious = average(
    addDays(latest.localDate, -21),
    addDays(latest.localDate, -14),
  );
  const weeklyChange =
    current !== null && previous !== null
      ? round2(current - previous)
      : null;
  const previousWeeklyChange =
    previous !== null && beforePrevious !== null
      ? round2(previous - beforePrevious)
      : null;
  let advice: WeightSummary["advice"] = insufficient;
  if (weeklyChange !== null) {
    if (weeklyChange > 0.5)
      advice = {
        action: "decrease",
        deltaKcal: -200,
        targetSlot: "snack",
        message: `7日平均が週${weeklyChange > 0 ? "+" : ""}${weeklyChange}kgと増えすぎです。間食から200kcal減らしてください。`,
      };
    else if (weeklyChange < 0.2) {
      if (previousWeeklyChange !== null && previousWeeklyChange < 0.2)
        advice = {
          action: "increase",
          deltaKcal: 200,
          targetSlot: "night_snack",
          message:
            "7日平均の増加が2週続けて週+0.2kg未満です。夜食に+200kcal（例：ご飯100g追加）してください。",
        };
      else
        advice = {
          action: "watch",
          deltaKcal: 0,
          targetSlot: null,
          message:
            "7日平均の増加が週+0.2kg未満ですが、判定は2週連続が条件です。もう1週間同じ条件で様子を見てください。",
        };
    } else
      advice = {
        action: "maintain",
        deltaKcal: 0,
        targetSlot: null,
        message: `7日平均が週+${weeklyChange}kgで目標範囲（+0.2〜0.4kg）です。今の食事量を維持してください。`,
      };
  }
  return {
    latestWeightKg: latest.weightKg,
    currentWeekAverageKg: current,
    previousWeekAverageKg: previous,
    recentAverageKg,
    recentLogDays: recentWindow.length,
    weeklyChangeKg: weeklyChange,
    previousWeeklyChangeKg: previousWeeklyChange,
    advice,
  };
}
export function chooseRecipe(
  recipes: Recipe[],
  stock: Map<string, number>,
  used: string[],
  settings: Settings,
  allowPurchase: boolean,
): Recipe {
  const candidates = rankRecipes(recipes, stock, used, settings, allowPurchase);
  if (!candidates.length)
    throw new DomainError(
      "NO_FEASIBLE_DINNER",
      "在庫・調理時間・設備・アレルギー条件を満たす夕食がありません。在庫を補正するか、買い足しを許可し、条件を見直してください。",
      422,
    );
  return candidates[0];
}
