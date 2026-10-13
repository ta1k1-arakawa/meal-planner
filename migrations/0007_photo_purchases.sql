-- Append-only purchase evidence and new import state; never rewrite 0001-0006.
CREATE TABLE photo_purchase_meta (id INTEGER PRIMARY KEY CHECK(id=1), hash_salt TEXT NOT NULL);
INSERT INTO photo_purchase_meta VALUES (1,lower(hex(randomblob(32))));
CREATE TABLE photo_purchases (
 id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('processing','review','applied','failed','undone')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 receipt_hash TEXT UNIQUE, receipt_fingerprint TEXT,
 duplicate_of TEXT REFERENCES photo_purchases(id), possible_duplicate_id TEXT REFERENCES photo_purchases(id),
 purchase_date TEXT, linked_cycle_id TEXT, manual_candidates INTEGER NOT NULL DEFAULT 0 CHECK(manual_candidates>=0),
 relation TEXT NOT NULL DEFAULT 'unknown' CHECK(relation IN ('unknown','new','same','recorded')),
 model TEXT, error_code TEXT, image_count INTEGER NOT NULL CHECK(image_count BETWEEN 1 AND 4),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 lease_until TEXT NOT NULL, usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json))
);
CREATE TABLE photo_purchase_requests (
 request_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, purchase_id TEXT NOT NULL REFERENCES photo_purchases(id)
);
CREATE TABLE photo_purchase_images (
 image_hash TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES photo_purchases(id)
);
CREATE TABLE photo_purchase_items (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES photo_purchases(id),
 label TEXT NOT NULL, candidate_id TEXT REFERENCES ingredients(id),
 ingredient_id TEXT REFERENCES ingredients(id), amount INTEGER CHECK(amount BETWEEN 0 AND 1000000),
 applied_amount INTEGER NOT NULL DEFAULT 0 CHECK(applied_amount BETWEEN 0 AND 1000000),
 confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), auto_eligible INTEGER NOT NULL DEFAULT 0 CHECK(auto_eligible IN (0,1)),
 status TEXT NOT NULL CHECK(status IN ('pending','applied','ignored','undone')),
 reason TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 UNIQUE(purchase_id,label)
);
CREATE TABLE photo_purchase_credits (
 purchase_id TEXT NOT NULL REFERENCES photo_purchases(id), cycle_id TEXT NOT NULL,
 ingredient_id TEXT NOT NULL REFERENCES ingredients(id), amount INTEGER NOT NULL CHECK(amount>=0),
 manual_offset INTEGER NOT NULL DEFAULT 0 CHECK(manual_offset>=0 AND manual_offset<=amount),
 PRIMARY KEY(purchase_id,cycle_id,ingredient_id)
);
CREATE TABLE photo_purchase_audits (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES photo_purchases(id),
 version INTEGER NOT NULL CHECK(version>=1), kind TEXT NOT NULL CHECK(kind IN ('auto','resolve','correct','undo')),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)), after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(purchase_id,version)
);
CREATE TRIGGER photo_audit_no_update BEFORE UPDATE ON photo_purchase_audits BEGIN SELECT RAISE(ABORT,'immutable_photo_audit'); END;
CREATE TRIGGER photo_audit_no_delete BEFORE DELETE ON photo_purchase_audits BEGIN SELECT RAISE(ABORT,'immutable_photo_audit'); END;
CREATE TABLE photo_analysis_attempts (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES photo_purchases(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_photo_items ON photo_purchase_items(purchase_id);
CREATE INDEX idx_photo_credits_cycle ON photo_purchase_credits(cycle_id);
CREATE INDEX idx_photo_attempts_time ON photo_analysis_attempts(created_at);
CREATE TABLE photo_receipt_claims (
 fingerprint TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES photo_purchases(id)
);
