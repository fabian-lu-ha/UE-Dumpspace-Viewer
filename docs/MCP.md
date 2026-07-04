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

### Updating an existing install

```bash
npm run update   # git pull --ff-only + npm install
```

Then reconnect the client so it reloads the server process:

- Claude Code: `/mcp` -> reconnect
- Codex: restart Codex
- oh-my-pi: `/mcp reload`

The registration points at `src/mcp/server.mjs` by path, so new code is picked up on reconnect without re-registering (unless you moved the repo, in which case re-run `npm run mcp:install`). If you are updating from a version that predates the MCP server, run `npm run mcp:install` once after updating.

Check the running version with `get_dump_status` - its `serverVersion` should match `version` in `package.json`. If it is behind, the client is still running an old process; reconnect it.

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

## Bulk offset resolution

`resolve_offsets` is the go-to for looking up or verifying known offsets - use it instead of parsing the dump JSON yourself. It resolves many members in one call instead of paging through `search_members` per class, searches inherited members by default, and falls back to a same-named function (returning its address) when a name is a UFUNCTION rather than a field. Matching is case-insensitive, and a miss returns `suggestions` (the closest real member/function names) so a typo surfaces the right name.

```json
{
  "queries": ["AActor::RootComponent", "UWorld::PersistentLevel", "AActor::K2_DestroyActor", "AActor::Nope"],
  "includeInherited": true
}
```

returns each query with its offset (members) or address (functions), and for misses reports which classes were searched:

```json
{
  "total": 4,
  "found": 3,
  "missing": 1,
  "results": [
    { "found": true, "kind": "member", "class": "AActor", "member": "RootComponent", "offsetHex": "0x1e0", "type": "USceneComponent*", "size": 8 },
    { "found": true, "kind": "member", "class": "UWorld", "member": "PersistentLevel", "offsetHex": "0x50" },
    { "found": true, "kind": "function", "class": "AActor", "member": "K2_DestroyActor", "addressHex": "0x4134580" },
    { "found": false, "reason": "member/function not found", "searchedClasses": ["AActor", "UObject"], "membersScanned": 81 }
  ]
}
```

## Raw JSON and full member listings

- Pass `raw: true` to `get_symbol_detail` or `search_members` (or `resolve_offsets`) to include the raw dump entry - the array-of-tuples member format `[[TypeName, TypeKind, Mod, []], Offset, Size, Flags]`.
- Pass `memberLimit: 0` to `get_symbol_detail` (or `limit: 0` to a search) to return all members uncapped, instead of a single page.
- `search_members` results include a `searched` field listing the classes scanned and total member count - handy for understanding an empty `includeInherited` result.
