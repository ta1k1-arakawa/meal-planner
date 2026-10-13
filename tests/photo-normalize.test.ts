import { describe, it, expect } from "vitest";
import { normalizePurchaseItems, receiptHash } from "../worker/photo-normalize";
import { imageDimensions } from "../worker/photo-upload";
import type { Ingredient } from "../worker/contracts";
import type { RecognizedItem, Recognition } from "../worker/photo-contracts";
const ingredient = (
  id: string,
  name: string,
  state: string,
  unit: Ingredient["unit"] = "g",
  conversion: number | null = null,
): Ingredient => ({
  id,
  name,
  state,
  unit,
  kcal_per_100: 0,
  protein_per_100: 0,
  source: "test",
  food_code: "test",
  allergens_json: "[]",
  display_unit: conversion ? "個" : null,
  grams_per_display_unit: conversion,
  inventory_exempt: 0,
});
const catalog = [
  ingredient("tomato", "トマト", "raw"),
  ingredient("egg", "鶏卵", "raw", "g", 50),
  ingredient("rice", "ご飯", "cooked"),
  ingredient("liquid", "テスト飲料", "ready", "ml"),
];
const item = (overrides: Partial<RecognizedItem> = {}): RecognizedItem => ({
  label: "トマト",
  ingredientId: "tomato",
  foodState: "raw",
  category: "food",
  amount: 200,
  unit: "g",
  packs: 1,
  quantityEvidence: "200g",
  countEvidence: "1個",
  confidence: 0.99,
  matchConfidence: 0.99,
  quantityConfidence: 0.99,
  ...overrides,
});
const normalized = (items: RecognizedItem[]) =>
  normalizePurchaseItems({ receipt: null, items }, catalog);
describe("conservative photo normalization", () => {
  it.each(["トマトソース", "ミニトマト", "卵豆腐", "トマトジュース"])(
    "does not substring-match %s to raw food",
    (label) => {
      expect(
        normalized([
          item({ label, ingredientId: label === "卵豆腐" ? "egg" : "tomato" }),
        ])[0].status,
      ).toBe("pending");
    },
  );
  it("uses visible quantity boundaries, never matching 50g inside 150g or inventing density", () => {
    expect(
      normalized([item({ amount: 50, quantityEvidence: "150g" })])[0].status,
    ).toBe("pending");
    expect(
      normalized([item({ unit: "ml", quantityEvidence: "200ml" })])[0].status,
    ).toBe("pending");
    expect(
      normalized([item({ packs: 2, countEvidence: "数量不明" })])[0].status,
    ).toBe("pending");
    expect(
      normalized([
        item({ amount: 0.0005, unit: "kg", quantityEvidence: "0.0005kg" }),
      ])[0].status,
    ).toBe("pending");
  });
  it("converts kg/l and configured pieces with retained conversion basis; no raw/cooked mapping", () => {
    expect(
      normalized([
        item({
          amount: 0.2,
          unit: "kg",
          quantityEvidence: "0.2kg",
          packs: 2,
          countEvidence: "2パック",
        }),
      ])[0].amount,
    ).toBe(400);
    const liquid = normalized([
      item({
        label: "テスト飲料",
        ingredientId: "liquid",
        foodState: "ready",
        amount: 0.5,
        unit: "l",
        quantityEvidence: "0.5L",
      }),
    ])[0];
    expect(liquid.amount).toBe(500);
    const egg = normalized([
      item({
        label: "鶏卵",
        ingredientId: "egg",
        amount: 10,
        unit: "count",
        quantityEvidence: "10個",
      }),
    ])[0];
    expect(egg.amount).toBe(500);
    expect(egg.evidence.amountPerUnit).toBe(50);
    const raw = normalized([
      item({ label: "無洗米", ingredientId: "rice", foodState: "raw" }),
    ])[0];
    expect(raw.ingredientId).toBeNull();
    expect(raw.amount).toBeNull();
  });
  it("does not double count duplicate receipt/product rows or uncertain matches", () => {
    const duplicated = normalized([item(), item()]);
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0].status).toBe("pending");
    expect(
      normalized([item({ ingredientId: "missing-food" })])[0].ingredientId,
    ).toBeNull();
  });
  it("creates a salted normalized identity only for valid high-confidence calendar/time evidence", async () => {
    const receipt: NonNullable<Recognition["receipt"]> = {
      merchant: "テスト店",
      localDateTime: "2026-10-13T12:30:05",
      total: 1200,
      currency: "JPY",
      receiptNumber: "A123",
      confidence: 0.99,
    };
    const hash = await receiptHash(receipt, "private-salt");
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(await receiptHash(receipt, "different-salt"));
    expect(
      await receiptHash(
        { ...receipt, localDateTime: "2026-02-30T12:30" },
        "salt",
      ),
    ).toBeNull();
    expect(
      await receiptHash(
        { ...receipt, localDateTime: "2026-10-13T24:30" },
        "salt",
      ),
    ).toBeNull();
    expect(
      await receiptHash({ ...receipt, confidence: 0.5 }, "salt"),
    ).toBeNull();
  });
  it("rejects forged MIME, truncated dimensions, and reads actual PNG dimensions", () => {
    expect(imageDimensions(new ArrayBuffer(2), "image/jpeg")).toBeNull();
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    expect(imageDimensions(png.buffer, "image/png")).toEqual([1, 1]);
    expect(imageDimensions(png.buffer, "image/jpeg")).toBeNull();
  });
});
