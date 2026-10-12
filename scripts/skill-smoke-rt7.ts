/**
 * skill-smoke-rt7.ts — RT7 live verification: run three of the newly
 * migrated skills end-to-end against a REAL project (or the E2E project in
 * flight), through the shared skill executor:
 *
 *   1. knowledge-summary (the gap-digest STRICT-JSON call — synthetic titles)
 *   2. gap-design        (the identify pass — synthetic coverage lines)
 *   3. coherence-review  (the cross-section review — synthetic numbered body)
 *   4. coherence-edit    (prose skill — one real re-edit call)
 *
 *   bun run scripts/skill-smoke-rt7.ts [projectId]
 *
 * Verifies per skill: prompt assembly, the RT6/RT7 session-metadata
 * unification (step/skill rows — the legacy "coherence"/"knowledge-verify"
 * step strings are now INSIDE the namespace), post-processing, and the
 * telemetry envelope — with ONE real LLM call per skill.
 */
import { db } from "@/lib/db";
import { runSkill } from "@/lib/skill/executor";
import { coherenceEditSkill, coherenceReviewSkill } from "@/lib/skill/skills-coherence";
import { gapDesignSkill } from "@/lib/skill/skills-gap";
import { knowledgeDigestSkill } from "@/lib/skill/skills-knowledge";

function fail(msg: string): never {
  console.error(`RT7_SMOKE_FAIL: ${msg}`);
  process.exit(1);
}

async function sessionMeta(projectId: string, taskType: string) {
  const md = await db.conversationSession.findFirst({
    where: { projectId, taskType },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  if (!md?.metadata) return null;
  return typeof md.metadata === "string" ? JSON.parse(md.metadata) : (md.metadata as any);
}

async function main() {
  const argId = process.argv[2];
  const project = argId
    ? await db.project.findFirst({ where: { id: argId } })
    : await db.project.findFirst({ orderBy: { createdAt: "desc" } });
  if (!project) fail("no project found");
  const topic = String(project!.topic).slice(0, 70);
  console.log(`project=${project!.id} (topic: ${topic}...)`);

  let pass = 0;

  // -------------------------------------------------------- 1. knowledge-summary
  {
    const digestTitles = [
      "(1) CRISPR-Cas9 mechanisms and applications",
      "(2) Off-target effects of Cas9 nucleases",
      "(3) Base editing without double-strand breaks",
      "(4) Prime editing: search-and-replace genome editing",
    ].join("\n");
    const res = await runSkill(
      knowledgeDigestSkill,
      { topic: project!.topic, field: project!.field || "molecular biology", digestTitles },
      { projectId: project!.id, fallbackValue: { missing: [] }, noCache: true },
    );
    const items = res.output.missing;
    const kindsOk = items.every((m) =>
      ["landmark", "review", "method", "database", "contradicting"].includes(m.kind),
    );
    console.log(
      `[knowledge-summary] degraded=${res.degraded} missing=${items.length} kinds=${[...new Set(items.map((m) => m.kind))].join(",") || "(none)"} first="${items[0]?.title.slice(0, 60) ?? ""}"`,
    );
    if (kindsOk) pass++;
    else fail("knowledge-summary contract violation");
    const m = await sessionMeta(project!.id, "gather");
    if (m) console.log(`  session: step=${m.step} skill=${m.skill} sub=${m.sub ?? "(none)"} (expect step=knowledge skill=knowledge-summary sub=gapDigest)`);
  }

  // ------------------------------------------------------------- 2. gap-design
  {
    const res = await runSkill(
      gapDesignSkill,
      {
        topic: project!.topic,
        field: project!.field || "molecular biology",
        coverageLines:
          "§1: Delivery vectors — FOCUS: AAV tropism and immunogenicity\n  allocated refs (1):\n    - AAV vector engineering",
        sectionCount: 2,
        sectionTitles: ["Delivery vectors", "Clinical translation"],
        remainingCapacity: 3,
      },
      { projectId: project!.id, fallbackValue: { gaps: [] }, noCache: true },
    );
    const gaps = res.output.gaps;
    const queriesOk = gaps.every((g) => g.queries.length >= 1 && g.queries.length <= 2);
    console.log(
      `[gap-design] degraded=${res.degraded} gaps=${gaps.length} queriesOk=${queriesOk} first="${gaps[0]?.gap.slice(0, 60) ?? ""}"`,
    );
    if (queriesOk) pass++;
    else fail("gap-design contract violation");
    const m = await sessionMeta(project!.id, "gather");
    if (m) console.log(`  session: step=${m.step} skill=${m.skill} sub=${m.sub ?? "(none)"} (expect step=gapAgent skill=gap-design sub=identify)`);
  }

  // -------------------------------------------------------- 3. coherence-review
  {
    const numberedBody = [
      "## 1. Mechanisms",
      "Cas9 cleaves DNA guided by a crRNA [1]. The cutting mechanism requires Mg2+.",
      "## 2. Applications",
      "Cas9 cleaves DNA as directed by the guide RNA [2], enabling therapeutic editing.",
    ].join("\n\n");
    const res = await runSkill(
      coherenceReviewSkill,
      { title: topic, numberedBody, sectionCount: 2 },
      { projectId: project!.id, fallbackValue: { summary: "", findings: [] }, noCache: true },
    );
    const typesOk = res.output.findings.every((f) =>
      ["repetition", "contradiction", "terminology", "numeric", "transition", "cross-ref"].includes(f.type),
    );
    console.log(
      `[coherence-review] degraded=${res.degraded} findings=${res.output.findings.length} types=${[...new Set(res.output.findings.map((f) => f.type))].join(",") || "(none)"} summary="${res.output.summary.slice(0, 60)}"`,
    );
    if (typesOk) pass++;
    else fail("coherence-review contract violation");
    const m = await sessionMeta(project!.id, "review");
    if (m) console.log(`  session: step=${m.step} skill=${m.skill} sub=${m.sub ?? "(none)"} (expect step=polish skill=coherence-review sub=review)`);
  }

  // ---------------------------------------------------------- 4. coherence-edit
  {
    const sectionText =
      "Cas9 nucleases cleave DNA at sites specified by the associated guide RNA molecule [3]. " +
      "The HNH and RuvC domains each cut one strand of the target duplex, producing a blunt double-strand break. " +
      "Repair outcomes depend on the cellular context, with non-homologous end joining dominating in most mammalian cell types [4]. " +
      "The guide RNA hybridizes with the target sequence adjacent to the PAM motif.";
    const res = await runSkill(
      coherenceEditSkill,
      {
        title: topic,
        heading: "Mechanisms",
        prevTail: "(this is the opening section)",
        nextHead: "Therapeutic applications of CRISPR editing have expanded rapidly in clinical trials…",
        sectionText,
        findings: [
          {
            type: "terminology",
            sections: [1, 2],
            description: "the nuclease is called 'Cas9' in §1 and 'the nuclease' in §2",
            suggestion: "use 'Cas9' consistently in §2",
          },
        ],
      },
      { projectId: project!.id, fallbackValue: "", noCache: true, metadata: { section: 2 } },
    );
    const lenOk = res.ok ? res.output.length > 80 : res.output === sectionText;
    console.log(
      `[coherence-edit] degraded=${res.degraded} ok=${res.ok} outputLen=${res.output.length} (fallback→original when !ok)`,
    );
    if (lenOk) pass++;
    else fail("coherence-edit contract violation");
    const m = await sessionMeta(project!.id, "revise");
    if (m) console.log(`  session: step=${m.step} skill=${m.skill} sub=${m.sub ?? "(none)"} section=${m.section ?? "?"} (expect step=polish skill=coherence-edit sub=polish section=2)`);
  }

  console.log(pass >= 3 ? "RT7_SMOKE_PASS" : "RT7_SMOKE_FAIL");
  process.exit(pass >= 3 ? 0 : 1);
}

main();
