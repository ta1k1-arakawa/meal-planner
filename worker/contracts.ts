import { z } from "zod";
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "実在する日付を指定してください");
export const keySchema = z.string().min(8).max(128);
export const itemSchema = z
  .object({
    ingredientId: z.string().min(1).max(80),
    amount: z.number().int().min(0).max(1000000),
  })
  .strict();
export const itemsSchema = z
  .array(itemSchema)
  .min(1)
  .max(80)
  .refine(
    (a) => new Set(a.map((i) => i.ingredientId)).size === a.length,
    "食材が重複しています",
  );
export const adjustSchema = z
  .object({
    ingredientId: z.string().min(1),
    delta: z
      .number()
      .int()
      .min(-1000000)
      .max(1000000)
      .refine((n) => n !== 0),
    version: z.number().int().min(0),
    idempotencyKey: keySchema,
    displayUnit: z.boolean().default(false),
  })
  .strict();
export const completeSchema = z
  .object({
    version: z.number().int().min(0),
    idempotencyKey: keySchema,
    items: itemsSchema,
  })
  .strict();
export const purchaseSchema = completeSchema.extend({
  items: z
    .array(itemSchema)
    .max(80)
    .refine(
      (a) => new Set(a.map((i) => i.ingredientId)).size === a.length,
      "食材が重複しています",
    ),
});
export const generateSchema = z
  .object({ startDate: dateSchema, allowPurchase: z.boolean().default(false) })
  .strict();
export const versionSchema = z
  .object({ version: z.number().int().min(0) })
  .strict();
export const settingsSchema = z
  .object({
    version: z.number().int().min(0),
    dailyKcal: z.number().int().min(500).max(6000),
    dailyProtein: z.number().int().min(1).max(500),
    dinnerKcal: z.number().int().min(200).max(2000),
    dinnerProtein: z.number().int().min(1).max(200),
    maxMinutes: z.number().int().min(1).max(30),
    shoppingDays: z
      .array(z.number().int().min(0).max(6))
      .length(2)
      .refine((a) => a[0] !== a[1]),
    equipment: z.array(z.string().min(1).max(50)).max(20),
    allergies: z.array(z.string().min(1).max(50)).max(30),
    excludedIngredients: z.array(z.string().min(1).max(80)).max(80),
  })
  .strict();
export interface Ingredient {
  id: string;
  name: string;
  unit: "g" | "ml";
  kcal_per_100: number;
  protein_per_100: number;
  source: string;
  food_code: string;
  state: string;
  allergens_json: string;
  display_unit: string | null;
  grams_per_display_unit: number | null;
  inventory_exempt: number;
}
export interface AmountItem {
  ingredientId: string;
  amount: number;
}
export interface RecipeItem extends AmountItem {
  name: string;
  unit: "g" | "ml";
  inventory_exempt: boolean;
  kcal_per_100: number;
  protein_per_100: number;
  source: string;
  food_code: string;
  state: string;
}
export interface Stock extends Ingredient {
  quantity: number;
  version: number;
}
export interface Recipe {
  id: string;
  title: string;
  total_minutes: number;
  equipment_json: string;
  instructions_json: string;
  preference_weight: number;
  items: RecipeItem[];
  kcal: number;
  protein: number;
}
export interface Settings {
  version: number;
  dailyKcal: number;
  dailyProtein: number;
  dinnerKcal: number;
  dinnerProtein: number;
  maxMinutes: number;
  shoppingDays: number[];
  equipment: string[];
  allergies: string[];
  excludedIngredients: string[];
}
export interface Plan {
  id: string;
  local_date: string;
  status: "draft" | "planned" | "completed" | "skipped";
  version: number;
  recipe: Recipe;
}
export interface ShoppingItem {
  ingredient_id: string;
  name: string;
  requested_amount: number;
  proposed_amount: number;
  actual_amount: number | null;
  unit: string;
}
export interface Cycle {
  id: string;
  starts_on: string;
  ends_on: string;
  shopping_on: string;
  status: "review" | "confirmed";
  version: number;
  items: ShoppingItem[];
}
export interface MealLog {
  id: string;
  plan_id: string;
  completed_at: string;
  total_kcal: number;
  total_protein_g: number;
  recipe_snapshot: string;
}
export interface NutritionSummary {
  confirmed: { kcal: number; protein: number };
  projected: { kcal: number; protein: number };
  unknown: string[];
  presets: { id: string; label: string; kcal: number; protein_g: number }[];
}
