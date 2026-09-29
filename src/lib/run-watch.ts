/**
 * run-watch registry (round-cs-8: frozen-progress recovery).
 *
 * WHY THIS EXISTS: the one-click generation pipeline reports progress over a
 * single long-lived SSE connection, but that wire can drop mid-run (proxy
 * idle-cut, gateway timeout, dev-server HMR restart, tab sleep) while the
 * pipeline itself keeps running server-side. The UI now recovers by polling
 * GET /api/task-runs — and those polls double as a LIVENESS signal.
 *
 * The v2 route uses this registry to distinguish:
 *  - "wire dropped, but a client is still watching" (the recovery poller —
 *    or a human viewing the Run Timeline) → keep the pipeline running;
 *  - "wire dropped and nobody is watching" → abort after a grace window
 *    (the original client-disconnect waste guard, now time-shifted so a
 *    transient cut never kills a live run).
 *
 * Module-scope singleton inside the dev-server process, in-memory only —
 * the same lifetime class as the pipelines it observes.
 */

const lastWatchAt: Record<string, number> = {};

export const runWatch = {
  /** Record "a client just observed this project's run timeline". */
  touch(projectId: string): void {
    if (!projectId) return;
    lastWatchAt[projectId] = Date.now();
  },
  /** Epoch-ms of the last watch touch for the project (0 = never watched). */
  since(projectId: string): number {
    return lastWatchAt[projectId] ?? 0;
  },
};
