import { NextRequest, NextResponse } from "next/server";
import { chatWithSession } from "@/lib/llm-session";
import { createSSEStream, SSE_HEADERS } from "@/lib/sse";
import { queryDatabase } from "@/lib/databases";
import { db } from "@/lib/db";
import {
  verifySourcesWithKnowledge,
  verifyMissingViaPubMed,
  applyKnowledgeCompletions,
  type KVSourceInput,
} from "@/lib/knowledge-verify";
import type { DatabaseSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

interface GatherQuery {
  database: DatabaseSource;
  query: string;
  rationale: string;
}

interface GatherBody {
  mode: "clarify" | "organize" | "critique" | "verify";
  topic: string;
  field?: string;
  purpose?: string;
  projectId?: string;
  history?: { question: string; answer: string }[];
  queries?: GatherQuery[];
  sources?: {
    source: string;
    externalId?: string;
    title: string;
    authors?: string;
    year?: string;
    journal?: string;
    abstract?: string;
  }[];
  runQueries?: boolean;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as GatherBody;
  if (!body.mode || !body.topic) {
    return NextResponse.json({ error: "Missing 'mode' or 'topic'." }, { status: 400 });
  }

  const { stream, send, complete, error } = createSSEStream();

  (async () => {
    try {
      const sendLog = (msg: string) => send("step", { status: "progress", message: msg });

      if (body.mode === "clarify") {
        send("step", { status: "started", message: "Starting clarify mode..." });
        const result = await runClarify(body, sendLog);
        send("step", { status: "done", message: "Clarify complete." });
        send("complete", result);
        complete();
      } else if (body.mode === "organize") {
        send("step", { status: "started", message: "Starting organize mode..." });
        const result = await runOrganize(body, sendLog);
        send("step", { status: "done", message: `Organize complete: ${result.queries?.length || 0} queries, ${result.results?.length || 0} results.` });
        send("complete", result);
        complete();
      } else if (body.mode === "critique") {
        send("step", { status: "started", message: "Starting adversarial critique..." });
        const result = await runCritique(body, sendLog);
        send("step", { status: "done", message: "Critique complete." });
        send("complete", result);
        complete();
      } else if (body.mode === "verify") {
        send("step", { status: "started", message: "Starting LLM knowledge cross-check..." });
        const result = await runVerify(body, sendLog);
        send("step", { status: "done", message: `Knowledge cross-check complete: ${result.fieldsCompleted} fields completed, ${result.sourcesAdded} sources added.` });
        send("complete", result);
        complete();
      } else {
        error("Unknown mode.");
      }
    } catch (err: any) {
      console.error("[/api/ai/gather] error:", err);
      error(err?.message || "Gathering failed.");
    }
  })();

  return new Response(stream, { headers: SSE_HEADERS });
}

/* ---------------- Clarify ---------------- */
async function runClarify(body: GatherBody, sendLog: (msg: string) => void) {
  sendLog("Preparing clarifying questions...");
  const history = body.history || [];
  const historyText = history.length
    ? history.map((h, i) => `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`).join("\n\n")
    : "(none yet)";

  const system =
    "You are a senior research supervisor helping a researcher scope a literature review. " +
    "Ask focused, high-leverage clarifying questions to pin down the research purpose, scope, organism/system of interest, " +
    "time window, and what kind of evidence (structural, sequence, clinical) is most relevant. " +
    "Ask at most 3 questions per round. Once you have enough, set ready=true and write a concise PURPOSE STATEMENT.";

  const prompt = `RESEARCH TOPIC: ${body.topic}
FIELD: ${body.field || "life sciences"}

PREVIOUS Q&A:
${historyText}

${history.length === 0 ? "This is the first round. Ask 2-3 clarifying questions." : "Based on the answers, either ask 1-2 follow-up questions OR declare ready=true with a purpose statement."}

Respond as STRICT JSON:
{
  "questions": ["...", "..."],
  "ready": false,
  "purpose": ""
}
When ready=true, questions should be empty and purpose should be a 2-3 sentence purpose statement. Output JSON only.`;

  sendLog("Calling LLM for clarifying questions...");
  const raw = body.projectId
    ? await chatWithSession(body.projectId, prompt, { system, temperature: 0.4, taskType: "gather", metadata: { mode: "clarify" } })
    : await chatFallback(prompt, { system, temperature: 0.4 });
  sendLog("Parsing clarify response...");
  const parsed = safeParseJSON(raw, { questions: [], ready: true, purpose: body.topic });
  return {
    mode: "clarify",
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    ready: Boolean(parsed.ready),
    purpose: String(parsed.purpose || ""),
  };
}

/* ---------------- Organize ---------------- */
async function runOrganize(body: GatherBody, sendLog: (msg: string) => void) {
  const purpose = body.purpose || body.topic;
  sendLog("Designing search strategy...");
  const system =
    "You are a research data strategist. Given a research purpose, design a multi-database search plan " +
    "to gather the most relevant primary sources. Use PubMed for literature, UniProt for proteins, RCSB PDB for structures, " +
    "NCBI for genes, and BLAST only if a specific sequence is central. " +
    "Produce 4-8 queries total, distributed across the most relevant databases. Each query must be a concrete, runnable search string.";

  const prompt = `RESEARCH TOPIC: ${body.topic}
FIELD: ${body.field || "life sciences"}
PURPOSE STATEMENT: ${purpose}

Design a search plan. For each query, explain WHY it's needed and which database.

Respond as STRICT JSON:
{
  "plan": "1-2 sentence overview of the strategy",
  "queries": [
    { "database": "pubmed|uniprot|rcsb|ncbi|blast", "query": "concrete search string", "rationale": "why this query matters" }
  ]
}
Output JSON only. Use lowercase database names.`;

  sendLog("Calling LLM to design queries...");
  const raw = body.projectId
    ? await chatWithSession(body.projectId, prompt, { system, temperature: 0.5, taskType: "gather", metadata: { mode: "organize" } })
    : await chatFallback(prompt, { system, temperature: 0.5 });
  sendLog("Parsing search plan...");
  const parsed = safeParseJSON(raw, { plan: "", queries: [] });
  const queries: GatherQuery[] = (Array.isArray(parsed.queries) ? parsed.queries : [])
    .filter((q: any) => q.database && q.query && ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database))
    .map((q: any) => ({ database: q.database as DatabaseSource, query: String(q.query), rationale: String(q.rationale || "") }));

  let results: any[] = [];
  if (body.runQueries && queries.length) {
    sendLog(`Executing ${queries.slice(0, 6).length} database queries in parallel...`);
    const responses = await Promise.allSettled(
      queries.slice(0, 6).map((q) => queryDatabase(q.database, q.query).then((r) => ({ ...r, rationale: q.rationale })))
    );
    for (const r of responses) {
      if (r.status === "fulfilled") results.push(r.value);
    }
    sendLog(`Database queries returned ${results.length} result sets.`);
  }

  return { mode: "organize", plan: String(parsed.plan || ""), queries, results };
}

/* ---------------- Critique (adversarial) ---------------- */
async function runCritique(body: GatherBody, sendLog: (msg: string) => void) {
  const sources = body.sources || [];
  sendLog(`Analyzing ${sources.length} gathered sources...`);
  const sourcesText = sources.length
    ? sources.map((s, i) => `[${i + 1}] (${s.source}${s.externalId ? ":" + s.externalId : ""}) ${s.authors || ""} ${s.year || ""} ${s.journal || ""}. ${s.title}. ${s.abstract ? s.abstract.slice(0, 200) : ""}`).join("\n")
    : "(no sources gathered yet)";

  const system =
    "You are an adversarial peer reviewer and research-gap analyst. Given the gathered sources and the research purpose, " +
    "you MUST critically identify: (1) coverage GAPS (what important aspect is missing), (2) BIASES (over-reliance on one " +
    "database, recency bias, organism bias), and (3) concrete SUGGESTIONS to improve the source set — either ADD new queries " +
    "or REMOVE weak/irrelevant sources. Be specific and demanding.";

  const prompt = `RESEARCH TOPIC: ${body.topic}
PURPOSE: ${body.purpose || body.topic}

GATHERED SOURCES (${sources.length}):
${sourcesText}

Perform an adversarial critique. Respond as STRICT JSON:
{
  "gaps": ["gap 1", "gap 2"],
  "biases": ["bias 1"],
  "suggestions": [
    { "action": "add", "database": "pubmed|uniprot|rcsb|ncbi|blast", "query": "concrete query", "reason": "why" },
    { "action": "remove", "index": 1, "reason": "why this source is weak/irrelevant" }
  ],
  "verdict": "overall assessment: adequate | needs-improvement | insufficient",
  "confidence": 0.0
}
Output JSON only. 'index' in remove suggestions is 1-based into the gathered sources list.`;

  sendLog("Running adversarial critique via LLM...");
  const raw = body.projectId
    ? await chatWithSession(body.projectId, prompt, { system, temperature: 0.5, taskType: "gather", metadata: { mode: "critique", sourceCount: body.sources?.length } })
    : await chatFallback(prompt, { system, temperature: 0.5 });
  sendLog("Parsing critique response...");
  const parsed = safeParseJSON(raw, { gaps: [], biases: [], suggestions: [], verdict: "needs-improvement", confidence: 0.5 });

  const addSuggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).filter((s: any) => s.action === "add" && s.database && s.query);
  let addedResults: any[] = [];
  if (body.runQueries && addSuggestions.length) {
    sendLog(`Executing ${addSuggestions.slice(0, 4).length} suggested queries...`);
    const responses = await Promise.allSettled(
      addSuggestions.slice(0, 4).map((s: any) => queryDatabase(s.database as DatabaseSource, String(s.query)).then((r) => ({ ...r, rationale: String(s.reason || "") })))
    );
    for (const r of responses) {
      if (r.status === "fulfilled") addedResults.push(r.value);
    }
    sendLog(`Suggested queries returned ${addedResults.length} result sets.`);
  }

  return {
    mode: "critique",
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    biases: Array.isArray(parsed.biases) ? parsed.biases : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    verdict: String(parsed.verdict || "needs-improvement"),
    confidence: Number(parsed.confidence || 0.5),
    addedResults,
  };
}

/* ---------------- Knowledge cross-check (round-33) ---------------- */
/**
 * Standalone knowledge-verify mode: runs the LLM-knowledge cross-check on
 * the project's ALREADY-SAVED data sources (no regeneration, no clearing).
 *   A. fills missing metadata (fill-gaps-only) on saved data sources and
 *      their reference twins;
 *   B. adds LLM-suggested missing sources — PubMed-confirmed ones become
 *      citable references; unconfirmed ones are saved as flagged,
 *      non-citable suggestions.
 */
async function runVerify(body: GatherBody, sendLog: (msg: string) => void) {
  const projectId = body.projectId;
  if (!projectId) throw new Error("mode 'verify' requires projectId.");
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { topic: true, field: true },
  });
  if (!project) throw new Error("Project not found.");

  const dataSources = await db.dataSource.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  const references = await db.reference.findMany({ where: { projectId } });
  sendLog(`Loaded ${dataSources.length} saved sources (${references.length} references).`);

  const kvInputs: KVSourceInput[] = dataSources.map((ds: any) => ({
    id: ds.id,
    source: ds.source,
    externalId: ds.externalId,
    title: ds.title || "",
    authors: ds.authors,
    year: ds.year,
    journal: ds.journal,
    doi: ds.doi,
    abstract: ds.abstract,
  }));

  const kv = await verifySourcesWithKnowledge(
    projectId, kvInputs, body.topic || project.topic, body.field || project.field || "life sciences",
    { onLog: sendLog }
  );
  sendLog(`LLM knowledge pass: ${kv.completions.length} sources assessed, ${kv.missing.length} gap suggestions.`);

  const applied = await applyKnowledgeCompletions(
    projectId, dataSources as any, references as any, kv.completions, db,
    { onLog: sendLog }
  );

  const { verified, unverified } = await verifyMissingViaPubMed(kv.missing, { onLog: sendLog });

  const existingExtIds = new Set(dataSources.map((ds: any) => ds.externalId).filter(Boolean));
  const addedSources: any[] = [];
  for (const v of verified) {
    if (existingExtIds.has(v.item.externalId)) continue;
    try {
      await db.dataSource.create({
        data: {
          projectId,
          source: v.item.source,
          query: "llm-knowledge cross-check",
          rawJson: JSON.stringify({ items: [v.item] }),
          title: v.item.title,
          externalId: v.item.externalId,
          url: v.item.url,
          authors: v.item.authors || null,
          journal: v.item.journal || null,
          year: v.item.year || null,
          doi: v.item.doi || null,
          abstract: v.item.abstract || null,
          extra: JSON.stringify(v.item.extra),
          pinned: true,
        },
      });
      // Claim the PMID so a later duplicate suggestion can't re-save it
      existingExtIds.add(v.item.externalId);
      // Mirror as a citable reference (PubMed-verified = real metadata + PMID)
      try {
        await db.reference.create({
          data: {
            type: "pubmed",
            externalId: v.item.externalId,
            title: v.item.title,
            authors: v.item.authors || null,
            journal: v.item.journal || null,
            year: v.item.year || null,
            url: v.item.url || null,
            doi: v.item.doi || null,
            abstract: v.item.abstract || null,
            projectId,
          },
        });
      } catch (refErr: any) {
        sendLog(`Reference create failed: ${String(refErr?.message ?? refErr).slice(0, 100)}`);
      }
      addedSources.push({
        title: v.item.title,
        journal: v.item.journal,
        year: v.item.year,
        externalId: v.item.externalId,
        verified: true,
        reason: v.item.reason,
      });
    } catch (err: any) {
      sendLog(`Save verified source failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }

  // Unconfirmed suggestions are saved as NON-citable flagged data sources
  // (source='llm', extra.unverified=true) for the user to review.
  const unverifiedSuggestions: any[] = [];
  for (const s of unverified) {
    try {
      const dup = await db.dataSource.findFirst({
        where: { projectId, title: s.title },
        select: { id: true },
      });
      if (dup) continue;
      await db.dataSource.create({
        data: {
          projectId,
          source: "llm",
          query: "llm-knowledge cross-check (unverified)",
          rawJson: JSON.stringify({ items: [s] }),
          title: s.title,
          externalId: s.doi || null,
          url: s.doi ? `https://doi.org/${s.doi}` : null,
          authors: s.authors || null,
          journal: s.journal || null,
          year: s.year || null,
          doi: s.doi || null,
          abstract: null,
          extra: JSON.stringify({
            unverified: true,
            llmKind: s.kind,
            llmReason: s.reason,
            note: "Proposed by LLM knowledge; not confirmed in PubMed — review before citing.",
          }),
          pinned: false,
        },
      });
      unverifiedSuggestions.push({
        title: s.title,
        authors: s.authors,
        year: s.year,
        journal: s.journal,
        doi: s.doi,
        reason: s.reason,
        kind: s.kind,
      });
    } catch (err: any) {
      sendLog(`Save unverified suggestion failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }

  return {
    mode: "verify",
    fieldsCompleted: applied.fieldsCompleted,
    sourcesCompleted: applied.sourcesCompleted,
    byField: applied.byField,
    sourcesAdded: addedSources.length,
    addedSources,
    unverifiedCount: unverifiedSuggestions.length,
    unverifiedSuggestions,
  };
}

function safeParseJSON(raw: string, fallback: any): any {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}

// Fallback for when projectId is not available (no session context)
import { chat as _chat } from "@/lib/ai";
async function chatFallback(prompt: string, opts: { system?: string; temperature?: number }): Promise<string> {
  return _chat(prompt, opts);
}
