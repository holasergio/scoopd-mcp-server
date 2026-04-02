# Scoopd MCP Server

AI-powered Instagram competitor intelligence — directly in Claude.

Analyze any public Instagram account: content strategy, hooks, engagement gaps, brand voice, posting patterns. Get a full 9-section strategic report without leaving your AI chat.

## Quick Start

### Option 1: Claude.ai (Web)

1. Sign up at [scoopd.pro](https://scoopd.pro) (free, no credit card)
2. Go to **API Keys** → Create a key
3. In Claude.ai: **Settings → Connectors → Add custom connector**
   - Name: `Scoopd`
   - URL: `https://mcp.scoopd.pro/mcp`
4. Authorize with your API key
5. Start analyzing: *"Analyze @cristiano's Instagram strategy"*

### Option 2: Claude Code (CLI)

Claude Code uses `.mcp.json` for project-level or `~/.claude.json` for global MCP config.

**Project-level** — create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "scoopd": {
      "command": "npx",
      "args": ["-y", "scoopd-mcp-server"],
      "env": {
        "SCOOPD_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Or global** — run in terminal:

```bash
claude mcp add scoopd -- npx -y scoopd-mcp-server
```

Then set your API key:

```bash
export SCOOPD_API_KEY="sk_live_your_key_here"
```

**Alternative: remote URL mode** (if supported by your Claude Code version):

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "scoopd": {
      "type": "url",
      "url": "https://mcp.scoopd.pro/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

> **Note:** Claude Code primarily supports stdio-based MCP servers (local processes). If the `type: "url"` method doesn't work in your version, use the `npx` method above which runs the server locally via stdio.

### Option 3: Claude Desktop App

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "scoopd": {
      "command": "npx",
      "args": ["-y", "scoopd-mcp-server"],
      "env": {
        "SCOOPD_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Available Tools

| Tool | Description | Credits |
|------|-------------|---------|
| `scoopd_analyze_account` | Full 9-section competitor analysis | 1 |
| `scoopd_get_report` | Retrieve a saved report by ID | 0 |
| `scoopd_list_reports` | List all your reports | 0 |
| `scoopd_my_usage` | Check plan & remaining analyses | 0 |

## Report Sections

1. **Account Snapshot** — followers, engagement rate, niche
2. **Content DNA** — topics, formats, content pillars
3. **Hook Analysis** — opening hooks with effectiveness ratings
4. **Gap Analysis** — untapped content opportunities
5. **Sentiment** — audience tone and community strength
6. **Hashtags** — top hashtags and recommendations
7. **Top Performers** — best Reels with engagement analysis
8. **Brand Voice** — personality, tone, signature phrases
9. **Posting Patterns** — best days, consistency score

## Pricing

| Plan | Price | Analyses/mo | Features |
|------|-------|-------------|----------|
| Free | $0 | 3 | Full 9-section reports |
| Creator | $19/mo | 25 | + PDF/CSV export |
| Pro | $49/mo | 100 | + Compare, Watchlist |
| Agency | $149/mo | Unlimited | + White-label, Tracking |

## Example Prompts

- *"Analyze @garyvee's content strategy"*
- *"What hooks does @hubspot use in their Reels?"*
- *"Compare @nike and @adidas Instagram strategies"*
- *"Show my remaining analyses this month"*
- *"Pull up my last report"*

## Architecture

```
Claude (any client)
    ↓ MCP protocol
Scoopd MCP Server (stdio or HTTP)
    ↓ HTTPS API calls
scoopd.pro API (/api/analyze, /api/jobs, etc.)
    ↓
Worker (yt-dlp + GPT-4o analysis)
    ↓
9-section report → returned to Claude
```

**Remote mode** (`TRANSPORT=http`): Runs as HTTP server at `https://mcp.scoopd.pro/mcp`. Used by Claude.ai Connectors.

**Local mode** (`TRANSPORT=stdio`, default): Runs as subprocess. Used by Claude Code and Claude Desktop via `npx`.

## Development

```bash
git clone https://github.com/scoopd/scoopd-mcp-server
cd scoopd-mcp-server
npm install
npm run dev    # Watch mode with hot reload
npm run build  # Production build
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SCOOPD_API_KEY` | Yes (stdio) | Your Scoopd API key |
| `TRANSPORT` | No | `stdio` (default) or `http` |
| `PORT` | No | HTTP port (default: 3100) |

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
