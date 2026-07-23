import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat, webSearch } from "@/lib/ai";
import {
  buildCitationContext,
  buildWritePrompt,
  countWords,
  summarizeDataSource,
  writingSystemPrompt,
} from "@/lib/writing";
import type { WriteRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as WriteRequest;
    if (!body.topic) {
      return NextResponse.json({ error: "Missing 'topic'." }, { status: 400 });
    }

    // Gather references
    const references = body.referenceIds?.length
      ? await db.reference.findMany({ where: { id: { in: body.referenceIds } } })
      : [];

    // Gather pinned/selected data sources
    const dataSources = body.dataSourceIds?.length
      ? await db.dataSource.findMany({ where: { id: { in: body.dataSourceIds } } })
      : [];

    // Gather user-provided data (images, tables, text descriptions)
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
      const all = await Promise.all(
        body.searchQueries.slice(0, 3).map((q) => webSearch(q, 4))
      );
      searchItems = all.flat().slice(0, 8);
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
            // Include enhanced metadata from the DataSource record
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
      searchContext: [dsContext, searchContext, userDataContext].filter(Boolean).join("\n\n"),
    });

    const content = await chat(prompt, { system, temperature: 0.65 });

    // Create the paragraph record if a project is provided
    let paragraph = null;
    if (body.projectId) {
      const count = await db.paragraph.count({
        where: { projectId: body.projectId },
      });
      const title = body.focus
        ? `${body.focus.slice(0, 50)}`
        : `${body.topic.slice(0, 50)}`;
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

      // attach references used
      if (references.length) {
        await db.reference.updateMany({
          where: { id: { in: references.map((r) => r.id) } },
          data: { paragraphId: paragraph.id },
        });
      }
    }

    return NextResponse.json({
      paragraph,
      content,
      usedReferences: references.length,
      usedDataSources: dataSources.length,
      usedSearchResults: searchItems.length,
    });
  } catch (err: any) {
    console.error("[/api/ai/write] error:", err);
    return NextResponse.json(
      { error: err?.message || "Writing failed." },
      { status: 500 }
    );
  }
}
