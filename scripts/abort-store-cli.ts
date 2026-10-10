/**
 * abort-store-cli.ts — ops tool for the persisted rate-abort state (RT4 P0-1).
 *
 *   bun run scripts/abort-store-cli.ts set   → simulate a storm abort (writes db/rate-abort.json)
 *   bun run scripts/abort-store-cli.ts clear → force-clear memory + file
 *   bun run scripts/abort-store-cli.ts show  → print the persisted state
 *
 * The "set" mode is also the live test for restart amnesia: an abort written
 * here (external process) must be hydrated by a dev server that never
 * called setAbort itself — verify via GET /api/quota-status → aborted:true.
 */
import { setAbort, clearAbort, isAborted } from "@/lib/rate-limiter";
import { loadRateAbort, rateAbortStorePath } from "@/lib/rate-abort-store";

const mode = process.argv[2] ?? "show";
if (mode === "set") {
  setAbort("manual/simulated storm via abort-store-cli");
  console.log(`abort SET → ${rateAbortStorePath()}`);
} else if (mode === "clear") {
  clearAbort();
  console.log(`abort CLEARED (file removed; this process's ladder reset)`);
} else {
  const persisted = loadRateAbort();
  console.log(`store file: ${rateAbortStorePath()}`);
  console.log("persisted:", persisted ? JSON.stringify(persisted, null, 2) : "(none)");
  console.log("isAborted() (this process):", isAborted());
}
