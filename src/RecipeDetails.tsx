import type {
  Ingredient,
  Recipe,
  RecipeItem,
  Stock,
} from "../worker/contracts";

export function RecipeDetails({
  recipe,
  ingredients,
  stocks,
}: {
  recipe: Recipe;
  ingredients: Ingredient[];
  stocks: Stock[];
}) {
  // Pre-0004 log snapshots may contain only IDs/amounts. Keep those snapshots intact
  // while using the ingredient catalog to supply missing display names and units.
  const items = recipe.items.map((item) => {
    const ingredient = ingredients.find((i) => i.id === item.ingredientId);
    return {
      ...item,
      name: item.name ?? ingredient?.name ?? item.ingredientId,
      unit: item.unit ?? ingredient?.unit ?? "g",
      inventory_exempt:
        item.inventory_exempt ?? ingredient?.inventory_exempt === 1,
    };
  });
  function list(values: RecipeItem[], managed: boolean) {
    return (
      <ul>
        {values.map((item) => {
          const stock = stocks.find((s) => s.id === item.ingredientId);
          return (
            <li key={item.ingredientId}>
              {item.name} {item.amount}
              {item.unit}
              {managed && (
                <small>
                  在庫 {stock?.quantity ?? 0}
                  {item.unit} / 単独の不足{" "}
                  {Math.max(0, item.amount - (stock?.quantity ?? 0))}
                  {item.unit}
                </small>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="recipe-details">
      <h3>在庫管理する食材</h3>
      {list(
        items.filter((i) => !i.inventory_exempt),
        true,
      )}
      <h3>調味料（在庫登録不要）</h3>
      {list(
        items.filter((i) => i.inventory_exempt),
        false,
      )}
      <p className="muted">
        調味料は常備している前提です。既定量を栄養に含めます。分量はg/mlを基準にしてください。
      </p>
      <h3>作り方</h3>
      <ol>
        {(JSON.parse(recipe.instructions_json) as string[]).map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <p className="muted">
        栄養は食品成分表に基づく概算。ご飯は炊飯済みの重量です。
      </p>
    </div>
  );
}
