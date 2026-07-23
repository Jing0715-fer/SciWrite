import { NextRequest, NextResponse } from "next/server";
import { chat } from "@/lib/ai";
import { queryDatabase } from "@/lib/databases";
import type { DatabaseSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

interface GatherQuery {
  database: DatabaseSource;
  query: string;
  rationale: string;
}

interface GatherBody {
  mode: "clarify" | "organize" | "critique";
  topic: string;
  field?: string;
  purpose?: string;
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
  try {
    const body = (await req.json()) as GatherBody;
    if (!body.mode || !body.topic) {
      return NextResponse.json(
        { error: "Missing 'mode' or 'topic'." },
        { status: 400 }
      );
    }

    if (body.mode === "clarify") {
      return NextResponse.json(await runClarify(body));
    }
    if (body.mode === "organize") {
      return NextResponse.json(await runOrganize(body));
    }
    if (body.mode === "critique") {
      return NextResponse.json(await runCritique(body));
    }
    return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
  } catch (err: any) {
    console.error("[/api/ai/gather] error:", err);
    return NextResponse.json(
      { error: err?.message || "Gathering failed." },
      { status: 500 }
    );
  }
}

/* ---------------- Clarify ---------------- */
async function runClarify(body: GatherBody) {
  const history = body.history || [];
  const historyText = history.length
    ? history
        .map((h, i) => `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`)
        .join("\n\n")
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

${
  history.length === 0
    ? "This is the first round. Ask 2-3 clarifying questions."
    : "Based on the answers, either ask 1-2 follow-up questions OR declare ready=true with a purpose statement."
}

Respond as STRICT JSON:
{
  "questions": ["...", "..."],
  "ready": false,
  "purpose": ""
}
When ready=true, questions should be empty and purpose should be a 2-3 sentence purpose statement. Output JSON only.`;

  const raw = await chat(prompt, { system, temperature: 0.4 });
  const parsed = safeParseJSON(raw, {
    questions: [],
    ready: true,
    purpose: body.topic,
  });
  return {
    mode: "clarify",
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    ready: Boolean(parsed.ready),
    purpose: String(parsed.purpose || ""),
  };
}

/* ---------------- Organize ---------------- */
async function runOrganize(body: GatherBody) {
  const purpose = body.purpose || body.topic;
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

  const raw = await chat(prompt, { system, temperature: 0.5 });
  const parsed = safeParseJSON(raw, { plan: "", queries: [] });
  const queries: GatherQuery[] = (Array.isArray(parsed.queries) ? parsed.queries : [])
    .filter(
      (q: any) =>
        q.database &&
        q.query &&
        ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database)
    )
    .map((q: any) => ({
      database: q.database as DatabaseSource,
      query: String(q.query),
      rationale: String(q.rationale || ""),
    }));

  let results: any[] = [];
  if (body.runQueries && queries.length) {
    const responses = await Promise.allSettled(
      queries.slice(0, 6).map((q) =>
        queryDatabase(q.database, q.query).then((r) => ({
          ...r,
          rationale: q.rationale,
        }))
      )
    );
    for (const r of responses) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      }
    }
  }

  return {
    mode: "organize",
    plan: String(parsed.plan || ""),
    queries,
    results,
  };
}

/* ---------------- Critique (adversarial) ---------------- */
async function runCritique(body: GatherBody) {
  const sources = body.sources || [];
  const sourcesText = sources.length
    ? sources
        .map(
          (s, i) =>
            `[${i + 1}] (${s.source}${s.externalId ? ":" + s.externalId : ""}) ${
              s.authors || ""
            } ${s.year || ""} ${s.journal || ""}. ${s.title}. ${
              s.abstract ? s.abstract.slice(0, 200) : ""
            }`
        )
        .join("\n")
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

  const raw = await chat(prompt, { system, temperature: 0.5 });
  const parsed = safeParseJSON(raw, {
    gaps: [],
    biases: [],
    suggestions: [],
    verdict: "needs-improvement",
    confidence: 0.5,
  });

  const addSuggestions = (
    Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  ).filter((s: any) => s.action === "add" && s.database && s.query);
  let addedResults: any[] = [];
  if (body.runQueries && addSuggestions.length) {
    const responses = await Promise.allSettled(
      addSuggestions.slice(0, 4).map((s: any) =>
        queryDatabase(s.database as DatabaseSource, String(s.query)).then((r) => ({
          ...r,
          rationale: String(s.reason || ""),
        }))
      )
    );
    for (const r of responses) {
      if (r.status === "fulfilled") addedResults.push(r.value);
    }
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

function safeParseJSON(raw: string, fallback: any): any {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}
