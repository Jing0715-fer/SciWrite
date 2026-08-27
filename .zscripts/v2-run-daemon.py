#!/usr/bin/env python3
"""
Double-fork daemon to run the V2 full-generation E2E test detached from the
sandbox shell (same pattern as dev-daemon.py — see its docstring for why a
plain `nohup ... &` dies under this sandbox's process-tree cleanup).

Usage:
    python3 .zscripts/v2-run-daemon.py <logfile> [extra args to the test...]

Example:
    python3 .zscripts/v2-run-daemon.py tool-results/r17-run.log \
        --topic "Structural biology of TMC1 and TMC2 mechanotransduction channels" \
        --field "structural biology" --words 2500
"""
import os
import sys

CWD = "/home/z/my-project"
BUN = "bun"

if len(sys.argv) < 2:
    print("usage: v2-run-daemon.py <logfile> [test args...]", file=sys.stderr)
    sys.exit(1)

LOG = sys.argv[1] if os.path.isabs(sys.argv[1]) else os.path.join(CWD, sys.argv[1])
TEST_ARGS = sys.argv[2:]

# First fork
pid = os.fork()
if pid > 0:
    print(f"first-fork parent exiting, child={pid}")
    sys.exit(0)

os.setsid()

# Second fork — true daemon
pid = os.fork()
if pid > 0:
    sys.exit(0)

os.chdir(CWD)

devnull_fd = os.open("/dev/null", os.O_RDONLY)
log_fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
os.dup2(devnull_fd, 0)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)
os.close(devnull_fd)
os.close(log_fd)

# exec bun run scripts/full-generation-test.ts <args>
os.execvp(BUN, [BUN, "run", "scripts/full-generation-test.ts"] + TEST_ARGS)
