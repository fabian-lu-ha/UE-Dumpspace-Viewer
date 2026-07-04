# Dumpspace Viewer MCP Server

This project includes a local stdio MCP server for Claude Code, Codex, and oh-my-pi.

## Run

```bash
npm run mcp
```

The server keeps dump data in memory for the current MCP process. Call `load_dump_folder` before using search or inspection tools.

## Setup (one command)

From the repo root:

```bash
npm install
npm run mcp:install
```

`mcp:install` detects the Claude Code (`claude`), Codex (`codex`), and oh-my-pi (`omp`) clients and **prompts you to choose** which one(s) to register with. It uses the absolute path to `server.mjs` so it works from any directory, and it is safe to re-run — it re-points an existing registration at the current path (handy if you move the repo). For oh-my-pi it merges into `~/.omp/agent/mcp.json` without touching your other servers. No config files to edit by hand.

To skip the prompt, name the target:

```bash
npm run mcp:install -- claude   # Claude Code only
npm run mcp:install -- codex    # Codex only
npm run mcp:install -- pi       # oh-my-pi only (alias: omp)
npm run mcp:install -- all      # every detected client
```

Then **reconnect** the client and ask it to call `load_dump_folder` with your dump directory:

- Claude Code: `/mcp` -> reconnect
- Codex: restart Codex
- oh-my-pi: `/mcp reload`

### Manual registration (optional)

If you prefer to register it yourself, or use another client, the CLIs are:

```bash
# Claude Code
claude mcp add --scope user --transport stdio dumpspace-viewer -- node /absolute/path/to/UE-Dumpspace-Viewer/src/mcp/server.mjs

# Codex
codex mcp add dumpspace-viewer -- node /absolute/path/to/UE-Dumpspace-Viewer/src/mcp/server.mjs
```

oh-my-pi has no registration CLI. Add this to `~/.omp/agent/mcp.json` (user-level) or `.omp/mcp.json` (project-level), then run `/mcp reload` in the agent:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "dumpspace-viewer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/UE-Dumpspace-Viewer/src/mcp/server.mjs"]
    }
  }
}
```

Other clients (Claude Desktop, Cursor, Cline, Windsurf, ...) use the same `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "dumpspace-viewer": {
      "command": "node",
      "args": ["/absolute/path/to/UE-Dumpspace-Viewer/src/mcp/server.mjs"]
    }
  }
}
```

## Query Model

Search tools return compact handles and paging metadata:

```json
{
  "items": [],
  "page": {
    "nextCursor": null,
    "limit": 50,
    "totalApprox": 0
  }
}
```

Queries support substring matching, glob wildcards, and OR:

```text
*health*
player*|survivor*
kind:class inherits:UObject
kind:class assignableTo:UObject
```

Use `get_symbol_detail` and `search_members` to expand a handle. Use `explain_type_relationship` when deciding whether one type can be treated as another through inheritance.
