#!/usr/bin/env node
// Registers this project's MCP server with a client you choose.
// Interactive:      npm run mcp:install
// Non-interactive:  npm run mcp:install -- claude | codex | pi | all
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'mcp', 'server.mjs');
const NAME = 'dumpspace-viewer';
const quote = (s) => `"${s}"`;

const OMP_SCHEMA =
  'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';

function have(bin) {
  try {
    execSync(`${bin} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Run a command, swallowing output/errors; returns true on exit code 0.
function run(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// oh-my-pi has no registration CLI, so write its mcp.json directly.
// Merge into any existing config instead of clobbering it.
function writeOmpConfig() {
  const dir = join(homedir(), '.omp', 'agent');
  const file = join(dir, 'mcp.json');

  let config = { $schema: OMP_SCHEMA, mcpServers: {} };
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      console.log(`  [fail] oh-my-pi: ${file} is not valid JSON; left it untouched`);
      return false;
    }
  }
  if (!config.$schema) config.$schema = OMP_SCHEMA;
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};

  config.mcpServers[NAME] = { type: 'stdio', command: 'node', args: [serverPath] };

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

const CLIENTS = [
  {
    key: 'claude',
    label: 'Claude Code',
    reconnect: '/mcp -> reconnect',
    detect: () => have('claude'),
    register() {
      // Re-point any existing registration at the current path (idempotent).
      run(`claude mcp remove --scope user ${NAME}`);
      run(`claude mcp remove ${NAME}`);
      return run(`claude mcp add --scope user --transport stdio ${NAME} -- node ${quote(serverPath)}`);
    }
  },
  {
    key: 'codex',
    label: 'Codex',
    reconnect: 'restart Codex',
    detect: () => have('codex'),
    register() {
      run(`codex mcp remove ${NAME}`);
      return run(`codex mcp add ${NAME} -- node ${quote(serverPath)}`);
    }
  },
  {
    key: 'pi',
    label: 'oh-my-pi (omp)',
    aliases: ['omp', 'ohmypi'],
    reconnect: '/mcp reload',
    detect: () => have('omp') || existsSync(join(homedir(), '.omp')),
    register: writeOmpConfig
  }
];

const matchesArg = (c, arg) => c.key === arg || (c.aliases || []).includes(arg);

const available = CLIENTS.map((c) => ({ ...c, present: c.detect() }));
const present = available.filter((c) => c.present);

async function chooseTargets() {
  const arg = (process.argv[2] || '').toLowerCase();

  if (arg) {
    if (arg === 'all') return present;
    const match = present.find((c) => matchesArg(c, arg));
    if (!match) {
      const names = present.map((c) => c.key).join(', ') || 'none detected';
      console.error(`No available client matches "${arg}". Detected: ${names}`);
      process.exit(1);
    }
    return [match];
  }

  if (present.length === 0) {
    console.log('No supported client (claude, codex, oh-my-pi) was found.');
    console.log('Install one, then re-run: npm run mcp:install');
    process.exit(1);
  }

  if (!stdin.isTTY) {
    console.error('Non-interactive shell. Pass a target: npm run mcp:install -- <claude|codex|pi|all>');
    process.exit(1);
  }

  console.log(`Register MCP server "${NAME}"`);
  console.log(`  command: node ${serverPath}\n`);
  console.log('Which client do you want to install it to?\n');
  present.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
  console.log('  a) all of the above\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('Select (number, comma-separated, or "a"): ')).trim().toLowerCase();
  rl.close();

  if (answer === 'a' || answer === 'all') return present;
  const chosen = answer
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => present[Number.parseInt(t, 10) - 1])
    .filter(Boolean);

  if (chosen.length === 0) {
    console.log('Nothing selected. Exiting.');
    process.exit(1);
  }
  return chosen;
}

const targets = await chooseTargets();

console.log('');
const done = [];
for (const c of targets) {
  const ok = c.register();
  console.log(ok ? `  [ok] ${c.label}` : `  [fail] ${c.label} registration failed`);
  if (ok) done.push(c);
}

console.log('');
if (done.length > 0) {
  console.log(`Done - ${done.length} client(s) configured. Reconnect, then call load_dump_folder:`);
  for (const c of done) {
    console.log(`  - ${c.label}: ${c.reconnect}`);
  }
} else {
  process.exitCode = 1;
}
