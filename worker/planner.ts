import type { Ingredient, Recipe, Settings } from "./contracts";
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
  for (const item of recipe.items) {
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
export function chooseRecipe(
  recipes: Recipe[],
  stock: Map<string, number>,
  used: string[],
  settings: Settings,
  allowPurchase: boolean,
): Recipe {
  const candidates = recipes
    .map((recipe) => {
      const missing = recipe.items.reduce(
        (sum, i) =>
          sum + Math.max(0, i.amount - (stock.get(i.ingredientId) ?? 0)),
        0,
      );
      const missingKinds = recipe.items.filter(
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
  if (!candidates.length)
    throw new DomainError(
      "NO_FEASIBLE_DINNER",
      "在庫・調理時間・設備・アレルギー条件を満たす夕食がありません。在庫を補正するか、買い足しを許可し、条件を見直してください。",
      422,
    );
  return candidates[0].recipe;
}
