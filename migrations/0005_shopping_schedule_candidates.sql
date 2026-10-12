-- Additive only: preserve every existing cycle, item, purchase and meal record.
ALTER TABLE shopping_cycles ADD COLUMN obsolete INTEGER NOT NULL DEFAULT 0 CHECK(obsolete IN (0,1));
ALTER TABLE shopping_cycles ADD COLUMN shopping_days_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(shopping_days_json));
UPDATE shopping_cycles SET shopping_days_json=(SELECT shopping_days_json FROM app_settings WHERE id=1);
CREATE INDEX idx_cycles_active ON shopping_cycles(obsolete,status,shopping_on);
CREATE TABLE plan_recipe_rejections (
 plan_id TEXT NOT NULL REFERENCES meal_plans(id),
 recipe_id TEXT NOT NULL REFERENCES recipes(id),
 rejected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(plan_id,recipe_id)
);
