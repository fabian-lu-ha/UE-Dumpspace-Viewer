#!/usr/bin/env node
// Registers this project's MCP server with a client CLI you choose.
// Interactive:      npm run mcp:install
// Non-interactive:  npm run mcp:install -- claude | codex | all
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'mcp', 'server.mjs');
const NAME = 'dumpspace-viewer';
const quote = (s) => `"${s}"`;

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

const CLIENTS = [
  {
    key: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    // Re-point any existing registration at the current path (idempotent).
    register() {
      run(`claude mcp remove --scope user ${NAME}`);
      run(`claude mcp remove ${NAME}`);
      return run(`claude mcp add --scope user --transport stdio ${NAME} -- node ${quote(serverPath)}`);
    }
  },
  {
    key: 'codex',
    label: 'Codex',
    bin: 'codex',
    register() {
      run(`codex mcp remove ${NAME}`);
      return run(`codex mcp add ${NAME} -- node ${quote(serverPath)}`);
    }
  }
];

const available = CLIENTS.map((c) => ({ ...c, present: have(c.bin) }));
const present = available.filter((c) => c.present);

async function chooseTargets() {
  const arg = (process.argv[2] || '').toLowerCase();

  // Explicit target from the command line.
  if (arg) {
    if (arg === 'all') return present;
    const match = present.find((c) => c.key === arg);
    if (!match) {
      const names = present.map((c) => c.key).join(', ') || 'none detected';
      console.error(`No available client matches "${arg}". Detected: ${names}`);
      process.exit(1);
    }
    return [match];
  }

  if (present.length === 0) {
    console.log('No supported client CLI (claude, codex) was found on your PATH.');
    console.log('Install Claude Code or Codex, then re-run: npm run mcp:install');
    process.exit(1);
  }

  // Non-interactive shell with no argument: require an explicit target.
  if (!stdin.isTTY) {
    console.error('Non-interactive shell. Pass a target: npm run mcp:install -- <claude|codex|all>');
    process.exit(1);
  }

  // Interactive menu.
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
let configured = 0;
for (const c of targets) {
  const ok = c.register();
  console.log(ok ? `  [ok] ${c.label}` : `  [fail] ${c.label} registration failed`);
  if (ok) configured++;
}

console.log('');
if (configured > 0) {
  console.log(`Done - ${configured} client(s) configured.`);
  console.log('Restart or reconnect the client (in Claude Code: /mcp), then ask it to call');
  console.log('load_dump_folder with the path to your Dumper-7 JSON folder.');
} else {
  process.exitCode = 1;
}
