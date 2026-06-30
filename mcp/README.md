# yes-chef MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
MCP client — **Claude Desktop**, **Claude Code**, etc. — talk to your yes-chef
instance conversationally:

> *"What have we eaten the last few days?"* · *"Log that I had a chicken burrito
> for lunch today."* · *"Suggest lunches for next week, prefer something new."*
> · *"Generate an image for the salmon bowl."*

It's a thin **stdio** adapter over the yes-chef agent API (`/api/v1/agent/*`),
authenticated with a bearer token. The web app is unchanged; this just exposes
the same endpoints as tools.

## Tools

| Tool | What it does |
|---|---|
| `list_meals` | List the meal library (filter by `query` / `tag`) |
| `get_state` | Recent + upcoming entries, days needing planning, notes |
| `get_stats` | Totals, variety index, streak, top meals, breakdowns |
| `get_recommendations` | Top-N picks from the variety-tunable algorithm |
| `suggest_week` | Preview meals to fill a week of lunch slots (doesn't save) |
| `create_meal` | Add a meal to the library |
| `log_meal` | Log (eaten) or plan a meal — resolves by name or id; optional slot |
| `push_note` | Push a reminder banner to the web UI |
| `generate_meal_image` | Generate a dish image via ComfyUI (txt2img or img2img) |

## Setup

1. **Create a token** in yes-chef: **Settings → Agent API tokens → + Create token**. Copy it (shown once).

2. **Install dependencies:**
   ```bash
   cd mcp
   npm install
   ```

3. **Configure your MCP client** with the base URL + token as environment variables.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "yes-chef": {
      "command": "node",
      "args": ["/absolute/path/to/yes-chef/mcp/server.js"],
      "env": {
        "YESCHEF_BASE_URL": "https://menu.example.com",
        "YESCHEF_TOKEN": "your-agent-token"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the 🔌 menu.

### Claude Code

```bash
claude mcp add yes-chef \
  --env YESCHEF_BASE_URL=https://menu.example.com \
  --env YESCHEF_TOKEN=your-agent-token \
  -- node /absolute/path/to/yes-chef/mcp/server.js
```

## Configuration

| Variable | Required | Description |
|---|:---:|---|
| `YESCHEF_BASE_URL` | ✓ | Base URL of your server, e.g. `https://menu.example.com` or `http://localhost:3000` |
| `YESCHEF_TOKEN` | ✓ | An agent API token from Settings |

> **Transport:** this is a local **stdio** server — it runs on the machine
> where your MCP client runs and reaches yes-chef over HTTP at `YESCHEF_BASE_URL`
> (your tunnel/LAN address). No inbound ports on the yes-chef box are needed
> beyond what the web app already exposes.

## Quick manual check

```bash
YESCHEF_BASE_URL=https://menu.example.com YESCHEF_TOKEN=... node server.js
# It prints "connected … 9 tools ready." to stderr and waits for JSON-RPC on stdin.
# Ctrl-C to exit. Normally your MCP client launches it for you.
```
