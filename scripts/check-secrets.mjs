// Searches the files of the repository (tracked, or not tracked and not ignored) and, when it exists, the built
// frontend for anything that looks like a secret. Exits with status 1 and lists the files when it finds one.
// Usage: node scripts/check-secrets.mjs [directory ...]   (extra directories are scanned as they are)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = [
  { name: 'Google API key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'OpenAI or similar secret key', regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'A shared secret with a value', regex: /\bAGENT_SHARED_SECRET\s*[:=]\s*['"]?(?!change-me|test|\$|<|['"]|\s|$)[A-Za-z0-9+/_-]{12,}/ },
  { name: 'A Gemini key with a value', regex: /\bGEMINI_API_KEY\s*[:=]\s*['"]?(?!\$|<|['"]|\s|$)[A-Za-z0-9_-]{12,}/ },
];
// Names that must never appear in what the browser receives.
const BROWSER_ONLY = [
  { name: 'The shared-secret header or variable in the browser bundle', regex: /x-agent-secret|AGENT_SHARED_SECRET|GEMINI_API_KEY/i },
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', '.pytest_cache', 'dist']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|pyc)$/i;

function listRepository() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).map((file) => path.join(root, file));
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) && directory === root) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function scan(files, patterns) {
  const found = [];
  for (const file of files) {
    if (BINARY.test(file) || !existsSync(file) || statSync(file).size > 5 * 1024 * 1024) continue;
    const text = readFileSync(file, 'utf8');
    for (const { name, regex } of patterns) {
      if (regex.test(text)) found.push(`${path.relative(root, file)}: ${name}`);
    }
  }
  return found;
}

const problems = [...scan(listRepository(), PATTERNS)];
const bundles = [path.join(root, 'frontend', 'dist'), ...process.argv.slice(2).map((dir) => path.resolve(dir))].filter(existsSync);
for (const bundle of bundles) problems.push(...scan(walk(bundle), [...PATTERNS, ...BROWSER_ONLY]));

// An env file that holds a value must never be tracked.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of tracked) {
  if (/(^|\/)\.env(\.[^/]*)?$/.test(file) && !file.endsWith('.env.example')) problems.push(`${file}: an environment file is tracked`);
}

if (problems.length > 0) {
  console.error(`Possible secrets found:\n${problems.map((line) => `  ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`No secrets found in ${listRepository().length} files${bundles.length ? ` and ${bundles.length} built bundle(s)` : ''}.`);
