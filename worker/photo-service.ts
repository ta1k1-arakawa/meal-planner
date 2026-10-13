import { z } from "zod";
import * as db from "./db";
import type { Cycle } from "./contracts";
import { DomainError, tokyoDate } from "./planner";
import {
  photoEditSchema,
  photoUndoSchema,
  type PhotoPurchase,
  type PhotoItem,
} from "./photo-contracts";
import { normalizePurchaseItems, receiptHash } from "./photo-normalize";
import {
  requirePhotoAI,
  recognizePhotos,
  PHOTO_MODEL,
  type PhotoAIEnv,
} from "./photo-ai";
import { parseUpload } from "./photo-upload";

interface Root extends Omit<PhotoPurchase, "items" | "duplicate"> {
  duplicate_of: string | null;
  receipt_hash: string | null;
  receipt_fingerprint: string | null;
}
async function root(database: D1Database, id: string) {
  const p = await db
    .stmt(database, "SELECT * FROM photo_purchases WHERE id=?", id)
    .first<Root>();
  if (!p) throw new DomainError("NOT_FOUND", "写真の登録履歴がありません", 404);
  return p;
}
export async function photoPurchase(
  database: D1Database,
  id: string,
  duplicate = false,
): Promise<PhotoPurchase> {
  const p = await root(database, id);
  if (p.duplicate_of) return photoPurchase(database, p.duplicate_of, true);
  // Explicit allowlist: never expose receipt hashes, salt or raw provider data.
  return {
    id: p.id,
    status: p.status,
    version: p.version,
    purchase_date: p.purchase_date,
    linked_cycle_id: p.linked_cycle_id,
    relation: p.relation,
    model: p.model,
    error_code: p.error_code,
    image_count: p.image_count,
    created_at: p.created_at,
    lease_until: p.lease_until,
    possible_duplicate_id: p.possible_duplicate_id,
    manual_candidates: p.manual_candidates,
    items: await db.rows<PhotoItem>(
      database,
      "SELECT * FROM photo_purchase_items WHERE purchase_id=? ORDER BY rowid",
      id,
    ),
    ...(duplicate ? { duplicate: true } : {}),
  };
}
export async function photoHistory(database: D1Database) {
  const ids = await db.rows<{ id: string }>(
    database,
    "SELECT id FROM photo_purchases WHERE duplicate_of IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 20",
  );
  return Promise.all(ids.map((p) => photoPurchase(database, p.id)));
}
function exhausted(p: Root) {
  return (
    p.status === "failed" ||
    (p.status === "processing" && p.lease_until < new Date().toISOString())
  );
}
async function manualOverlap(
  database: D1Database,
  date: string,
  ids: string[],
) {
  if (!ids.length) return [];
  return db.rows<{ source_id: string }>(
    database,
    `SELECT DISTINCT m.source_id FROM inventory_movements m JOIN operations o ON o.idempotency_key=m.idempotency_key WHERE m.reason='purchase' AND m.delta>0 AND json_extract(o.payload,'$.id')=m.source_id AND date(m.created_at,'+9 hours')=? AND m.ingredient_id IN (${ids.map(() => "?").join(",")}) ORDER BY m.created_at DESC`,
    date,
    ...ids,
  );
}
async function knownUpload(database: D1Database, key: string, hash: string) {
  const r = await db
    .stmt(
      database,
      "SELECT * FROM photo_purchase_requests WHERE request_key=?",
      key,
    )
    .first<{ payload_hash: string; purchase_id: string }>();
  if (!r) return null;
  if (r.payload_hash !== hash)
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "同じ再送キーに別の写真は使えません",
      409,
    );
  return photoPurchase(database, r.purchase_id);
}
export async function importPhotos(
  database: D1Database,
  env: PhotoAIEnv,
  request: Request,
) {
  const { key, images, payloadHash } = await parseUpload(request);
  const known = await knownUpload(database, key, payloadHash);
  if (known) return { ...known, duplicate: true };
  const claims = await db.rows<{ purchase_id: string }>(
    database,
    `SELECT DISTINCT purchase_id FROM photo_purchase_images WHERE image_hash IN (${images.map(() => "?").join(",")})`,
    ...images.map((i) => i.hash),
  );
  if (claims.length > 1)
    throw new DomainError(
      "PHOTO_MIXED_PURCHASES",
      "別々の登録に使った写真です。買い物ごとに撮影してください",
      409,
    );
  const existing = claims.length
    ? await root(database, claims[0].purchase_id)
    : null;
  if (existing && !exhausted(existing)) {
    const ownedImages = await db.rows<{ image_hash: string }>(
      database,
      "SELECT image_hash FROM photo_purchase_images WHERE purchase_id=?",
      existing.id,
    );
    if (images.some((i) => !ownedImages.some((o) => o.image_hash === i.hash)))
      throw new DomainError(
        "PHOTO_MIXED_PURCHASES",
        "登録済みの写真と新しい写真は混ぜられません。複数枚は最初にまとめて解析してください。保留項目は登録履歴から確認できます",
        409,
      );
    try {
      await db.atomic(database, [
        db.stmt(
          database,
          "INSERT INTO photo_purchase_requests VALUES (?,?,?)",
          key,
          payloadHash,
          existing.id,
        ),
      ]);
    } catch (error) {
      const retry = await knownUpload(database, key, payloadHash);
      if (retry) return retry;
      throw error;
    }
    return photoPurchase(database, existing.id, true);
  }
  // Failed import retries need the complete original image set and a fresh explicit key.
  if (existing) {
    const old = await db.rows<{ image_hash: string }>(
      database,
      "SELECT image_hash FROM photo_purchase_images WHERE purchase_id=?",
      existing.id,
    );
    if (
      old.length !== images.length ||
      old.some((o) => !images.some((i) => i.hash === o.image_hash))
    )
      throw new DomainError(
        "PHOTO_RETRY_IMAGES",
        "再解析には元の写真をすべて選んでください",
        409,
      );
  }
  requirePhotoAI(env);
  const id = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString(),
    lease = new Date(Date.now() + 120000).toISOString();
  const day = now.slice(0, 10) + "T00:00:00.000Z",
    month = now.slice(0, 7) + "-01T00:00:00.000Z";
  const limits = [
    db.guard(
      database,
      "(SELECT count(*) FROM photo_analysis_attempts WHERE created_at>=?)<5",
      day,
    ),
    db.guard(
      database,
      "(SELECT count(*) FROM photo_analysis_attempts WHERE created_at>=?)<60",
      month,
    ),
  ];
  const attempts = await db
    .stmt(
      database,
      "SELECT sum(created_at>=?) AS daily,count(*) AS monthly FROM photo_analysis_attempts WHERE created_at>=?",
      day,
      month,
    )
    .first<{ daily: number; monthly: number }>();
  if ((attempts?.daily ?? 0) >= 5 || (attempts?.monthly ?? 0) >= 60)
    throw new DomainError(
      "PHOTO_RATE_LIMIT",
      "解析回数の上限（日5回・月60回）です。手動入力を使えます",
      503,
    );
  const statements: D1PreparedStatement[] = [...limits];
  if (existing)
    statements.push(
      db.guard(
        database,
        "EXISTS(SELECT 1 FROM photo_purchases WHERE id=? AND version=? AND (status='failed' OR (status='processing' AND lease_until<?)))",
        id,
        existing.version,
        now,
      ),
      db.stmt(
        database,
        "UPDATE photo_purchases SET status='processing',error_code=NULL,version=version+1,lease_until=? WHERE id=?",
        lease,
        id,
      ),
    );
  else
    statements.push(
      db.stmt(
        database,
        "INSERT INTO photo_purchases(id,status,image_count,lease_until) VALUES (?,'processing',?,?)",
        id,
        images.length,
        lease,
      ),
      ...images.map((i) =>
        db.stmt(
          database,
          "INSERT INTO photo_purchase_images VALUES (?,?)",
          i.hash,
          id,
        ),
      ),
    );
  statements.push(
    db.stmt(
      database,
      "INSERT INTO photo_purchase_requests VALUES (?,?,?)",
      key,
      payloadHash,
      id,
    ),
    db.stmt(
      database,
      "INSERT INTO photo_analysis_attempts(id,purchase_id,created_at) VALUES (?,?,?)",
      crypto.randomUUID(),
      id,
      now,
    ),
  );
  try {
    await db.atomic(database, statements);
  } catch (error) {
    const retry = await knownUpload(database, key, payloadHash);
    if (retry) return retry;
    const winner = await db
      .stmt(
        database,
        "SELECT purchase_id FROM photo_purchase_images WHERE image_hash=?",
        images[0].hash,
      )
      .first<{ purchase_id: string }>();
    if (winner) return photoPurchase(database, winner.purchase_id, true);
    throw error;
  }
  const owned = await root(database, id);
  try {
    const ingredients = await db.ingredients(database);
    const { recognition, usage } = await recognizePhotos(
      env,
      images,
      ingredients,
    );
    const normalized = normalizePurchaseItems(recognition, ingredients);
    if (!normalized.length)
      throw new DomainError(
        "PHOTO_UNREADABLE",
        "食品を読み取れませんでした。撮り直すか手動入力を使ってください",
        422,
      );
    const salt = (await db
      .stmt(database, "SELECT hash_salt FROM photo_purchase_meta WHERE id=1")
      .first<{ hash_salt: string }>())!.hash_salt;
    const fingerprint = await receiptHash(
      recognition.receipt
        ? { ...recognition.receipt, receiptNumber: null }
        : null,
      salt,
    );
    // A receipt number is strong identity. Without one, ask whether equal shop/time/total is a second purchase.
    const strong =
      fingerprint && recognition.receipt?.receiptNumber?.trim()
        ? await receiptHash(recognition.receipt, salt)
        : null;
    const purchaseDate = fingerprint
      ? recognition.receipt!.localDateTime.slice(0, 10)
      : tokyoDate();
    const candidateIDs = normalized.flatMap((i) =>
      i.candidateId ? [i.candidateId] : [],
    );
    const manual = await manualOverlap(database, purchaseDate, candidateIDs);
    const potentialPhoto =
      !fingerprint && candidateIDs.length
        ? await db
            .stmt(
              database,
              `SELECT p.id FROM photo_purchases p WHERE p.id<>? AND p.duplicate_of IS NULL AND ((p.status='processing' AND date(p.created_at,'+9 hours')=?) OR (p.status IN ('review','applied','undone') AND p.purchase_date=? AND EXISTS(SELECT 1 FROM photo_purchase_items i WHERE i.purchase_id=p.id AND i.candidate_id IN (${candidateIDs.map(() => "?").join(",")})))) ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1`,
              id,
              purchaseDate,
              purchaseDate,
              ...candidateIDs,
            )
            .first<{ id: string }>()
        : null;
    const current = await db.shopping(database, tokyoDate());
    const linked =
      manual[0]?.source_id ??
      (purchaseDate === tokyoDate() && current?.status === "review"
        ? current.id
        : null);
    const stage = [
      db.guard(
        database,
        "EXISTS(SELECT 1 FROM photo_purchases WHERE id=? AND status='processing' AND version=? AND lease_until=?)",
        id,
        owned.version,
        owned.lease_until,
      ),
    ];
    if (fingerprint)
      stage.push(
        db.stmt(
          database,
          "INSERT OR IGNORE INTO photo_receipt_claims VALUES (?,?)",
          fingerprint,
          id,
        ),
      );
    stage.push(
      db.stmt(
        database,
        "UPDATE photo_purchases SET status='review',version=version+1,receipt_hash=?,receipt_fingerprint=?,possible_duplicate_id=COALESCE((SELECT purchase_id FROM photo_receipt_claims WHERE fingerprint=? AND purchase_id<>?),?),purchase_date=?,linked_cycle_id=?,manual_candidates=?,relation=CASE WHEN ?=0 AND ? IS NULL AND NOT EXISTS(SELECT 1 FROM photo_receipt_claims WHERE fingerprint=? AND purchase_id<>?) THEN 'new' ELSE 'unknown' END,model=?,usage_json=? WHERE id=?",
        strong,
        fingerprint,
        fingerprint,
        id,
        potentialPhoto?.id ?? null,
        purchaseDate,
        linked,
        manual.length,
        manual.length,
        potentialPhoto?.id ?? null,
        fingerprint,
        id,
        PHOTO_MODEL,
        usage,
        id,
      ),
    );
    for (const item of normalized)
      stage.push(
        db.stmt(
          database,
          "INSERT INTO photo_purchase_items(id,purchase_id,label,candidate_id,ingredient_id,amount,confidence,auto_eligible,status,reason,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          crypto.randomUUID(),
          id,
          item.label,
          item.candidateId,
          item.ingredientId,
          item.amount,
          item.confidence,
          item.status === "applied" ? 1 : 0,
          item.status === "ignored" ? "ignored" : "pending",
          item.reason,
          JSON.stringify(item.evidence),
        ),
      );
    try {
      await db.atomic(database, stage);
    } catch (error) {
      if (strong) {
        const other = await db
          .stmt(
            database,
            "SELECT id FROM photo_purchases WHERE receipt_hash=? AND id<>?",
            strong,
            id,
          )
          .first<{ id: string }>();
        if (other) {
          await db.atomic(database, [
            db.guard(
              database,
              "EXISTS(SELECT 1 FROM photo_purchases WHERE id=? AND version=? AND status='processing')",
              id,
              owned.version,
            ),
            db.stmt(
              database,
              "UPDATE photo_purchases SET duplicate_of=?,status='undone',version=version+1 WHERE id=?",
              other.id,
              id,
            ),
          ]);
          return photoPurchase(database, other.id, true);
        }
      }
      throw error;
    }
    const p = await photoPurchase(database, id);
    if (p.relation !== "unknown") {
      const eligible = p.items.filter(
        (i) => i.auto_eligible === 1 && i.ingredient_id && i.amount,
      );
      if (eligible.length || !p.items.some((i) => i.status === "pending")) {
        try {
          return await editPhoto(
            database,
            id,
            {
              version: p.version,
              idempotencyKey: `photo-auto:${id}`,
              items: eligible.map((i) => ({
                id: i.id,
                ingredientId: i.ingredient_id,
                amount: i.amount!,
              })),
            },
            "auto",
          );
        } catch (error) {
          if (!(error instanceof DomainError) || error.status !== 409)
            throw error;
          return photoPurchase(database, id);
        }
      }
    }
    return p;
  } catch (error) {
    const code =
      error instanceof DomainError ? error.code : "PHOTO_AI_UNAVAILABLE";
    // A late/failed attempt may not overwrite a newer retry or staged result.
    await db
      .stmt(
        database,
        "UPDATE photo_purchases SET status='failed',error_code=?,version=version+1 WHERE id=? AND version=? AND status='processing' AND lease_until=?",
        code,
        id,
        owned.version,
        owned.lease_until,
      )
      .run();
    return photoPurchase(database, id);
  }
}

type Edit = z.infer<typeof photoEditSchema>;
export async function editPhoto(
  database: D1Database,
  id: string,
  body: Edit,
  kind: "auto" | "resolve" | "correct" = "resolve",
) {
  return mutatePhoto(database, id, body, kind);
}
export async function undoPhoto(
  database: D1Database,
  id: string,
  body: z.infer<typeof photoUndoSchema>,
) {
  return mutatePhoto(database, id, { ...body, items: [] }, "undo");
}
async function mutatePhoto(
  database: D1Database,
  id: string,
  body: Edit,
  kind: "auto" | "resolve" | "correct" | "undo",
) {
  const payload = JSON.stringify({ photoId: id, action: kind, ...body });
  const opKind =
    kind === "auto" || kind === "resolve" ? "purchase" : "correction";
  const previous = await db.replay(
    database,
    body.idempotencyKey,
    opKind,
    payload,
  );
  if (previous) return photoPurchase(database, previous);
  const [p, ingredients] = await Promise.all([
    photoPurchase(database, id),
    db.ingredients(database),
  ]);
  const retried = await db.replay(
    database,
    body.idempotencyKey,
    opKind,
    payload,
  );
  if (retried) return photoPurchase(database, retried);
  if (
    p.id !== id ||
    !["review", "applied"].includes(p.status) ||
    p.version !== body.version
  )
    throw new DomainError(
      "PHOTO_CONFLICT",
      "写真の内容は変更済みです。履歴を読み直してください",
      409,
    );
  if (kind === "auto" && p.relation !== "new")
    throw new DomainError(
      "PHOTO_RELATION",
      "購入履歴との関係を確認してください",
      422,
    );
  const relation = body.relation ?? p.relation;
  if (relation === "unknown" && kind !== "undo")
    throw new DomainError(
      "PHOTO_RELATION",
      "登録済みの買い物か確認してください",
      422,
    );
  if (p.relation !== "unknown" && body.relation && body.relation !== p.relation)
    throw new DomainError(
      "PHOTO_RELATION",
      "確定済みの購入種別は変更できません。取り消して在庫を手動で調整してください",
      422,
    );
  if (
    relation === "same" &&
    (p.possible_duplicate_id || p.manual_candidates !== 1)
  )
    throw new DomainError(
      "PHOTO_RELATION",
      "対応する購入を一つに特定できません。登録済みか別の購入かを選んでください",
      422,
    );
  const after = p.items.map((i) => ({ ...i }));
  for (const edit of body.items) {
    const item = after.find((i) => i.id === edit.id);
    if (!item)
      throw new DomainError("PHOTO_ITEMS", "登録された行だけ変更できます", 422);
    if (kind === "resolve" && item.status !== "pending")
      throw new DomainError(
        "PHOTO_ITEMS",
        "確認は保留項目だけに使えます。登録済みの内容は訂正してください",
        422,
      );
    const ingredient = ingredients.find((i) => i.id === edit.ingredientId);
    if (edit.ingredientId && (!ingredient || ingredient.inventory_exempt))
      throw new DomainError(
        "PHOTO_INGREDIENT",
        "管理対象の食材を選んでください。調味料の在庫登録は不要です",
        422,
      );
    if (edit.amount > 0 && !ingredient)
      throw new DomainError(
        "PHOTO_INGREDIENT",
        "数量を登録する食材を選んでください",
        422,
      );
    if (
      edit.amount > 0 &&
      ingredient?.state === "cooked" &&
      ingredient.id === "rice" &&
      /精米|無洗米|玄米|もち米|生米/.test(item.label)
    )
      throw new DomainError(
        "PHOTO_STATE",
        "生米は炊飯済みご飯に登録できません。登録しないを選んでください",
        422,
      );
    item.ingredient_id = edit.ingredientId;
    item.amount = edit.amount;
    item.status = edit.amount > 0 ? "applied" : "ignored";
    item.reason = kind === "auto" ? item.reason : "ユーザーが確認・訂正";
  }
  if (kind === "undo" || relation === "recorded")
    for (const item of after) {
      item.amount = 0;
      item.applied_amount = 0;
      item.status = kind === "undo" ? "undone" : "ignored";
    }
  // Only explicit edits or safely eligible observations become accepted when resolving relationship.
  if (p.relation === "unknown" && relation !== "recorded" && kind !== "undo")
    for (const item of after) {
      if (
        item.status === "pending" &&
        item.auto_eligible &&
        item.ingredient_id &&
        item.amount
      ) {
        item.status = "applied";
      }
    }
  const beforeTotals = new Map<string, number>(),
    desired = new Map<string, number>();
  for (const item of p.items)
    if (item.ingredient_id)
      beforeTotals.set(
        item.ingredient_id,
        (beforeTotals.get(item.ingredient_id) ?? 0) + item.applied_amount,
      );
  for (const item of after)
    if (item.status === "applied" && item.ingredient_id)
      desired.set(
        item.ingredient_id,
        (desired.get(item.ingredient_id) ?? 0) + (item.amount ?? 0),
      );
  const cycle = p.linked_cycle_id
    ? await db.cycleById(database, p.linked_cycle_id)
    : null;
  if (
    kind !== "undo" &&
    p.relation === "new" &&
    p.manual_candidates === 0 &&
    !p.items.some((i) => i.applied_amount > 0)
  ) {
    const overlapping = await manualOverlap(
      database,
      p.purchase_date ?? tokyoDate(),
      p.items.flatMap((i) => (i.candidate_id ? [i.candidate_id] : [])),
    );
    if (overlapping.length) {
      await db.atomic(database, [
        db.guard(
          database,
          "EXISTS(SELECT 1 FROM photo_purchases WHERE id=? AND version=? AND status='review')",
          id,
          p.version,
        ),
        db.stmt(
          database,
          "UPDATE photo_purchases SET relation='unknown',manual_candidates=?,linked_cycle_id=?,version=version+1 WHERE id=?",
          overlapping.length,
          overlapping[0].source_id,
          id,
        ),
      ]);
      throw new DomainError(
        "PHOTO_MANUAL_CONFLICT",
        "解析中に手動購入が確定されました。同じ買い物か確認してください",
        409,
      );
    }
  }
  if (
    kind !== "undo" &&
    relation === "new" &&
    p.manual_candidates === 0 &&
    cycle?.status === "confirmed"
  ) {
    const confirmedItems = await db.cycleItems(database, cycle);
    if (
      body.items.some(
        (edit) =>
          edit.amount > 0 &&
          p.items.find((i) => i.id === edit.id)?.status === "pending" &&
          confirmedItems.some(
            (i) =>
              i.ingredient_id === edit.ingredientId &&
              (i.actual_amount ?? 0) > 0,
          ),
      )
    )
      throw new DomainError(
        "PHOTO_PENDING_MANUAL_OVERLAP",
        "この保留食品は手動で購入確定した履歴と重なります。同じ購入なら「登録しない」を選んでください。別の購入なら在庫タブから追加できます",
        422,
      );
  }
  const credits = await db.rows<{
    purchase_id: string;
    ingredient_id: string;
    amount: number;
    manual_offset: number;
  }>(
    database,
    "SELECT purchase_id,ingredient_id,amount,manual_offset FROM photo_purchase_credits WHERE cycle_id=? ORDER BY purchase_id,ingredient_id",
    p.linked_cycle_id ?? "",
  );
  const offsets = new Map<string, number>();
  if (relation === "same" && kind !== "undo") {
    if (!cycle || cycle.status !== "confirmed")
      throw new DomainError("PHOTO_RELATION", "購入履歴を確認できません", 409);
    const manualItems = await db.cycleItems(database, cycle);
    for (const [ingredientId, amount] of desired) {
      const recorded =
        manualItems.find((i) => i.ingredient_id === ingredientId)
          ?.actual_amount ?? 0;
      const credited = credits
        .filter((c) => c.purchase_id !== id && c.ingredient_id === ingredientId)
        .reduce((n, c) => n + c.manual_offset, 0);
      offsets.set(
        ingredientId,
        Math.min(amount, Math.max(0, recorded - credited)),
      );
    }
  }
  const target = new Map(
    [...desired].map(([i, n]) => [i, n - (offsets.get(i) ?? 0)]),
  );
  const remaining = new Map(target);
  for (const item of after) {
    const amount =
      item.status === "applied" && item.ingredient_id
        ? Math.min(item.amount ?? 0, remaining.get(item.ingredient_id) ?? 0)
        : 0;
    item.applied_amount = amount;
    if (item.ingredient_id)
      remaining.set(
        item.ingredient_id,
        (remaining.get(item.ingredient_id) ?? 0) - amount,
      );
  }
  const deltas = new Map<string, number>();
  for (const ingredientId of new Set([
    ...beforeTotals.keys(),
    ...target.keys(),
  ])) {
    const d =
      (target.get(ingredientId) ?? 0) - (beforeTotals.get(ingredientId) ?? 0);
    if (d) deltas.set(ingredientId, d);
  }
  const statements = await db.reconcileShopping(database, {
    stockDeltas: deltas,
  });
  statements.push(
    db.guard(
      database,
      "EXISTS(SELECT 1 FROM photo_purchases WHERE id=? AND version=? AND status IN ('review','applied'))",
      id,
      body.version,
    ),
  );
  if (cycle)
    statements.unshift(
      db.guard(
        database,
        `EXISTS(SELECT 1 FROM ${db.cycleTable(cycle)} WHERE id=? AND version=? AND status=?)`,
        cycle.id,
        cycle.version,
        cycle.status,
      ),
    );
  // Guard credit rows even for confirmed lists: two imports cannot consume the same manual offset.
  statements.push(
    db.guard(
      database,
      "(SELECT count(*) FROM photo_purchase_credits WHERE cycle_id=?)=?",
      p.linked_cycle_id ?? "",
      credits.length,
    ),
  );
  for (const credit of credits)
    statements.push(
      db.guard(
        database,
        "EXISTS(SELECT 1 FROM photo_purchase_credits WHERE purchase_id=? AND cycle_id=? AND ingredient_id=? AND amount=? AND manual_offset=?)",
        credit.purchase_id,
        p.linked_cycle_id!,
        credit.ingredient_id,
        credit.amount,
        credit.manual_offset,
      ),
    );
  for (const [ingredientId, delta] of deltas)
    statements.push(
      db.movement(
        database,
        ingredientId,
        delta,
        delta > 0 && opKind === "purchase" ? "purchase" : "correction",
        id,
        body.idempotencyKey,
      ),
    );
  for (const item of after)
    statements.push(
      db.stmt(
        database,
        "UPDATE photo_purchase_items SET ingredient_id=?,amount=?,applied_amount=?,status=?,reason=? WHERE id=?",
        item.ingredient_id,
        item.amount,
        item.applied_amount,
        item.status,
        item.reason,
        item.id,
      ),
    );
  if (cycle) {
    statements.push(
      db.stmt(
        database,
        "DELETE FROM photo_purchase_credits WHERE purchase_id=?",
        id,
      ),
    );
    for (const [ingredientId, amount] of desired)
      statements.push(
        db.stmt(
          database,
          "INSERT INTO photo_purchase_credits(purchase_id,cycle_id,ingredient_id,amount,manual_offset) VALUES (?,?,?,?,?)",
          id,
          cycle.id,
          ingredientId,
          amount,
          offsets.get(ingredientId) ?? 0,
        ),
      );
  }
  const status =
    kind === "undo"
      ? "undone"
      : after.some((i) => i.status === "pending")
        ? "review"
        : "applied";
  statements.push(
    db.stmt(
      database,
      "UPDATE photo_purchases SET status=?,relation=?,version=version+1 WHERE id=?",
      status,
      relation,
      id,
    ),
    db.stmt(
      database,
      "INSERT INTO photo_purchase_audits(id,purchase_id,version,kind,before_json,after_json,idempotency_key) VALUES (?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      id,
      p.version + 1,
      kind,
      JSON.stringify({ relation: p.relation, items: p.items }),
      JSON.stringify({ relation, items: after }),
      body.idempotencyKey,
    ),
  );
  await db.idempotentBatch(
    database,
    body.idempotencyKey,
    opKind,
    payload,
    id,
    statements,
  );
  return photoPurchase(database, id);
}
export async function photoCredits(database: D1Database, cycle: Cycle) {
  return db.rows<{ ingredient_id: string; amount: number }>(
    database,
    "SELECT ingredient_id,sum(amount-manual_offset) AS amount FROM photo_purchase_credits WHERE cycle_id=? GROUP BY ingredient_id HAVING sum(amount-manual_offset)>0",
    cycle.id,
  );
}
