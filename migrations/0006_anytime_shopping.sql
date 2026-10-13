-- New purchase sessions allow multiple real shopping trips per calendar day.
-- Existing cycles, items, operations, stock and meal records remain untouched.
CREATE TABLE shopping_runs (
 id TEXT PRIMARY KEY, starts_on TEXT NOT NULL,
 ends_on TEXT NOT NULL CHECK(ends_on>=starts_on), shopping_on TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('review','confirmed')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 idempotency_key TEXT UNIQUE REFERENCES operations(idempotency_key),
 obsolete INTEGER NOT NULL DEFAULT 0 CHECK(obsolete IN (0,1)),
 shopping_days_json TEXT NOT NULL CHECK(json_valid(shopping_days_json))
);
CREATE UNIQUE INDEX idx_one_pending_run ON shopping_runs(starts_on) WHERE status='review' AND obsolete=0;
CREATE TABLE shopping_run_items (
 id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES shopping_runs(id),
 ingredient_id TEXT NOT NULL, requested_amount INTEGER NOT NULL CHECK(requested_amount>=0),
 proposed_amount INTEGER NOT NULL CHECK(proposed_amount>=0),
 actual_amount INTEGER CHECK(actual_amount>=0), unit TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('review','confirmed')),
 UNIQUE(cycle_id,ingredient_id), FOREIGN KEY(ingredient_id,unit) REFERENCES ingredients(id,unit)
);
CREATE INDEX idx_run_items ON shopping_run_items(cycle_id);
