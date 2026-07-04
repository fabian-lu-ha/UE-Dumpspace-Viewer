const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function importSdk(modulePath) {
  return import(modulePath);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function createDumpFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dumpspace-mcp-'));
  writeJson(path.join(folder, 'ClassesInfo.json'), {
    UObject: [{ __MDKClassSize: [0, 40] }],
    AActor: [{ __InheritInfo: ['UObject'] }, { RootComponent: [['USceneComponent', 'C', '*'], 304, 8] }],
    ADBDPlayer: [{ __InheritInfo: ['AActor'] }, { HealthComponent: [['UHealthComponent', 'C', '*'], 1920, 8] }]
  });
  writeJson(path.join(folder, 'StructsInfo.json'), {});
  writeJson(path.join(folder, 'FunctionsInfo.json'), {
    ADBDPlayer: {
      GetHealth: [['float', 'D'], []]
    }
  });
  writeJson(path.join(folder, 'EnumsInfo.json'), {});
  writeJson(path.join(folder, 'OffsetsInfo.json'), {
    GWorld: 1193046
  });
  return folder;
}

test('stdio MCP server loads a dump and supports paged search, member search, and inheritance checks', async () => {
  const { Client } = await importSdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await importSdk('@modelcontextprotocol/sdk/client/stdio.js');
  const dumpFolder = createDumpFolder();
  const serverPath = path.join(__dirname, '..', 'src', 'mcp', 'server.mjs');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath]
  });
  const client = new Client({ name: 'dumpspace-integration-test', version: '1.0.0' });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        'explain_type_relationship',
        'get_dump_status',
        'get_symbol_detail',
        'load_dump_folder',
        'search_members',
        'search_symbols'
      ]
    );

    const loadResult = await client.callTool({
      name: 'load_dump_folder',
      arguments: { folderPath: dumpFolder }
    });
    const loadPayload = JSON.parse(loadResult.content[0].text);
    assert.equal(loadPayload.success, true);
    assert.equal(loadPayload.counts.classes, 3);

    const searchResult = await client.callTool({
      name: 'search_symbols',
      arguments: { query: '*health*|A*', kinds: ['class', 'function'], limit: 2 }
    });
    const searchPayload = JSON.parse(searchResult.content[0].text);
    assert.equal(searchPayload.items.length, 2);
    assert.equal(typeof searchPayload.page.nextCursor, 'string');

    const memberResult = await client.callTool({
      name: 'search_members',
      arguments: {
        owner: 'ADBDPlayer',
        query: '*component*',
        includeInherited: true,
        searchFields: ['name', 'type'],
        limit: 10
      }
    });
    const memberPayload = JSON.parse(memberResult.content[0].text);
    assert.deepEqual(
      memberPayload.items.map((item) => `${item.owner}.${item.name}`),
      ['AActor.RootComponent', 'ADBDPlayer.HealthComponent']
    );

    const relationshipResult = await client.callTool({
      name: 'explain_type_relationship',
      arguments: { from: 'ADBDPlayer*', to: 'UObject*' }
    });
    const relationshipPayload = JSON.parse(relationshipResult.content[0].text);
    assert.equal(relationshipPayload.compatible, true);
    assert.equal(relationshipPayload.relationship, 'derived-to-base');
    assert.deepEqual(relationshipPayload.path, ['ADBDPlayer', 'AActor', 'UObject']);
  } finally {
    await client.close();
    fs.rmSync(dumpFolder, { recursive: true, force: true });
  }
});
