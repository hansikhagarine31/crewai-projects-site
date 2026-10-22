// Runs the agents tests with the virtual environment's Python, on Windows or elsewhere.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agents = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
const candidates = [path.join(agents, '.venv', 'Scripts', 'python.exe'), path.join(agents, '.venv', 'bin', 'python')];
const python = candidates.find((candidate) => existsSync(candidate)) ?? 'python';
const result = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-W', 'ignore', ...process.argv.slice(2)], { cwd: agents, stdio: 'inherit' });
process.exit(result.status ?? 1);
