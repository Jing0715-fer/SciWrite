#!/usr/bin/env bash
# Use plain Node (not bun) for Next dev to avoid a Prisma IPC pipe stall that
# silently hangs the gather save loop under sustained SQLite writes.
#
# Symptom: gather step ends with "Saving..." progress event, then UI sits at
# 17% forever with no further events. Cause: bun's child-process IPC channel
# to query_engine-windows.dll.node never resolves a few inserts after the
# loop has been running for ~30-60 seconds.
#
# Switching to `npx next dev` (Node 22) bypasses that and the full
# `gather → curate → plan → generate → compose` pipeline completes.
set -e
cd "$(dirname "$0")/.."
rm -rf .next dev.log
exec npx next dev -p 3000 > dev.log 2>&1
