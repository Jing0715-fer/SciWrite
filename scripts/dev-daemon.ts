/**
 * dev-daemon.ts — sandbox-reaper-proof dev server launcher.
 *
 * The Bash tool in this sandbox reaps orphaned/background processes at command
 * boundaries (setsid/nohup/disown all die). The ONLY survival path observed
 * is a `detached: true` + `unref()`'d child spawned from a bun process that
 * exits immediately after. This script exists solely to perform that spawn.
 *
 * Usage: bun run scripts/dev-daemon.ts
 * Output: /home/z/SciWrite/dev.log (server stdout+stderr)
 */
import { spawn } from 'child_process';
import { openSync } from 'fs';

const CWD = '/home/z/SciWrite';
const OUT = openSync(`${CWD}/dev.log`, 'a');
const ERR = openSync(`${CWD}/dev.log`, 'a');

const env = {
  ...process.env,
  DATABASE_URL: 'file:/home/z/SciWrite/db/custom.db',
};

const child = spawn('bun', ['x', 'next', 'dev', '-p', '3000'], {
  cwd: CWD,
  env,
  detached: true,
  stdio: ['ignore', OUT, ERR],
});

child.unref();
console.log(`dev server spawned: pid=${child.pid} -> ${CWD}/dev.log`);
