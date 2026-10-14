/**
 * RT17 (#1): SSE event-sequence regression framework — REBUILT.
 *
 * The RT10→RT12 golden-hash scenario runner was lost in the 2026-10-14
 * sandbox reset (along with the seam extractions it guarded). This file
 * re-establishes the acceptance gate that made the seam surgeries safe:
 * after every extraction, the token-sequence hash of a full mocked run
 * must be BYTE-IDENTICAL to the recorded golden manifest.
 *
 * Architecture (RT17-a audit, rebuilt against the current code):
 *   - MOCK EDGE: @/lib/llm-session (every LLM call — route direct AND skill
 *     executor), @/lib/ai (webSearch/webSearchDetailed + the taskType-less
 *     chat() used by article-title), @/lib/databases (gather + knowledge
 *     network surface), @/lib/db (scratch SQLite per scenario), and
 *     z-ai-web-dev-sdk (the route's 8-token providerStorming probe).
 *   - Dispatch keys: metadata.skill (skill calls) → `${taskType}:${metadata.step}`
 *     (route direct calls that carry a step, e.g. gather:web-search-queries)
 *     → taskType → "default".
 *   - chatWithSessionStream returns synchronously WITHOUT invoking onChunk
 *     → zero generate:streaming events (deterministic; the 100-ms throttle
 *     would also never fire on a fast mock).
 *   - Scenario loop: fresh scratch DB (prisma db push template + per-scenario
 *     file copy) → db.project.create → route.POST(NextRequest) → consume the
 *     SSE stream → project frames into a token sequence → sha256 golden hash.
 *   - Origin http://127.0.0.1:9 makes the post-pipeline self-fetches
 *     (relationships / fallback review) fail FAST and deterministically →
 *     those steps land on their designed skipped paths.
 *   - RECORDER PARITY: the wire step projection must match TaskRun.stepsJson
 *     (the replay contract the timeline UI depends on).
 *   - RECORD mode: SCIWRITE_RECORD_SSE=<scenario|1> rewrites the manifest +
 *     ndjson for the matched scenario only (no git noise on untouched ones).
 *
 * RT8 mock discipline (see skill-executor.test.ts header): mock.module is
 * process-global with no rollback; every mocked namespace re-exports the
 * full real surface; `mockActive` flips in afterAll so LATER-loaded test
 * files exercise the real implementations.
 */

import { test, expect, describe, mock, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { setRateAbortStorePath, persistRateAbort } from "@/lib/rate-abort-store";
import { clearAbort } from "@/lib/rate-limiter";
import { clearWebSearchCache } from "@/lib/web-search-cache";
import { clearLLMCache } from "@/lib/llm-cache";
import { _resetStormRecoveryForTests } from "@/lib/storm-recovery";

const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURE_DIR = join(HERE, "..", "fixtures", "sse");
const RECORD_ENV = process.env.SCIWRITE_RECORD_SSE ?? "";

/** Scenarios in the loop. Degraded-window scenarios are added when their
 * consumer seams are re-extracted (contract-triggered discipline). */
const SCENARIOS = ["tiny", "gap-merge", "web-retry-window", "rescore-window"] as const;

// ---------------------------------------------------------------------------
// Mock state (module-level so the mock closures read CURRENT values)
// ---------------------------------------------------------------------------

interface ScenarioStubs {
  responses: Record<string, string>;
  databases: Record<string, any>;
  webSearch: Record<string, any[]>;
  dynamic?: {
    chat?: { failFirstN?: Record<string, number> };
    webSearch?: { failFirstN?: number };
  };
}

let mockActive = true;
let activeStubs: ScenarioStubs = { responses: {}, databases: {}, webSearch: {} };
const chatFailCounters = new Map<string, number>();
let webFailCounter = 0;
let currentDb: any = null;
/** Dispatch log: every LLM call's resolved key, in call order (debug aid). */
const chatDispatchLog: string[] = [];
const unknownDispatchLog: string[] = [];

const realLlmSession: any = await import("@/lib/llm-session?real");
const realAi: any = await import("@/lib/ai?real");
const realDatabases: any = await import("@/lib/databases?real");

function resolveResponseKey(opts: any): string {
  const skill = opts?.metadata?.skill;
  if (skill !== undefined && skill !== null) return String(skill);
  const tt = opts?.taskType ? String(opts.taskType) : "";
  const step = opts?.metadata?.step ? String(opts.metadata.step) : "";
  if (tt && step && activeStubs.responses[`${tt}:${step}`] !== undefined) {
    return `${tt}:${step}`;
  }
  if (tt && activeStubs.responses[tt] !== undefined) return tt;
  if (tt) {
    // A known-direct taskType without a scenario entry — worth logging so
    // fixture authors notice a missing response (falls to default).
    if (!["gather", "plan", "generate", "verify", "translate"].includes(tt)) {
      unknownDispatchLog.push(tt);
    } else {
      unknownDispatchLog.push(`${tt}${step ? ":" + step : ""}`);
    }
  }
  return "default";
}

function maybeFailChat(key: string): void {
  const n = activeStubs.dynamic?.chat?.failFirstN?.[key];
  if (!n) return;
  const c = (chatFailCounters.get(key) ?? 0) + 1;
  chatFailCounters.set(key, c);
  if (c <= n) {
    const err: any = new Error("429 Too Many Requests (mock failFirstN)");
    err.status = 429;
    throw err;
  }
}

mock.module("@/lib/llm-session", () => ({
  chatWithSession: async (
    projectId: string,
    prompt: string,
    opts: any,
  ): Promise<string> => {
    if (!mockActive) return realLlmSession.chatWithSession(projectId, prompt, opts);
    const key = resolveResponseKey(opts);
    chatDispatchLog.push(key);
    maybeFailChat(key);
    return activeStubs.responses[key] ?? activeStubs.responses["default"] ?? "";
  },
  chatWithSessionStream: async (
    projectId: string,
    prompt: string,
    opts: any,
    onChunk?: (c: string, acc: string) => void,
  ): Promise<string> => {
    if (!mockActive)
      return realLlmSession.chatWithSessionStream(projectId, prompt, opts, onChunk);
    const key = resolveResponseKey(opts);
    chatDispatchLog.push(key);
    maybeFailChat(key);
    // Deliberately NO onChunk invocation → zero streaming frames.
    return activeStubs.responses[key] ?? activeStubs.responses["default"] ?? "";
  },
  clearSession: async (...args: any[]) => {
    if (!mockActive) return realLlmSession.clearSession(...(args as [any]));
  },
  loadSessionContext: async (..._args: any[]) => [] as any[],
  saveSessionMessage: async (..._args: any[]) => {},
  isStatelessTaskType: (t: string) => realLlmSession.isStatelessTaskType(t),
}));

mock.module("@/lib/ai", () => {
  const mod: any = { ...realAi };
  mod.chat = async (prompt: string, opts: any = {}) => {
    if (!mockActive) return realAi.chat(prompt, opts);
    const key = resolveResponseKey(opts);
    chatDispatchLog.push(key);
    maybeFailChat(key);
    return activeStubs.responses[key] ?? activeStubs.responses["default"] ?? "OK";
  };
  mod.chatStream = async (prompt: string, opts: any = {}) => {
    if (!mockActive) return realAi.chatStream(prompt, opts);
    const key = resolveResponseKey(opts);
    chatDispatchLog.push(key);
    return activeStubs.responses[key] ?? activeStubs.responses["default"] ?? "OK";
  };
  mod.webSearchDetailed = async (query: string, num?: number) => {
    if (!mockActive) return realAi.webSearchDetailed(query, num);
    const failN = activeStubs.dynamic?.webSearch?.failFirstN;
    if (failN) {
      webFailCounter += 1;
      if (webFailCounter <= failN) {
        return { items: [], reason: "rate-limit" as const, detail: "mock failFirstN" };
      }
    }
    const items = activeStubs.webSearch[query] ?? [];
    return { items, reason: undefined, detail: undefined };
  };
  mod.webSearch = async (query: string, num?: number) => {
    if (!mockActive) return realAi.webSearch(query, num);
    const outcome = await mod.webSearchDetailed(query, num);
    return outcome.items;
  };
  return mod;
});

mock.module("@/lib/databases", () => {
  const mod: any = { ...realDatabases };
  mod.queryDatabase = async (source: string, query: string, _opts: any = {}) => {
    const key = `${source}:${query}`;
    const hit = activeStubs.databases[key];
    if (hit !== undefined) return hit;
    return { items: [] };
  };
  mod.fetchPubMedSummaries = async (..._args: any[]) => [] as any[];
  mod.searchCrossref = async (..._args: any[]) => ({ items: [] as any[] });
  mod.lookupCrossrefDoi = async (..._args: any[]) => null;
  mod.fetchFullTextForPubMed = async (..._args: any[]) => null;
  mod.fetchPmcFullText = async (..._args: any[]) => null;
  mod.fetchPubMedAbstracts = async (..._args: any[]) => [] as any[];
  mod.searchUniprot = async (..._args: any[]) => ({ items: [] as any[] });
  mod.searchRcsb = async (..._args: any[]) => ({ items: [] as any[] });
  mod.searchNcbiGene = async (..._args: any[]) => ({ items: [] as any[] });
  mod.runBlast = async (..._args: any[]) => ({ items: [] as any[] });
  return mod;
});

mock.module("@/lib/db", () => ({
  db: new Proxy({} as any, {
    get(_target: any, prop: string | symbol): any {
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      const v = currentDb?.[prop as string];
      return v;
    },
  }),
}));

mock.module("z-ai-web-dev-sdk", () => ({
  default: {
    create: async () => ({
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: "OK" } }] }),
        },
      },
    }),
  },
}));

// AFTER the mocks (bun hoists mock.module above static imports).
import { POST as generateFullV2Post } from "@/app/api/ai/generate-full-v2/route";

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

interface ScenarioRun {
  scenario: string;
  frames: any[];
  tokens: string[];
  tokenCount: number;
  eventCount: number;
  hash: string;
  projectId: string;
  dbClient: any;
  scratchDir: string;
}

/** Consume an SSE Response body into parsed frame objects (route frame =
 * `data: ${JSON.stringify({event, ...payload})}\n\n`). */
async function consumeSSE(body: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: any[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          frames.push(JSON.parse(line.slice(5).trim()));
        } catch {
          // ignore keep-alive/comment frames
        }
      }
    }
  }
  return frames;
}

/** Wire frames → token sequence. Non-step events → event name. Step events →
 * `step:status` (+ `:section` for per-section families). Consecutive repeats
 * collapse to `token×N` so throttle-adjacent duplicates stay stable. */
function projectTokens(frames: any[]): string[] {
  const raw: string[] = [];
  for (const f of frames) {
    if (f.event === "step") {
      const sec = f.section !== undefined ? `:${f.section}` : "";
      raw.push(`${f.step}:${f.status}${sec}`);
    } else {
      raw.push(String(f.event));
    }
  }
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    let j = i;
    while (j < raw.length && raw[j] === raw[i]) j++;
    out.push(j - i > 1 ? `${raw[i]}×${j - i}` : raw[i]);
    i = j;
  }
  return out;
}

let seedDbPath = "";
let scratchRoot = "";

function makeScratchDb(scenario: string): { client: any; dir: string } {
  const dir = join(scratchRoot, scenario);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "scratch.db");
  copyFileSync(seedDbPath, dbPath);
  const client = new PrismaClient({
    datasources: { db: { url: `file:${dbPath}` } },
    log: ["warn", "error"],
  });
  return { client, dir };
}

async function runScenario(scenario: string): Promise<ScenarioRun> {
  // Reset per-scenario mock state.
  const stubsPath = join(FIXTURE_DIR, `${scenario}.stubs.json`);
  activeStubs = JSON.parse(readFileSync(stubsPath, "utf8"));
  chatFailCounters.clear();
  webFailCounter = 0;
  chatDispatchLog.length = 0;
  unknownDispatchLog.length = 0;
  clearLLMCache();
  clearWebSearchCache();
  _resetStormRecoveryForTests();
  // Other suite files exercise the REAL rate-limiter (storm-recovery.test.ts
  // round-trips setAbort) — the in-process abort flag would fail this run's
  // pre-flight check. Clear it (disk state handled below).
  clearAbort();

  const { client, dir } = makeScratchDb(scenario);
  currentDb = client;
  setRateAbortStorePath(join(dir, "rate-abort.json"));
  persistRateAbort(null);

  const proj = await client.project.create({
    data: {
      topic: activeStubs.project?.topic ?? "Test topic",
      field: activeStubs.project?.field ?? "life sciences",
      title: activeStubs.project?.topic ?? "Test topic",
    },
  });

  const body = {
    projectId: proj.id,
    ...(activeStubs.request ?? {}),
  };
  const req = new NextRequest("http://127.0.0.1:9/api/ai/generate-full-v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await generateFullV2Post(req as any);
  const frames = await consumeSSE(res.body as ReadableStream<Uint8Array>);

  const tokens = projectTokens(frames);
  const hash = createHash("sha256").update(tokens.join("\n")).digest("hex");

  if (RECORD_ENV === scenario || RECORD_ENV === "1") {
    writeFileSync(join(FIXTURE_DIR, `${scenario}.ndjson`), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    const manifest = {
      scenario,
      tokenSequenceHash: hash,
      tokens,
      tokenCount: tokens.length,
      eventCount: frames.length,
      requestBody: body,
      stubsFile: `${scenario}.stubs.json`,
      goldenFile: `${scenario}.ndjson`,
      recordedAt: new Date().toISOString(),
      notes:
        "Happy-path clean run: zero degradation, zero gaps, zero repair, zero polish findings. Self-fetch satellites (relationships/review fallback) fail fast via 127.0.0.1:9 → designed skipped paths.",
    };
    writeFileSync(
      join(FIXTURE_DIR, `${scenario}.manifest.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(`[sse] RECORDED scenario=${scenario} hash=${hash.slice(0, 12)} tokens=${tokens.length}`);
  }

  return {
    scenario,
    frames,
    tokens,
    tokenCount: tokens.length,
    eventCount: frames.length,
    hash,
    projectId: proj.id,
    dbClient: client,
    scratchDir: dir,
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const runs = new Map<string, ScenarioRun>();

beforeAll(async () => {
  // Scratch DB seed template: push the prisma schema once to a file, then
  // each scenario copies it (fast, hermetic, no shared state).
  scratchRoot = mkdtempSync(join(tmpdir(), "sse-"));
  seedDbPath = join(scratchRoot, "seed.db");
  execSync(`bunx prisma db push --skip-generate --schema prisma/schema.prisma`, {
    env: { ...process.env, DATABASE_URL: `file:${seedDbPath}` },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  for (const sc of SCENARIOS) {
    runs.set(sc, await runScenario(sc));
  }
}, 600_000);

afterAll(async () => {
  mockActive = false;
  for (const run of runs.values()) {
    try {
      await run.dbClient.$disconnect();
    } catch {
      // ignore
    }
  }
});

describe("sse scenario framework: gap-merge (gap agent round with a real merge)", () => {
  test(
    "gapAgent terminal: gapsFound ≥1, newRefs ≥1, done (not skipped)",
    () => {
      const run = runs.get("gap-merge")!;
      const gapDone = run.frames.filter(
        (f) => f.event === "step" && f.step === "gapAgent" && f.status === "done",
      );
      expect(gapDone.length).toBe(1);
      expect(gapDone[0].gapsFound ?? 0).toBeGreaterThanOrEqual(1);
      expect(gapDone[0].newRefs ?? 0).toBeGreaterThanOrEqual(1);
      const gapSkipped = run.frames.filter(
        (f) => f.event === "step" && f.step === "gapAgent" && f.status === "skipped",
      );
      expect(gapSkipped.length).toBe(0);
    },
    30_000,
  );
  test(
    "complete: skillCalls include gap-design + gap-research; curated pool grew by ≥1",
    () => {
      const run = runs.get("gap-merge")!;
      const complete = run.frames.find((f) => f.event === "complete")!;
      expect(complete.stats.skillCalls["gap-design"]).toBeGreaterThanOrEqual(1);
      expect(complete.stats.skillCalls["gap-research"] ?? 0).toBeGreaterThanOrEqual(1);
      const tiny = runs.get("tiny")!;
      const tinyComplete = tiny.frames.find((f) => f.event === "complete")!;
      expect(complete.stats.curatedReferences).toBeGreaterThan(
        tinyComplete.stats.curatedReferences,
      );
    },
    30_000,
  );
  test(
    "GOLDEN + terminal: hash matches the recorded manifest, complete is last",
    () => {
      const run = runs.get("gap-merge")!;
      const manifestPath = join(FIXTURE_DIR, "gap-merge.manifest.json");
      if (!existsSync(manifestPath)) {
        expect(RECORD_ENV).not.toBe("");
        return;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(run.hash).toBe(manifest.tokenSequenceHash);
      expect(run.frames[run.frames.length - 1].event).toBe("complete");
    },
    30_000,
  );
});

describe("sse scenario framework: web-retry-window (degraded web-search heal)", () => {
  test(
    "degraded web query disclosed, probe-as-first-retry heals it, stormRecovery entry records the recovery",
    () => {
      const run = runs.get("web-retry-window")!;
      // Event sequence rides the existing gather:progress slots (no new
      // event types — the golden-hash discipline for degraded paths).
      const msgs = run.frames
        .filter((f) => f.event === "step" && f.step === "gather" && f.status === "progress")
        .map((f) => String(f.message || ""));
      expect(msgs.some((m) => /degraded: rate-limit/.test(m))).toBe(true);
      expect(msgs.some((m) => /query\(ies\) degraded/.test(m))).toBe(true);
      expect(msgs.some((m) => /recovery probe succeeded/i.test(m))).toBe(true);
      expect(msgs.some((m) => /rate-limited web search\(es\) recovered/.test(m))).toBe(true);
      // The incident + recovery land in complete.stats.stormRecovery (the
      // RT16 entry shape — timeline recovery badges read exactly this).
      const complete = run.frames.find((f) => f.event === "complete")!;
      expect(Array.isArray(complete.stats.stormRecovery)).toBe(true);
      expect(complete.stats.stormRecovery.length).toBeGreaterThanOrEqual(1);
      const entry = complete.stats.stormRecovery[0];
      expect(entry.stage).toContain("gather");
      expect(["recovered", "clean"]).toContain(entry.outcome);
      expect(entry.retriedCount ?? 0).toBeGreaterThanOrEqual(1);
      expect(entry.recoveredCount ?? 0).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );
  test(
    "GOLDEN + terminal: hash matches the recorded manifest, complete last",
    () => {
      const run = runs.get("web-retry-window")!;
      const manifestPath = join(FIXTURE_DIR, "web-retry-window.manifest.json");
      if (!existsSync(manifestPath)) {
        expect(RECORD_ENV).not.toBe("");
        return;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(run.hash).toBe(manifest.tokenSequenceHash);
      expect(run.frames[run.frames.length - 1].event).toBe("complete");
    },
    30_000,
  );
});

describe("sse scenario framework: rescore-window (degraded score heal)", () => {
  test(
    "score:done carries batch counts; skillDegraded keeps the incident record",
    () => {
      const run = runs.get("rescore-window")!;
      const scoreDone = run.frames.find(
        (f) => f.event === "step" && f.step === "score" && f.status === "done",
      );
      expect(scoreDone).toBeDefined();
      // RT16 cross-round count correction: after a successful rescore the
      // healed batch counts as LLM (llmBatches ≥1, fallbackBatches back to
      // 0) — the INCIDENT stays disclosed via skillDegraded + the event
      // sequence below (dual disclosure: incident AND recovery).
      expect(scoreDone!.llmBatches ?? 0).toBeGreaterThanOrEqual(1);
      const scoreMsgs = run.frames
        .filter((f) => f.event === "step" && f.step === "score" && f.status === "progress")
        .map((f) => String(f.message || ""));
      expect(scoreMsgs.some((m) => /mechanical fallback/.test(m))).toBe(true);
      expect(scoreMsgs.some((m) => /Rescored \d+\/\d+ storm-degraded batch/.test(m))).toBe(true);
      const complete = run.frames.find((f) => f.event === "complete")!;
      expect((complete.stats.skillDegraded ?? {}).score ?? 0).toBeGreaterThanOrEqual(1);
      expect(complete.stats.skillCalls.score ?? 0).toBeGreaterThanOrEqual(2);
      const entry = (complete.stats.stormRecovery ?? [])[0];
      expect(entry?.stage).toBe("score");
      expect(entry?.outcome).toBe("recovered");
    },
    30_000,
  );
  test(
    "GOLDEN + terminal: hash matches the recorded manifest, complete last",
    () => {
      const run = runs.get("rescore-window")!;
      const manifestPath = join(FIXTURE_DIR, "rescore-window.manifest.json");
      if (!existsSync(manifestPath)) {
        expect(RECORD_ENV).not.toBe("");
        return;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(run.hash).toBe(manifest.tokenSequenceHash);
      expect(run.frames[run.frames.length - 1].event).toBe("complete");
    },
    30_000,
  );
});

describe("sse scenario framework: tiny (happy path)", () => {
  test(
    "terminal event: exactly one complete (or error), and it is last",
    () => {
      const run = runs.get("tiny")!;
      const terminals = run.frames.filter(
        (f) => f.event === "complete" || f.event === "error",
      );
      expect(terminals.length).toBe(1);
      expect(terminals[0].event).toBe("complete");
      expect(run.frames[run.frames.length - 1].event).toBe("complete");
    },
    120_000,
  );

  test(
    "zero ping frames + every frame has an event key",
    () => {
      const run = runs.get("tiny")!;
      const pings = run.frames.filter((f) => f.event === "ping");
      expect(pings.length).toBe(0);
      for (const f of run.frames) expect(typeof f.event).toBe("string");
    },
    30_000,
  );

  test(
    "SPINE: main sequence order (gather → knowledge → score → curate → plan → gapAgent → analyze → allocate → generate/verify → compose → title → repair → polish → complete)",
    () => {
      const run = runs.get("tiny")!;
      const seen: string[] = [];
      for (const f of run.frames) {
        if (f.event !== "step") continue;
        if (["generate", "verify"].includes(f.step)) continue; // per-section families checked separately
        if (seen[seen.length - 1] !== f.step) seen.push(f.step);
      }
      const expectedSpine = [
        "init",
        "gather",
        "knowledge",
        "score",
        "curate",
        "plan",
        "gapAgent",
        "analyze",
        "allocate",
        "compose",
        "title",
        "repair",
        "polish",
      ];
      for (const step of expectedSpine) expect(seen).toContain(step);
      const order = expectedSpine.map((s) => seen.indexOf(s));
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1]);
      }
    },
    30_000,
  );

  test(
    "SHAPES: done events carry their contracted payload keys",
    () => {
      const run = runs.get("tiny")!;
      const done = (step: string) =>
        run.frames.find((f) => f.event === "step" && f.step === step && f.status === "done");
      const requireKeys = (frame: any, keys: string[]) => {
        for (const k of keys) expect(frame).toHaveProperty(k);
      };
      const score = done("score");
      expect(score).toBeDefined();
      requireKeys(score!, [
        "scoredCount",
        "coreCount",
        "importantCount",
        "marginalCount",
        "fullTextCount",
        "llmBatches",
        "fallbackBatches",
      ]);
      const knowledge = done("knowledge");
      expect(knowledge).toBeDefined();
      requireKeys(knowledge!, [
        "fieldsCompleted",
        "sourcesAdded",
        "crossrefAdded",
        "promoted",
        "unverified",
      ]);
      const curate = done("curate");
      expect(curate).toBeDefined();
      requireKeys(curate!, ["curatedCount", "plannedCitations", "llmDriven"]);
      const plan = done("plan");
      expect(plan).toBeDefined();
      requireKeys(plan!, ["sectionCount", "sections"]);
      const compose = done("compose");
      expect(compose).toBeDefined();
      requireKeys(compose!, ["wordCount", "references"]);
      const complete = run.frames.find((f) => f.event === "complete");
      expect(complete).toBeDefined();
      expect(complete!.stats).toHaveProperty("skillCalls");
      expect(complete!.stats).toHaveProperty("skillDegraded");
      expect(complete!.stats).toHaveProperty("stormRecovery");
      expect(complete!.stats).toHaveProperty("webSearchCache");
      expect(complete!.accuracy).toHaveProperty("citationsChecked");
    },
    30_000,
  );

  test(
    "INVARIANTS: clean run — zero skill degradation, zero stormRecovery entries, zero repair telemetry revisions",
    () => {
      const run = runs.get("tiny")!;
      const complete = run.frames.find((f) => f.event === "complete")!;
      expect(Object.keys(complete.stats.skillDegraded ?? {}).length).toBe(0);
      expect(Array.isArray(complete.stats.stormRecovery)).toBe(true);
      expect(complete.stats.stormRecovery.length).toBe(0);
      // The review skill runs once even when clean (stopReason records it);
      // "not triggered" means zero REVISIONS were applied.
      expect(complete.accuracy.autoRepairTriggered ?? false).toBe(false);
      expect(complete.accuracy.autoRepairRevisions ?? 0).toBe(0);
      expect(complete.accuracy.citationsRemoved ?? 0).toBe(0);
      // Gathered a healthy pool from the stub databases.
      expect(complete.stats.sourcesGathered).toBeGreaterThan(0);
      expect(complete.stats.curatedReferences).toBeGreaterThan(0);
    },
    30_000,
  );

  test(
    "generate/verify per-section pairing: every section generates and verifies",
    () => {
      const run = runs.get("tiny")!;
      const genDone = run.frames.filter(
        (f) => f.event === "step" && f.step === "generate" && f.status === "done",
      );
      const verDone = run.frames.filter(
        (f) => f.event === "step" && f.step === "verify" && f.status === "done",
      );
      expect(genDone.length).toBeGreaterThanOrEqual(5);
      expect(verDone.length).toBeGreaterThanOrEqual(5);
      const genSections = genDone.map((f: any) => f.section).sort();
      const verSections = verDone.map((f: any) => f.section).sort();
      expect(verSections).toEqual(genSections);
    },
    30_000,
  );

  test(
    "GOLDEN: token-sequence hash matches the recorded manifest",
    () => {
      const run = runs.get("tiny")!;
      const manifestPath = join(FIXTURE_DIR, "tiny.manifest.json");
      if (!existsSync(manifestPath)) {
        console.warn("[sse] no manifest on disk — run with SCIWRITE_RECORD_SSE=tiny");
        expect(RECORD_ENV).not.toBe("");
        return;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(run.hash).toBe(manifest.tokenSequenceHash);
      expect(run.tokenCount).toBe(manifest.tokenCount);
      expect(run.eventCount).toBe(manifest.eventCount);
    },
    30_000,
  );

  test(
    "RECORDER PARITY: wire step projection ≡ TaskRun.stepsJson projection",
    async () => {
      const run = runs.get("tiny")!;
      const taskRuns = await run.dbClient.taskRun.findMany({
        where: { projectId: run.projectId },
        orderBy: { startedAt: "asc" },
      });
      expect(taskRuns.length).toBeGreaterThanOrEqual(1);
      const steps = JSON.parse(taskRuns[taskRuns.length - 1].stepsJson ?? "[]");
      const recorderKeys = steps.map((s: any) =>
        s.section !== undefined && s.section !== null
          ? `${s.step}:${s.status}:${s.section}`
          : `${s.step}:${s.status}`,
      );
      const wireKeys = run.frames
        .filter((f) => f.event === "step")
        .map((f: any) =>
          f.section !== undefined && f.section !== null
            ? `${f.step}:${f.status}:${f.section}`
            : `${f.step}:${f.status}`,
        );
      // Wire may include streaming frames the recorder folds — with our
      // zero-streaming mocks they are identical lists.
      expect(recorderKeys).toEqual(wireKeys);
      // Status sanity on the persisted row.
      expect(["completed", "failed", "aborted"]).toContain(taskRuns[taskRuns.length - 1].status);
    },
    120_000,
  );
});
