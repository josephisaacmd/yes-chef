# 🍽️ yes-chef

> **Your Smart Menu Planner**

A self-hosted meal planner focused on weekly lunch meal-prep: pick the lunch (plus an optional veggie side) you'll prep for work each weekday, keep a flexible day-by-day log of everything you actually eat, generate dish images with your own ComfyUI server, and let autonomous AI assistants push reminders and recommend meals through a clean agent API — all from a single-container Docker app.

Repository: <https://github.com/josephisaac91/web-menu> · See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## Features

- **📅 Weekly lunch planner** — plan the lunch you'll meal-prep for work each weekday (Mon–Fri), plus an optional veggie side. Breakfast & dinner are figured out on the fly.
- **🎲 Pick a meal** — tag filter, recency-aware scoring algorithm with a tunable **variety** knob (0 = pure random → 1 = strongly prefer novel / under-eaten meals)
- **✨ Try something new** — surfaces meals you've never eaten first, then the longest-ago ones
- **📋 Top-N recommendations** — preview the 5 best picks ranked by the algorithm
- **📜 Flexible history** — log anything you ate on a given day; any number of entries per day, with an *optional* slot label (great for piping in eating-out purchases from a budget feed via the agent API, plus manual home-cooked entries). Monthly calendar + stats panel (variety index, streak, top meals, breakdowns).
- **🎨 ComfyUI image generation** — generate a dish image for any meal using your own self-hosted [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server: **text-to-image** from the meal name, or **image-to-image** that transforms one of the meal's photos into a stylized version
- **🤖 Agent API** — Bearer-token gated endpoints under `/api/v1/agent/*` for autonomous AI agents (reminders, recommendations, state snapshots, logging/planning meals, image generation)
- **🔌 MCP server** — talk to your planner from Claude Desktop / Claude Code: *"log that I had a burrito for lunch"*, *"suggest next week's lunches"*. See [`mcp/`](mcp/)
- **🏷️ Tags** — free-form metadata per meal; manage / rename / delete from the Meals tab
- **📥 CSV import** — bulk-import a food log; idempotent
- **🔒 Auth** — shared household password (with 5-strike / 24-hour lockout), optional Google OAuth
- **🐳 Docker-first** — single container, SQLite database, no external services required

> **Note:** AI photo analysis & per-meal nutrition/macros are currently disabled in the UI. The provider code and database columns are intact, so they can be re-enabled later — see [AI photo analysis](#ai-photo-analysis-disabled).

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express |
| Database | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Auth | express-session + bcrypt password gate; optional Google OAuth |
| Frontend | Vanilla HTML / CSS / JS (no build step) |
| Container | Docker + Docker Compose |

---

## Quick start (local, no Docker)

```bash
git clone https://github.com/josephisaac91/web-menu.git yes-chef
cd yes-chef
cp .env.example .env        # edit APP_PASSWORD, SESSION_SECRET, SECURE_COOKIES=false
npm install
npm start
# open http://localhost:3000
```

---

## Docker

### Build and run

```bash
git clone https://github.com/josephisaac91/web-menu.git yes-chef
cd yes-chef
cp .env.example .env        # edit values — see Environment variables below
docker compose up -d --build
# open http://localhost:3000
```

Data is stored in `./data/` (SQLite + session files). Back up by copying that folder.

### Build the image manually (no compose)

```bash
docker build -t yes-chef:latest .
```

> **Note:** Always include `-t yes-chef:latest` — without it the image is only reachable by its SHA digest.

---

## Deploying with Dockge on TrueNAS (or any Docker host)

Dockge manages stacks from a directory (default `/opt/stacks/`). Because this app builds from a `Dockerfile`, you need the source on the server.

### 1 — Copy files to the server

From your local machine (replace `user` and `server-ip`):

```bash
rsync -av --exclude='node_modules' --exclude='data' --exclude='.git' \
  /path/to/yes-chef/ \
  user@server-ip:/opt/stacks/yes-chef/
```

### 2 — Set environment variables

Create your `.env` **or** paste the `environment:` block directly into Dockge's compose editor (more reliable — see compose snippet below).

### 3 — Build the image on the server

```bash
ssh user@server-ip
cd /opt/stacks/yes-chef        # or wherever you copied the files
docker build -t yes-chef:latest .
```

### 4 — Compose file for Dockge

Paste this into Dockge's editor (adjust the data path if you want a specific TrueNAS dataset):

```yaml
services:
  yes-chef:
    image: yes-chef:latest
    container_name: yes-chef
    user: "root"
    restart: unless-stopped
    environment:
      - APP_PASSWORD=your-password
      - SESSION_SECRET=your-long-random-secret
      - SECURE_COOKIES=false      # set true only after HTTPS / Cloudflare Tunnel is live
      - DATA_DIR=/data
      - PORT=3000
      - TZ=America/Los_Angeles
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/stacks/yes-chef/data:/data   # or a TrueNAS dataset path
```

Hit **Start** in Dockge.

### Rebuild after a code update

```bash
rsync -av --exclude='node_modules' --exclude='data' --exclude='.git' \
  /path/to/yes-chef/ user@server-ip:/opt/stacks/yes-chef/
ssh user@server-ip "cd /opt/stacks/yes-chef && docker build -t yes-chef:latest ."
# then Restart in Dockge
```

---

## Cloudflare Tunnel

The compose file binds only to `127.0.0.1:3000` so the app is not directly reachable from the internet. Cloudflare Tunnel handles the public exposure and provides free TLS.

### Setup

1. Install `cloudflared` on the host and authenticate:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create yes-chef
   ```

2. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <TUNNEL-UUID>
   credentials-file: /home/<you>/.cloudflared/<TUNNEL-UUID>.json
   ingress:
     - hostname: menu.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

3. Route DNS and start:
   ```bash
   cloudflared tunnel route dns yes-chef menu.yourdomain.com
   cloudflared tunnel run yes-chef
   ```

4. Once the tunnel is live, set `SECURE_COOKIES=true` and restart the container — session cookies will now be sent only over HTTPS.

---

## Environment variables

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `APP_PASSWORD` | ✓ | `changeme` | Shared login password (plaintext; hashed in memory at startup) |
| `SESSION_SECRET` | ✓ | `dev-only-not-secret` | Secret used to sign session cookies — use a long random string |
| `SECURE_COOKIES` | | `false` | Set `true` when behind HTTPS (Cloudflare Tunnel). **If `true` over plain HTTP, login will appear to work but sessions won't stick** |
| `DATA_DIR` | | `/data` | Where the SQLite file and sessions are stored |
| `PORT` | | `3000` | Port the server listens on inside the container |
| `GOOGLE_CLIENT_ID` | | _(disabled)_ | Google OAuth client ID — leave blank to disable Google sign-in |
| `GOOGLE_CLIENT_SECRET` | | _(disabled)_ | Google OAuth client secret |
| `ALLOWED_EMAILS` | | _(all)_ | Comma-separated Gmail addresses allowed to sign in via Google |
| `PUBLIC_BASE_URL` | | _(disabled)_ | Your public URL, e.g. `https://menu.yourdomain.com` — required for OAuth redirect |
| `COMFYUI_BASE_URL` | | _(disabled)_ | ComfyUI server URL for image generation, e.g. `http://localhost:8188`. Manageable from Settings → ComfyUI after first boot |
| `COMFYUI_WORKFLOW_JSON` | | _(blank)_ | Seeds the **text-to-image** workflow (API format) with the `%prompt%` placeholder. The image-to-image workflow is set from the Settings UI. Usually easier to paste both there |
| `COMFYUI_PROMPT_TEMPLATE` | | _(built-in)_ | Prompt template; `{meal}` is replaced with the meal name |

Generate a good `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Google OAuth (optional)

Adds a **Continue with Google** button to the login page. The shared password continues to work alongside it.

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials → Create OAuth Client ID**
   - Type: **Web application**
   - Authorized redirect URI: `https://menu.yourdomain.com/auth/google/callback`

2. Set environment variables:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   PUBLIC_BASE_URL=https://menu.yourdomain.com
   ALLOWED_EMAILS=you@gmail.com,partner@gmail.com
   ```

3. Restart the container — the Google button appears automatically.

---

## Importing a food log from CSV

### Browser upload

In the **Meals** tab, expand **Bulk import from CSV**, choose your file, and click **Import**. Re-importing is safe — existing meals get their tags merged, not duplicated.

### Command line

```bash
# using npm
npm run import                        # reads ./food-log.csv by default
npm run import -- path/to/file.csv
npm run import -- --dry-run           # preview only, no writes
npm run import -- --replace-tags      # overwrite tags instead of merging

# inside a running container
docker exec yes-chef node scripts/import-csv.js
```

### CSV format

First row must be a header. Column names are case-insensitive and common aliases are accepted:

| Purpose | Accepted header names |
|---|---|
| Meal name (**required**) | `name`, `dish`, `dish name`, `meal`, `meal name`, `food` |
| Tags | `tags`, `tag`, `category`, `categories`, `cuisine`, `cuisine type`, `type` |
| Notes | `notes`, `note`, `description`, `comment`, `comments` |

Separate multiple tags within a single field with `;` or `|`. Extra columns are ignored.

See [`food-log.example.csv`](food-log.example.csv) for a working example.

```csv
name,tags,notes
Chicken tikka masala,home cook;healthy,Serve with naan
Pad Thai,eat out;quick,"Big Bowl on 5th Ave"
Sushi,eat out,Date night favourite
```

---

## API reference

All endpoints require authentication. All request and response bodies are JSON.

### Meals

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/meals` | List all meals. Optional: `?tag=foo&tag=bar` (AND filter), `?q=text` (name search) |
| `GET` | `/api/meals/random` | Random meal matching filters. `?avoid_days=14` skips recently eaten |
| `GET` | `/api/meals/new` | Never-eaten meals first, then longest-ago. Same tag filters |
| `GET` | `/api/meals/:id` | Single meal with tags |
| `POST` | `/api/meals` | Create. Body: `{ name, notes?, tags?: string[] }` |
| `PUT` | `/api/meals/:id` | Update. Tags array replaces existing |
| `DELETE` | `/api/meals/:id` | Delete (cascades to entries) |
| `POST` | `/api/meals/bulk` | Bulk import. Body: `{ meals: [{name, tags, notes}], merge_tags?: bool }` |

### Tags

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tags` | All tags with meal counts |
| `POST` | `/api/tags` | Create. Body: `{ name }` |
| `DELETE` | `/api/tags/:id` | Delete (removes from all meals) |

### Entries (planned + eaten)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/entries` | List entries. Optional: `?from=YYYY-MM-DD&to=YYYY-MM-DD&status=planned\|eaten` |
| `POST` | `/api/entries` | Create. Body: `{ meal_id, on_date, slot?, status? }` |
| `PATCH` | `/api/entries/:id` | Partial update — e.g. flip `status` from `planned` to `eaten` |
| `DELETE` | `/api/entries/:id` | Remove |

`slot` is **optional** — `breakfast | lunch | side | dinner | snack` or `""` (no slot). Any number of entries may share a date.  
`status` ∈ `planned | eaten`  
Dates are `YYYY-MM-DD`.

The weekly lunch planner uses `slot: "lunch"` (and `slot: "side"` for the veggie side) with `status: "planned"`. The history log accepts entries with any slot or none.

---

## Data model

```
meals       (id, name UNIQUE, notes, created_at, updated_at)
tags        (id, name UNIQUE)
meal_tags   (meal_id → meals, tag_id → tags)          many-to-many
entries     (id, meal_id → meals, on_date, slot, status, rating, notes, created_at)
```

Planning and history share the `entries` table — only `status` differs, making it trivial to flip a planned meal to eaten.

---

## Project structure

```
yes-chef/
├── server.js                 Express app, session, auth wiring
├── db.js                     SQLite schema + helper functions (auto-migrates legacy db file)
├── middleware/
│   ├── auth.js               Session gate (redirect HTML / 401 JSON)
│   └── agent-auth.js         Bearer-token OR session auth for /api/v1/agent/*
├── routes/
│   ├── auth.js               Password login / logout (with 5-strike / 24h lockout)
│   ├── oauth.js              Google OAuth (optional)
│   ├── meals.js              Meals CRUD + smart picker + photos + nutrition
│   ├── tags.js               Tags CRUD
│   ├── entries.js            Planned & eaten entries
│   └── agent.js              Agent API: stats, recommendations, notes, photo AI
├── lib/
│   ├── pick-algorithm.js     Variety-tunable scoring picker
│   ├── comfyui.js            ComfyUI image-generation client
│   └── ai-provider.js        Pluggable vision provider (currently UI-disabled)
├── public/
│   ├── index.html            App shell (tabs + notes banner)
│   ├── login.html            Login page
│   ├── app.js                Vanilla JS SPA
│   └── style.css             Styles (light + dark mode)
├── mcp/                      MCP server (stdio) for Claude Desktop / Claude Code
│   ├── server.js             Wraps the agent API as MCP tools
│   └── README.md             Client setup
├── scripts/
│   └── import-csv.js         CLI bulk importer
├── food-log.example.csv      Example CSV format
├── CHANGELOG.md
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Agent API (autonomous AI integration)

Set one or more long random tokens to enable bearer-auth access for external agents (Claude Dispatch, Hermes, OpenClaw, scripts, etc.):

```env
AGENT_API_TOKENS=token-a,token-b
```

All endpoints live under `/api/v1/agent/*` and accept either a browser session **or** `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET   | `/api/v1/agent/spec`            | Self-description (capabilities + AI status) |
| GET   | `/api/v1/agent/state?back=14&forward=7` | Recent + upcoming entries, "needs planning" days, unread notes |
| GET   | `/api/v1/agent/stats?days=365`  | Variety index, streak, top meals, breakdowns |
| GET   | `/api/v1/agent/recommendations?variety=0.7&n=5&tag=quick` | Top-N picks from the scoring algorithm |
| GET   | `/api/v1/agent/meals?q=&tag=`    | List the meal library |
| POST  | `/api/v1/agent/meals`           | Create a meal `{ name, tags?, notes? }` |
| POST  | `/api/v1/agent/entries`         | Log/plan a meal `{ meal_id, on_date?, slot?, status? }` |
| POST  | `/api/v1/agent/plan/suggest`    | Preview meals to fill date×slot cells (does not write) |
| POST  | `/api/v1/agent/meals/:id/generate-image` | Generate a ComfyUI image `{ prompt?, mode?, photo_id? }` |
| GET   | `/api/v1/agent/notes`           | List notes (`?unread=1`, `?dismissed=0`) |
| POST  | `/api/v1/agent/notes`           | Push a reminder: `{ kind, text, due_date?, meta? }` |
| PATCH | `/api/v1/agent/notes/:id`       | `{ read: true }` or `{ dismissed: true }` |
| DELETE| `/api/v1/agent/notes/:id`       | Delete a note |

**Note kinds** are `info`, `reminder`, `recommendation`, `warning`. Notes appear as a dismissable banner across the top of the web UI, so an agent that posts *"Take chicken out of freezer for tomorrow"* surfaces to the user immediately.

`POST /api/v1/agent/entries` is the bearer-friendly way to log meals — point your budget-import script at it with a token, no browser session needed. `slot` is optional; `on_date` defaults to today; `status` defaults to `eaten`.

### MCP server

For conversational use from **Claude Desktop / Claude Code**, a stdio MCP server wraps these endpoints as tools (`log_meal`, `suggest_week`, `get_state`, `generate_meal_image`, …). See [`mcp/README.md`](mcp/README.md) for setup.

### Example: weekly planning reminder cron

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"reminder","text":"Plan next week — 4 unplanned days","due_date":"2026-05-19"}' \
  https://menu.example.com/api/v1/agent/notes
```

### Example: agent asks for recommendations

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://menu.example.com/api/v1/agent/recommendations?variety=0.75&n=5&tag=quick"
```

---

## ComfyUI image generation

Generate a dish image for any meal using your own self-hosted [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server. Two pipelines are supported:

- **Text-to-image** — generate a fresh stylized image from the meal name / prompt.
- **Image-to-image** — take an existing meal photo and transform it into a stylized version (the photo is uploaded into ComfyUI and fed to a `LoadImage` node).

### Quick start: ready-made workflows

Copy-paste examples live in [`comfy-workflows/`](comfy-workflows/):

- **SD 1.5 / SDXL** — [`txt2img.json`](comfy-workflows/txt2img.json) and [`img2img.json`](comfy-workflows/img2img.json). Stock nodes, default SD 1.5 checkpoint. The **only** field you must change is `ckpt_name`. For SDXL, also bump the latent size from `512` to `1024`.
- **FLUX.1** (best quality; needs ~12 GB VRAM via the fp8 build) — [`flux-txt2img.json`](comfy-workflows/flux-txt2img.json) and [`flux-img2img.json`](comfy-workflows/flux-img2img.json). Uses the all-in-one `flux1-dev-fp8.safetensors` checkpoint (`models/checkpoints/`), the FLUX-only `EmptySD3LatentImage` (16-channel) latent, a `FluxGuidance` node (~3.5), and — for img2img — an `ImageScale` node that resizes the base photo to a multiple of 16 (FLUX requires this). KSampler `cfg` stays `1.0`; steering is via `FluxGuidance`.

### Placeholders

If you'd rather export your own workflow: build it in ComfyUI, enable **dev mode** in settings, click **Save (API Format)**, then add these tokens:

- **`%prompt%`** (both pipelines) — in the positive-prompt node's text:
  ```json
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "%prompt%", "clip": ["4", 1] } }
  ```
- **`%image%`** (image-to-image only) — in the `LoadImage` node's filename. yes-chef uploads the meal photo to ComfyUI and substitutes its name here:
  ```json
  "10": { "class_type": "LoadImage", "inputs": { "image": "%image%", "upload": "image" } }
  ```
  Pair this with a `VAEEncode` → `KSampler` `latent_image` path and a `denoise` below ~0.7 so the original food stays recognizable (the examples use `0.55`).
- **`%seed%`** (optional, both pipelines) — put it **unquoted** as the KSampler seed (`"seed": %seed%`). yes-chef fills it with a fresh random integer each run, so repeated generations vary instead of returning the same (ComfyUI-cached) image.

Every workflow needs a `SaveImage` node so there's an output to download.

### Configuring

In yes-chef, go to **Settings → ComfyUI**:
1. Set the **Base URL** (e.g. `http://localhost:8188` — for a Docker host, the address ComfyUI is reachable at from the yes-chef container).
2. Optionally tweak the **prompt template** (`{meal}` is replaced with the meal name).
3. Paste the **Text-to-image** workflow, and optionally the **Image-to-image** workflow.
4. **Save**, then **Test connection** to confirm the server is reachable.

Image-to-image is optional — if you leave that workflow blank, only text-to-image is enabled.

### Generating

On the **Meals** tab, open a saved meal:
- **🎨 Generate image** runs text-to-image.
- The **✨** button on each photo runs image-to-image using that photo as the base.

Either way the server fills the placeholders, queues the workflow (`POST /prompt`), polls `/history/{id}` until it finishes, downloads the first image via `/view`, and saves it as a **new** photo on that meal (the base photo is kept).

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/v1/agent/comfyui`      | Get the current config + status |
| PUT  | `/api/v1/agent/comfyui`      | Save `{ base_url, prompt_template, workflow_txt2img, workflow_img2img }` |
| POST | `/api/v1/agent/comfyui/test` | Probe the server is reachable |
| POST | `/api/meals/:id/generate-image` | Generate + attach an image. Body: `{ prompt?, mode?: 'txt2img'\|'img2img', photo_id? }` |

See `lib/comfyui.js` for the implementation.

---

## AI photo analysis (disabled)

> **Currently disabled in the UI.** The pluggable vision provider code (`lib/ai-provider.js`), its agent endpoints, and the `nutrition_json` / `analysis_json` database columns are all intact, so this can be re-enabled later. The AI providers can still be configured under **Settings → AI providers**. The rest of this section describes the feature as it worked / will work when re-enabled.

When enabled, the Meals view shows a 🤖 button on each photo when an AI provider is configured. Click it to analyze the image and get back structured JSON:

```json
{
  "description": "Pan-seared salmon with asparagus and quinoa",
  "dish_name": "Salmon bowl",
  "cuisine": "modern american",
  "ingredients": ["salmon", "asparagus", "quinoa", "lemon"],
  "tags": ["healthy", "high-protein", "gluten-free"],
  "portion": { "size": "medium", "estimated_grams": 350 },
  "nutrition": { "calories": 520, "protein_g": 38, "carbs_g": 32, "fat_g": 24, "fiber_g": 6, "sodium_mg": 480 },
  "confidence": 0.82
}
```

You can then one-click apply the tags, nutrition, and/or description to the meal record.

### Configure a provider

```env
# Cloud — OpenAI (vision)
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini

# Cloud — Anthropic (Claude with vision)
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-3-5-sonnet-latest

# Local — Ollama running a vision model (no key required)
AI_PROVIDER=ollama
AI_BASE_URL=http://host.docker.internal:11434
AI_MODEL=llava
```

Adding more providers is a ~30-line addition to `lib/ai-provider.js` — all providers conform to the same JSON schema.

---

## Pick algorithm — variety scoring

Each candidate meal is scored on three signals, then weighted-random sampled:

- **Recency** — days since last eaten (saturates at 90)
- **Rarity** — eaten less than its 1/N "fair share" of total entries
- **Novelty** — flat bonus for never-eaten meals

The `variety` slider linearly blends a uniform-weight distribution (0.0) with the variety score (1.0). The avoid-days window is applied as a hard filter, with automatic relaxation if it empties the candidate pool.

See `lib/pick-algorithm.js` for the implementation.

---

## License

[MIT](LICENSE)
