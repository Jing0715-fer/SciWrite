/**
 * e2e-daemon.ts — reaper-proof E2E launcher (see dev-daemon.ts for the
 * sandbox reaper rationale). Runs the full-generation E2E test detached,
 * logging to tool-results/rt16-e2e.log.
 */
import { spawn } from 'child_process';
import { openSync } from 'fs';

const CWD = '/home/z/SciWrite';
const OUT = openSync(`${CWD}/tool-results/rt16-e2e.log`, 'a');

const child = spawn('bun', ['run', 'scripts/full-generation-test.ts', '--words', '1500'], {
  cwd: CWD,
  env: { ...process.env, DATABASE_URL: 'file:/home/z/SciWrite/db/custom.db' },
  detached: true,
  stdio: ['ignore', OUT, OUT],
});

child.unref();
console.log(`e2e spawned: pid=${child.pid} -> tool-results/rt16-e2e.log`);
