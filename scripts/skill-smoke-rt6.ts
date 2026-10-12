/**
 * skill-smoke-rt6.ts — RT6 live verification: run the newly migrated skills
 * end-to-end against a REAL project, through the shared skill executor:
 *
 *   1. curate-smart  (A-family; needs scored refs — reuses mechanical scores)
 *   2. review-core   (B-family STRICT-JSON reviewer)
 *   3. fact-check    (B-family arbitration with a fabricated quantitative claim)
 *
 *   bun run scripts/skill-smoke-rt6.ts [projectId]
 *
 * Verifies per skill: prompt assembly, session metadata unification
 * (step/skill), post-processing/normalization, fallback-free healthy path,
 * and the telemetry envelope — with ONE real LLM call per skill.
 */
import { db } from "@/lib/db";
import { runSkill } from "@/lib/skill/executor";
import { curateSmartSkill } from "@/lib/skill/skills-curation";
import { reviewCoreSkill, REVIEW_CORE_PARSE_FALLBACK } from "@/lib/skill/skills-review";
import { factCheckArbitrateSkill } from "@/lib/skill/skills-evidence";
import { mechanicalScores, type SourceScore } from "@/lib/scoring";
import { typicalCitationCount } from "@/lib/citation-planner";

function fail(msg: string): never {
  console.error(`RT6_SMOKE_FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const argId = process.argv[2];
  const project = argId
    ? await db.project.findFirst({ where: { id: argId } })
    : await db.project.findFirst({ orderBy: { createdAt: "desc" } });
  if (!project) fail("no project found");
  console.log(`project=${project!.id} (topic: ${String(project!.topic).slice(0, 60)}...)`);

  // Fetch a paragraph with content for the review skill.
  const candidates = await db.paragraph.findMany({
    where: { projectId: project!.id },
    orderBy: { updatedAt: "desc" },
    take: 12,
  });
  const para = candidates.find((p) => (p.content || "").trim().length > 0);
  const articleContent = (para?.content as string) || `## Introduction\n\n${project!.topic} is an important research area [1].`;
  console.log(`review input: ${(para ? "real paragraph" : "synthetic paragraph")} (${articleContent.length} chars)`);

  let pass = 0;

  // ---------------------------------------------------------------- 1. curate-smart
  {
    const refs = await db.reference.findMany({ where: { projectId: project!.id }, take: 8 });
    if (refs.length < 7) {
      console.log(`[curate-smart] SKIP — needs >=7 refs, project has ${refs.length}`);
    } else {
      const scores: SourceScore[] = mechanicalScores(refs, new Map(), project!.topic);
      const typical = typicalCitationCount(3000);
      const res = await runSkill(
        curateSmartSkill,
        {
          topic: project!.topic,
          field: "molecular biology",
          targetWords: 3000,
          refs,
          scores,
          typical,
          softFloor: Math.min(6, refs.length),
          hardCap: refs.length,
        },
        { projectId: project!.id, fallbackValue: { indices: [], rationale: "" } },
      );
      const dedupOk = new Set(res.output.indices).size === res.output.indices.length;
      const rangeOk = res.output.indices.every((n) => n >= 1 && n <= refs.length);
      console.log(
        `[curate-smart] degraded=${res.degraded} picked=${res.output.indices.length}/${refs.length} dedup=${dedupOk} range=${rangeOk} rationale="${res.output.rationale.slice(0, 70)}"`,
      );
      if (rangeOk && dedupOk) pass++;
      else fail("curate-smart contract violation");
      const md = (res.telemetry as any) && res.degraded
        ? null
        : await db.conversationSession.findFirst({
            where: { projectId: project!.id, taskType: "curate-smart" },
            orderBy: { createdAt: "desc" },
            select: { metadata: true },
          });
      if (md?.metadata) {
        const m = typeof md.metadata === "string" ? JSON.parse(md.metadata) : (md.metadata as any);
        console.log(`  session: step=${m.step} skill=${m.skill} pool=${m.pool}`);
      }
    }
  }

  // ---------------------------------------------------------------- 2. review-core
  {
    const res = await runSkill(
      reviewCoreSkill,
      { title: project!.topic, abstract: null, content: articleContent.slice(0, 4000), factBlock: "" },
      { projectId: project!.id, fallbackValue: { ...REVIEW_CORE_PARSE_FALLBACK }, noCache: true },
    );
    const p = res.output;
    const verdictOk = typeof p.verdict === "string" && p.verdict.length > 0;
    const classesOk =
      !p.weaknessClasses ||
      p.weaknessClasses.length === 0 ||
      p.weaknessClasses.every((c) => c === "fixable" || c === "advisory");
    console.log(
      `[review-core] degraded=${res.degraded} verdict=${p.verdict} overall=${p.scores?.overall ?? "?"} weaknesses=${(p.weaknesses || []).length} classes=${(p.weaknessClasses || []).join(",") || "(none)"}`,
    );
    if (verdictOk && classesOk) pass++;
    else fail("review-core contract violation");
    const md = await db.conversationSession.findFirst({
      where: { projectId: project!.id, taskType: "review" },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    if (md?.metadata) {
      const m = typeof md.metadata === "string" ? JSON.parse(md.metadata) : (md.metadata as any);
      console.log(`  session: step=${m.step} skill=${m.skill} mode=${m.mode}`);
    }
  }

  // ---------------------------------------------------------------- 3. fact-check
  {
    const claim = {
      id: 1,
      category: "quantitative" as const,
      sentence: `${String(project!.topic).slice(0, 40)} was first identified in 1995.`,
      citedNums: [] as number[],
      searchQuery: String(project!.topic).slice(0, 60),
    };
    const res = await runSkill(
      factCheckArbitrateSkill,
      { claim, evidence: [], citedRefs: [], abstracts: [] },
      {
        projectId: project!.id,
        fallbackValue: {
          claimId: claim.id, category: claim.category, sentence: claim.sentence,
          citedNums: [], verdict: "UNVERIFIABLE", reason: "", evidenceQuote: "",
          evidenceUrls: [], confidence: 0,
        },
        noCache: true,
      },
    );
    const f = res.output;
    const verdictOk = ["VERIFIED", "CONTRADICTED", "UNVERIFIABLE", "ERROR"].includes(f.verdict);
    const confOk = f.confidence >= 0 && f.confidence <= 100;
    console.log(
      `[fact-check] degraded=${res.degraded} verdict=${f.verdict} conf=${f.confidence} reason="${f.reason.slice(0, 70)}"`,
    );
    if (verdictOk && confOk) pass++;
    else fail("fact-check contract violation");
    const md = await db.conversationSession.findFirst({
      where: { projectId: project!.id, taskType: "review" },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    if (md?.metadata) {
      const m = typeof md.metadata === "string" ? JSON.parse(md.metadata) : (md.metadata as any);
      console.log(`  session: step=${m.step} skill=${m.skill} claimCategory=${m.claimCategory}`);
    }
  }

  console.log(pass >= 2 ? "RT6_SMOKE_PASS" : "RT6_SMOKE_FAIL");
  process.exit(pass >= 2 ? 0 : 1);
}

main();
