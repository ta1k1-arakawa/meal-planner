CREATE TABLE meal_log_corrections (
 id TEXT PRIMARY KEY, log_id TEXT NOT NULL REFERENCES meal_logs(id), version INTEGER NOT NULL CHECK(version>=1),
 items_snapshot TEXT NOT NULL CHECK(json_valid(items_snapshot)), total_kcal REAL NOT NULL CHECK(total_kcal>=0), total_protein_g REAL NOT NULL CHECK(total_protein_g>=0),
 idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(log_id,version)
);
CREATE TRIGGER correction_no_update BEFORE UPDATE ON meal_log_corrections BEGIN SELECT RAISE(ABORT,'immutable_correction'); END;
CREATE TRIGGER correction_no_delete BEFORE DELETE ON meal_log_corrections BEGIN SELECT RAISE(ABORT,'immutable_correction'); END;
CREATE INDEX idx_corrections_log ON meal_log_corrections(log_id,version);
