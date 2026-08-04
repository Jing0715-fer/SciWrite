#!/bin/bash
# Watchdog: restart dev server if it dies
cd /home/z/my-project
while true; do
  echo "[$(date)] starting dev server..." >> dev.log
  bun run dev >> dev.log 2>&1 &
  DEVPID=$!
  echo "[$(date)] dev server pid: $DEVPID" >> dev.log
  # Wait for it to die
  wait $DEVPID
  EXIT_CODE=$?
  echo "[$(date)] dev server exited with code $EXIT_CODE, restarting in 2s..." >> dev.log
  sleep 2
done
