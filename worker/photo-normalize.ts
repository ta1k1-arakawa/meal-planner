import type { Ingredient } from "./contracts";
import type { Recognition, RecognizedItem } from "./photo-contracts";
import { dateSchema } from "./contracts";

export const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・()（）]/g, "");
const aliases: Record<string, string[]> = {
  rice: ["パックご飯", "パックごはん", "炊飯済みご飯"],
  chicken: ["鶏もも肉皮なし", "皮なし鶏もも"],
  pork: ["豚もも赤身", "豚もも肉赤肉"],
  salmon: ["しろさけ", "白鮭"],
  tofu: ["木綿豆腐"],
  egg: ["鶏卵", "卵"],
  cabbage: ["キャベツ"],
  onion: ["たまねぎ", "玉ねぎ"],
  carrot: ["にんじん", "人参"],
  broccoli: ["ブロッコリー"],
  mushroom: ["ぶなしめじ"],
  tomato: ["トマト"],
  ginger: ["しょうが", "生姜"],
  soy: ["しょうゆ", "醤油", "こいくちしょうゆ"],
  oil: ["植物油", "サラダ油"],
  miso: ["みそ", "味噌"],
  sugar: ["砂糖"],
  curry: ["カレー粉"],
};
// Whole known names only: substring matches such as 「卵豆腐」「トマトソース」
// must never turn prepared/unknown products into raw catalog ingredients.
function matchesName(label: string, ingredient: Ingredient) {
  const name = normalized(label)
    .replace(/^(?:国産|国内産|北海道産|青森県産|日本産)/, "")
    .replace(/(?:\d+(?:\.\d+)?(?:kg|g|ml|l|個|丁|袋|パック|玉|本|点))+$/, "");
  return (aliases[ingredient.id] ?? [ingredient.name]).some(
    (alias) => name === normalized(alias),
  );
}
export interface NormalizedPhotoItem {
  label: string;
  candidateId: string | null;
  ingredientId: string | null;
  amount: number | null;
  confidence: number;
  status: "pending" | "applied" | "ignored";
  reason: string;
  evidence: {
    state: string;
    basis: string;
    packs: number | null;
    observedAmount: number | null;
    observedUnit: string | null;
    amountPerUnit: number | null;
  };
}

function quantity(item: RecognizedItem, ingredient: Ingredient) {
  if (
    item.amount === null ||
    !item.unit ||
    item.packs === null ||
    item.quantityConfidence < 0.97
  )
    return null;
  const text = normalized(item.quantityEvidence);
  const observed = String(item.amount);
  const unit = item.unit === "count" ? ingredient.display_unit : item.unit;
  const escaped = observed.replace(/\./g, "\\.");
  if (
    !unit ||
    !new RegExp(`(?:^|[^\\d.])${escaped}${normalized(unit)}(?:$|[^a-z])`).test(
      text,
    )
  )
    return null;
  if (
    item.packs > 1 &&
    !new RegExp(`(?:^|[^\\d])${item.packs}(?:パック|袋|点|個|丁|x|×)`).test(
      normalized(item.countEvidence),
    )
  )
    return null;
  let factor = 1,
    basis = "label",
    amountPerUnit: number | null = null;
  if (item.unit === "count") {
    if (!ingredient.grams_per_display_unit || !Number.isInteger(item.amount))
      return null;
    factor = ingredient.grams_per_display_unit;
    basis = "configured_conversion";
    amountPerUnit = factor;
  } else if (
    (item.unit === "g" || item.unit === "kg") &&
    ingredient.unit === "g"
  )
    factor = item.unit === "kg" ? 1000 : 1;
  else if (
    (item.unit === "ml" || item.unit === "l") &&
    ingredient.unit === "ml"
  )
    factor = item.unit === "l" ? 1000 : 1;
  else return null; // No invented density, spoon volumes or raw-to-cooked conversions.
  const amount = item.amount * factor * item.packs;
  if (
    Math.abs(amount - Math.round(amount)) > 1e-6 ||
    amount <= 0 ||
    amount > 1000000
  )
    return null;
  return { amount: Math.round(amount), basis, amountPerUnit };
}
export function normalizePurchaseItems(
  result: Recognition,
  ingredients: Ingredient[],
): NormalizedPhotoItem[] {
  const duplicates = new Set(
    result.items
      .filter(
        (item, index, all) =>
          all.findIndex(
            (other) => normalized(other.label) === normalized(item.label),
          ) !== index,
      )
      .map((item) => normalized(item.label)),
  );
  const seen = new Set<string>();
  return result.items
    .filter((item) => {
      const key = normalized(item.label);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => {
      const ingredient = ingredients.find((i) => i.id === item.ingredientId);
      const amount = ingredient ? quantity(item, ingredient) : null;
      const matched = !!ingredient && matchesName(item.label, ingredient);
      const rawRice = /精米|無洗米|玄米|もち米|生米/.test(item.label);
      const safeFood =
        !!ingredient &&
        matched &&
        !rawRice &&
        item.foodState === ingredient.state &&
        item.category === "food" &&
        item.confidence >= 0.97 &&
        item.matchConfidence >= 0.97 &&
        !duplicates.has(normalized(item.label));
      let status: NormalizedPhotoItem["status"] = "pending",
        reason = "食品を確認してください";
      if (duplicates.has(normalized(item.label)))
        reason = "同じ品名の複数行があり、数量の確認が必要です";
      else if (item.category === "nonfood" && item.confidence >= 0.97) {
        status = "ignored";
        reason = "食品以外のため在庫には登録しません";
      } else if (
        ingredient?.inventory_exempt === 1 &&
        matched &&
        item.matchConfidence >= 0.97
      ) {
        status = "ignored";
        reason = "常備調味料のため在庫登録は不要です";
      } else if (!ingredient || !matched || item.matchConfidence < 0.97)
        reason = "登録食材へ確実に対応付けられません";
      else if (rawRice || item.foodState !== ingredient.state)
        reason =
          "食品の状態が異なるか不明です。生米を炊飯済みご飯には加算しません";
      else if (!amount) reason = "表示された重量・個数・換算を確認してください";
      else if (item.confidence < 0.97 || item.category !== "food")
        reason = "画像だけでは確実に判断できません";
      else {
        status = "applied";
        reason =
          amount.basis === "configured_conversion"
            ? "表示個数と設定済み係数で換算"
            : "明示された分量を読み取り";
      }
      return {
        label: item.label,
        candidateId: ingredient?.id ?? null,
        ingredientId: safeFood ? ingredient!.id : null,
        amount:
          matched && !rawRice && item.foodState === ingredient?.state
            ? (amount?.amount ?? null)
            : null,
        confidence: Math.min(
          item.confidence,
          item.matchConfidence,
          item.quantityConfidence,
        ),
        status,
        reason,
        evidence: {
          state: item.foodState,
          basis: amount?.basis ?? "unknown",
          packs: item.packs,
          observedAmount: item.amount,
          observedUnit: item.unit,
          amountPerUnit: amount?.amountPerUnit ?? null,
        },
      };
    });
}
export async function digest(value: string | ArrayBuffer) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function receiptHash(
  receipt: Recognition["receipt"],
  salt: string,
) {
  if (!receipt || receipt.confidence < 0.97) return null;
  if (
    !dateSchema.safeParse(receipt.localDateTime.slice(0, 10)).success ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(
      receipt.localDateTime,
    )
  )
    return null;
  return digest(
    JSON.stringify([
      salt,
      normalized(receipt.merchant),
      receipt.localDateTime.slice(0, 16),
      receipt.total,
      receipt.currency,
      normalized(receipt.receiptNumber ?? ""),
    ]),
  );
}
