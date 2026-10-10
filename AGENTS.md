# AGENTS.md — Dinner Planner

## Mission

Build a private, mobile-first Japanese-language web app for one person that automatically plans **dinners only**, manages ingredient inventory, produces shopping lists for twice-weekly shopping, and records actual dinner nutrition. Follow `SPEC.md` as the product and data contract. If requirements conflict, prioritize data integrity, explicit user confirmation, and minimal daily input.

## Product defaults (all user-editable where applicable)

- Timezone and locale: `Asia/Tokyo`, `ja-JP`.
- Daily estimated energy goal: **2,800 kcal**; daily protein goal **110 g** (starting estimates, not medical advice).
- Dinner planning target: **950 kcal**, preferred **850–1,050 kcal**; protein target **40 g**, preferred minimum **35 g**.
- Dinner cooking-time hard ceiling **30 minutes** including preparation. Only dinner recipes are automatically scheduled.
- Breakfast default **none**; alternative preset **2 mochi**. User can override by day or edit presets. Do not silently assume breakfast was eaten.
- Bedtime protein preset **one serving**; configurable brand, serving size, liquid, kcal, protein, and default inclusion. Do not claim consumption without distinguishing estimate/preset from confirmed intake.
- Lunch and snacks are optional manual nutrition entries; do not plan them.
- Shopping: **twice per week**, weekdays configurable; generate all dinners until the next shopping day, taking planned consumption into account.
- **No expiration / best-before date tracking or prioritization.** This is a product scope choice, not a statement that food cannot spoil.
- Pantry seasonings (`inventory_exempt=1`; initially oil/soy/miso/sugar/curry) require no stock, purchase or actual-amount input. Fresh ginger remains managed. Keep every seasoning in ingredient display, nutrition and allergen checks.
- Photo import: support photographing products/labels/receipts; infer items and approximate quantities, clearly tag estimates and require human confirmation before inventory mutation.
- Prefer locally maintainable and low-cost architecture. Initial deployment target: Cloudflare Workers + D1 + React/TypeScript + Vite PWA. Private authentication required.

## Engineering workflow

1. Inspect repository and read `SPEC.md` before implementation. Establish project scaffolding only if absent.
2. Implement in vertical slices with tests: schema/migrations -> ingredient/recipe data -> stock mutation -> meal completion -> planner -> shopping -> photo import -> PWA/deployment.
3. Before large changes, summarize the intended files and acceptance tests. Never silently redefine product rules.
4. Keep schema and API types in sync. Use TypeScript strict mode; validate all API input at runtime (e.g. Zod). Use integer grams or explicit units with conversions; no unlabelled floats for inventory.
5. Never expose API secrets to the browser or commit `.env`, tokens, photos, or production data. Authenticate every private API route. Restrict photo uploads by type/size and avoid retaining images by default.
6. Provide migration scripts, seed data, `.env.example`, local run steps, tests and deployment notes. Do not require a personal PC to stay powered for deployed operation.
7. Execute lint, typecheck, unit tests and relevant integration tests after changes. Report what ran and any remaining failures honestly.
8. Never rewrite deployed migrations. Add a new migration and test a populated old database upgrade, preserving stock, append-only ledgers and immutable meal snapshots. Do not automatically apply this change to production.

## Invariants — critical

- **Plans are projections, not actual consumption.** Creating/editing a meal plan must not decrement actual stock.
- **Only confirmed shopping or an explicit stock adjustment increases stock.** AI photo recognition never updates inventory without user confirmation.
- **Only a successful, confirmed meal completion (or explicit correction) consumes stock.** Record actual ingredient amounts and nutrition as immutable snapshots for historical accuracy.
- Stock update, stock movement entries, meal log, and plan status change must be **atomic**. Use D1-compatible transactional statements / `batch()` and guard concurrent updates.
- Completion must be **idempotent**: each meal plan can be completed once; retry with the same idempotency key yields the same result without subtracting again. Conflicting completion attempts must fail safely.
- Detect insufficient inventory **before committing**. Do not permit negative stock by default. Offer a user-confirmed stock correction or substitution.
- Store adjustments/movements in an append-only audit trail. Correct previous entries via compensating movements rather than silent overwrites.
- A skipped dinner creates no consumed-ingredient record and does not reduce stock. Completed or skipped dates are never automatically overwritten.
- Re-planning must reserve/allocate ingredients in a **virtual inventory**, respecting already planned earlier dinners. Actual available stock remains separate from projected stock.
- All nutrition numbers must be calculated from explicit ingredient amounts and a cited/identified nutrition dataset; mark approximate values. Do not make up exact food weights from photos.
- The app must visually distinguish **planned**, **preset/estimated**, and **confirmed/eaten** nutrition totals.
- Exempt seasonings never create new stock movements. Historical stock/movement/shopping rows remain stored. Meal completion automatically snapshots recipe default amounts (`amount_source=recipe_default`); corrections use the original recipe snapshot and preserve default nutrition references, without modifying original logs.
- Every current recipe shows concrete names, quantities, seasoning mixtures and recipe-specific steps. Resolve instruction quantity placeholders from ingredient lines; never duplicate food weights in instruction prose. Show pantry ingredients separately and omit preparation for unused foods.

## Expected domain entities

`ingredients`, `recipes`, `recipe_ingredients`, `inventory_stocks`, `inventory_movements`, `meal_plans`, `meal_plan_dishes`, `meal_logs`, `meal_log_items`, `shopping_cycles`, `shopping_items`, `photo_imports`, `photo_import_items`, `food_presets`, `daily_food_entries`, `body_weight_logs`, `app_settings`. See `SPEC.md` for relationships and behaviors. Foreign keys, unique constraints, CHECK constraints and indexes are mandatory.

## API sketch

- `GET /api/today`, `GET /api/plans`, `POST /api/plans/generate`, `POST /api/plans/:id/regenerate`
- `POST /api/plans/:id/complete`, `POST /api/plans/:id/skip`
- `GET /api/inventory`, `POST /api/inventory/adjust`
- `GET /api/shopping/current`, `POST /api/shopping/:id/confirm`
- `POST /api/photo-imports`, `GET /api/photo-imports/:id`, `POST /api/photo-imports/:id/confirm`
- `GET /api/meal-logs`, `GET /api/daily-nutrition`, `PUT /api/daily-food-entries/:date`
- `GET /api/settings`, `PUT /api/settings`, `POST /api/body-weight-logs`
  Use versioned contracts or document breaking changes. Never implement AI recognition by presenting fabricated deterministic results as real detection.

## Planner constraints

- Hard: <=30 min estimated prep + cooking, dinner-only, no food allergy violations, suitable equipment, feasible portion amounts.
- When it is not shopping day, prioritize existing inventory. When planning for a shopping cycle, derive required purchase quantities from cumulative deficits across all dinners, not independently per recipe.
- Soft: dinner kcal/protein near target, minimize purchased leftovers, variety, fewer purchases, user preferences.
- If constraints are unsatisfiable, return a transparent explanation and viable user choices; do not produce an infeasible plan labeled as valid.
- In MVP, use a deterministic recipe catalog and rule-based search/scoring. External LLM is optional and must not be on the critical path for ordinary dinner generation.

## UI rules

Mobile-first Japanese interface with screens: 今日, 献立, 買い物, 在庫, 記録, 設定. Core actions should take few taps. Before stock-consuming actions show the amount and allow changes. Photo recognition must use an editable review table with confidence/estimate indicators. Show kcal, protein, cooking time, ingredients, cooking steps, and available vs missing materials. Meet accessible button targets and keyboard semantics.

## Testing acceptance checklist

- Create a three/four-day plan across two shopping dates without over-allocating shared ingredients.
- Confirm purchasing once, retry, and verify no duplicate stock additions.
- Complete dinner once, retry same request, verify one log and one stock deduction.
- Concurrent or conflicting completion requests do not double consume or drive stock negative.
- Modify actual grams at completion; stored nutrition and deduction reflect actual amounts.
- Skip dinner; no stock change and subsequent projected plans can be rebuilt.
- Change recipe after previous dinners completed; historical log stays unchanged.
- Upload photo -> recognize as _unverified_ -> edit quantities -> confirm -> only then update stock.
- Breakfast none vs mochi, nighttime shake default vs override; distinguish projections from confirmed food intake.
- Invalid inputs, nonauthenticated requests, upload errors and network retries handled clearly.
- With seasoning stock zero, managed foods alone permit generation/completion. No seasonings appear in purchase or amount-entry forms; oil's kcal and soy's allergens still count.
- Recipe default seasoning amounts survive correction/retry/catalog edits without any seasoning stock mutation.
- Upgrade populated 0001-0003 through 0004 and verify historical data preservation, including hidden pantry stock and shopping rows.
