#!/usr/bin/env python3
"""
Double-fork daemon to start the Next.js dev server detached from any
parent shell session. This is the ONLY reliable way to keep `bun run dev`
alive under sandbox shells that aggressively reap child processes
between tool calls (e.g. MCP bash tool's process-tree cleanup).

=== Why this script exists ===
Running `bun run dev &` + `disown` from a shell works for normal
terminals but dies when the spawning shell is killed by its parent
tool. Running `nohup bun run dev > dev.log 2>&1 &` keeps the process
alive longer but the parent bash that owns the redirection can still
get reaped, leaving stdout pointing at a closed pipe -- every write
then raises EPIPE -> `uncaughtException` -> the next-server enters a
degraded state where SSE streams silently disconnect mid-pipeline.
This is the root cause of the infamous `v2 pipeline failed` errors
the user saw during V2 generation.

=== How it works ===
1. fork() -- parent exits, child becomes session leader (setsid)
2. fork() again -- true daemon pattern, child reparents to init
3. os.dup2() redirects OS-level fds 0/1/2 to /dev/null and dev.log
4. os.execvp() replaces this python process with `next dev`,
   inheriting the redirected fd table.

Step 3 is critical: `sys.stdout = open(...)` only changes Python's
stdout wrapper, NOT the OS-level fd 1. Without os.dup2 the child
next process keeps the parent shell's pipe as stdout, which breaks
the moment the parent shell is reaped.

Usage:
    python3 .zscripts/dev-daemon.py
Then verify with:
    sleep 5 && curl -sS --max-time 30 http://localhost:3000/ -o /dev/null -w '%{http_code}\\n'
"""
import os
import sys

DEV_BIN = "/home/z/my-project/node_modules/.bin/next"
CWD = "/home/z/my-project"
LOG = "/home/z/my-project/dev.log"
PORT = "3000"

# First fork
pid = os.fork()
if pid > 0:
    print(f"first-fork parent exiting, child={pid}")
    sys.exit(0)

os.setsid()

pid = os.fork()
if pid > 0:
    sys.exit(0)

os.chdir(CWD)

# Redirect OS-level fds. MUST use os.dup2 -- sys.stdout reassignment
# is NOT inherited by execvp.
devnull_fd = os.open("/dev/null", os.O_RDONLY)
log_fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(devnull_fd, 0)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)
os.close(devnull_fd)
os.close(log_fd)

os.execvp(DEV_BIN, [DEV_BIN, "dev", "-p", PORT])
