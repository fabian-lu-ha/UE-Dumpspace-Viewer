import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const { DumpspaceSession } = require('../core/dumpspaceSession');
const { version: SERVER_VERSION } = require('../../package.json');

const session = new DumpspaceSession({
  defaultLimit: Number.parseInt(process.env.DUMPSPACE_MCP_DEFAULT_LIMIT || '50', 10),
  maxLimit: Number.parseInt(process.env.DUMPSPACE_MCP_MAX_LIMIT || '200', 10)
});

const server = new McpServer(
  {
    name: 'ue-dumpspace-viewer',
    version: SERVER_VERSION
  },
  {
    instructions: [
      'Inspect Unreal Engine Dumper-7 JSON dumps.',
      'Workflow: 1) load_dump_folder once. 2) search_symbols / search_members to find compact handles.',
      '3) get_symbol_detail to expand a handle (class size + members, enum values, or a function signature + address).',
      'For offsets, prefer resolve_offsets: it takes many "Class::Member" strings and returns offsets (members) or',
      'addresses (functions) in one call - much cheaper than one detail call per symbol.',
      'Queries support substring, glob wildcards (*), OR (|), and filters (kind:, inherits:, assignableTo:),',
      'e.g. *health*|player* or kind:class inherits:UObject.',
      'Paging: search tools return page.nextCursor; pass it back as cursor. Use limit/memberLimit 0 to get all at once',
      'for bounded sets like a class\'s members. Add raw:true when you need the exact array-of-tuples JSON shape.'
    ].join(' ')
  }
);

const CursorSchema = z.string().optional().describe('Opaque cursor from a previous paged result.');
const LimitSchema = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .optional()
  .describe('Requested page size. The server caps this to its configured maxLimit. Use 0 for all (uncapped) - intended for bounded sets like a class\'s members.');

function jsonResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function requireLoaded() {
  const counts = session.getCounts();
  const loaded = Object.values(counts).some((count) => count > 0);
  if (!loaded) {
    return {
      error: 'No dump is loaded. Call load_dump_folder with a folder containing Dumper-7 JSON files first.',
      requiredFiles: ['ClassesInfo.json', 'StructsInfo.json', 'FunctionsInfo.json', 'EnumsInfo.json', 'OffsetsInfo.json']
    };
  }
  return null;
}

server.registerTool(
  'load_dump_folder',
  {
    title: 'Load Dumper-7 JSON Folder',
    description:
      'Load a folder containing Dumper-7 JSON files into the MCP session. Required before search and inspection tools.',
    inputSchema: {
      folderPath: z.string().min(1).describe('Absolute or working-directory-relative path containing the dump JSON files.')
    }
  },
  async ({ folderPath }) => jsonResult(session.loadFolder(folderPath))
);

server.registerTool(
  'get_dump_status',
  {
    title: 'Get Loaded Dump Status',
    description:
      'Health check: returns the server version, the loaded flag, the currently loaded folder, and symbol counts. Call this first if unsure whether a dump is loaded, or to check the running server version.',
    inputSchema: {}
  },
  async () => {
    const counts = session.getCounts();
    return jsonResult({
      serverVersion: SERVER_VERSION,
      loaded: Object.values(counts).some((count) => count > 0),
      folderPath: session.folderPath,
      counts,
      limits: {
        defaultLimit: session.defaultLimit,
        maxLimit: session.maxLimit
      }
    });
  }
);

server.registerTool(
  'search_symbols',
  {
    title: 'Search Symbols',
    description:
      'Search classes, structs, functions, enums, and offsets. Supports glob wildcards and OR with |, e.g. *health*|player*. Returns compact handles and nextCursor for paging.',
    inputSchema: {
      query: z.string().default('*').describe('Search query. Supports *, |, and filters such as kind:class inherits:UObject.'),
      kinds: z
        .array(z.enum(['class', 'struct', 'function', 'enum', 'offset']))
        .optional()
        .describe('Optional symbol kinds to include. Omit for all kinds.'),
      regex: z.boolean().optional().describe('Treat query terms as regular expressions instead of glob/substring terms.'),
      cursor: CursorSchema,
      limit: LimitSchema
    }
  },
  async (args) => {
    const notLoaded = requireLoaded();
    if (notLoaded) return jsonResult(notLoaded);
    return jsonResult(session.searchSymbols(args));
  }
);

server.registerTool(
  'search_members',
  {
    title: 'Search Members',
    description:
      'Search members on a class/struct. Can include inherited members and search names, types, or both. Returns compact member handles and nextCursor.',
    inputSchema: {
      owner: z.string().min(1).describe('Class/struct name or symbol id, for example ADBDPlayer or class:ADBDPlayer.'),
      query: z.string().default('*').describe('Member query. Supports *, |, and regex when regex is true.'),
      includeInherited: z.boolean().default(false).describe('Include members from base classes/structs in inheritance order.'),
      searchFields: z
        .array(z.enum(['name', 'type']))
        .default(['name'])
        .describe('Which member fields to match against. Use ["name","type"] for broad discovery.'),
      regex: z.boolean().optional().describe('Treat query terms as regular expressions instead of glob/substring terms.'),
      raw: z.boolean().optional().describe('Include each member\'s raw JSON tuple ([typeInfo, offset, size, ...]).'),
      cursor: CursorSchema,
      limit: LimitSchema
    }
  },
  async (args) => {
    const notLoaded = requireLoaded();
    if (notLoaded) return jsonResult(notLoaded);
    return jsonResult(session.searchMembers(args));
  }
);

server.registerTool(
  'get_symbol_detail',
  {
    title: 'Get Symbol Detail',
    description:
      'Expand a symbol handle from search_symbols (or a bare name of any kind). Class/struct returns size + inheritance + children; enum returns values + underlying type; function returns signature, address, and flags. Set includeMembers with memberLimit 0 to list all members; set raw true for the exact JSON entry.',
    inputSchema: {
      symbolId: z.string().min(1).describe('Symbol id from search_symbols, or a class/struct name.'),
      includeMembers: z.boolean().default(false).describe('Include a first page of direct members for class/struct symbols.'),
      memberLimit: LimitSchema,
      raw: z.boolean().optional().describe('Include the raw JSON entry for the symbol (e.g. the array-of-tuples member format).')
    }
  },
  async (args) => {
    const notLoaded = requireLoaded();
    if (notLoaded) return jsonResult(notLoaded);
    return jsonResult(session.getSymbolDetail(args));
  }
);

server.registerTool(
  'explain_type_relationship',
  {
    title: 'Explain Type Relationship',
    description:
      'Explain whether one class/struct type can be converted to another through inheritance. Reports same-type, derived-to-base, base-to-derived, or unrelated.',
    inputSchema: {
      from: z.string().min(1).describe('Source type name, optionally with a trailing pointer star.'),
      to: z.string().min(1).describe('Target type name, optionally with a trailing pointer star.')
    }
  },
  async (args) => {
    const notLoaded = requireLoaded();
    if (notLoaded) return jsonResult(notLoaded);
    return jsonResult(session.explainTypeRelationship(args));
  }
);

server.registerTool(
  'resolve_offsets',
  {
    title: 'Resolve Offsets (bulk)',
    description:
      'Resolve/verify many "ClassName::MemberName" queries to offsets in a single call - use this instead of parsing the dump JSON yourself. Searches inherited members by default and falls back to a same-named function (returning its address). A miss reports which classes were searched plus "suggestions": the closest real names, so a typo or wrong case surfaces the right one.',
    inputSchema: {
      queries: z
        .array(z.string().min(1))
        .min(1)
        .describe('List of "ClassName::MemberName" strings, e.g. ["AActor::RootComponent", "UWorld::GameState"].'),
      includeInherited: z
        .boolean()
        .default(true)
        .describe('Search base classes/structs as well (most-derived class wins). Default true.'),
      raw: z.boolean().optional().describe('Include the raw JSON entry for each resolved member/function.')
    }
  },
  async (args) => {
    const notLoaded = requireLoaded();
    if (notLoaded) return jsonResult(notLoaded);
    return jsonResult(session.resolveOffsets(args));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
