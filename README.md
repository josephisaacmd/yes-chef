# 🍽️ yes-chef

> **Your Smart Menu Planner**

A self-hosted meal planner with a scoring-based meal picker, photo-aware AI nutrition analysis, and a clean agent API so autonomous AI assistants can push reminders, recommend meals, and help you plan the week — all from a single-container Docker app.

Repository: <https://github.com/josephisaacmd/yes-chef> · See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## Features

- **🎲 Pick a meal** — tag filter, recency-aware scoring algorithm with a tunable **variety** knob (0 = pure random → 1 = strongly prefer novel / under-eaten meals)
- **✨ Try something new** — surfaces meals you've never eaten first, then the longest-ago ones
- **📋 Top-N recommendations** — preview the 5 best picks ranked by the algorithm
- **📅 Adaptive planner** — 1 / 2 / 3 / 5 / 7-day views with separate Lunch + Veg side slots
- **📜 History calendar** — monthly calendar plus a stats panel (variety index, streak, top meals, breakdowns by slot / tag / month)
- **🤖 Agent API** — Bearer-token gated endpoints under `/api/v1/agent/*` for autonomous AI agents (reminders, recommendations, state snapshots, photo analysis)
- **🧠 AI photo analysis** — pluggable vision provider (OpenAI / Anthropic / Ollama) auto-tags meals and estimates nutrition (calories, macros, portion)
- **🏷️ Tags** — free-form metadata per meal; manage / rename / delete from the Meals tab
- **📥 CSV import** — bulk-import a food log; idempotent
- **🔒 Auth** — shared household password (with 5-strike / 24-hour lockout), optional Google OAuth
- **🐳 Docker-first** — single container, SQLite database, no external services required

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
git clone https://github.com/josephisaacmd/yes-chef.git
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
git clone https://github.com/josephisaacmd/yes-chef.git
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

`slot` ∈ `breakfast | lunch | dinner | snack`  
`status` ∈ `planned | eaten`  
Dates are `YYYY-MM-DD`.

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
│   └── ai-provider.js        Pluggable vision provider (OpenAI / Anthropic / Ollama)
├── public/
│   ├── index.html            App shell (4 tabs + notes banner)
│   ├── login.html            Login page
│   ├── app.js                Vanilla JS SPA
│   └── style.css             Styles (light + dark mode)
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
| GET   | `/api/v1/agent/notes`           | List notes (`?unread=1`, `?dismissed=0`) |
| POST  | `/api/v1/agent/notes`           | Push a reminder: `{ kind, text, due_date?, meta? }` |
| PATCH | `/api/v1/agent/notes/:id`       | `{ read: true }` or `{ dismissed: true }` |
| DELETE| `/api/v1/agent/notes/:id`       | Delete a note |
| POST  | `/api/v1/agent/photos/:photoId/analyze` | Run vision provider on a meal photo |
| POST  | `/api/v1/agent/photos/:photoId/apply`   | Apply analysis to the meal: `{ tags?, nutrition?, description? }` |

**Note kinds** are `info`, `reminder`, `recommendation`, `warning`. Notes appear as a dismissable banner across the top of the web UI, so an agent that posts *"Take chicken out of freezer for tomorrow"* surfaces to the user immediately.

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

## AI photo analysis

The Meals view shows a 🤖 button on each photo when an AI provider is configured. Click it to analyze the image and get back structured JSON:

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
