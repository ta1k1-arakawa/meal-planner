import type { AmountItem, Ingredient, RecipeItem } from "./contracts";
import { DomainError } from "./planner";

export function recipeItem(
  item: AmountItem,
  ingredients: Ingredient[],
): RecipeItem {
  const ing = ingredients.find((i) => i.id === item.ingredientId);
  if (!ing) throw new DomainError("UNKNOWN_INGREDIENT", "未知の食材です", 422);
  return {
    ...item,
    name: ing.name,
    unit: ing.unit,
    inventory_exempt: ing.inventory_exempt === 1,
    kcal_per_100: ing.kcal_per_100,
    protein_per_100: ing.protein_per_100,
    source: ing.source,
    food_code: ing.food_code,
    state: ing.state,
  };
}

export function renderInstructions(
  template: string,
  items: RecipeItem[],
): string {
  const steps: string[] = JSON.parse(template);
  return JSON.stringify(
    steps.map((step) =>
      step.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_token, id: string) => {
        const item = items.find((i) => i.ingredientId === id);
        if (!item)
          throw new DomainError(
            "INVALID_RECIPE",
            "手順に必要な材料がありません",
            422,
          );
        return `${item.name} ${item.amount}${item.unit}`;
      }),
    ),
  );
}

// Current classification governs new inventory operations. Defaults and nutrient
// metadata come from the original recipe snapshot on correction, never a revised catalog.
export function actualItems(
  input: AmountItem[],
  defaults: AmountItem[],
  ingredients: Ingredient[],
): AmountItem[] {
  for (const item of input) {
    const ing = ingredients.find((i) => i.id === item.ingredientId);
    if (!ing)
      throw new DomainError("UNKNOWN_INGREDIENT", "未知の食材です", 422);
    if (ing.inventory_exempt === 1)
      throw new DomainError(
        "INVENTORY_EXEMPT",
        "常備調味料の使用量入力は不要です。レシピの既定量を自動計上します",
        422,
      );
  }
  return [
    ...input,
    ...defaults
      .filter(
        (item) =>
          ingredients.find((i) => i.id === item.ingredientId)
            ?.inventory_exempt === 1,
      )
      .map(({ ingredientId, amount }) => ({ ingredientId, amount })),
  ];
}
