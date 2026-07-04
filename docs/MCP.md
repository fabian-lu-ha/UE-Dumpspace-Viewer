# Dumpspace Viewer MCP Server

This project includes a local stdio MCP server for Claude Code and Codex.

## Run

```bash
npm run mcp
```

The server keeps dump data in memory for the current MCP process. Call `load_dump_folder` before using search or inspection tools.

## Claude Code

Install the server in Claude Code's local project config:

```bash
claude mcp add --transport stdio dumpspace-viewer -- node src/mcp/server.mjs
```

Using an absolute path is recommended if you launch Claude from outside the repository.

## Codex

Project-scoped configuration is included in `.codex/config.toml`:

```toml
[mcp_servers.dumpspace_viewer]
command = "node"
args = ["src/mcp/server.mjs"]
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
