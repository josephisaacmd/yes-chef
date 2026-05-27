# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.4.0
[0.3.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.3.0
[0.2.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.2.0
[0.1.0]: https://github.com/josephisaac91/web-menu/releases/tag/v0.1.0
