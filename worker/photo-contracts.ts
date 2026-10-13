import { z } from "zod";
import { keySchema, versionSchema } from "./contracts";

const confidence = z.number().min(0).max(1);
export const recognitionSchema = z
  .object({
    receipt: z
      .object({
        merchant: z.string().min(1).max(120),
        localDateTime: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/),
        total: z.number().int().min(1).max(100000000),
        currency: z.literal("JPY"),
        receiptNumber: z.string().max(80).nullable(),
        confidence,
      })
      .strict()
      .nullable(),
    items: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            ingredientId: z.string().max(80).nullable(),
            foodState: z.enum(["raw", "cooked", "ready", "unknown"]),
            category: z.enum(["food", "seasoning", "nonfood", "unknown"]),
            amount: z.number().positive().max(1000000).nullable(),
            unit: z.enum(["g", "kg", "ml", "l", "count"]).nullable(),
            packs: z.number().int().min(1).max(1000).nullable(),
            quantityEvidence: z.string().max(200),
            countEvidence: z.string().max(100),
            confidence,
            matchConfidence: confidence,
            quantityConfidence: confidence,
          })
          .strict(),
      )
      .max(80),
  })
  .strict();
export type Recognition = z.infer<typeof recognitionSchema>;
export type RecognizedItem = Recognition["items"][number];
export const photoEditSchema = versionSchema
  .extend({
    idempotencyKey: keySchema,
    relation: z.enum(["new", "same", "recorded"]).optional(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            ingredientId: z.string().min(1).max(80).nullable(),
            amount: z.number().int().min(0).max(1000000),
          })
          .strict(),
      )
      .max(80)
      .refine((items) => new Set(items.map((i) => i.id)).size === items.length),
  })
  .strict();
export const photoUndoSchema = versionSchema
  .extend({ idempotencyKey: keySchema })
  .strict();
export interface PhotoItem {
  id: string;
  purchase_id: string;
  label: string;
  candidate_id: string | null;
  ingredient_id: string | null;
  amount: number | null;
  applied_amount: number;
  confidence: number;
  auto_eligible: number;
  status: "pending" | "applied" | "ignored" | "undone";
  reason: string;
  evidence_json: string;
}
export interface PhotoPurchase {
  id: string;
  status: "processing" | "review" | "applied" | "failed" | "undone";
  version: number;
  purchase_date: string | null;
  linked_cycle_id: string | null;
  relation: "unknown" | "new" | "same" | "recorded";
  model: string | null;
  error_code: string | null;
  image_count: number;
  created_at: string;
  lease_until: string;
  possible_duplicate_id: string | null;
  manual_candidates: number;
  items: PhotoItem[];
  duplicate?: boolean;
}
