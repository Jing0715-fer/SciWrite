#!/bin/bash
cd /home/z/my-project
export PORT=3000
export HOSTNAME=0.0.0.0
export NODE_ENV=production

while true; do
  echo "[$(date '+%H:%M:%S')] Starting server..."
  bun .next/standalone/server.js 2>&1 | tee -a /home/z/my-project/dev.log &
  SERVER_PID=$!
  
  # Keep-alive: ping every 5s, restart if dead
  while kill -0 $SERVER_PID 2>/dev/null; do
    sleep 5
    # Self-ping to keep the process active
    curl -s -o /dev/null http://localhost:3000/api/projects 2>/dev/null || true
  done
  
  echo "[$(date '+%H:%M:%S')] Server died, restarting in 2s..."
  sleep 2
done
