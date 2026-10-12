PRAGMA foreign_keys = ON;
CREATE TABLE ingredients (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
 unit TEXT NOT NULL CHECK(unit IN ('g','ml')),
 kcal_per_100 REAL NOT NULL CHECK(kcal_per_100>=0), protein_per_100 REAL NOT NULL CHECK(protein_per_100>=0),
 source TEXT NOT NULL, food_code TEXT NOT NULL, state TEXT NOT NULL,
 allergens_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allergens_json)),
 display_unit TEXT, grams_per_display_unit INTEGER CHECK(grams_per_display_unit>0),
 UNIQUE(id,unit)
);
CREATE TABLE recipes (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, servings INTEGER NOT NULL DEFAULT 1 CHECK(servings=1),
 total_minutes INTEGER NOT NULL CHECK(total_minutes BETWEEN 1 AND 30),
 equipment_json TEXT NOT NULL CHECK(json_valid(equipment_json)), instructions_json TEXT NOT NULL CHECK(json_valid(instructions_json)),
 tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)), preference_weight REAL NOT NULL DEFAULT 0
);
CREATE TABLE recipe_ingredients (
 recipe_id TEXT NOT NULL REFERENCES recipes(id), ingredient_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), unit TEXT NOT NULL,
 PRIMARY KEY(recipe_id,ingredient_id), FOREIGN KEY(ingredient_id,unit) REFERENCES ingredients(id,unit)
);
CREATE TABLE inventory_stocks (
 ingredient_id TEXT PRIMARY KEY, unit TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), FOREIGN KEY(ingredient_id,unit) REFERENCES ingredients(id,unit)
);
CREATE TABLE meal_plans (
 id TEXT PRIMARY KEY, local_date TEXT NOT NULL UNIQUE CHECK(local_date GLOB '????-??-??'),
 status TEXT NOT NULL CHECK(status IN ('draft','planned','completed','skipped')), version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE meal_plan_dishes (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE, recipe_id TEXT NOT NULL REFERENCES recipes(id),
 servings INTEGER NOT NULL DEFAULT 1 CHECK(servings=1), UNIQUE(plan_id,recipe_id)
);
CREATE TABLE operations (
 idempotency_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('adjust','complete','purchase','correction')),
 payload TEXT NOT NULL, result_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE meal_logs (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES meal_plans(id),
 completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 total_kcal REAL NOT NULL CHECK(total_kcal>=0), total_protein_g REAL NOT NULL CHECK(total_protein_g>=0),
 recipe_snapshot TEXT NOT NULL CHECK(json_valid(recipe_snapshot)),
 idempotency_key TEXT NOT NULL UNIQUE REFERENCES operations(idempotency_key)
);
CREATE TABLE meal_log_items (
 id TEXT PRIMARY KEY, log_id TEXT NOT NULL REFERENCES meal_logs(id), ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
 ingredient_name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), unit TEXT NOT NULL,
 kcal REAL NOT NULL CHECK(kcal>=0), protein_g REAL NOT NULL CHECK(protein_g>=0), source TEXT NOT NULL, food_code TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE shopping_cycles (
 id TEXT PRIMARY KEY, starts_on TEXT NOT NULL UNIQUE, ends_on TEXT NOT NULL CHECK(ends_on>=starts_on), shopping_on TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('review','confirmed')), version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 idempotency_key TEXT UNIQUE REFERENCES operations(idempotency_key)
);
CREATE TABLE shopping_items (
 id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES shopping_cycles(id), ingredient_id TEXT NOT NULL,
 requested_amount INTEGER NOT NULL CHECK(requested_amount>=0), proposed_amount INTEGER NOT NULL CHECK(proposed_amount>=0),
 actual_amount INTEGER CHECK(actual_amount>=0), unit TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('review','confirmed')),
 UNIQUE(cycle_id,ingredient_id), FOREIGN KEY(ingredient_id,unit) REFERENCES ingredients(id,unit)
);
CREATE TABLE inventory_movements (
 id TEXT PRIMARY KEY, ingredient_id TEXT NOT NULL REFERENCES inventory_stocks(ingredient_id), delta INTEGER NOT NULL CHECK(delta!=0),
 reason TEXT NOT NULL CHECK(reason IN ('purchase','meal_consumption','manual_adjustment','correction')),
 source_id TEXT NOT NULL, idempotency_key TEXT NOT NULL REFERENCES operations(idempotency_key),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(idempotency_key,ingredient_id)
);
-- A movement is the only writer of stock. CHECK(quantity>=0) aborts the entire D1 batch on races/shortfall.
CREATE TRIGGER movement_apply AFTER INSERT ON inventory_movements BEGIN
 UPDATE inventory_stocks SET quantity=quantity+NEW.delta, version=version+1 WHERE ingredient_id=NEW.ingredient_id;
END;
CREATE TRIGGER movement_no_update BEFORE UPDATE ON inventory_movements BEGIN SELECT RAISE(ABORT,'append_only_movement'); END;
CREATE TRIGGER movement_no_delete BEFORE DELETE ON inventory_movements BEGIN SELECT RAISE(ABORT,'append_only_movement'); END;
CREATE TRIGGER log_no_update BEFORE UPDATE ON meal_logs BEGIN SELECT RAISE(ABORT,'immutable_log'); END;
CREATE TRIGGER log_no_delete BEFORE DELETE ON meal_logs BEGIN SELECT RAISE(ABORT,'immutable_log'); END;
CREATE TRIGGER log_item_no_update BEFORE UPDATE ON meal_log_items BEGIN SELECT RAISE(ABORT,'immutable_log'); END;
CREATE TRIGGER log_item_no_delete BEFORE DELETE ON meal_log_items BEGIN SELECT RAISE(ABORT,'immutable_log'); END;
-- A failed CAS must throw, not silently affect zero rows and let the rest of a batch commit.
CREATE TABLE transaction_guards (ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE photo_imports (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('unverified','confirmed','failed')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, model TEXT);
CREATE TABLE photo_import_items (
 id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES photo_imports(id), ingredient_candidate TEXT,
 amount INTEGER CHECK(amount>=0), unit TEXT CHECK(unit IN ('g','ml')), estimate_flag INTEGER NOT NULL CHECK(estimate_flag IN (0,1)), raw_label TEXT,
 confidence REAL CHECK(confidence BETWEEN 0 AND 1)
);
CREATE TABLE food_presets (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('breakfast','bedtime')), label TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>=0), unit TEXT NOT NULL, kcal REAL NOT NULL CHECK(kcal>=0), protein_g REAL NOT NULL CHECK(protein_g>=0),
 enabled_by_default INTEGER NOT NULL CHECK(enabled_by_default IN (0,1)), details_json TEXT NOT NULL CHECK(json_valid(details_json))
);
CREATE TABLE daily_food_entries (
 id TEXT PRIMARY KEY, local_date TEXT NOT NULL, meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast','lunch','snack','bedtime')),
 preset_id TEXT REFERENCES food_presets(id), source TEXT NOT NULL CHECK(source IN ('manual','preset')), status TEXT NOT NULL CHECK(status IN ('projected','confirmed')),
 kcal REAL NOT NULL CHECK(kcal>=0), protein_g REAL NOT NULL CHECK(protein_g>=0), UNIQUE(local_date,meal_type)
);
CREATE TABLE body_weight_logs (id TEXT PRIMARY KEY, local_date TEXT NOT NULL UNIQUE, weight_kg REAL NOT NULL CHECK(weight_kg BETWEEN 20 AND 500));
CREATE TABLE app_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL CHECK(timezone='Asia/Tokyo'),
 daily_kcal INTEGER NOT NULL CHECK(daily_kcal>0), daily_protein_g INTEGER NOT NULL CHECK(daily_protein_g>0),
 dinner_kcal INTEGER NOT NULL CHECK(dinner_kcal>0), dinner_protein_g INTEGER NOT NULL CHECK(dinner_protein_g>0),
 max_minutes INTEGER NOT NULL CHECK(max_minutes BETWEEN 1 AND 30),
 shopping_days_json TEXT NOT NULL CHECK(json_valid(shopping_days_json)), equipment_json TEXT NOT NULL CHECK(json_valid(equipment_json)),
 allergies_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allergies_json)), excluded_ingredients_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(excluded_ingredients_json))
);
CREATE INDEX idx_movements_ingredient ON inventory_movements(ingredient_id,created_at);
CREATE INDEX idx_plans_status_date ON meal_plans(status,local_date);
CREATE INDEX idx_dishes_plan ON meal_plan_dishes(plan_id);
CREATE INDEX idx_recipe_ingredient ON recipe_ingredients(ingredient_id);
CREATE INDEX idx_log_items_log ON meal_log_items(log_id);
CREATE INDEX idx_shopping_cycle ON shopping_items(cycle_id);
CREATE INDEX idx_import_items ON photo_import_items(import_id);
CREATE INDEX idx_daily_date ON daily_food_entries(local_date);
CREATE INDEX idx_logs_completed ON meal_logs(completed_at);
