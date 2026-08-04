import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat, webSearch } from "@/lib/ai";
import { chatWithSession } from "@/lib/llm-session";
import { createSSEStream, SSE_HEADERS } from "@/lib/sse";
import {
  buildCitationContext,
  buildStructureContextFromDataSources,
  buildWritePrompt,
  countWords,
  renumberByAppearance,
  summarizeDataSource,
  writingSystemPrompt,
} from "@/lib/writing";
import {
  sanitizeOutOfRangeCitations,
  validateCitationsInline,
} from "@/lib/citation-audit";
import type { WriteRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as WriteRequest;
  if (!body.topic) {
    return NextResponse.json({ error: "Missing 'topic'." }, { status: 400 });
  }

  const { stream, send, complete, error } = createSSEStream();

  (async () => {
    try {
      send("step", { status: "started", message: "Gathering references..." });

      // Gather references
      const references = body.referenceIds?.length
        ? await db.reference.findMany({ where: { id: { in: body.referenceIds } } })
        : [];
      send("step", { status: "progress", message: `${references.length} references loaded.` });

      // Gather pinned/selected data sources
      send("step", { status: "progress", message: "Loading data sources..." });
      const dataSources = body.dataSourceIds?.length
        ? await db.dataSource.findMany({ where: { id: { in: body.dataSourceIds } } })
        : [];

      // Molcraft fusion: load cached structure analyses for any RCSB data
      // sources, and build an LLM-ready structural context block. This gives
      // the LLM REAL computed metrics (helix/sheet %, ligands, Ramachandran,
      // B-factor, SASA, H-bonds, charge/pI, BSA) to discuss deeply.
      const structureContext = await buildStructureContextFromDataSources(
        body.dataSourceIds || []
      );
      if (structureContext) {
        send("step", {
          status: "progress",
          message: "Loaded cached protein structure analyses for RCSB sources.",
        });
      }

      // Gather user-provided data
      send("step", { status: "progress", message: "Loading user data..." });
      const userData = body.userDataIds?.length
        ? await db.userData.findMany({ where: { id: { in: body.userDataIds } } })
        : [];

      const userDataContext = userData.length
        ? "USER-PROVIDED DATA (use these to describe Results — figures, tables, observations):\n" +
          userData
            .map((u, i) => {
              const parts = [`[DATA:${i + 1}] (${u.type}) ${u.title}`];
              if (u.description) parts.push(`Description: ${u.description}`);
              if (u.type === "table" && u.data) {
                try {
                  const tableData = JSON.parse(u.data);
                  if (tableData.headers && tableData.rows) {
                    parts.push(`Table headers: ${tableData.headers.join(" | ")}`);
                    parts.push(`Rows: ${tableData.rows.length} data rows`);
                    if (tableData.rows.length > 0) {
                      parts.push(`Sample row: ${tableData.rows[0].join(" | ")}`);
                    }
                  }
                } catch {}
              }
              return parts.join("\n");
            })
            .join("\n\n")
        : "";

      // Optionally run web search to enrich context
      let searchItems: { title: string; snippet: string; url: string; host_name?: string }[] = [];
      if (body.searchQueries && body.searchQueries.length) {
        send("step", { status: "progress", message: `Running ${body.searchQueries!.slice(0, 3).length} web searches...` });
        const all = await Promise.all(
          body.searchQueries.slice(0, 3).map((q) => webSearch(q, 4))
        );
        searchItems = all.flat().slice(0, 8);
        send("step", { status: "progress", message: `Web search returned ${searchItems.length} results.` });
      }

      const referencesContext = buildCitationContext(
        references.map((r) => ({
          title: r.title,
          authors: r.authors || undefined,
          journal: r.journal || undefined,
          year: r.year || undefined,
          url: r.url || undefined,
          externalId: r.externalId || undefined,
          source: r.type as any,
        })),
        "REFERENCE LIST"
      );

      const dsContext = dataSources.length
        ? "STRUCTURAL / SEQUENCE / DATABASE RECORDS (cite as [SOURCE:ID]):\n" +
          dataSources
            .map((d) => {
              const raw = (() => {
                try {
                  return JSON.parse(d.rawJson);
                } catch {
                  return null;
                }
              })();
              const items: any[] = raw?.items ?? (raw ? [raw] : []);
              const sub = summarizeDataSource(
                items.map((it) => ({
                  source: d.source,
                  externalId: it.externalId || d.externalId || "",
                  title: it.title || d.title || d.query,
                  authors: it.authors || d.authors,
                  journal: it.journal || d.journal,
                  year: it.year || d.year,
                  url: it.url || d.url || "",
                }))
              );
              const metaParts: string[] = [];
              if (d.authors) metaParts.push(`Authors: ${d.authors}`);
              if (d.journal) metaParts.push(`Journal: ${d.journal}`);
              if (d.year) metaParts.push(`Year: ${d.year}`);
              if (d.doi) metaParts.push(`DOI: ${d.doi}`);
              if (d.abstract) metaParts.push(`Abstract: ${d.abstract.slice(0, 300)}`);
              const extraMeta = metaParts.length ? `\nMetadata: ${metaParts.join(" | ")}` : "";
              return `## ${d.source.toUpperCase()} — query: ${d.query}\n${sub || d.summary || ""}${extraMeta}`;
            })
            .join("\n\n")
        : "";

      const searchContext = searchItems.length
        ? "WEB SEARCH CONTEXT (cite by [n] matching REFERENCE LIST order; if from web only, mark [WEB:n]):\n" +
          searchItems
            .map(
              (s, i) =>
                `[WEB:${i + 1}] ${s.name || s.title} — ${s.host_name || ""}\n${s.snippet}\n${s.url}`
            )
            .join("\n\n")
        : "";

      const system = writingSystemPrompt({
        format: body.format,
        scenario: body.scenario,
        field: body.field,
        language: body.language,
      });
      const prompt = buildWritePrompt({
        topic: body.topic,
        focus: body.focus,
        format: body.format,
        scenario: body.scenario,
        referencesContext,
        structureContext,
        searchContext: [dsContext, searchContext, userDataContext].filter(Boolean).join("\n\n"),
      });

      send("step", { status: "progress", message: "Calling LLM to write paragraph..." });

      let content = body.projectId
        ? await chatWithSession(body.projectId, prompt, {
            system,
            temperature: 0.65,
            taskType: "write",
            metadata: { format: body.format, scenario: body.scenario },
          })
        : await chat(prompt, { system, temperature: 0.65 });

      send("step", { status: "progress", message: "Sanitizing out-of-range citations..." });

      // Layer 1 — adversarial pre-save guard. Replace any [n] where n >
      // references.length with a [$REF] placeholder so the user sees an
      // explicit "needs a reference" marker instead of a silently-wrong
      // citation number. This runs BEFORE renumberByAppearance so the
      // renumberer only sees in-range citations.
      const { content: sanitizedContent, replaced } = sanitizeOutOfRangeCitations(
        content,
        references.length
      );
      if (replaced > 0) {
        send("step", {
          status: "progress",
          message: `Replaced ${replaced} out-of-range citation(s) with [$REF] placeholder(s).`,
        });
      }
      content = sanitizedContent;

      send("step", { status: "progress", message: "Renumbering citations by appearance order..." });

      const { content: renumberedContent, references: reorderedRefs } =
        renumberByAppearance(content, references);
      content = renumberedContent;

      // Layer 1 — run the inline validator on the renumbered content to log
      // topicality warnings (suspect/unsupported). These do not block the
      // save (false positives are common with short titles) but are recorded
      // for the audit trail and surfaced in the article audit banner.
      const inlineFindings = validateCitationsInline(content, reorderedRefs as any);
      if (inlineFindings.length > 0) {
        const blocking = inlineFindings.filter(
          (f) => f.verdict === "out-of-range" || f.verdict === "missing"
        ).length;
        const suspect = inlineFindings.filter(
          (f) => f.verdict === "suspect" || f.verdict === "unsupported"
        ).length;
        send("step", {
          status: "progress",
          message: `Citation audit: ${blocking} blocking, ${suspect} topicality warning(s).`,
        });
        console.warn(
          `[/api/ai/write] inline citation audit (${inlineFindings.length} findings):`,
          inlineFindings.map((f) => `[${f.n}] ${f.verdict}: ${f.reason.slice(0, 80)}`)
        );
      }

      let paragraph = null;
      if (body.projectId) {
        send("step", { status: "progress", message: "Saving paragraph to database..." });
        const count = await db.paragraph.count({
          where: { projectId: body.projectId },
        });
        const title = body.focus || body.topic;
        paragraph = await db.paragraph.create({
          data: {
            projectId: body.projectId,
            title,
            content,
            format: body.format,
            scenario: body.scenario,
            status: "draft",
            order: count,
            wordCount: countWords(content),
          },
        });

        send("step", { status: "progress", message: `Linking ${reorderedRefs.length} cited references...` });
        for (let idx = 0; idx < reorderedRefs.length; idx++) {
          const ref = reorderedRefs[idx];
          const existing = await db.reference.findFirst({
            where: {
              externalId: ref.externalId,
              paragraphId: paragraph.id,
            },
          });
          if (!existing) {
            await db.reference.create({
              data: {
                type: ref.type || "manual",
                externalId: ref.externalId,
                title: ref.title,
                authors: ref.authors,
                journal: ref.journal,
                year: ref.year,
                url: ref.url,
                doi: ref.doi,
                abstract: ref.abstract,
                projectId: body.projectId,
                paragraphId: paragraph.id,
                citationOrder: idx,
              },
            });
          } else {
            await db.reference.update({
              where: { id: existing.id },
              data: { citationOrder: idx },
            });
          }
        }
      }

      send("step", { status: "done", message: `Paragraph written: ${countWords(content)} words.` });
      send("complete", {
        paragraph,
        content,
        usedReferences: references.length,
        usedDataSources: dataSources.length,
        usedSearchResults: searchItems.length,
      });
      complete();
    } catch (err: any) {
      console.error("[/api/ai/write] error:", err);
      error(err?.message || "Writing failed.");
    }
  })();

  return new Response(stream, { headers: SSE_HEADERS });
}
