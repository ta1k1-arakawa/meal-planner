// Purchase price caps for the bulking budget (owner rules, 2026-11-10).
// yenPer100 is expressed in the ingredient's canonical unit (g or ml), so a
// unit price from any purchase can be compared directly. Display labels keep
// the shopper-friendly form (per 100g, per egg, per litre, per 5kg bag).
export interface PriceCap {
  ingredientId: string;
  label: string;
  yenPer100: number;
  limitText: string;
}
export const PRICE_CAPS: PriceCap[] = [
  {
    ingredientId: "chicken",
    label: "鶏肉",
    yenPer100: 110,
    limitText: "100gあたり110円まで",
  },
  {
    ingredientId: "pork",
    label: "豚肉",
    yenPer100: 130,
    limitText: "100gあたり130円まで",
  },
  {
    ingredientId: "ground_meat",
    label: "挽き肉",
    yenPer100: 130,
    limitText: "100gあたり130円まで",
  },
  {
    // One egg is counted as 50g in the catalog conversion.
    ingredientId: "egg",
    label: "卵",
    yenPer100: 60,
    limitText: "1個30円まで",
  },
  {
    ingredientId: "milk",
    label: "牛乳",
    yenPer100: 24,
    limitText: "1Lあたり240円まで",
  },
  {
    // Cooked rice: a 5kg raw bag (about 11kg cooked) at 3,200 yen.
    ingredientId: "rice",
    label: "米",
    yenPer100: 29,
    limitText: "生米5kgで3,200円まで（炊飯済み100gあたり約29円）。高い時はパスタへ",
  },
  {
    ingredientId: "pasta",
    label: "パスタ",
    yenPer100: 25,
    limitText: "1kgあたり250円まで",
  },
];
export function priceCapFor(ingredientId: string): PriceCap | undefined {
  return PRICE_CAPS.find((c) => c.ingredientId === ingredientId);
}
/** Unit price in yen per 100 canonical units, or null when not computable. */
export function unitPriceYenPer100(
  priceYen: number,
  amount: number,
): number | null {
  if (!amount) return null;
  return Math.round((priceYen / amount) * 1000) / 10;
}
export function exceedsCap(
  ingredientId: string,
  priceYen: number,
  amount: number,
): boolean {
  const cap = priceCapFor(ingredientId);
  const unit = unitPriceYenPer100(priceYen, amount);
  return !!cap && unit !== null && unit > cap.yenPer100;
}
