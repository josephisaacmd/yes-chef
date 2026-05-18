# 🍽️ web-menu

A self-hosted meal planner and history log. Pick something to eat, plan the week ahead, track what you've had, and grow a personal database of household favourites — all from a clean web UI running in Docker.

---

## Features

- **🎲 Pick a meal** — filter your meal list by tag, roll a random pick, and skip anything eaten in the last *N* days
- **✨ Try something new** — surfaces meals you've never eaten first, then the longest-ago ones
- **📅 Weekly planner** — 7-day grid with breakfast / lunch / dinner slots; mark planned meals as eaten in one click
- **📜 History** — a running log of everything you've eaten, newest first
- **🏷️ Tags** — free-form metadata per meal (`eat out`, `home cook`, `healthy`, `quick`, etc.)
- **📥 CSV import** — bulk-import a food log from a spreadsheet; idempotent so re-running is safe
- **🔒 Simple auth** — shared household password; optional Google OAuth for Gmail sign-in
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
git clone https://github.com/your-username/web-menu.git
cd web-menu
cp .env.example .env        # edit APP_PASSWORD, SESSION_SECRET, SECURE_COOKIES=false
npm install
npm start
# open http://localhost:3000
```

---

## Docker

### Build and run

```bash
git clone https://github.com/your-username/web-menu.git
cd web-menu
cp .env.example .env        # edit values — see Environment variables below
docker compose up -d --build
# open http://localhost:3000
```

Data is stored in `./data/` (SQLite + session files). Back up by copying that folder.

### Build the image manually (no compose)

```bash
docker build -t web-menu:latest .
```

> **Note:** Always include `-t web-menu:latest` — without it the image is only reachable by its SHA digest.

---

## Deploying with Dockge on TrueNAS (or any Docker host)

Dockge manages stacks from a directory (default `/opt/stacks/`). Because this app builds from a `Dockerfile`, you need the source on the server.

### 1 — Copy files to the server

From your local machine (replace `user` and `server-ip`):

```bash
rsync -av --exclude='node_modules' --exclude='data' --exclude='.git' \
  /path/to/web-menu/ \
  user@server-ip:/opt/stacks/web-menu/
```

### 2 — Set environment variables

Create your `.env` **or** paste the `environment:` block directly into Dockge's compose editor (more reliable — see compose snippet below).

### 3 — Build the image on the server

```bash
ssh user@server-ip
cd /opt/stacks/web-menu        # or wherever you copied the files
docker build -t web-menu:latest .
```

### 4 — Compose file for Dockge

Paste this into Dockge's editor (adjust the data path if you want a specific TrueNAS dataset):

```yaml
services:
  web-menu:
    image: web-menu:latest
    container_name: web-menu
    user: "root"
    restart: unless-stopped
    environment:
      - APP_PASSWORD=your-password
      - SESSION_SECRET=your-long-random-secret
      - SECURE_COOKIES=false      # set true only after HTTPS / Cloudflare Tunnel is live
      - DATA_DIR=/data
      - PORT=3000
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - /opt/stacks/web-menu/data:/data   # or a TrueNAS dataset path
```

Hit **Start** in Dockge.

### Rebuild after a code update

```bash
rsync -av --exclude='node_modules' --exclude='data' --exclude='.git' \
  /path/to/web-menu/ user@server-ip:/opt/stacks/web-menu/
ssh user@server-ip "cd /opt/stacks/web-menu && docker build -t web-menu:latest ."
# then Restart in Dockge
```

---

## Cloudflare Tunnel

The compose file binds only to `127.0.0.1:3000` so the app is not directly reachable from the internet. Cloudflare Tunnel handles the public exposure and provides free TLS.

### Setup

1. Install `cloudflared` on the host and authenticate:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create web-menu
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
   cloudflared tunnel route dns web-menu menu.yourdomain.com
   cloudflared tunnel run web-menu
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
docker exec web-menu node scripts/import-csv.js
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
web-menu/
├── server.js               Express app, session, auth wiring
├── db.js                   SQLite schema + helper functions
├── middleware/
│   └── auth.js             Session gate (redirect HTML / 401 JSON)
├── routes/
│   ├── auth.js             Password login / logout
│   ├── oauth.js            Google OAuth (optional)
│   ├── meals.js            Meals CRUD + random + new + bulk import
│   ├── tags.js             Tags CRUD
│   └── entries.js          Planned & eaten entries
├── public/
│   ├── index.html          App shell (4 tabs)
│   ├── login.html          Login page
│   ├── app.js              Vanilla JS SPA
│   └── style.css           Styles (light + dark mode)
├── scripts/
│   └── import-csv.js       CLI bulk importer
├── food-log.example.csv    Example CSV format
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## License

[MIT](LICENSE)
