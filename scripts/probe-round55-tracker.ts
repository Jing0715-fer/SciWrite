/**
 * round-55 probe: the v2 phase table now includes review (0.3) + revise
 * (0.9, when armed) between compose and translate. Verify:
 *  1. Monotonic progress across the full event sequence (incl. review/revise)
 *  2. A verdict-free run (revise never fires — dead phase leaves its slice
 *     unclaimed; translate still progresses; finish() lands 100)
 *  3. A gate run (revise fires between compose and translate; translate
 *     events AFTER revise done still monotonic)
 */
import { PipelineProgressTracker } from "/home/z/my-project/src/lib/progress-tracker";

const phases = (both: boolean, armed: boolean) => [
  { step: "gather", weight: 2.2 },
  { step: "knowledge", weight: 1.4 },
  { step: "score", weight: 0.9 },
  { step: "curate", weight: 0.7 },
  { step: "plan", weight: 0.9 },
  { step: "analyze", weight: 1.1 },
  { step: "allocate", weight: 0.2 },
  { step: "generate", unitWeight: 2 },
  { step: "verify", unitWeight: 0.9 },
  { step: "compose", weight: 0.5 },
  { step: "review", weight: 0.3 },
  ...(armed ? [{ step: "revise", weight: 0.9 }] : []),
  ...(both ? [{ step: "translate", unitWeight: 0.75 }] : []),
];

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
}

function runScenario(name: string, both: boolean, armed: boolean, gateFires: boolean, sections = 8) {
  console.log(`\n[${name}] both=${both} armed=${armed} gateFires=${gateFires}`);
  const tr = new PipelineProgressTracker(phases(both, armed));
  const seq: { v: number | null; ev: any }[] = [];
  const feed = (ev: any) => {
    const v = tr.onEvent(ev);
    seq.push({ v, ev });
    return v;
  };
  const pctAt = (i: number) => seq[i].v;

  let i = 0;
  feed({ step: "init", status: "done" }); i++; assert(seq[0].v === null, "init untracked (passthrough)");
  feed({ step: "gather", status: "started" }); i++;
  for (let q = 1; q <= 5; q++) feed({ step: "gather", status: "progress", message: `query ${q}` });
  feed({ step: "gather", status: "done" });
  for (const s of ["knowledge", "score", "curate", "plan", "analyze", "allocate"]) {
    feed({ step: s, status: "started" }); feed({ step: s, status: "done" });
  }
  feed({ step: "plan", status: "done", sectionCount: sections });
  for (let s = 1; s <= sections; s++) {
    feed({ step: "generate", status: "started", section: s, total: sections });
    feed({ step: "generate", status: "streaming", section: s, total: sections, accumulatedLength: 400 });
    feed({ step: "verify", status: "started", section: s, total: sections });
    feed({ step: "verify", status: "done", section: s, total: sections, checked: 5, removed: 0 });
    feed({ step: "generate", status: "done", section: s, total: sections, wordCount: 300 });
  }
  feed({ step: "compose", status: "started" }); feed({ step: "compose", status: "done" });
  feed({ step: "review", status: "started" });
  const reviewMid = pctAt(seq.length - 1)!;
  feed({ step: "review", status: "done", verdict: "major-revision" });
  const reviewEnd = pctAt(seq.length - 1)!;
  console.log(`  review span: ${reviewMid.toFixed(1)} → ${reviewEnd.toFixed(1)}`);
  if (gateFires && armed) {
    feed({ step: "revise", status: "started", round: 1, total: 1 });
    feed({ step: "revise", status: "progress", round: 1 });
    feed({ step: "revise", status: "done", round: 1, total: 1 });
    feed({ step: "review", status: "started", round: 1 });
    feed({ step: "review", status: "done", round: 1, verdict: "minor-revision" });
  } else {
    feed({ step: "review", status: "done", verdict: "minor-revision" });
  }
  if (both) {
    feed({ step: "translate", status: "started" });
    for (let s = 1; s <= sections; s++) {
      feed({ step: "translate", status: "started", section: s, total: sections, wordCount: 320 });
      feed({ step: "translate", status: "streaming", section: s, total: sections, accumulatedLength: 500 });
      feed({ step: "translate", status: "done", section: s, total: sections, wordCount: 600 });
    }
    feed({ step: "translate", status: "done", message: "complete" });
  }
  feed({ step: "relationships", status: "started" }); // untracked → passthrough
  const finish = tr.finish();

  // Assertions
  const vals = seq.map((x) => x.v).filter((v): v is number => v != null);
  for (let k = 1; k < vals.length; k++) {
    assert(vals[k] >= vals[k - 1], `monotonic violated at event ${k}: ${vals[k - 1]} → ${vals[k]}`);
  }
  assert(vals.length > 0, "some events tracked");
  assert(Math.max(...vals) <= 99.4, "no premature 100");
  assert(finish === 100, "finish() = 100");
  const lastTracked = vals[vals.length - 1];
  console.log(`  last tracked=${lastTracked.toFixed(1)} finish=100`);
  if (both) {
    // translate events must progress beyond the review/revise region
    assert(lastTracked > 90, `translate reached deep into the bar (got ${lastTracked})`);
  }
  console.log(`  OK (${vals.length} tracked events, strictly monotonic)`);
}

runScenario("v2 EN + gate armed, verdict OK (no revise fires)", false, true, false);
runScenario("v2 both + gate armed, major-revision → revise fires", true, true, true);
runScenario("v2 both + gate OFF", true, false, false);
runScenario("v2 EN + gate OFF", false, false, false);

console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
