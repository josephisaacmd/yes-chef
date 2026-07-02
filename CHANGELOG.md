# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.10.0] — 2026-07-02

Phase 2 of the predictive-model roadmap: the scorer itself.

### Changed — Pick algorithm v2 (per-meal cadence, kicks, reactions)

- Every meal is now scored on **its own re-eat clock** learned from Christine's
  history (median gap between eats), replacing the one-size-fits-all avoid
  window: score is low right after eating, peaks at the meal's typical gap,
  and decays to a floor when long overdue (old favourites stay suggestible).
  Meals with <3 eats inherit their tags' cadence, then the global cadence.
- **Kick detector**: eaten 2+ times within a week and still fresh → boost
  ("on a kick 🔥"); 3+ eats in two weeks gone quiet → satiation cooldown.
  A meal keeping its normal weekly cadence is *not* treated as a kick.
- **Reaction memory**: 😣 sat_poorly within 45 days → strong suppression;
  👍 liked → mild boost. **Rejection memory**: suggested-and-passed-over in
  the last 7 days → small penalty.
- **Eater-aware**: scores compute from the requested eater's history
  (default `christine` = entries she ate). Joseph's cafeteria lunches never
  pollute her model.
- **Explainable**: every suggestion carries a `_why` (e.g. "typically every
  ~9d, last eaten 8d ago · on a kick 🔥"), shown in the top-5 UI.
- `scoreMeals()` is exported as a deterministic function (accepts a `today`
  override) — the hook for Phase 3 backtesting. `npm test` runs
  `scripts/test-scorer.js`, 11 assertions over synthetic household patterns.
- Recommendations accept `?date=` and exclude meals occupying adjacent meal
  occasions; hard avoid-days default dropped from 14 → 1 everywhere (the
  cadence model handles longer horizons).

---

## [0.9.0] — 2026-07-02

Phase 1 of the predictive-model roadmap: capture the data the future scorer
will learn from (who ate what, which suggestions landed, what sat poorly).

### Added — Eater attribution

- `entries.eater` (`joseph | christine | both`, default `both` for existing
  rows). Slot-aware defaults on create: lunch/breakfast/side → `christine`
  (her packed lunch), dinner/no-slot → `both`. Accepted by `/api/entries`,
  `/api/v1/agent/entries`, and the MCP `log_meal` tool; "Who ate" selects in
  the Pick view and History add dialog stay synced to the slot.

### Added — Suggestion logging + outcome feedback

- New `suggestion_log` table: every logged batch of offered suggestions, one
  row per meal, with rank, context (slot/date/eater/tags/variety), and outcome
  (`offered | chosen | passed | rejected`).
- `GET /api/v1/agent/recommendations?log=1&slot=&date=&eater=` records the
  batch and returns `batch_id`; `POST /api/v1/agent/suggestions/:batchId/outcome`
  records `{ chosen_meal_id }` or `{ none: true }`; `GET /api/v1/agent/suggestions`
  lists recent batches. The Pick tab's top-5 logs automatically — tapping
  **Pick** records the choice, and a new **✗ None of these** records a decline.
- MCP: `get_recommendations` gains `log/slot/date/eater` params; new
  `record_suggestion_outcome` tool.

### Added — Reactions (sensitive-stomach signal)

- `entries.reaction` (`liked | sat_poorly`). Tapping a History entry now opens
  an action dialog (👍 Liked / 😣 Sat poorly / delete) instead of a bare
  delete-confirm; reactions render as emoji on the calendar.

### Changed — Plan covers dinner again

- The Plan tab is now Monday–Sunday with **Lunch (+ veggie side)** and
  **Dinner** rows: Christine's packed lunch plus the shared dinner.
- Auto-fill excludes meals planned/eaten on **adjacent days** as well as the
  requested days — no same meal in back-to-back meal occasions (e.g. last
  night's dinner suggested as today's lunch). The auto-fill dialog offers the
  dinner slot again.

---

## [0.8.0] — 2026-06-30

### Added — MCP server for Claude Desktop / Claude Code

- New `mcp/` package: a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the agent API as tools, so you can drive yes-chef conversationally — *"log that I had a burrito for lunch"*, *"suggest next week's lunches"*, *"generate an image for the salmon bowl"*. Configured with `YESCHEF_BASE_URL` + an agent token; see `mcp/README.md`.
- Tools: `list_meals`, `get_state`, `get_stats`, `get_recommendations`, `suggest_week`, `create_meal`, `log_meal`, `push_note`, `generate_meal_image`.

### Added — ComfyUI example workflows + random seed

- Ready-to-paste example workflows in `comfy-workflows/` (`txt2img.json`, `img2img.json`) using stock nodes and the default SD 1.5 checkpoint — set `ckpt_name` and go.
- New optional **`%seed%`** placeholder: put it unquoted as the KSampler seed and yes-chef substitutes a fresh random integer each run, so repeated generations vary instead of returning the same (ComfyUI-cached) image.

### Added — Bearer-accessible write endpoints

- `POST /api/v1/agent/entries` — log (eaten) or plan a meal `{ meal_id, on_date?, slot?, status? }` with a token. This is the bearer-friendly path for budget-import scripts; previously entry writes required a browser session. `slot` optional, `on_date` defaults to today, `status` defaults to `eaten`.
- `POST /api/v1/agent/meals/:id/generate-image` — ComfyUI generation over the agent API.
- Photo-save + ComfyUI generation logic factored into `lib/photos.js` and shared by the session and agent routes.

---

## [0.7.0] — 2026-06-30

### Changed — Planner is now a weekly lunch meal-prep view

- The **Plan** tab is now a single Monday–Friday work-week focused on the lunch you meal-prep for work, with a **Lunch** slot and an optional **Veggie side** per weekday. Breakfast & dinner are intentionally left out — figured out on the fly.
- Removed the 1 / 2 / 3 / 5 / 7-day selector; navigation now moves a whole week at a time.
- The **Home** "Today" card became **"This week's lunches"**, and the auto-fill dialog now offers Lunch + Veggie side.

### Changed — Flexible eating history

- Entry **slots are now optional**. You can log any number of meals on a day with no required breakfast/lunch/dinner slot — `slot` accepts `""` (no slot) in addition to the known labels. This makes it easy to pipe eating-out purchases from a budget feed (via the agent API / `POST /api/entries`) alongside manually-logged home-cooked meals.
- The History "+ Add meal" dialog defaults to no slot and notes that you can log as many meals per day as you like.

### Added — ComfyUI image generation (text-to-image + image-to-image)

- Generate a dish image for any meal using your own self-hosted ComfyUI server. New **Settings → ComfyUI** card (base URL, prompt template, and two workflow fields).
  - **Text-to-image** — `%prompt%` placeholder; triggered by **🎨 Generate image** on the Meals tab.
  - **Image-to-image** — `%prompt%` + `%image%` placeholders; the **✨** button on a meal photo uploads that photo to ComfyUI (`POST /upload/image`) and feeds it to a `LoadImage` node, transforming it into a stylized version. The original photo is kept; the result is added as a new photo.
- New `lib/comfyui.js` client (optionally upload base image → queue `/prompt` → poll `/history` → download `/view`) and endpoints:
  - `GET/PUT /api/v1/agent/comfyui`, `POST /api/v1/agent/comfyui/test`
  - `POST /api/meals/:id/generate-image` — body `{ prompt?, mode?: 'txt2img'|'img2img', photo_id? }`
- Config is stored in a new `app_settings` key/value table and can be seeded from `COMFYUI_BASE_URL` / `COMFYUI_WORKFLOW_JSON` (text-to-image) / `COMFYUI_PROMPT_TEMPLATE`.

### Changed — AI photo analysis & nutrition hidden

- AI photo analysis and per-meal nutrition/macros are **removed from the UI** for now. The provider code (`lib/ai-provider.js`), its agent endpoints, and the `nutrition_json` / `analysis_json` database columns are left intact so the feature can be re-enabled later with minimal work.

---

## [0.6.0] — 2026-06-13

### Added — Create meals inline from Plan & History

- The meal picker (used when filling a Plan slot) now offers a **"+ Create …"** row when you type a name that doesn't exist yet. Picking it creates the meal and drops it straight into the slot — no round-trip to the Meals tab.
- The new meal is added to local state immediately, so it's available in every subsequent picker and list.
- **History** gains a **"+ Add meal"** button: pick a date + slot, choose (or create) a meal, and it's logged as eaten. Previously History was view/delete only.

### Added — Agent API meal endpoints

- `GET  /api/v1/agent/meals?q=&tag=` — list the meal library (with tags + nutrition) so an agent can avoid creating duplicates.
- `POST /api/v1/agent/meals` — create a meal `{ name, notes?, tags?: string[], nutrition?: object }`. Returns `409` if the (case-insensitive) name already exists, `400` if name is missing.

---

## [0.5.0] — 2026-06-13

### Added — Agent API token management in the UI

- New **🔑 Agent API tokens** card under **Settings**. Create and revoke bearer tokens for external agents directly from the web UI — no `.env` editing, no container restart.
- Tokens are generated server-side (32 random bytes / 64 hex chars), stored **hashed** (SHA-256) with only a 6-char prefix kept for display. The raw secret is shown **exactly once** in a reveal dialog with a copy button.
- Revoking a token takes effect immediately (the next request with it gets a 401).
- The auth middleware now accepts tokens from **both** the `AGENT_API_TOKENS` env var (bootstrap/legacy) **and** the DB-managed list.
- Token management endpoints are **session-only**: an agent token cannot create or revoke tokens, preventing privilege escalation if one leaks.
- Per-token `last_used_at` is tracked and shown in the list.

### Added — Endpoints

- `GET    /api/v1/agent/tokens` (session only)
- `POST   /api/v1/agent/tokens` (session only; returns the secret once)
- `DELETE /api/v1/agent/tokens/:id` (session only)

### Changed

- Startup log now reports both env-token and DB-token counts:
  `[agent-auth] N env token(s) loaded …` / `[agent-auth] M token(s) managed in DB …`.

### Migration

- New table `agent_tokens` is created automatically on first boot. Existing `AGENT_API_TOKENS` env tokens keep working unchanged.

---

## [0.4.1] — 2026-05-24

### Fixed — Agent API rejecting valid tokens in Docker

- `AGENT_API_TOKENS` now has surrounding quotes and whitespace stripped from each token. docker-compose's `env_file` parser (unlike dotenv) does **not** strip quotes, so a `.env` line like `AGENT_API_TOKENS="abc"` arrived inside the container as the literal string `"abc"` (quotes included) and never matched the clean token an agent sent — producing a generic `401 unauthenticated`. Quoted/comma-spaced values now work.
- Added a startup log line: `[agent-auth] N token(s) loaded: <prefix>…` (or a notice when none are set) so you can immediately confirm what the server actually parsed without exposing the secret.

---

## [0.4.0] — 2026-05-23

### Added — Settings tab + multi-provider AI

- New **Settings** tab with full CRUD for AI provider configurations:
  - Add multiple named configs (Anthropic, OpenAI, OpenRouter, Ollama, OpenAI-compatible)
  - Each row shows provider / model / base URL / masked key
  - **Activate**, **Test**, **Edit**, **Delete** buttons per config
  - Active config gets a green pill and border highlight
- New "Active model" dropdown on the Meals tab's 🤖 AI vision card — switch the active AI on the fly with no restart.
- Edit dialog has provider-specific placeholder hints (e.g. "MUST include vendor/ prefix" for OpenRouter, "vision-capable models only" for Ollama) and a one-click **Test now** button that probes the connection before saving.
- API keys are stored in the DB (single-tenant, self-hosted), never returned over the wire — only a masked preview (`sk-a…seed`).
- Backward compatible: on first boot, if `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` / `AI_BASE_URL` are set in env, a config is seeded automatically. After that, env vars are ignored.

### Added — Endpoints

- `GET    /api/v1/agent/ai/configs`
- `POST   /api/v1/agent/ai/configs`
- `PATCH  /api/v1/agent/ai/configs/:id`
- `DELETE /api/v1/agent/ai/configs/:id`
- `POST   /api/v1/agent/ai/configs/:id/activate`
- `POST   /api/v1/agent/ai/configs/:id/test`
- `GET    /api/v1/agent/ai/providers` (lists supported names)

### Fixed — Photos disappearing

- The `/photos/*` static route now uses `fallthrough: false`. Previously, a missing file fell through to the SPA wildcard and returned `index.html` with a 200 status; browsers tried to render the HTML as an image and produced an invisible "broken" tile with no error icon.
- The auth middleware now returns a real `401 Unauthorized` for `/photos/*` requests instead of redirecting to `/login` (a redirect also produced HTML masquerading as an image).
- Image tags in the photo manager now have an `onerror` handler that swaps in a visible ⚠ "Image failed to load" placeholder so problems surface immediately.
- Photo upload now verifies the file actually landed on disk with the correct size and returns a 500 with the `errno` + path on failure — catches permissions / volume issues that previously failed silently.

### Changed — Photo deletion safety

- The ✕ delete button on a photo tile now uses a **two-step arm/confirm** pattern: first click marks the tile with a red border and changes the button to "✓ Confirm" with a 4-second timer. Click again to delete; click anywhere else (or wait 4s) to cancel. No more accidental deletions.
- Clicking an un-analysed photo now opens a fullscreen **lightbox** (click outside or press Escape to close).

### Changed — Misc

- Tabs are now: **Home · Pick · Plan · History · Photos · Meals · Settings**.
- Removed the "Diagnostics" button from the Meals tab — it lives in Settings now (still reachable via the same dialog).

### Migration

- New table `ai_configs` is created automatically on first boot. Existing data is untouched.
- After upgrading: open **Settings** → review the seeded config(s). If you have leftover `AI_*` env vars from before, you can delete them — they're only read when the table is empty.

---

## [0.3.0] — 2026-05-17

### Added — Home page

- New **Home** tab is now the default landing view. Includes:
  - Time-aware greeting and full date
  - "Today" card with each slot, eaten state, and an inline 🍽️ mark-eaten button
  - "Quick actions" card with one-click access to Pick / Auto-fill / Photos / Meals
  - "This year" mini stats card (eaten / unique / variety / streak)
  - "Coming up" — the next planned entries across the upcoming week
  - "Recent photos" strip showing the 8 most recently uploaded photos; click to jump straight into the meal editor
- Brand header is now a link to Home; URL hash (`#home`, `#photos`, …) is kept in sync so deep links work.

### Added — Photos page

- New **Photos** tab: full-bleed gallery of every meal photo across the library.
- Filter by meal name; toggle "only AI-analyzed".
- Analyzed photos get a green border; calorie overlays carry over from the meal record.
- Clicking a photo jumps to that meal's editor.

### Added — Auto-fill plan (suggest meals)

- New **✨ Auto-fill** button on the Plan view (and on Home).
- Dialog lets you:
  - Pick a date range (presets: **Tomorrow**, **Next 5 weekdays**, **Next 7 days**, **Next weekend**, or fully custom from/to)
  - Choose which slots to fill (breakfast / lunch / dinner)
  - Tune the same variety slider used by the Pick view
  - Filter by tags
  - Skip slots that are already filled (default on)
- The picker batches the request and returns N distinct meals (no repeats within the batch, and already-planned meals in the window are excluded automatically).
- Preview screen lets you 🔄 reroll any individual slot or ✕ remove it before committing.
- "Add all to plan" creates the planned entries in one shot.
- New endpoint: `POST /api/v1/agent/plan/suggest` (preview-only, does not write).
- `lib/pick-algorithm.js` now accepts `excludeIds` for chained / rerolled picks.

### Changed

- Tabs are now: **Home · Pick · Plan · History · Photos · Meals**.

---

## [0.2.0] — 2026-05-17

### Renamed

- **`web-menu` → `yes-chef`** (subtitle: *Your Smart Menu Planner*).
  - Docker image / container / compose service: `yes-chef`.
  - Session cookie: `web_menu_sid` → `yes_chef_sid` (existing sessions will need to sign in again — one-time).
  - SQLite file: `web-menu.sqlite` → `yes-chef.sqlite` (auto-migrated on first boot if the legacy file exists; WAL/SHM sidecars are moved too).
  - Repository on GitHub is still <https://github.com/josephisaac91/web-menu>.

### Added — Smart picker

- New **variety-tunable scoring algorithm** in `lib/pick-algorithm.js`. Each candidate meal is scored on recency, rarity (vs. fair-share frequency), and novelty, then weighted-random sampled.
- `GET /api/meals/random?variety=0.7` — variety knob (0 = uniform, 1 = strongly prefer novel/under-eaten).
- `GET /api/v1/agent/recommendations?variety=&n=&tag=` — top-N recommendations.
- Pick view UI: variety slider with live value display, and "📋 Show top 5" button to preview ranked picks before committing.

### Added — Agent API for autonomous AI assistants

- New router under `/api/v1/agent/*` (`routes/agent.js`).
- Bearer-token auth via `AGENT_API_TOKENS` env var (comma-separated). Browser sessions also work.
- Endpoints: `spec`, `state`, `stats`, `recommendations`, `notes` (CRUD + dismiss), `photos/:id/analyze`, `photos/:id/apply`.
- Notes/reminders surface as a sticky dismissable banner across the top of the UI; polled every 5 min so an external agent can push *"Take chicken out of the freezer"* and it shows up without a refresh.
- Note kinds: `info`, `reminder`, `recommendation`, `warning` (each with its own color).

### Added — AI photo analysis

- Pluggable vision provider in `lib/ai-provider.js`: OpenAI, Anthropic, Ollama (local).
- Configured via `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`.
- Strict JSON output schema: description, dish_name, cuisine, ingredients, tags, portion (size + estimated grams), nutrition (kcal/protein/carbs/fat/fiber/sodium), confidence.
- Meals view shows 🤖 button on each photo when AI is enabled; analyzed photos get a green "AI" badge and clickable analysis dialog.
- One-click "Apply tags / nutrition / description / all" to merge AI output into the meal record.

### Added — History stats & nutrition

- New `meals.nutrition_json` column with 6 editable fields in the meal form (calories / protein / carbs / fat / fiber / sodium).
- Meal tiles in the gallery show a `kcal` overlay when calories are set.
- History tab gains a **📊 Stats** panel: total eaten, unique meals, **Shannon-entropy variety index** (0..1), current streak, top 5 most-eaten, breakdowns by slot / tag / month.

### Added — UX polish

- Plan view: **1 / 2 / 3 / 5 / 7-day** selector with `localStorage` persistence; navigation advances by the chosen span. Mobile collapses 5d/7d to 3 columns.
- Plan view: separate **Lunch + Veg side** slot (server-supported new slot value `side`).
- Each plan-slot is now a vertical block (label on its own line, meal + actions below) — fixes the cramped overlap on mobile.
- "Mark all meals eaten" 🍽️ button next to each day's date header in the plan view.
- Plan view checkmark emoji ✅ replaced with 🍽️ throughout for visual consistency.

### Added — Operational

- `TZ=America/Los_Angeles` baked into `docker-compose.yml`; SQLite queries that depend on "today" now use `date('now','localtime',…)` so date math matches the wall clock instead of UTC.
- Brute-force protection on `/auth/login`: max 5 failed attempts per IP, 24-hour lockout. Successful login clears the record. Remaining-attempt count returned in the error.
- Session cookie lifetime extended to 400 days — the browser-enforced maximum.
- Tag management UI on the Meals tab: rename or delete tags inline.

### Changed

- Meals page reorganised: list → **photo gallery** of tiles with cover image, tag chips, kcal overlay, and one-click delete. Edit form scrolls into view on click.
- `PUT /api/meals/:id` and `POST /api/meals` accept an optional `nutrition` object.
- History page is now a monthly calendar (Sunday-first) instead of a flat list.

### Internal

- Added `lib/` directory for non-route business logic.
- Added `middleware/agent-auth.js`.
- New tables: `meal_photos` (with `analysis_json`, `analyzed_at`), `agent_notes`.
- `db.js` exports `safeJSON` helper and `DATA_DIR`; one-off `addColumnIfMissing` migrator for future schema tweaks.

### Migration notes

- **Sign in again** after the first boot on the new version — the session cookie name changed.
- **DB filename auto-migrates** the first time the new build starts; nothing for you to do.
- **No new mandatory env vars.** AI + agent features are off by default; set `AGENT_API_TOKENS` and/or `AI_PROVIDER=…` to enable.
- If you previously had `Authorization: Bearer …` callers, point them at the new path prefix `/api/v1/agent/*`.

---

## [0.1.0] — 2026-05-15

Initial public release of `web-menu`.

### Added

- Tag-filtered random meal picker with optional "skip last N days" exclusion.
- "Try something new" picker (never-eaten → longest-ago).
- 7-day weekly planner (breakfast / lunch / dinner) with mark-as-eaten.
- Linear history log of eaten meals.
- Meals + tags CRUD with photo uploads (base64 JSON, served under `/photos/`).
- CSV bulk import (browser + CLI), idempotent.
- Shared password auth (bcrypt-hashed at boot) and optional Google OAuth.
- Docker single-container deployment with `better-sqlite3` and file-store sessions under `DATA_DIR`.

[0.6.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.6.0
[0.5.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.5.0
[0.4.1]: https://github.com/josephisaac91/web-menu/releases/tag/v0.4.1
[0.4.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.4.0
[0.3.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.3.0
[0.2.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.2.0
[0.1.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.1.0
