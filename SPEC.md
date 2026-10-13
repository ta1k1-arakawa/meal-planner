# Dinner Planner — Product / Technical Specification v1.4

## Scope and operating assumptions

Personal Japanese mobile-first PWA. Automatically schedule dinners only. Shopping on any day; two configurable weekdays are recommended cycle boundaries. One-person portions. Up to 30 minutes including prep. Run without a personal PC via Cloudflare Workers, D1 and static app deployment. Require access control. Target minimal ongoing cost; external vision AI may incur costs.

## Nutrition and default non-dinner behavior

Initial daily target: 2,800 kcal / 110g protein (estimate requiring weight-trend adjustment). Initial dinner target: 950 kcal / 40g protein; preferred 850–1050 kcal, >=35g protein. Breakfast preset is `none`; another optional preset is `two_mochi`, with edible grams and nutritional values configurable. Nighttime protein shake preset is one serving; brand/amount/water-or-milk/nutrients configurable. Day-specific override allowed. Lunch/snacks entered manually if desired. A preset is a forecast, NOT evidence it was consumed. In daily view show separate `confirmed`, `projected`, `unknown` values. If lunch is unrecorded, do NOT present daily sum as complete. Offer optional weight log and calculate 7-day trend; energy goal is user-editable.

## Inventory and measurements

One aggregate stock row per ingredient + unit if applicable, without expiration metadata. Canonical internal ingredient amounts in g for food (and ml for liquids where appropriate). Pack count/pieces may be retained as display units and converted using editable conversion coefficients; do not claim exact mass. Track an append-only movement ledger (`purchase`, `meal_consumption`, `manual_adjustment`, `correction`) and current quantity as a maintained aggregate. Safe concurrent updates must enforce stock >= 0. No expiry sorting. Storage type is optional. User is responsible for food safety.

Ingredients classified with `inventory_exempt=1` are pantry seasonings: initially `oil`, `soy`, `miso`, `sugar`, `curry`. Fresh `ginger` remains managed. Exempt ingredients need no inventory registration, purchase confirmation or actual-amount input, and produce no new stock movements. Exclude them from inventory forms, virtual reservations, deficit scoring and shopping recalculation, even at stock zero. Preserve pre-existing stocks, movements and shopping rows; exclude them in business logic rather than deleting historical data. Classification is a flag, not an ID allowlist in application logic.

## Recipe model

Recipes have name, serving yield, total estimated prep/cooking time, equipment, numbered instructions, labels, tags and optional user preference weight. Recipe-ingredient lines contain canonical measured quantities, optional substitutions, raw/cooked state and food composition source identifier. Dinner can be a dish or combo of dish+rice+side. Nutrient calculation from food ingredient reference amounts; snapshots committed on completion. Seed a tested catalog of 30–50 realistic 30-min meals; expand later. Some ingredient values are necessarily approximate; mark them.

All 30 initial recipes show named foods, exact canonical quantities, seasoning mixtures, preparation, order of addition and estimated heating times with safe doneness instructions. Group materials into managed foods and pantry seasonings. Keep seasonings in nutrition and allergen checks. Instruction templates use `{{ingredient_id}}` references resolved from `recipe_ingredients` into name + amount + unit; this table is the sole source of ingredient amounts. Canonical g/ml values are authoritative; do not imply exact equivalence to spoon volumes. Do not show tofu/egg preparation in recipes that do not use them. Retain the 950 kcal / 40 g dinner target and <=30-minute estimate.

## Planning lifecycle

`draft` -> `planned` -> `completed` or `skipped` (replanning can replace only open days). At shopping day, generate dinners until the day before the following shopping day using current stocks plus proposed purchases. Compute cumulative requirement and deficits for the shopping list. Keep the stock-only planner API available; the mobile shopping action always permits a reviewed purchase. Use virtual inventory reservations in chronological order. Avoid repeated recipes and penalize large leftover purchases. Ensure feasible portion scaling within 30 minutes. Never decrement actual stock for planned consumption. If a dinner changes, recompute open-day reservations and shopping shortfalls.

## Shopping lifecycle

`shopping_cycles`: date range, scheduled shopping date, status. `shopping_items`: planned need, proposed purchase, actual purchase, unit, review/confirmed status. On purchase confirmation, perform atomic stock increase + movement writes. Use an idempotency token to avoid double additions. Some purchases can be omitted or quantity-edited. Do not assume photo-extracted amount has been purchased until confirmed.

## Shopping schedule changes and recipe selection (Issue #4)

Keep arbitrary two distinct shopping weekdays editable. The current operation uses Tuesday/Saturday: Tuesday–Friday four dinners, Saturday–Monday three. Do not include shortages from past or pre-shopping dinners in the next period's purchase quantity; earlier open dinners reserve available actual stock, while valid future earlier proposals are projected once. Preview the next shopping period before its shopping date; show the actual shopping date and covered dates explicitly. Reading a preview never increases stock. Purchase confirmation means actual purchases, never intention to purchase.

Changing shopping weekdays requires explicit confirmation when pending lists exist. Mark old review cycles obsolete and recompute the next period from existing plans atomically with settings. Never overwrite existing recipes just for changing weekdays. Show unplanned dates and let the user explicitly generate the full next period. Completed/skipped dinners, confirmed cycles/items, inventory ledger and meal snapshots stay unchanged. Repair already stale reviews via the same confirmed operation even if the current setting already contains the new weekdays.

Use additive migration `0005`: obsolete flag and schedule snapshot on cycles, plus per-plan rejected recipes. Leave migrations `0001`–`0004` immutable. Keep obsolete records; exclude them and any reviews inconsistent with the current schedule from reads, purchase confirmation and projected purchases. If a review at the same unique start date is explicitly discarded, reuse its row with a higher version and recalculated unconfirmed items; never reuse or rewrite a confirmed row. The legacy cycle creation API rejects a conflicting confirmed start date; the daily shopping flow uses separate shopping runs for additional quantities without changing the original row. Settings/list/stock/plan versions guard atomic recomputation against concurrent writes.

Recipe changes offer up to five ranked candidates with missing named ingredient amounts, kcal/protein and cooking time. Viewing/cancelling does not mutate plans. Prefer distinct ingredient combinations before seasoning variations and allow paging through undisplayed candidates. Exclude the current recipe and recipes previously changed away from on the same plan. Empty/exhausted sets are explained; never silently reset exclusions. On user selection revalidate recipe, stock, equipment/allergen constraints and plan version, then update only that date, record the old recipe as rejected and reconcile all pending lists in one batch. Preserve later recipes and immutable purchases; stock-only requests require enough stock for the replacement and later dinners; purchase-enabled replacements create a separate supplemental review without editing confirmed purchases. The 30-recipe catalog is still largely five main ingredient families × six seasoning styles; new recipe families can be added independently.

## Mobile daily operation (Issue #6)

Show 今日 / 献立 / 買い物 / 在庫 / レシピ in the main navigation and a labelled settings gear in the header. Plans show only dates >= the server's Asia/Tokyo date; keep past records in D1 and leave completed-today display intact. Remove History UI, not meal log/correction APIs or immutable snapshots. Render candidates inline beneath their own recipe title, at most five per page. Expose busy state, prevent double submission with an immediate lock, keep keyed cards and page position, return focus without scrolling after closing, and recover version conflicts with fresh candidates. All successful changes refresh affected plans, stocks and purchases automatically. Read-only refresh runs on focus/visible/online and periodically while visible, pauses during edits, and never resends mutations.

POST /shopping/today is one explicit action for shopping now on any weekday. Use today through cycleEnd(today, recommendedDays). Preserve planned/draft recipes, completed and skipped plans; create recipes only for missing days. Calculate remaining planned dinner shortages using actual stock. Exclude past unhandled dinners, obsolete proposals and overlapping old unconfirmed periods. Retire expired/inconsistent/overlapping reviews without deleting their rows; preserve all confirmed purchases. Maintain one active pending shopping run per start date and create a separate run after a confirmed purchase, permitting real same-day top-ups without duplicating quantities. Read/reconcile legacy cycles and new runs together in chronological order, projecting valid earlier future proposals once.

Add migration 0006 to create shopping_runs and shopping_run_items with FK/CHECK/unique constraints. Do not rewrite migrations 0001–0005 or transform existing rows. Confirming a run uses the same operations idempotency and stock movement ledger in a single guarded D1 batch. Different-key competing confirmations cannot both succeed. Existing confirmed cycles, meal logs and purchase/stock history remain immutable. A record being hidden in UI does not authorize its deletion. Production deployment and remote migration remain manual and are not executed for this change.

## Photo recognition

Entry point: camera or library, multiple image types (goods, readable package labels, receipt). Server-side adapter interface for vision model to emit structured JSON with canonical name candidate, quantity, unit, raw text, estimated/confidence flags and unresolved items. No precise weights inferred from ambiguous objects alone. Match product to ingredients; require user review of all rows. Store recognition metadata, not raw images by default; ephemeral upload handling. Rate limit and size-limit requests, allow full manual fallback, maintain cost visibility. Confirm changes to inventory only via purchase confirmation or explicit stock addition; photo confirmation and shopping confirmation must not result in double addition.

## Meal completion transaction

Client allows review and editing of actually used grams (including rice and sides). API validates version, auth, nonnegative amounts, and sufficient stock. Single atomic batch: insert meal log with nutrient snapshot, insert detailed ingredient consumption lines, insert negative stock movements, decrement stocks, set plan completed, record idempotency key. Return newly committed meal log. Retry same key returns same result; a different key for already completed plan returns conflict. If lacking inventory, reject without writes and provide reconciliation UI. Corrections are audit logged and apply compensating movements transactionally. Skipping has no consumption and marks plan skipped.

Completion/correction request items contain managed ingredients only. The server automatically includes pantry seasonings at recipe default amounts in ingredient/nutrition snapshots, without consuming stock. Mark their amount source as `recipe_default`, distinct from actual input. On correction use defaults from the original immutable recipe snapshot, not a subsequently edited catalog; preserve saved seasoning nutrition references where available. Legacy snapshots lacking metadata use their original ingredient log reference values where derivable. Reject explicit new seasoning input. Identical pre-update requests already committed may still replay their original result without mutation.

Deployed migrations `0001`–`0003` are immutable. Apply classification, amount-source metadata and recipe-template updates via additive `0004` migration. Preserve existing stock quantities/versions, audit trails, original logs, corrections and recipe-ingredient quantities. Never run production migration or deployment automatically for this change.

## Proposed domain schema (conceptual)

- `ingredients(id,name,canonical_unit,nutrients_per_100,source,inventory_exempt,...)`
- `recipes(id,title,servings,total_minutes,instructions_json,...)`; `recipe_ingredients(recipe_id,ingredient_id,amount,unit,...)`
- `inventory_stocks(id,ingredient_id,quantity,unit,version,...)` with `UNIQUE(ingredient_id,unit)`; `inventory_movements(id,stock_id,delta,reason,source_id,idempotency_key,created_at)`
- `meal_plans(id,local_date,status,version,...)`; `meal_plan_dishes(id,plan_id,recipe_id,servings,...)`
- `meal_logs(id,plan_id,completed_at,total_kcal,total_protein_g,idempotency_key,...)`; `meal_log_items(id,log_id,ingredient_id,amount,unit,kcal,protein_g,amount_source,...)`
- `shopping_cycles(id,starts_on,ends_on,shopping_on,status,...)`; `shopping_items(id,cycle_id,ingredient_id,requested_amount,actual_amount,unit,status,...)`
- `photo_imports(id,status,created_at,model,...)`; `photo_import_items(id,import_id,ingredient_candidate,amount,unit,estimate_flag,raw_label,...)`
- `food_presets(id,kind,label,nutrients,quantity,enabled_by_default,...)`; `daily_food_entries(id,local_date,meal_type,preset_id,source,status,kcal,protein_g,...)`
- `body_weight_logs(id,local_date,weight_kg,...)`; `app_settings(id,timezone,targets,shopping_days,max_minutes,preferences,...)`
  Exact SQL schema, FKs, nullability, indexes and migrations to be designed and tested by implementation agent. For integrity use explicit keys, UNIQUE(plan_id) on completed logs and compare-and-swap/version guards for plan changes.

## Initial API and UX

Screens: Today (dinner + ingredients + preparation + kcal/protein), Plans (calendar & replace), Shopping (list & confirm), Inventory (manual/photo addition), Recipes (complete catalog), Settings (goals, days, presets). REST endpoints enumerated in AGENTS.md. Japanese local dates; timestamps stored UTC. Privacy by default: auth protected, secrets only on backend, no public inventory or images.

## MVP acceptance and milestone order

1. Setup/auth/migrations and tests; seed recipes/nutrition.
2. Inventory + atomic movement logic; unit conversion.
3. Dinner completion, skip, correction, idempotency and history.
4. Cycle-aware menu optimizer and shopping shortfall calculator.
5. Nutrition presets & daily summary distinguishing projected/confirmed.
6. Vision adapter with confirm-before-save and manual fallback.
7. PWA UX, deploy, errors and documentation.
   No external vision API is required to complete basic planning flows; stub tests must be explicitly labeled stubs.
