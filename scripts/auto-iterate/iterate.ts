/**
 * auto-iterate round runner — one autonomous improvement round.
 *
 * round-63: the user asked for a SCHEDULED iteration loop:
 *   "定时迭代项目，每轮完成后都要push，并要回顾修改前后的效果对比，
 *    如果效果变差了需要及时矫正"
 *   (iterate the project on a schedule; push after every round; compare
 *    before/after effect; correct promptly when the effect regresses)
 *
 * The sandbox has no system cron (no crontab/crond), so the schedule lives
 * in mini-services/iterate-scheduler (a bun --hot service that triggers
 * THIS script). The script itself is scheduler-agnostic and can be run
 * manually at any time:
 *
 *   bun scripts/auto-iterate/iterate.ts
 *
 * One round:
 *   1. Lockfile guard (never two concurrent rounds).
 *   2. Snapshot: git HEAD, previous round's metrics, last-known-good SHA.
 *   3. Health: dev server (restart if reaped) + provider probe (wait up to
 *      30 min when a canary run is pending — the account-level 429 storms
 *      of rounds 60/62 lasted hours).
 *   4. Mechanical gate: tsc + lint error counts (the code-quality baseline).
 *   5. Canary production test (provider healthy only): create a canary
 *      project on a rotating topic → POST the v2 full pipeline (bilingual,
 *      3000 words, SSE consumed to the complete event, ≤100 min) → extract
 *      metrics from the DB + mechanical audit → delete the PREVIOUS canary
 *      project (exactly one canary exists at a time; the sidebar stays
 *      clean and the DB growth is bounded).
 *   6. Before/after comparison vs the previous round's metrics.json
 *      (committed alongside the code — that IS the before/after record).
 *      HARD regressions (blocking citations, bilingual parity break, tsc/
 *      lint errors, pipeline collapse) trigger auto-correction: revert the
 *      code commits since last-known-good (≤3, report commits excluded),
 *      re-verify, push the correction. SOFT deltas are reported only.
 *   7. Append the round report to iteration-state/rounds.md, update
 *      metrics.json + last-good, commit and PUSH (every round ends with a
 *      push — including degraded rounds, whose report has diagnostic value).
 *
 * Everything is best-effort with hard timeouts: a round can never hang the
 * scheduler (the lockfile is PID+staleness checked).
 */
import { db } from "@/lib/db";
import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { countWords } from "@/lib/writing";

const ROOT = "/home/z/my-project";
const STATE_DIR = `${ROOT}/iteration-state`;
const LOCK_FILE = `${STATE_DIR}/round.lock`;
const METRICS_FILE = `${STATE_DIR}/metrics.json`;
const REPORT_FILE = `${STATE_DIR}/rounds.md`;
const LAST_GOOD_FILE = `${STATE_DIR}/last-good.txt`;
const LAST_ROUND_FILE = `${STATE_DIR}/last-round.json`;
const CANARY_TITLE = "Auto-Iterate Canary";

const ROUND_TIMEOUT_MS = 100 * 60_000; // whole-round hard cap
const PROVIDER_WAIT_MS = 30 * 60_000; // max in-round wait for the provider
const START = Date.now();
const ROUND_STAMP = new Date().toISOString();

const TOPICS = [
  "Ferroptosis structural biology: cryo-EM and crystal structures of GPX4, ACSL4, SLC7A11-xCT cystine/glutamate antiporter, system Xc−, ferroptosis suppressor protein 1 (FSP1), lipid peroxide repair enzymes, and iron storage and trafficking proteins in ferroptosis regulation",
  "Chaperone-mediated autophagy structural biology: LAMP2A regulation, Hsc70 substrate recognition, ATG protein structures, and lysosomal membrane protein mechanisms",
  "Nuclear pore complex structural biology: cryo-EM architectures of nucleoporins, FG-repeat phase separation, transport receptor mechanisms, and karyopherin cargo trafficking",
  "GPCR structural biology: active-state conformations, arrestin coupling, G-protein selectivity, allosteric modulator binding pockets, and cryo-EM signaling complex architectures",
];

// ---------- small utilities ----------

function sh(cmd: string): { code: number; out: string } {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd: ROOT });
  return { code: r.exitCode ?? 0, out: (r.stdout?.toString() || "") + (r.stderr?.toString() || "") };
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeText(path: string, text: string) {
  fs.mkdirSync(path.dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
}

// ---------- lockfile ----------

function acquireLock(): boolean {
  try {
    
    const old = readJson<{ pid: number; started: string }>(LOCK_FILE);
    if (old) {
      const alive = Bun.spawnSync(["bash", "-c", `kill -0 ${old.pid} 2>/dev/null && echo alive`]).stdout
        ?.toString()
        .includes("alive");
      const stale = Date.now() - new Date(old.started).getTime() > ROUND_TIMEOUT_MS + 10 * 60_000;
      if (alive && !stale) {
        log(`round already running (pid ${old.pid}, started ${old.started}) — exiting`);
        return false;
      }
      log(`stale/dead lock (pid ${old.pid}) — reclaiming`);
    }
    writeText(LOCK_FILE, JSON.stringify({ pid: process.pid, started: ROUND_STAMP }));
    return true;
  } catch (e: any) {
    log(`lock error (proceeding unlocked): ${String(e?.message ?? e).slice(0, 80)}`);
    return true;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// ---------- health ----------

async function ensureDevServer(): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch("http://localhost:3000/api/projects", { signal: AbortSignal.timeout(10_000) });
      if (r.ok) return true;
    } catch {}
    if (i === 0) {
      log("dev server down — restarting");
      sh("(setsid nohup bun run dev >> dev.log 2>&1 &)");
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  return false;
}

async function probeProvider(): Promise<boolean> {
  try {
    const zai = await ZAI.create();
    await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 8,
    });
    return true;
  } catch {
    return false;
  }
}

/** Wait for the provider to recover (only when a canary run is pending). */
async function waitForProvider(): Promise<boolean> {
  const deadline = Date.now() + PROVIDER_WAIT_MS;
  for (;;) {
    if (await probeProvider()) return true;
    if (Date.now() > deadline) return false;
    log("provider throttled (429) — waiting 5 min before retry");
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

// ---------- mechanical gate ----------

async function mechanicalGate(): Promise<{ tscErrors: number; lintErrors: number }> {
  const tsc = sh("bunx tsc --noEmit 2>&1 | grep -c 'error TS' || true");
  const tscErrors = parseInt((tsc.out.match(/(\d+)/) || ["0"])[1], 10) || 0;
  const lint = sh("bun run lint 2>&1 | tail -3 | grep -oE '[0-9]+ error' | head -1 || true");
  const lintErrors = parseInt((lint.out.match(/(\d+)/) || ["0"])[1], 10) || 0;
  log(`mechanical gate: tsc=${tscErrors} lint=${lintErrors}`);
  return { tscErrors, lintErrors };
}

// ---------- canary production test ----------

interface RoundMetrics {
  round: number;
  stamp: string;
  gitHead: string;
  outcome: "clean" | "degraded-provider" | "degraded-infra" | "regressed" | "regressed-corrected";
  produced: boolean;
  wordsEn: number;
  wordsZh: number;
  refsTotal: number;
  distinctCited: number;
  citationDensity: number;
  blockingErrors: number;
  topicalityWarnings: number;
  parityMismatches: number;
  hasChinese: boolean;
  repairRounds: number;
  reviewVerdict: string;
  reviewOverall: number;
  factCheckWeaknesses: number;
  tscErrors: number;
  lintErrors: number;
  durationMs: number;
}

function extractCitationNums(text: string): Set<number> {
  const set = new Set<number>();
  const idx = text.indexOf("## References");
  const body = idx >= 0 ? text.slice(0, idx) : text;
  const re = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const part of m[1].split(/[,;]\s*/)) {
      const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) set.add(n);
      else { const n = parseInt(part); if (!isNaN(n)) set.add(n); }
    }
  }
  return set;
}

async function runCanary(roundNo: number): Promise<{ metrics: Partial<RoundMetrics>; articleId: string | null; error?: string }> {
  const topic = TOPICS[(roundNo - 1) % TOPICS.length];

  // Create the canary project
  let projectId: string;
  try {
    const r = await fetch("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${CANARY_TITLE} #${roundNo}`,
        topic,
        field: "structural biology",
      }),
    });
    const j: any = await r.json();
    projectId = j?.project?.id;
    if (!projectId) throw new Error(`project create failed: ${JSON.stringify(j).slice(0, 120)}`);
  } catch (e: any) {
    return { metrics: {}, articleId: null, error: `project-create: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  log(`canary project ${projectId} (topic: ${topic.slice(0, 50)}…)`);

  // Run the v2 pipeline and consume the SSE stream to completion
  const t0 = Date.now();
  let articleId: string | null = null;
  let completeData: any = null;
  let streamError: string | null = null;
  try {
    const controller = new AbortController();
    const killTimer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
    const res = await fetch("http://localhost:3000/api/ai/generate-full-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, language: "both", targetWords: 3000, maxTokens: 20480 }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`pipeline POST ${res.status}`);
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.event === "complete") { completeData = data; articleId = data.articleId || null; }
          if (data.event === "error" || data.event === "fatal") {
            streamError = String(data.error || data.message || "pipeline error").slice(0, 160);
          }
        } catch {}
      }
    }
    clearTimeout(killTimer);
  } catch (e: any) {
    streamError = `stream: ${String(e?.message ?? e).slice(0, 120)}`;
  }
  const durationMs = Date.now() - t0;

  if (!completeData || !articleId) {
    return {
      metrics: { durationMs },
      articleId: null,
      error: streamError || "pipeline ended without a complete event",
    };
  }
  log(`pipeline complete in ${(durationMs / 60_000).toFixed(1)} min (article ${articleId})`);

  // Extract metrics from the DB + mechanical audit
  const article = await db.article.findUnique({ where: { id: articleId } });
  const audit: any = await fetch(`http://localhost:3000/api/articles/${articleId}/audit-citations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deep: false }),
  }).then((r) => r.json()).catch(() => null);

  const reviews = await db.review.findMany({ where: { articleId }, orderBy: { round: "asc" } });
  const content = article?.content || "";
  const contentZh = article?.contentZh || "";
  const enCites = extractCitationNums(content);
  const zhCites = extractCitationNums(contentZh);
  const enHeads = (content.match(/^##\s+(.+)$/gm) || []).length;
  const zhHeads = (contentZh.match(/^##\s+(.+)$/gm) || []).length;
  let parityMismatches = 0;
  for (const n of enCites) if (!zhCites.has(n)) parityMismatches++;
  if (enHeads !== zhHeads) parityMismatches += Math.abs(enHeads - zhHeads);
  const refsTotal = audit?.totalReferences ?? completeData?.references ?? 0;
  const wordsEn = countWords(content);
  let factCheckWeaknesses = 0;
  for (const r of reviews) {
    try {
      const ws = JSON.parse(r.weaknesses || "[]");
      factCheckWeaknesses += (Array.isArray(ws) ? ws : []).filter((w: any) => String(w).includes("FACT-CHECK")).length;
    } catch {}
  }

  const metrics: Partial<RoundMetrics> = {
    produced: true,
    wordsEn,
    wordsZh: countWords(contentZh),
    refsTotal,
    distinctCited: enCites.size,
    citationDensity: wordsEn > 0 ? Math.round((refsTotal / wordsEn) * 10000) / 10 : 0,
    blockingErrors: audit?.summary?.blockingErrors ?? -1,
    topicalityWarnings: (audit?.summary?.suspect ?? 0) + (audit?.summary?.unsupported ?? 0),
    parityMismatches,
    hasChinese: !!contentZh,
    repairRounds: reviews.length,
    reviewVerdict: reviews[reviews.length - 1]?.verdict || "none",
    reviewOverall: reviews[reviews.length - 1]?.scoreOverall ?? -1,
    factCheckWeaknesses,
    durationMs,
  };

  // Delete the PREVIOUS canary project (keep exactly one at a time)
  try {
    const prev = await db.project.findFirst({
      where: { title: { startsWith: CANARY_TITLE }, id: { not: projectId } },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true },
    });
    if (prev) {
      await fetch(`http://localhost:3000/api/projects/${prev.id}`, { method: "DELETE" });
      log(`cleaned previous canary: ${prev.title}`);
    }
  } catch {}

  return { metrics, articleId };
}

// ---------- comparison + correction ----------

function hardRegressions(cur: RoundMetrics): string[] {
  const issues: string[] = [];
  if (cur.tscErrors > 0) issues.push(`tsc errors ${cur.tscErrors}`);
  if (cur.lintErrors > 0) issues.push(`lint errors ${cur.lintErrors}`);
  if (cur.produced) {
    if (cur.blockingErrors > 0) issues.push(`citation blocking errors ${cur.blockingErrors}`);
    if (cur.parityMismatches > 0) issues.push(`bilingual parity mismatches ${cur.parityMismatches}`);
    if (!cur.hasChinese) issues.push("bilingual run produced no Chinese half");
    if (cur.wordsEn < 1500 || cur.refsTotal < 15) issues.push(`pipeline collapse (${cur.wordsEn}w / ${cur.refsTotal} refs)`);
    if (cur.distinctCited < 15) issues.push(`only ${cur.distinctCited} distinct citations`);
  }
  return issues;
}

function codeCommitsSince(sha: string): string[] {
  if (!sha) return [];
  const r = sh(`git log --format=%H ${sha}..HEAD 2>/dev/null`);
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function correctByRevert(commits: string[], reason: string): Promise<boolean> {
  if (commits.length === 0) return false;
  const targets = commits.slice(0, 3); // newest first, bounded
  log(`auto-correct: reverting ${targets.length} commit(s): ${targets.join(", ").slice(0, 80)}`);
  for (const sha of targets) {
    const r = sh(`git revert --no-edit ${sha} 2>&1`);
    if (r.code !== 0) {
      log(`revert ${sha} FAILED: ${r.out.slice(0, 120)}`);
      return false;
    }
  }
  const gate = await mechanicalGate();
  if (gate.tscErrors > 0 || gate.lintErrors > 0) {
    log("post-revert verification failed — rolling the reverts back");
    sh(`git reset --hard HEAD~${targets.length}`);
    return false;
  }
  return true;
}

// ---------- report ----------

function buildReportLines(cur: RoundMetrics, prev: RoundMetrics | null, canary: { error?: string }, regressions: string[], corrected: boolean, headBefore: string): string {
  const lines: string[] = [];
  lines.push(`## Round ${cur.round} — ${cur.stamp.slice(0, 19)}Z`);
  lines.push(`- outcome: **${cur.outcome}**${corrected ? " (auto-revert applied)" : ""} · head \`${cur.gitHead.slice(0, 8)}\`${cur.gitHead !== headBefore ? ` (was \`${headBefore.slice(0, 8)}\`)` : ""}`);
  if (canary.error) lines.push(`- canary error: \`${canary.error.slice(0, 140)}\``);
  if (cur.produced) {
    lines.push(`- canary: ${cur.wordsEn} EN words · ${cur.wordsZh} ZH words · ${cur.refsTotal} refs (density ${cur.citationDensity}/1000w) · distinct-cited ${cur.distinctCited}`);
    lines.push(`- integrity: blocking ${cur.blockingErrors} · topicality warnings ${cur.topicalityWarnings} · bilingual parity mismatches ${cur.parityMismatches}`);
    lines.push(`- review: ${cur.repairRounds} round(s) · verdict ${cur.reviewVerdict} · overall ${cur.reviewOverall} · FACT-CHECK weaknesses ${cur.factCheckWeaknesses}`);
  }
  lines.push(`- mechanical: tsc ${cur.tscErrors} errors · lint ${cur.lintErrors} errors · duration ${(cur.durationMs / 60_000).toFixed(1)} min`);
  if (prev && prev.produced && cur.produced) {
    lines.push(`- vs round ${prev.round}: words ${prev.wordsEn}→${cur.wordsEn} · refs ${prev.refsTotal}→${cur.refsTotal} · density ${prev.citationDensity}→${cur.citationDensity} · topicality ${prev.topicalityWarnings}→${cur.topicalityWarnings} · verdict ${prev.reviewVerdict}→${cur.reviewVerdict}`);
  }
  if (regressions.length > 0) {
    lines.push(`- regressions: ${regressions.join("; ")}${corrected ? " → corrected (reverted + re-verified)" : " → NOT auto-corrected (no reversible code commits since last-good — investigate manually)"}`);
  }
  lines.push("");
  return lines.join("\n");
}

function prependReport(text: string) {
  
  const HEADER = "# Auto-Iterate Round Reports\n\nOne section per round (newest first). metrics.json = machine-readable baseline; last-good.txt = last clean-outcome commit. Scheduled by mini-services/iterate-scheduler — every 6h, throttled-provider retry every 45 min. Manual trigger: `bun scripts/auto-iterate/iterate.ts`.\n\n";
  let old = "";
  try { old = fs.readFileSync(REPORT_FILE, "utf8"); } catch {}
  let body = old;
  if (old.startsWith("# Auto-Iterate")) {
    body = old.slice(HEADER.length);
  }
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, HEADER + text + body);
}

// ---------- main ----------

async function main() {
  if (!acquireLock()) process.exit(0);
  const prevMetrics = readJson<RoundMetrics>(METRICS_FILE);
  const roundNo = (prevMetrics?.round || 0) + 1;
  let lastGood = "";
  try { lastGood = fs.readFileSync(LAST_GOOD_FILE, "utf8").trim(); } catch {}
  const headBefore = sh("git rev-parse HEAD").out.trim();

  log(`=== ROUND ${roundNo} start (head ${headBefore.slice(0, 8)}) ===`);

  // 3. health
  const devOk = await ensureDevServer();
  let providerOk = false;
  if (devOk) providerOk = await waitForProvider();

  // 4. mechanical gate (always runs)
  const gate = await mechanicalGate();

  // 5. canary production test
  let canary: { metrics: Partial<RoundMetrics>; articleId: string | null; error?: string } = { metrics: {}, articleId: null };
  if (devOk && providerOk) {
    canary = await runCanary(roundNo);
  } else {
    log(`canary skipped (${!devOk ? "dev server unavailable" : "provider throttled after 30-min wait"})`);
  }

  // 6. metrics + classification
  const cur = {
    round: roundNo,
    stamp: ROUND_STAMP,
    gitHead: headBefore,
    outcome: "clean" as RoundMetrics["outcome"],
    produced: false,
    wordsEn: 0, wordsZh: 0, refsTotal: 0, distinctCited: 0, citationDensity: 0,
    blockingErrors: 0, topicalityWarnings: 0, parityMismatches: 0, hasChinese: false,
    repairRounds: 0, reviewVerdict: "none", reviewOverall: -1, factCheckWeaknesses: 0,
    tscErrors: gate.tscErrors,
    lintErrors: gate.lintErrors,
    durationMs: Date.now() - START,
    ...(canary.metrics || {}),
  } as RoundMetrics;

  const regressions = hardRegressions(cur);
  if (!devOk) cur.outcome = "degraded-infra";
  else if (!providerOk) cur.outcome = "degraded-provider";
  else if (regressions.length > 0) cur.outcome = "regressed";

  // 7. correction on regression (only when CODE commits exist since last-good)
  let corrected = false;
  if (cur.outcome === "regressed") {
    const commits = codeCommitsSince(lastGood);
    corrected = await correctByRevert(commits, regressions.join("; "));
    if (corrected) {
      cur.outcome = "regressed-corrected";
      cur.gitHead = sh("git rev-parse HEAD").out.trim();
    }
  }

  // 8. report + metrics + push (every round ends with a push)
  prependReport(buildReportLines(cur, prevMetrics, canary, regressions, corrected, headBefore));
  writeText(METRICS_FILE, JSON.stringify(cur, null, 2));
  writeText(LAST_ROUND_FILE, JSON.stringify({ round: roundNo, outcome: cur.outcome, endedAt: new Date().toISOString() }));

  sh("git add iteration-state");
  const commitMsg = `chore(auto-iterate): round ${roundNo} — ${cur.outcome}${cur.produced ? ` (${cur.wordsEn}w/${cur.refsTotal}refs, blocking ${cur.blockingErrors}, parity ${cur.parityMismatches})` : ""}`;
  const c = sh(`git commit -m "${commitMsg.replace(/"/g, "'")}" 2>&1`);
  const p = sh("git push origin main 2>&1");
  log(`commit: ${c.out.split("\n")[0].slice(0, 90)}`);
  log(`push: ${p.out.split("\n").filter(Boolean).pop()?.slice(0, 90) || "no output"}`);

  // last-good pinned AFTER the report commit so the pin survives reverts of
  // code commits. Infra/provider degradations keep the last-good pin (the
  // code itself is unchanged) but never RE-pin to a degraded head.
  const baselineSafe =
    cur.outcome === "clean" ||
    ((cur.outcome === "degraded-provider" || cur.outcome === "degraded-infra") && gate.tscErrors === 0 && gate.lintErrors === 0);
  if (baselineSafe) {
    const sha = sh("git rev-parse HEAD").out.trim();
    writeText(LAST_GOOD_FILE, sha);
    sh("git add iteration-state/last-good.txt");
    sh(`git commit -m "chore(auto-iterate): pin last-good ${sha.slice(0, 8)}" 2>&1`);
    sh("git push origin main 2>&1");
  }

  log(`=== ROUND ${roundNo} end (${cur.outcome}) ===`);
  releaseLock();
}

main().catch((e) => {
  log(`FATAL: ${String((e as any)?.stack || e).slice(0, 400)}`);
  releaseLock();
  process.exit(1);
});
