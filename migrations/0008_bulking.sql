-- Bulking v2 (additive only). Never rewrite migrations 0001-0007.
-- Adds the no-breakfast bulking profile: whole-day slot plans, slot targets,
-- a monthly food budget, purchase prices, weight-based adjustment support and
-- a bulking recipe catalog. Existing plans, logs, stock and purchases stay.
PRAGMA foreign_keys = ON;
ALTER TABLE app_settings ADD COLUMN monthly_budget_yen INTEGER NOT NULL DEFAULT 25000 CHECK(monthly_budget_yen > 0);
ALTER TABLE app_settings ADD COLUMN slot_targets_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(slot_targets_json));
ALTER TABLE recipes ADD COLUMN slot TEXT NOT NULL DEFAULT 'dinner' CHECK(slot IN ('lunch','snack','dinner','night_snack','morning_drink'));
CREATE TABLE meal_slot_plans (
 id TEXT PRIMARY KEY, local_date TEXT NOT NULL CHECK(local_date GLOB '????-??-??'),
 slot TEXT NOT NULL CHECK(slot IN ('lunch','snack','night_snack','morning_drink')),
 recipe_id TEXT NOT NULL REFERENCES recipes(id),
 status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','completed','skipped')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(local_date, slot)
);
CREATE TABLE purchase_prices (
 cycle_id TEXT NOT NULL, ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
 price_yen INTEGER NOT NULL CHECK(price_yen >= 0),
 PRIMARY KEY(cycle_id, ingredient_id)
);
CREATE INDEX idx_slot_plans_date ON meal_slot_plans(local_date, slot);
CREATE INDEX idx_purchase_prices_ingredient ON purchase_prices(ingredient_id);
-- Owner bulking profile: 183cm, 60kg, muscle-centred gain, no breakfast.
UPDATE app_settings SET daily_kcal = 3000, daily_protein_g = 120, dinner_kcal = 1100, dinner_protein_g = 50, shopping_days_json = '[2,6]', monthly_budget_yen = 25000, slot_targets_json = '{"lunch":{"kcal":1150,"protein":50},"snack":{"kcal":450,"protein":18},"nightSnack":{"kcal":325,"protein":13},"morningDrink":{"kcal":200,"protein":7}}' WHERE id = 1;
UPDATE app_settings SET excluded_ingredients_json = CASE WHEN excluded_ingredients_json LIKE '%"oatmeal"%' THEN excluded_ingredients_json ELSE json_insert(excluded_ingredients_json, '$[#]', 'oatmeal') END WHERE id = 1;
UPDATE app_settings SET excluded_ingredients_json = CASE WHEN excluded_ingredients_json LIKE '%"peanut_butter"%' THEN excluded_ingredients_json ELSE json_insert(excluded_ingredients_json, '$[#]', 'peanut_butter') END WHERE id = 1;
-- New catalog ingredients. Values are approximate MEXT 2020 references.
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('oatmeal', 'オートミール', 'g', 380, 13.7, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:オートミール', 'dry', '[]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('peanut_butter', 'ピーナッツバター', 'g', 640, 25.0, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:ピーナッツバター', 'ready', '["落花生"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('pasta', 'スパゲッティ（乾）', 'g', 358, 13.0, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:スパゲッティ（乾）', 'dry', '["小麦"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('milk', '牛乳', 'ml', 67, 3.3, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:普通牛乳', 'ready', '["乳"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('banana', 'バナナ', 'g', 93, 1.1, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:バナナ', 'ready', '[]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('natto', '納豆', 'g', 200, 16.5, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:糸引き納豆', 'ready', '["大豆"]', 'パック', 50);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('yogurt', 'ヨーグルト（全脂無糖）', 'g', 62, 3.6, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:ヨーグルト', 'ready', '["乳"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('canned_mackerel', 'さば缶（水煮）', 'g', 190, 19.0, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:さば缶（水煮）', 'ready', '["さば"]', '缶', 150);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('canned_tuna', 'ツナ缶（油漬け）', 'g', 264, 17.3, '参考値（概算）', 'approx:ツナ缶（油漬け）', 'ready', '[]', '缶', 70);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('ground_meat', '合い挽き肉（生）', 'g', 210, 17.5, '参考値（概算）', 'approx:合い挽き肉', 'raw', '[]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('yakisoba_noodles', '焼きそば麺（蒸し）', 'g', 190, 5.0, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:蒸し中華麺', 'ready', '["小麦"]', '玉', 180);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('udon', 'うどん（ゆで）', 'g', 105, 2.6, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:うどん（ゆで）', 'cooked', '["小麦"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('bread', '食パン', 'g', 260, 9.0, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:食パン', 'ready', '["小麦", "乳"]', '枚', 60);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('cheese', 'プロセスチーズ', 'g', 340, 22.7, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:プロセスチーズ', 'ready', '["乳"]', '枚', 18);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('honey', 'はちみつ', 'g', 303, 0.3, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:はちみつ', 'ready', '[]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('cocoa', 'ココアパウダー', 'g', 270, 18.0, '参考値（概算）', 'approx:ピュアココア', 'ready', '[]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('castella', 'カステラ', 'g', 319, 5.3, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:カステラ', 'ready', '["卵", "小麦", "乳"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('bean_sprouts', 'もやし', 'g', 14, 1.7, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:りょくとうもやし', 'raw', '[]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('mayo', 'マヨネーズ', 'g', 703, 0.4, '日本食品標準成分表2020年版（八訂）・参考値（概算）', 'mext2020:マヨネーズ', 'ready', '["卵", "大豆"]', NULL, NULL);
INSERT INTO ingredients (id, name, unit, kcal_per_100, protein_per_100, source, food_code, state, allergens_json, display_unit, grams_per_display_unit) VALUES ('curry_roux', 'カレールー', 'g', 513, 6.5, '参考値（概算）', 'approx:カレールー', 'ready', '["小麦"]', NULL, NULL);
UPDATE ingredients SET inventory_exempt = 1 WHERE id IN ('mayo', 'curry_roux');
INSERT INTO inventory_stocks (ingredient_id, unit) SELECT id, unit FROM ingredients WHERE id IN ('oatmeal', 'peanut_butter', 'pasta', 'milk', 'banana', 'natto', 'yogurt', 'canned_mackerel', 'canned_tuna', 'ground_meat', 'yakisoba_noodles', 'udon', 'bread', 'cheese', 'honey', 'cocoa', 'castella', 'bean_sprouts', 'mayo', 'curry_roux');
-- Bulking recipes. Portions follow docs/bulking-v2.md and the owner meal plan.
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-oyakodon', '親子丼（増量）', 1, 20, '["フライパン"]', '["温かい炊飯済みの{{rice}}を用意する。", "{{chicken}}を一口大に切り、{{onion}}を薄切りにする。生肉に触れた手・包丁・まな板を洗う。", "フライパンに{{oil}}を熱し、{{soy}}と{{sugar}}を混ぜた煮汁で鶏肉とたまねぎを煮る。", "{{egg}}を溶いて回し入れ、卵と鶏肉の中心が75℃に達してから1分以上加熱する。", "ご飯にのせて盛り付ける。"]', '["増量", "昼食", "概算"]', 0, 'lunch');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'rice', 400, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'chicken', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'egg', 100, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'onion', 60, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'oil', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'soy', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-oyakodon', 'sugar', 6, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-curry-rice', 'カレーライス（増量）', 1, 25, '["鍋"]', '["温かい炊飯済みの{{rice}}を用意する。{{egg}}をゆでて殻をむき、中心が75℃に達してから1分以上加熱する。", "鍋に{{oil}}を熱し、{{ground_meat}}と薄切りにした{{onion}}を炒める。生肉に触れた道具を洗う。", "水を加えて煮立て、{{curry_roux}}を溶かし入れてとろみがつくまで煮る。肉の中心が75℃に達してから1分以上加熱する。", "ゆで卵と{{cheese}}をのせ、ご飯にかける。"]', '["増量", "昼食", "概算"]', 0, 'lunch');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'rice', 350, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'ground_meat', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'egg', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'cheese', 18, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'onion', 80, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'curry_roux', 20, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-curry-rice', 'oil', 10, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-teriyaki-don', '照り焼きチキン丼', 1, 20, '["フライパン"]', '["温かい炊飯済みの{{rice}}を用意する。", "{{chicken}}を一口大に切り、{{cabbage}}を千切りにする。生肉に触れた道具を洗う。", "フライパンに{{oil}}を熱して鶏肉を両面焼き、{{soy}}と{{sugar}}を絡める。中心が75℃に達してから1分以上加熱する。", "{{egg}}で目玉焼きを作り、中心が75℃に達してから1分以上加熱する。ご飯にキャベツと鶏肉をのせ、目玉焼きを添える。"]', '["増量", "昼食", "概算"]', 0, 'lunch');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'rice', 400, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'chicken', 180, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'egg', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'cabbage', 100, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'oil', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'soy', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-teriyaki-don', 'sugar', 6, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-yakisoba', '焼きそば大盛り', 1, 20, '["フライパン"]', '["{{pork}}を3cm幅に切り、{{bean_sprouts}}を洗う。生肉に触れた道具を洗う。", "フライパンに{{oil}}を熱し、豚肉と{{yakisoba_noodles}}をほぐしながら炒める。肉の中心が75℃に達してから1分以上加熱する。", "もやしを加えて炒め、{{soy}}と{{sugar}}で味を調える。{{egg}}で目玉焼きを作り、中心が75℃に達してから1分以上加熱してのせる。"]', '["増量", "昼食", "概算"]', 0, 'lunch');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'yakisoba_noodles', 360, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'pork', 120, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'bean_sprouts', 100, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'egg', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'oil', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'soy', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-yakisoba', 'sugar', 6, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-tuna-natto-don', 'ツナマヨ納豆丼', 1, 10, '[]', '["温かい炊飯済みの{{rice}}を用意する。", "{{canned_tuna}}の油を軽く切り、{{mayo}}と混ぜる。", "{{egg}}を耐熱容器に割り、電子レンジで中心が75℃に達してから1分以上加熱する。", "{{natto}}を混ぜ、ご飯にツナマヨと納豆、加熱した卵をのせ、{{soy}}をかける。"]', '["増量", "昼食", "概算"]', 0, 'lunch');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-tuna-natto-don', 'rice', 350, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-tuna-natto-don', 'canned_tuna', 140, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-tuna-natto-don', 'natto', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-tuna-natto-don', 'mayo', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-tuna-natto-don', 'egg', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-tuna-natto-don', 'soy', 10, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-saba-pasta', 'サバ缶パスタ', 1, 25, '["鍋", "フライパン"]', '["鍋で{{pasta}}を表示時間どおりゆでる。", "フライパンに{{oil}}と{{ginger}}を熱し、{{canned_mackerel}}を汁ごと加えてほぐす。", "ゆで上がったパスタとゆで汁少量を加え、{{soy}}で調えて全体を温める。"]', '["増量", "夕食", "概算"]', 0, 'dinner');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-saba-pasta', 'pasta', 180, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-saba-pasta', 'canned_mackerel', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-saba-pasta', 'oil', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-saba-pasta', 'ginger', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-saba-pasta', 'soy', 10, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-mabo-don', '麻婆豆腐丼', 1, 20, '["フライパン"]', '["温かい炊飯済みの{{rice}}を用意する。{{tofu}}を2cm角に切る。", "フライパンに{{oil}}を熱し、{{ground_meat}}とすりおろした{{ginger}}を炒める。生肉に触れた道具を洗い、肉の中心が75℃に達してから1分以上加熱する。", "{{miso}}、{{sugar}}、{{soy}}と水を加え、豆腐を加えて温める。ご飯にかける。"]', '["増量", "夕食", "概算"]', 0, 'dinner');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'rice', 300, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'tofu', 300, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'ground_meat', 120, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'oil', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'miso', 20, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'sugar', 5, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'soy', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-mabo-don', 'ginger', 10, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-pork-ginger', '豚の生姜焼き定食（増量）', 1, 20, '["フライパン"]', '["温かい炊飯済みの{{rice}}を用意する。", "{{pork}}を3cm幅に切り、{{cabbage}}を千切り、{{onion}}を薄切りにする。生肉に触れた道具を洗う。", "フライパンに{{oil}}を熱して豚肉とたまねぎを焼き、すりおろした{{ginger}}、{{soy}}、{{sugar}}を絡める。中心が75℃に達してから1分以上加熱し、キャベツを添える。"]', '["増量", "夕食", "概算"]', 0, 'dinner');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'rice', 400, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'pork', 180, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'cabbage', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'onion', 60, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'oil', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'soy', 15, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'ginger', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-pork-ginger', 'sugar', 6, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-chicken-nanban', 'チキン南蛮（増量）', 1, 25, '["フライパン"]', '["温かい炊飯済みの{{rice}}を用意する。{{cabbage}}を千切りにする。", "{{chicken}}を一口大に切り、{{oil}}を熱したフライパンで両面を焼く。生肉に触れた道具を洗い、中心が75℃に達してから1分以上加熱する。", "{{soy}}と{{sugar}}を絡める。{{egg}}をゆでて刻み、中心が75℃に達してから1分以上加熱したことを確認して{{mayo}}と混ぜたタルタルをかけ、キャベツを添える。"]', '["増量", "夕食", "概算"]', 0, 'dinner');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'rice', 350, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'chicken', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'egg', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'mayo', 20, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'cabbage', 100, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'oil', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'soy', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-chicken-nanban', 'sugar', 6, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('bulk-niku-udon', '肉うどん＋おにぎり', 1, 15, '["鍋"]', '["{{rice}}でおにぎりを作る。", "鍋に水、{{miso}}、{{soy}}を入れて温め、{{pork}}と{{udon}}を加える。生肉に触れた道具を洗い、肉の中心が75℃に達してから1分以上加熱する。", "{{egg}}を溶いて加え、中心が75℃に達してから1分以上加熱し、おにぎりと出す。"]', '["増量", "夕食", "概算"]', 0, 'dinner');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-niku-udon', 'udon', 500, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-niku-udon', 'pork', 100, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-niku-udon', 'egg', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-niku-udon', 'rice', 180, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-niku-udon', 'miso', 20, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('bulk-niku-udon', 'soy', 10, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('snack-milk-banana', '牛乳とバナナ', 1, 5, '[]', '["{{banana}}の皮をむき、冷えた{{milk}}と出す。"]', '["増量", "間食", "概算"]', 0, 'snack');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-milk-banana', 'milk', 500, 'ml');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-milk-banana', 'banana', 120, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('snack-onigiri-tuna', 'おにぎりとツナマヨ', 1, 5, '[]', '["{{rice}}でおにぎりを作る。", "{{canned_tuna}}の油を軽く切り、{{mayo}}と混ぜておにぎりに添える。"]', '["増量", "間食", "概算"]', 0, 'snack');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-onigiri-tuna', 'rice', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-onigiri-tuna', 'canned_tuna', 70, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-onigiri-tuna', 'mayo', 5, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('snack-bread-cheese', 'パン・チーズ・牛乳', 1, 5, '[]', '["{{bread}}に{{cheese}}をのせ、冷えた{{milk}}と出す。"]', '["増量", "間食", "概算"]', 0, 'snack');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-bread-cheese', 'bread', 90, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-bread-cheese', 'cheese', 18, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('snack-bread-cheese', 'milk', 200, 'ml');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('night-yogurt-honey', 'ヨーグルトとはちみつ', 1, 5, '[]', '["{{yogurt}}に{{honey}}をかけて混ぜる。"]', '["増量", "夜食", "概算"]', 0, 'night_snack');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-yogurt-honey', 'yogurt', 400, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-yogurt-honey', 'honey', 20, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('night-natto-rice', '納豆ご飯（夜食）', 1, 5, '["電子レンジ"]', '["{{rice}}は電子レンジで温める。", "{{natto}}を混ぜ、温かいご飯にのせて{{soy}}をかける。"]', '["増量", "夜食", "概算"]', 0, 'night_snack');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-natto-rice', 'rice', 150, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-natto-rice', 'natto', 50, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-natto-rice', 'soy', 10, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('night-milk-castella', '牛乳とカステラ', 1, 5, '[]', '["{{castella}}を切り分け、冷えた{{milk}}と出す。"]', '["増量", "夜食", "概算"]', 0, 'night_snack');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-milk-castella', 'milk', 250, 'ml');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('night-milk-castella', 'castella', 60, 'g');
INSERT INTO recipes (id, title, servings, total_minutes, equipment_json, instructions_json, tags_json, preference_weight, slot) VALUES ('morning-cocoa-milk', 'ココア牛乳（飲み物だけの朝用）', 1, 5, '["電子レンジ"]', '["{{milk}}を電子レンジで温め、{{cocoa}}と{{sugar}}をよく溶かす。固形の朝食ではなく、飲める日だけの任意枠。"]', '["増量", "朝の飲み物", "概算", "任意"]', 0, 'morning_drink');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('morning-cocoa-milk', 'milk', 200, 'ml');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('morning-cocoa-milk', 'cocoa', 10, 'g');
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit) VALUES ('morning-cocoa-milk', 'sugar', 10, 'g');
