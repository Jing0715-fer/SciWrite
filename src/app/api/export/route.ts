import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from "docx";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFNumber } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Annotation, Reference } from "@/lib/types";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import JSZip from "jszip";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Detect whether a string contains CJK (Chinese/Japanese/Korean) characters.
 * Used to decide whether to embed a CJK font for PDF rendering.
 *
 * Covers:
 *  - CJK Unified Ideographs (U+4E00–U+9FFF) — modern Chinese, kanji
 *  - CJK Extension A (U+3400–U+4DBF) — rare characters
 *  - CJK Compatibility Ideographs (U+F900–U+FAFF)
 *  - Hiragana (U+3040–U+309F), Katakana (U+30A0–U+30FF) — Japanese
 *  - Hangul Syllables (U+AC00–U+D7AF) — Korean
 */
function containsCJK(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Lazy-loaded CJK font bytes (cached after first load).
 * Loaded from public/fonts/NotoSansSC-Regular.ttf.
 * Returns null if the font file is not available.
 */
let _cjkFontBytes: Uint8Array | null | undefined = undefined;
async function loadCJKFont(): Promise<Uint8Array | null> {
  if (_cjkFontBytes !== undefined) return _cjkFontBytes;
  try {
    const fontPath = path.join(process.cwd(), "public", "fonts", "NotoSansSC-Regular.ttf");
    const buffer = await fs.readFile(fontPath);
    _cjkFontBytes = new Uint8Array(buffer);
    console.log(`[export] CJK font loaded from ${fontPath} (${_cjkFontBytes.length} bytes)`);
  } catch (err: any) {
    console.warn(`[export] CJK font not available: ${err?.message || "unknown"}`);
    _cjkFontBytes = null;
  }
  return _cjkFontBytes;
}

interface ExportBody {
  type: "paragraph" | "article" | "project-merge";
  id: string;
  format: "docx" | "pdf" | "markdown" | "latex" | "epub" | "graph-report";
  includeAnnotations?: boolean;
  journalTemplate?: string;
  mergeExport?: boolean;
  /** Language variant to export. Default: "en". */
  language?: "en" | "zh" | "both";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ExportBody;
    if (!body.type || !body.id || !body.format) {
      return NextResponse.json(
        { error: "Missing type, id, or format." },
        { status: 400 }
      );
    }

    const language = body.language || "en";

    // Fetch the record
    let title = "";
    let titleZh: string | null = null;
    let content = "";
    let contentZh: string | null = null;
    let abstract = "";
    let references: (Reference & { _count?: any })[] = [];
    let annotations: Annotation[] = [];
    let allUserData: any[] = [];
    // projectId resolved from the exported record so we can ALSO fetch every
    // gathered DataSource (PubMed/UniProt/RCSB/NCBI/BLAST/Web). We surface
    // these as a "Data Source Inventory" appendix in the export so the user
    // can see which gathered sources were actually cited vs. which were
    // gathered-but-unused. This answers the common question "why are there
    // 117 data sources but only 36 references in the exported document?"
    let projectId: string | null = null;
    let citedRefKeys = new Set<string>(); // keys of references actually cited inline
    // v112-2: Body-derived PMID set — populated when exporting an article by
    // parsing its "## References" section. Used to reconcile the (potentially
    // stale) paragraph-derived citedRefKeys against what's actually in the
    // article body. See isDataSourceCited() below.
    const bodyRefPmids = new Set<string>();

    if (body.type === "paragraph") {
      const p = await db.paragraph.findUnique({
        where: { id: body.id },
        include: { references: true, annotations: true },
      });
      if (!p) return NextResponse.json({ error: "Not found." }, { status: 404 });
      title = p.title;
      content = p.content;
      contentZh = p.contentZh;
      references = p.references;
      annotations = p.annotations;
      projectId = p.projectId;
      // For a single paragraph, the cited refs are exactly the paragraph's refs
      for (const r of p.references) {
        citedRefKeys.add(`${r.type}:${r.externalId || r.title}`);
      }
    } else if (body.type === "project-merge") {
      // Merge export: fetch all paragraphs + articles + references + userData for the project
      const project = await db.project.findUnique({
        where: { id: body.id },
        include: {
          paragraphs: {
            orderBy: { order: "asc" },
            include: { references: true, annotations: true },
          },
          articles: { orderBy: { updatedAt: "desc" }, take: 1 },
          references: { where: { paragraphId: null } },
          userData: true,
        },
      });
      if (!project) return NextResponse.json({ error: "Not found." }, { status: 404 });
      title = project.title;
      abstract = project.description || "";
      allUserData = project.userData;
      projectId = project.id;

      // Build merged content: all paragraphs as sections + latest article if exists
      const sections: string[] = [];
      const sectionsZh: string[] = [];
      let hasZh = false;
      for (const p of project.paragraphs) {
        const citeHeaderIdx = p.content.indexOf("### Citations");
        const cleanContent = citeHeaderIdx >= 0 ? p.content.slice(0, citeHeaderIdx).trim() : p.content.trim();
        sections.push(`## ${p.title}\n\n${cleanContent}`);
        if (p.contentZh) {
          hasZh = true;
          const zhCiteIdx = p.contentZh.indexOf("### Citations");
          const cleanZh = zhCiteIdx >= 0 ? p.contentZh.slice(0, zhCiteIdx).trim() : p.contentZh.trim();
          sectionsZh.push(`## ${p.title}\n\n${cleanZh}`);
        }
      }
      // If there's an article, use its content as the main body
      if (project.articles.length > 0) {
        const article = project.articles[0];
        const aCiteIdx = article.content.indexOf("### Citations");
        const aClean = aCiteIdx >= 0 ? article.content.slice(0, aCiteIdx).trim() : article.content.trim();
        content = aClean;
        if (article.contentZh) {
          contentZh = article.contentZh;
          hasZh = true;
        }
        if (article.abstract) abstract = article.abstract;
      } else {
        content = sections.join("\n\n");
        if (hasZh) contentZh = sectionsZh.join("\n\n");
      }

      // Merge all references (project-level + all paragraph-level), dedupe by externalId
      const refMap = new Map<string, Reference>();
      for (const r of project.references) {
        const key = `${r.type}:${r.externalId || r.title}`;
        if (!refMap.has(key)) refMap.set(key, r);
      }
      for (const p of project.paragraphs) {
        for (const r of p.references) {
          const key = `${r.type}:${r.externalId || r.title}`;
          if (!refMap.has(key)) refMap.set(key, r);
          // Track which references were actually linked to a paragraph
          // (i.e. cited inline via [n]) vs. just gathered.
          citedRefKeys.add(key);
        }
      }
      references = [...refMap.values()];

      // Merge all annotations
      annotations = project.paragraphs.flatMap((p) => p.annotations);
    } else {
      const a = await db.article.findUnique({
        where: { id: body.id },
        include: {
          articleParagraph: {
            include: { paragraph: { include: { references: true, annotations: true } } },
          },
        },
      });
      if (!a) return NextResponse.json({ error: "Not found." }, { status: 404 });
      title = a.title;
      titleZh = a.titleZh;
      content = a.content;
      contentZh = a.contentZh;
      abstract = a.abstract || "";
      projectId = a.projectId;
      // Merge references from all paragraphs linked to this article.
      // v112-2: After adversarial auto-fix the article body's "## References"
      // list may have had entries removed (e.g. Basit 2026 / Zhang 2015 reviews
      // removed as off-topic during adversarial review) without updating the
      // linked paragraphs' Reference rows. So the paragraph-derived citedRefKeys
      // is stale — it includes refs that are no longer in the article body.
      // We therefore parse the body's "## References" section post-hoc and
      // reconcile: only refs whose PMID appears in the body's references list
      // count as "cited inline" for the Data Source Inventory appendix.
      const refMap = new Map<string, Reference>();
      for (const ap of a.articleParagraph) {
        for (const r of ap.paragraph.references) {
          const key = `${r.type}:${r.externalId || r.title}`;
          if (!refMap.has(key)) refMap.set(key, r);
          citedRefKeys.add(key);
        }
      }
      references = [...refMap.values()];
      annotations = a.articleParagraph.flatMap((ap) => ap.paragraph.annotations);

      // v112-2: Build body-derived cited PMIDs from the article's "## References"
      // section (parse pubmed URLs). This becomes the authoritative set used
      // by the Data Source Inventory appendix to mark DataSources as "cited".
      const refStart = (a.content || "").indexOf("## References");
      if (refStart >= 0) {
        const refSection = a.content.substring(refStart);
        const pmidMatches = [...refSection.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g)];
        for (const m of pmidMatches) bodyRefPmids.add(m[1]);
      }
    }

    // Apply language selection: if user asked for "zh" and we have contentZh, use it.
    // If user asked for "both", we'll concatenate both with a separator.
    let exportTitle = title;
    let exportContent = content;
    if (language === "zh") {
      if (contentZh) {
        exportContent = contentZh;
        if (titleZh) exportTitle = titleZh;
      } else {
        // No Chinese version available — return 404 with a clear message
        return NextResponse.json(
          { error: "No Chinese translation available for this article. Generate with language='both' first." },
          { status: 404 }
        );
      }
    } else if (language === "both") {
      if (contentZh) {
        // Concatenate both versions with a clear separator
        const enTitle = title;
        const zhTitle = titleZh || title;
        exportTitle = `${title} / ${zhTitle}`;
        exportContent =
          `# ${enTitle}\n\n${content}\n\n---\n\n# ${zhTitle}\n\n${contentZh}`;
      } else {
        // No Chinese version — just export English
      }
    }

    // Strip AI-generated reference/citation sections from the EXPORT content
    // (we build our own reference list). Use exportContent so language selection applies.
    //
    // CRITICAL: when language === "both", exportContent is the concatenation of
    // the English article + "---" separator + Chinese article. Each half may
    // contain its own "## References" / "## 参考文献" block at the end. We must
    // strip each half INDEPENDENTLY — otherwise indexOf("## References")
    // returns the position of the English block, and slicing there would
    // delete the entire Chinese half of the document.
    const cleanContent = stripReferencesFromContent(exportContent, language);

    // Build reference list text — apply journal template format if specified
    const journalTemplate = body.journalTemplate;
    const refLabel = journalTemplate === "nature" ? "References" :
                     journalTemplate === "cell" ? "References" :
                     journalTemplate === "science" ? "References" :
                     journalTemplate === "jbc" ? "References" :
                     journalTemplate === "plos" ? "References" :
                     journalTemplate === "ieee" ? "References" :
                     "References";

    const refLines = references.length
      ? references.map((r, i) => {
          const n = i + 1;
          // Export validation: warn about missing fields (logged server-side)
          const missing: string[] = [];
          if (!r.authors) missing.push("authors");
          if (!r.year) missing.push("year");
          if (!r.journal) missing.push("journal");
          if (missing.length > 0) {
            console.warn(`[export] Reference [${n}] "${(r.title || "").slice(0, 50)}" missing: ${missing.join(", ")}`);
          }
          const authors = r.authors || "Anonymous";
          const year = r.year || "n.d.";
          // For export: strip PDB-specific info from journal name (keep only the publication journal)
          const rawJournal = r.journal || "";
          const journal = rawJournal.replace(/\s*\(PDB:\s*[^)]+\)/g, "").trim();
          const doi = r.doi || "";
          const url = r.url || "";
          // For export: do NOT include [RCSB:xxx] or [PDB:xxx] source tags — only show publication info
          const extId = (r.type !== "rcsb" && r.type !== "pdb" && r.externalId)
            ? ` [${r.type.toUpperCase()}:${r.externalId}]`
            : "";

          // Apply journal-specific formatting
          if (journalTemplate === "nature") {
            return `${n}. ${authors} ${r.title}. ${journal ? journal + " " : ""}${year ? `(${year})` : ""}.${extId}${url && !doi ? ` ${url}` : ""}`;
          } else if (journalTemplate === "cell") {
            return `${authors} (${year}). ${r.title}. ${journal}.${extId}${url && !doi ? ` ${url}` : ""}`;
          } else if (journalTemplate === "ieee") {
            return `[${n}] ${authors}, "${r.title}," ${journal || ""}, ${year}.${extId}${url && !doi ? ` ${url}` : ""}`;
          } else if (journalTemplate === "plos") {
            return `${n}. ${authors} ${r.title}. ${journal}. ${year};${extId}${url && !doi ? ` ${url}` : ""}`;
          } else {
            // Generic format
            return `[${n}] ${authors}${year ? ` (${year})` : ""}${journal ? `, ${journal}` : ""}. ${r.title}.${extId}${url && !doi ? ` ${url}` : ""}`;
          }
        })
      : [];

    // ============ Data Source Inventory & Citation Validation ============
    // Fetch every gathered DataSource for the project so we can show:
    //   1. A "Data Source Inventory" appendix listing all gathered sources
    //      (PubMed / RCSB / UniProt / NCBI / BLAST / Web) with their cited /
    //      uncited status. This answers the common question: "why are there
    //      117 data sources but only 36 references in the exported doc?"
    //      Answer: only PubMed + RCSB-with-publication + Web sources become
    //      citable References; UniProt/NCBI/BLAST are structural/sequence
    //      records that don't carry a publication, so they're gathered for
    //      context but never appear in the reference list.
    //   2. A "Citation Validation" report flagging:
    //      - [$REF] placeholders the LLM emitted when it couldn't find a
    //        suitable reference (these are gaps the user should fix)
    //      - [n] markers that point to a number beyond the reference list
    //        range (orphan citations)
    //      - References in the list that were never cited inline (orphans)
    let dataSources: any[] = [];
    if (projectId) {
      try {
        dataSources = await db.dataSource.findMany({
          where: { projectId },
          orderBy: [{ source: "asc" }, { createdAt: "asc" }],
        });
      } catch (err: any) {
        console.warn("[export] failed to fetch data sources:", err?.message);
      }
    }

    // Scan the cleaned body content for citation issues. We scan the EN
    // content; if language==="both" we also scan the ZH half. [$REF] is a
    // placeholder the generate-full pipeline writes when the LLM cites a
    // number outside the curated reference range.
    const dollarRefCount = (cleanContent.match(/\[\$REF\]/g) || []).length;

    // Orphan [n]: any [n] whose n exceeds the total reference count. We
    // renumber globally during generate-full, so this should be rare, but
    // can still happen if a section's local [n] wasn't mapped correctly.
    const maxRefN = references.length;
    const orphanCitations = new Set<number>();
    const citeMarkerRe = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
    let cm: RegExpExecArray | null;
    while ((cm = citeMarkerRe.exec(cleanContent))) {
      const nums = cm[1].split(/[,;]\s*/).flatMap((s: string) => {
        const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
        if (rm) {
          const arr: number[] = [];
          for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
          return arr;
        }
        const n = parseInt(s);
        return isNaN(n) ? [] : [n];
      });
      for (const n of nums) {
        if (n > maxRefN) orphanCitations.add(n);
      }
    }

    // References in the list that were never cited inline. We compute this by
    // scanning all [n] markers in the body and checking which indices 1..N
    // never appear. (citedRefKeys above tracks paragraph-linked refs, but for
    // the final exported article the body may have been globally renumbered,
    // so we re-derive from the body text.)
    const citedIndices = new Set<number>();
    const citeMarkerRe2 = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
    let cm2: RegExpExecArray | null;
    while ((cm2 = citeMarkerRe2.exec(cleanContent))) {
      const nums = cm2[1].split(/[,;]\s*/).flatMap((s: string) => {
        const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
        if (rm) {
          const arr: number[] = [];
          for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
          return arr;
        }
        const n = parseInt(s);
        return isNaN(n) ? [] : [n];
      });
      for (const n of nums) {
        if (n >= 1 && n <= maxRefN) citedIndices.add(n);
      }
    }
    const uncitedRefIndices: number[] = [];
    for (let i = 1; i <= maxRefN; i++) {
      if (!citedIndices.has(i)) uncitedRefIndices.push(i);
    }

    // Build the Data Source Inventory appendix text. Each source is listed
    // with its index, source DB, external ID, title, and a [CITED] / [gathered]
    // marker so the user can see at a glance which sources made it into the
    // article body and which were gathered-but-unused.
    //
    // v112-1: DataSource "cited" detection — for RCSB/PDB entries, the externalId
    // stored on the DataSource row is the PDB ID (e.g. "4OO8"), but the Reference
    // row created from the same gather stores `type=pubmed` + `externalId=PMID`
    // (because v2 fix #DB1 in citation-binding pipeline unified RCSB-with-
    // publication references to use their PMID as the canonical externalId).
    // So a plain "rcsb:4OO8" vs "pubmed:24529477" comparison never matches.
    // We therefore also consult DataSource.extra (JSON) for the linked PMID
    // (extra.pmid / extra.pubmedId) and check `pubmed:PMID` against citedRefKeys.
    // This fixes the long-standing "6 cited inline" under-count on RCSB-heavy
    // projects where the actual cited reference count is much higher.
    //
    // v112-2: If bodyRefPmids is populated (article-export case), we restrict
    // "cited" to only DataSources whose PMID appears in the article body's
    // "## References" section. This excludes paragraph-level references that
    // were auto-removed from the body during adversarial review (e.g. Basit
    // 2026, Zhang 2015 in the v2 CRISPR-Cas9 article). The result is a count
    // that matches the user's mental model of "cited inline" — i.e. only refs
    // that actually appear in the article body the reader sees.
    const isDataSourceCited = (ds: any): boolean => {
      const extId = ds.externalId || ds.title;
      // For RCSB/PDB DataSources, the canonical match key is the PMID in extra
      // JSON (extra.pmid / extra.pubmedId). The DataSource.externalId is the
      // PDB ID, which doesn't match the Reference's PMID-based externalId.
      if (ds.source === "rcsb" || ds.source === "pdb") {
        let extra: any = null;
        try {
          extra = typeof ds.extra === "string" ? JSON.parse(ds.extra) : ds.extra;
        } catch { /* ignore malformed extra */ }
        const pmid = extra?.pmid || extra?.pubmedId;
        if (pmid) {
          // v112-2: if body-derived PMID set is available, it's authoritative
          if (bodyRefPmids.size > 0) return bodyRefPmids.has(pmid);
          // otherwise fall back to paragraph-level citedRefKeys
          if (citedRefKeys.has(`pubmed:${pmid}`)) return true;
        }
        return false;
      }
      // For non-RCSB DataSources (pubmed, web, uniprot, ncbi, etc.), the
      // externalId IS the PMID (or equivalent). Check both the body-derived
      // set (authoritative) and the paragraph-level citedRefKeys (fallback).
      if (bodyRefPmids.size > 0 && ds.source === "pubmed") {
        return bodyRefPmids.has(extId);
      }
      const directKey = `${ds.source}:${extId}`;
      const altKey = `pubmed:${extId}`;
      return citedRefKeys.has(directKey) || citedRefKeys.has(altKey);
    };
    let dataSourceAppendix = "";
    if (dataSources.length > 0) {
      const citedCount = dataSources.filter((ds) => isDataSourceCited(ds)).length;
      // v112-2: For article exports, bodyRefPmids contains the PMIDs actually
      // present in the article's "## References" section. The cited count above
      // may exceed the ## References list size because some references have
      // multiple gathered DataSources (e.g., one PubMed record + several PDB
      // structures for the same publication). Both count as "cited" because
      // they all contributed to the same reference entry.
      const bodyRefNote = bodyRefPmids.size > 0
        ? ` The article body's "## References" section contains ${bodyRefPmids.size} unique references; ` +
          `the cited count above (${citedCount}) may be higher because a single reference can correspond ` +
          `to multiple gathered DataSources (e.g. one PubMed record + several PDB structures for the same publication).`
        : "";
      const lines: string[] = [
        "",
        "## Appendix: Data Source Inventory",
        "",
        `This appendix lists all ${dataSources.length} data sources gathered during the research phase. ` +
          `Of these, ${citedCount} were cited inline in the article body above; the remaining ` +
          `${dataSources.length - citedCount} were gathered for context (structural/sequence data, ` +
          `supplementary metadata) but did not carry a publication that could be cited as a reference. ` +
          `This is expected behavior: UniProt, NCBI, and BLAST records provide protein/domain/sequence ` +
          `context that informs the writing but are not themselves bibliographic citations.` + bodyRefNote,
        "",
        "| # | Source | External ID | Title | Status |",
        "|---|--------|-------------|-------|--------|",
      ];
      // v101-3: For large data source lists (>100), cap the table at 100 rows
      // to prevent markdown rendering issues and keep the appendix readable.
      // Show a summary line for the remaining entries.
      const maxTableRows = 100;
      const showAll = dataSources.length <= maxTableRows;
      const displaySources = showAll ? dataSources : dataSources.slice(0, maxTableRows);
      displaySources.forEach((ds, i) => {
        const isCited = isDataSourceCited(ds);
        const status = isCited ? "cited" : "gathered";
        const extId = (ds.externalId || "—").replace(/\|/g, "/");
        // v111-3: Sanitize title — remove newlines and pipes that break markdown tables
        const rawTitle = (ds.title || "") ;
        const title = rawTitle.replace(/\|/g, "/").replace(/\n/g, " ").replace(/\r/g, "").slice(0, 80);
        lines.push(`| ${i + 1} | ${ds.source} | ${extId} | ${title} | ${status} |`);
      });
      // v101-3: Add summary line for truncated entries
      if (!showAll) {
        const remaining = dataSources.length - maxTableRows;
        lines.push(`| ... | _${remaining} more entries omitted_ | | | |`);
      }
      // Ensure proper newline separation — join with explicit newlines
      dataSourceAppendix = lines.join("\n") + "\n";
    }

    // Build the Citation Validation report. This is a short diagnostic section
    // appended after the Data Source Inventory. It only appears when there are
    // actual issues to report (placeholder citations, orphan [n], uncited refs).
    const validationIssues: string[] = [];
    if (dollarRefCount > 0) {
      validationIssues.push(
        `- **${dollarRefCount} placeholder citation(s)** [\$REF] found in the body. ` +
          `These mark spots where the LLM could not find a suitable reference in the curated list. ` +
          `Review the surrounding text and either insert a manual citation or remove the claim.`,
      );
    }
    if (orphanCitations.size > 0) {
      validationIssues.push(
        `- **${orphanCitations.size} orphan citation(s)**: [${[...orphanCitations].join("], [")}] ` +
          `point beyond the reference list range (1–${maxRefN}). These were likely not renumbered ` +
          `correctly during global citation renumbering.`,
      );
    }
    if (uncitedRefIndices.length > 0 && uncitedRefIndices.length <= 20) {
      validationIssues.push(
        `- **${uncitedRefIndices.length} reference(s) in the list were never cited inline**: ` +
          `[${uncitedRefIndices.join("], [")}]. Consider citing them or removing them from the list.`,
      );
    } else if (uncitedRefIndices.length > 20) {
      validationIssues.push(
        `- **${uncitedRefIndices.length} references in the list were never cited inline** ` +
          `(too many to list individually). This is common in large reviews where the LLM ` +
          `gathers many sources but only cites the most relevant subset.`,
      );
    }
    let validationAppendix = "";
    if (validationIssues.length > 0) {
      validationAppendix =
        "\n\n## Appendix: Citation Validation Report\n\n" +
        "The following citation issues were detected during export. " +
        "They do not prevent the document from opening, but indicate spots " +
        "that may need manual review.\n\n" +
        validationIssues.join("\n");
    }

    // If mergeExport, append user data as appendix
    const appendixContent = allUserData.length
      ? "\n\n## Appendix: User Data\n\n" +
        allUserData
          .map((u, i) => {
            const parts = [`### ${u.title} (${u.type})`];
            if (u.description) parts.push(u.description);
            if (u.type === "table" && u.data) {
              try {
                const td = JSON.parse(u.data);
                if (td.headers && td.rows) {
                  parts.push(`| ${td.headers.join(" | ")} |`);
                  parts.push(`| ${td.headers.map(() => "---").join(" | ")} |`);
                  for (const row of td.rows.slice(0, 20)) {
                    parts.push(`| ${row.join(" | ")} |`);
                  }
                }
              } catch {}
            }
            return parts.join("\n");
          })
          .join("\n\n")
      : "";

    // Combine the main body with the appendices (data source inventory +
    // citation validation + optional user data). These appendices are
    // appended AFTER the reference list so they don't interfere with
    // the article's main body or citation renumbering.
    const fullAppendix =
      (dataSourceAppendix ? dataSourceAppendix : "") +
      (validationAppendix ? validationAppendix : "") +
      (appendixContent ? appendixContent : "");

    // Build a language-suffixed filename when exporting a specific language variant
    const langSuffix = language === "zh" ? "-zh" : language === "both" ? "-bilingual" : "";
    const filenameTitle = exportTitle;

    // Export validation: check each reference for missing fields (authors,
    // year, journal). Collect warnings to return as a response header so the
    // frontend can show a toast to the user.
    const exportWarnings: string[] = [];
    references.forEach((r, i) => {
      const missing: string[] = [];
      if (!r.authors) missing.push("authors");
      if (!r.year) missing.push("year");
      if (!r.journal) missing.push("journal");
      if (missing.length > 0) {
        exportWarnings.push(`[${i + 1}] ${(r.title || "").slice(0, 40)}: missing ${missing.join(", ")}`);
      }
    });
    const warningHeader = exportWarnings.length > 0
      ? encodeURIComponent(exportWarnings.slice(0, 5).join("; "))
      : "";

    if (body.format === "markdown") {
      const fullContent = cleanContent + (fullAppendix ? "\n\n" + fullAppendix.trim() : "");
      const md = buildMarkdown(exportTitle, abstract, fullContent, refLines, body.includeAnnotations ? annotations : undefined);
      return new NextResponse(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${buildFilename(filenameTitle, "md", langSuffix)}"`,
          ...(warningHeader ? { "X-Export-Warnings": warningHeader } : {}),
        },
      });
    }

    if (body.format === "docx") {
      const buffer = await buildDocx(
        exportTitle,
        abstract,
        cleanContent + (fullAppendix ? "\n\n" + fullAppendix.trim() : ""),
        refLines,
        body.includeAnnotations ? annotations : undefined,
        journalTemplate,
      );
      return new NextResponse(buffer, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${buildFilename(filenameTitle, "docx", langSuffix)}"`,
          ...(warningHeader ? { "X-Export-Warnings": warningHeader } : {}),
        },
      });
    }

    if (body.format === "pdf") {
      const buffer = await buildPdf(
        exportTitle,
        abstract,
        cleanContent + (fullAppendix ? "\n\n" + fullAppendix.trim() : ""),
        refLines,
        body.includeAnnotations ? annotations : undefined
      );
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${buildFilename(filenameTitle, "pdf", langSuffix)}"`,
          ...(warningHeader ? { "X-Export-Warnings": warningHeader } : {}),
        },
      });
    }

    if (body.format === "latex") {
      const latex = buildLatex(
        exportTitle,
        abstract,
        cleanContent,
        refLines,
        journalTemplate || "generic"
      );
      return new NextResponse(latex, {
        headers: {
          "Content-Type": "application/x-tex; charset=utf-8",
          "Content-Disposition": `attachment; filename="${buildFilename(filenameTitle, "tex", langSuffix)}"`,
        },
      });
    }

    if (body.format === "epub") {
      const buffer = await buildEpub(
        exportTitle,
        abstract,
        cleanContent + (fullAppendix ? "\n\n" + fullAppendix.trim() : ""),
        refLines,
        dataSources,
        body.includeAnnotations ? annotations : undefined,
      );
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Disposition": `attachment; filename="${buildFilename(filenameTitle, "epub", langSuffix)}"`,
        },
      });
    }

    if (body.format === "graph-report") {
      const html = buildGraphReport(
        exportTitle,
        abstract,
        cleanContent,
        references,
        dataSources,
        annotations,
      );
      return new NextResponse(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${buildFilename(filenameTitle, "html", "-graph")}"`,
        },
      });
    }

    return NextResponse.json({ error: "Unknown format." }, { status: 400 });
  } catch (err: any) {
    console.error("[/api/export] error:", err);
    return NextResponse.json(
      { error: err?.message || "Export failed." },
      { status: 500 }
    );
  }
}

/**
 * Strip AI-generated reference/citation sections from article content.
 *
 * We build our own canonical reference list during export, so any "## References",
 * "## 参考文献", "### Citations", or bare "REFERENCES:" blocks that the LLM
 * appended to the body must be removed.
 *
 * When language === "both", exportContent is the concatenation of the English
 * article + "\n\n---\n\n" + the Chinese article. Each half may independently
 * end with its own reference block. We split on the "---" separator and clean
 * each half separately, then re-join — this prevents the English "## References"
 * position from causing us to truncate away the entire Chinese half.
 *
 * For "en" or "zh" mode, there is no separator, so we just clean the whole string.
 */
function stripReferencesFromContent(content: string, language: "en" | "zh" | "both"): string {
  // When language === "both", the content was assembled as:
  //   `# ${enTitle}\n\n${enContent}\n\n---\n\n# ${zhTitle}\n\n${zhContent}`
  // We split on the "\n\n---\n\n" separator to process each half independently.
  if (language === "both") {
    const separator = "\n\n---\n\n";
    const sepIdx = content.indexOf(separator);
    if (sepIdx >= 0) {
      const enHalf = content.slice(0, sepIdx);
      const zhHalf = content.slice(sepIdx + separator.length);
      return stripRefsSingle(enHalf) + separator + stripRefsSingle(zhHalf);
    }
    // Fallback: no separator found (shouldn't happen in both mode) — clean whole
    return stripRefsSingle(content);
  }
  return stripRefsSingle(content);
}

/**
 * Strip reference/citation blocks from a single-language content string.
 * Removes everything from the FIRST reference-like header to the end of the
 * string, plus any "### Citations" block. Returns the cleaned body text.
 */
function stripRefsSingle(content: string): string {
  // Headers we recognize as the start of a reference section (case-insensitive,
  // leading markdown headers optional). Covers English + Chinese variants.
  const refHeaderRe =
    /^#{0,6}\s*\*{0,2}(References|REFERENCES|Citations|Bibliography|文献|参考文献|引用文献|参考资料)\*{0,2}\s*:?\s*$/m;
  const citeHeaderRe = /^#{0,6}\s*Citations\s*$/m;
  // Bare "REFERENCES:" line (no markdown header)
  const bareRefRe = /^\s*(REFERENCES|References)\s*:?\s*$/m;

  let cleanEnd = content.length;
  const refMatch = content.match(refHeaderRe);
  if (refMatch && refMatch.index !== undefined) {
    cleanEnd = Math.min(cleanEnd, refMatch.index);
  }
  const citeMatch = content.match(citeHeaderRe);
  if (citeMatch && citeMatch.index !== undefined) {
    cleanEnd = Math.min(cleanEnd, citeMatch.index);
  }
  const bareMatch = content.match(bareRefRe);
  if (bareMatch && bareMatch.index !== undefined) {
    cleanEnd = Math.min(cleanEnd, bareMatch.index);
  }
  return content.slice(0, cleanEnd).trim();
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document"
  );
}

/** Build filename: title-slug + timestamp + (optional lang suffix) + extension */
function buildFilename(title: string, ext: string, langSuffix = ""): string {
  const titleSlug = slug(title).slice(0, 40);
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `${titleSlug}_${ts}${langSuffix}.${ext}`;
}

function buildMarkdown(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  annotations?: Annotation[]
): string {
  const parts: string[] = [`# ${title}`, ""];
  if (abstract) {
    parts.push(`> ${abstract}`, "");
  }
  parts.push(content, "");
  if (annotations && annotations.length) {
    parts.push("---", "", "## Annotations", "");
    annotations.forEach((a, i) => {
      parts.push(
        `**[${i + 1}] ${a.type} (${a.severity})**${
          a.resolved ? " ✓ resolved" : ""
        }${a.selectedText ? `  \n> "${a.selectedText}"` : ""}`,
        "",
        a.comment,
        ""
      );
    });
  }
  if (refLines.length) {
    parts.push("---", "", "## References", "");
    parts.push(...refLines);
  }
  return parts.join("\n");
}

/**
 * Convert article markdown content to a LaTeX document.
 *
 * Supports:
 *  - ## headings → \section{...}
 *  - ### headings → \subsection{...}
 *  - **bold** → \textbf{...}
 *  - *italic* → \textit{...}
 *  - [n] citations → \cite{refN}
 *  - Inline `code` → \texttt{...}
 *  - Paragraph breaks → blank line
 *
 * Journal templates apply different document classes:
 *  - nature: \documentclass{nature}
 *  - cell: \documentclass{cell}
 *  - science: \documentclass{science}
 *  - generic (default): \documentclass[12pt]{article}
 *
 * References are emitted as a thebibliography environment with \bibitem entries.
 */
function buildLatex(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  journalTemplate: string,
): string {
  // Escape LaTeX special characters in text (but not in our generated commands)
  const escapeLatex = (s: string): string =>
    s
      .replace(/\\/g, "\\textbackslash{}")
      .replace(/&/g, "\\&")
      .replace(/%/g, "\\%")
      .replace(/\$/g, "\\$")
      .replace(/#/g, "\\#")
      .replace(/_/g, "\\_")
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/~/g, "\\textasciitilde{}")
      .replace(/\^/g, "\\textasciicircum{}");

  // Convert markdown inline formatting to LaTeX
  const convertInline = (text: string): string => {
    let result = text;
    // [n] citations → \cite{refN}
    result = result.replace(/\[(\d{1,3}(?:[,]\s?\d{1,3})*)\]/g, (_, nums) => {
      const keys = nums.split(/[,]\s*/).map((n: string) => `ref${n.trim()}`).join(", ");
      return `\\cite{${keys}}`;
    });
    // **bold** → \textbf{...}
    result = result.replace(/\*\*([^*]+)\*\*/g, (_, inner) => `\\textbf{${escapeLatex(inner)}}`);
    // *italic* → \textit{...}
    result = result.replace(/\*([^*]+)\*/g, (_, inner) => `\\textit{${escapeLatex(inner)}}`);
    // `code` → \texttt{...}
    result = result.replace(/`([^`]+)`/g, (_, inner) => `\\texttt{${escapeLatex(inner)}}`);
    // Escape remaining special chars (but not our \commands)
    // We need to be careful: only escape &, %, $, #, _, ~, ^ in plain text
    // that's NOT already part of a \command{...}. Simple approach: escape
    // the whole string first, then un-escape our commands.
    result = result
      .replace(/&/g, "\\&")
      .replace(/%/g, "\\%")
      .replace(/#/g, "\\#")
      .replace(/_/g, "\\_");
    return result;
  };

  // Convert markdown block-level to LaTeX
  const lines = content.split("\n");
  const bodyParts: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      inParagraph = false;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      if (inParagraph) bodyParts.push("");
      bodyParts.push(`\\subsection{${escapeLatex(trimmed.replace(/^###\s+/, ""))}}`);
      inParagraph = false;
    } else if (trimmed.startsWith("## ")) {
      if (inParagraph) bodyParts.push("");
      bodyParts.push(`\\section{${escapeLatex(trimmed.replace(/^##\s+/, ""))}}`);
      inParagraph = false;
    } else if (trimmed.startsWith("# ")) {
      if (inParagraph) bodyParts.push("");
      bodyParts.push(`\\section*{${escapeLatex(trimmed.replace(/^#\s+/, ""))}}`);
      inParagraph = false;
    } else {
      bodyParts.push(convertInline(trimmed));
      inParagraph = true;
    }
  }

  // Determine document class and packages based on journal template
  const isNature = journalTemplate === "nature";
  const isCell = journalTemplate === "cell";
  const isScience = journalTemplate === "science";
  const docClass =
    isNature ? "nature" :
    isCell ? "cell" :
    isScience ? "science" :
    "[12pt]{article}";

  // Journal-specific preamble packages
  const preamblePackages: string[] = [];
  if (!isNature && !isCell && !isScience) {
    // Generic article: add common packages
    preamblePackages.push("\\usepackage[utf8]{inputenc}");
    preamblePackages.push("\\usepackage{geometry}");
    preamblePackages.push("\\geometry{margin=1in}");
    preamblePackages.push("\\usepackage{hyperref}");
    preamblePackages.push("\\usepackage{booktabs}");
    preamblePackages.push("\\usepackage{graphicx}");
  }
  if (isNature) {
    preamblePackages.push("% Nature template — uses nature.cls");
    preamblePackages.push("\\usepackage{natbib}");
  }
  if (isCell) {
    preamblePackages.push("% Cell template — uses cell.cls");
    preamblePackages.push("\\usepackage{natbib}");
  }
  if (isScience) {
    preamblePackages.push("% Science template — uses science.cls");
    preamblePackages.push("\\usepackage{natbib}");
  }

  // Build the document
  const parts: string[] = [
    `\\documentclass{${docClass}}`,
    ``,
    `% Generated by SciWrite — AI Research Literature Writing Assistant`,
    `% Date: ${new Date().toISOString()}`,
    `% Template: ${journalTemplate}`,
    ``,
    ...preamblePackages,
    ``,
    `\\title{${escapeLatex(title)}}`,
    `\\author{SciWrite}`,
    `\\date{\\today}`,
    ``,
    `\\begin{document}`,
    `\\maketitle`,
    ``,
  ];

  // Abstract
  if (abstract) {
    parts.push(`\\begin{abstract}`);
    parts.push(escapeLatex(abstract));
    parts.push(`\\end{abstract}`);
    parts.push(``);
  }

  // Body
  parts.push(bodyParts.join("\n\n"));
  parts.push(``);

  // References as thebibliography
  if (refLines.length > 0) {
    parts.push(`\\begin{thebibliography}{${refLines.length}}`);
    refLines.forEach((line, i) => {
      // Extract the reference text (strip [n] prefix)
      const refText = line.replace(/^\[\d+\]\s*/, "");
      parts.push(`\\bibitem{ref${i + 1}}`);
      parts.push(escapeLatex(refText));
    });
    parts.push(`\\end{thebibliography}`);
  }

  parts.push(``);
  parts.push(`\\end{document}`);

  return parts.join("\n");
}

async function buildDocx(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  annotations?: Annotation[],
  journalTemplate?: string,
): Promise<ArrayBuffer> {
  const children: Paragraph[] = [];

  // Journal-specific styling
  const isNature = journalTemplate === "nature";
  const isCell = journalTemplate === "cell";
  const isScience = journalTemplate === "science";
  // Font: Nature/Science use sans-serif, Cell uses serif, generic uses Georgia
  const titleFont = isNature || isScience ? "Arial" : isCell ? "Times New Roman" : "Georgia";
  const bodyFont = isNature || isScience ? "Arial" : isCell ? "Times New Roman" : "Calibri";
  const titleSize = isNature ? 28 : isCell ? 30 : 36; // Nature has smaller titles
  const refSize = isNature ? 18 : 19; // Nature has smaller refs

  // Title — journal-specific font and size
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, size: titleSize, font: titleFont })],
      spacing: { after: 120 },
    })
  );

  // Horizontal rule
  children.push(
    new Paragraph({
      children: [],
      border: { bottom: { style: "single", size: 6, color: "0F766E", space: 1 } },
      spacing: { after: 200 },
    })
  );

  // Abstract
  if (abstract) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Abstract", bold: true, size: 22, font: "Georgia", color: "0F766E" }),
        ],
        spacing: { after: 80 },
      })
    );
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: abstract, italics: true, color: "444444", size: 21 }),
        ],
        spacing: { after: 240, line: 340 },
        indent: { left: 360, right: 360 },
        alignment: AlignmentType.JUSTIFIED,
      })
    );
  }

  // Body: split by markdown headings and paragraphs
  const blocks = content.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("### ")) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [new TextRun({ text: trimmed.replace(/^###\s+/, ""), font: "Georgia", color: "333333" })],
          spacing: { before: 200, after: 80 },
        })
      );
    } else if (trimmed.startsWith("## ")) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: trimmed.replace(/^##\s+/, ""), font: "Georgia", color: "0F766E", bold: true })],
          spacing: { before: 280, after: 100 },
          border: { bottom: { style: "single", size: 2, color: "D1D5DB", space: 4 } },
        })
      );
    } else if (trimmed.startsWith("# ")) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: trimmed.replace(/^#\s+/, ""), font: "Georgia", color: "0F766E", bold: true })],
          spacing: { before: 280, after: 100 },
        })
      );
    } else {
      const runs = parseInlineCitations(trimmed);
      children.push(
        new Paragraph({
          children: runs,
          spacing: { after: 160, line: 340 },
          alignment: AlignmentType.JUSTIFIED,
          indent: { firstLine: 360 },
        })
      );
    }
  }

  // Annotations
  if (annotations && annotations.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "Annotations", font: "Georgia", color: "0F766E", bold: true })],
        spacing: { before: 300, after: 100 },
        border: { bottom: { style: "single", size: 2, color: "D1D5DB", space: 4 } },
      })
    );
    annotations.forEach((a, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[${i + 1}] ${a.type} (${a.severity})${a.resolved ? " — resolved" : ""}`,
              bold: true, size: 21, font: "Calibri",
            }),
          ],
          spacing: { after: 40 },
        })
      );
      if (a.selectedText) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `“${a.selectedText}”`, italics: true, color: "666666", size: 20 })],
            indent: { left: 360 },
            spacing: { after: 40 },
          })
        );
      }
      children.push(
        new Paragraph({
          children: [new TextRun({ text: a.comment, size: 21, font: "Calibri" })],
          indent: { left: 360 },
          spacing: { after: 120 },
        })
      );
    });
  }

  // References
  if (refLines.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "References", font: "Georgia", color: "0F766E", bold: true })],
        spacing: { before: 360, after: 120 },
        border: { bottom: { style: "single", size: 2, color: "D1D5DB", space: 4 } },
      })
    );
    refLines.forEach((line) => {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line, size: 19, font: "Calibri", color: "333333" })],
          spacing: { after: 60, line: 280 },
          indent: { left: 360, hanging: 360 },
        })
      );
    });
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
      },
      children,
    }],
    styles: {
      default: {
        document: { run: { font: bodyFont, size: 22 } },
        heading1: { run: { font: titleFont, size: 28, bold: true, color: "0F766E" } },
        heading2: { run: { font: titleFont, size: 26, bold: true, color: "0F766E" } },
        heading3: { run: { font: titleFont, size: 24, color: "333333" } },
        title: { run: { font: titleFont, size: titleSize, bold: true, color: "1F2937" } },
      },
    },
  });

  return await Packer.toBuffer(doc);
}

function parseInlineCitations(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*|[A-Z]{2,12}:\s?[^\]]{1,60})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      runs.push(new TextRun({ text: text.slice(last, m.index) }));
    }
    runs.push(
      new TextRun({
        text: m[0],
        superScript: true,
        color: "0F766E",
        bold: true,
      })
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last) }));
  }
  return runs.length ? runs : [new TextRun({ text })];
}

/**
 * Sanitize text for WinAnsi/PDF: replace Unicode characters that Helvetica
 * cannot encode (superscripts, special dashes, arrows, etc.)
 */
function sanitizeForPdf(text: string): string {
  return text
    // Superscripts/subscripts
    .replace(/⁺/g, "+")
    .replace(/⁻/g, "-")
    .replace(/⁰/g, "0").replace(/¹/g, "1").replace(/²/g, "2").replace(/³/g, "3")
    .replace(/⁴/g, "4").replace(/⁵/g, "5").replace(/⁶/g, "6").replace(/⁷/g, "7")
    .replace(/⁸/g, "8").replace(/⁹/g, "9")
    .replace(/₀/g, "0").replace(/₁/g, "1").replace(/₂/g, "2").replace(/₃/g, "3")
    .replace(/₄/g, "4").replace(/₅/g, "5").replace(/₆/g, "6").replace(/₇/g, "7")
    .replace(/₈/g, "8").replace(/₉/g, "9")
    // Special dashes
    .replace(/–/g, "-").replace(/—/g, "-").replace(/‐/g, "-")
    // Quotes
    .replace(/"/g, '"').replace(/"/g, '"').replace(/'/g, "'").replace(/'/g, "'")
    // Arrows and symbols
    .replace(/→/g, "->").replace(/←/g, "<-").replace(/↔/g, "<->")
    .replace(/✓/g, "OK").replace(/✗/g, "X")
    .replace(/•/g, "-").replace(/·/g, ".")
    .replace(/°/g, " deg ")
    // Greek letters (common in science)
    .replace(/α/g, "alpha").replace(/β/g, "beta").replace(/γ/g, "gamma").replace(/δ/g, "delta")
    .replace(/ε/g, "epsilon").replace(/ζ/g, "zeta").replace(/η/g, "eta").replace(/θ/g, "theta")
    .replace(/λ/g, "lambda").replace(/μ/g, "mu").replace(/π/g, "pi").replace(/ρ/g, "rho")
    .replace(/σ/g, "sigma").replace(/τ/g, "tau").replace(/φ/g, "phi").replace(/ψ/g, "psi")
    .replace(/ω/g, "omega").replace(/Δ/g, "Delta").replace(/Σ/g, "Sigma").replace(/Ω/g, "Omega")
    // Angstrom
    .replace(/Å/g, "Angstrom")
    // Remove any remaining non-WinAnsi characters
    .replace(/[^\x00-\xFF]/g, "?");
}

async function buildPdf(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  annotations?: Annotation[]
): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  // Register fontkit so we can embed custom TrueType/OpenType fonts (e.g. NotoSansSC for CJK).
  pdfDoc.registerFontkit(fontkit);

  // Detect whether any content contains CJK characters.
  // If so, we use the embedded NotoSansSC font (which supports both CJK and Latin).
  // Otherwise, we use the legacy StandardFonts.Helvetica + sanitizeForPdf path.
  const hasCJK =
    containsCJK(title) ||
    containsCJK(abstract) ||
    containsCJK(content) ||
    refLines.some(containsCJK) ||
    (annotations?.some((a) => containsCJK(a.comment) || containsCJK(a.selectedText || "")) ?? false);

  let font: any;
  let boldFont: any;
  let italicFont: any;
  let useCJK = false;

  if (hasCJK) {
    const cjkBytes = await loadCJKFont();
    if (cjkBytes) {
      // NotoSansSC includes Latin glyphs, so we use it for all three roles.
      // There's no bold/italic variant in this single file, but we use
      // color + size differentiation to convey emphasis.
      font = await pdfDoc.embedFont(cjkBytes, { subset: true });
      boldFont = font; // same font; we use color/size to differentiate
      italicFont = font;
      useCJK = true;
    } else {
      // CJK detected but font not available — fall back to Helvetica with sanitization.
      // CJK characters will be rendered as "?" but the document will still be valid.
      console.warn("[export] CJK content detected but NotoSansSC font not available — CJK chars will be '?'.");
      font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    }
  } else {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  }

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 56;
  const maxWidth = pageWidth - margin * 2;
  let y = pageHeight - margin;

  const drawPage = pdfDoc.addPage([pageWidth, pageHeight]);
  y = pageHeight - margin;

  let currentPage = drawPage;

  /**
   * Word-wrap a single line of text. For Latin text we wrap by word (split on spaces);
   * for CJK text we wrap by character (CJK has no spaces between words).
   * Mixed text (Latin + CJK) is wrapped by character, which works for both.
   */
  const writeLine = (
    text: string,
    opts: { font?: any; size?: number; color?: any; indent?: number } = {}
  ) => {
    // v111-4: Split on newlines first — drawText fails on embedded \n
    // ("WinAnsi cannot encode \n (0x000a)"). Each \n becomes a new line.
    const lines = text.split("\n");
    for (const ln of lines) {
      writeSingleLine(ln, opts);
    }
  };

  const writeSingleLine = (
    text: string,
    opts: { font?: any; size?: number; color?: any; indent?: number } = {}
  ) => {
    // Only sanitize when using the WinAnsi Helvetica font — the CJK font supports Unicode.
    const sanitized = useCJK ? text : sanitizeForPdf(text);
    const f = opts.font || font;
    const size = opts.size || 10;
    const indent = opts.indent || 0;
    const color = opts.color || rgb(0.15, 0.15, 0.15);
    const availableWidth = maxWidth - indent;

    // Split into "wrap units" — for CJK each char is a unit; for Latin each word is a unit.
    // We detect CJK at the string level: if the line contains any CJK, we wrap by char.
    // This produces better results for mixed text (e.g. Chinese with English citations).
    const units = useCJK || containsCJK(sanitized)
      ? Array.from(sanitized) // by character (handles surrogate pairs correctly)
      : sanitized.split(" ");

    let line = "";
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      // For word-wrapped (non-CJK) text, join with spaces. For char-wrapped, no space.
      const sep = (useCJK || containsCJK(sanitized)) ? "" : " ";
      const test = line ? line + sep + u : u;
      if (f.widthOfTextAtSize(test, size) > availableWidth) {
        if (y - size * 1.3 < margin) {
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        try {
          currentPage.drawText(line, { x: margin + indent, y, size, font: f, color });
        } catch (e) {
          // If a glyph is missing from the font, pdf-lib throws. Skip the line silently.
        }
        y -= size * 1.35;
        line = u;
      } else {
        line = test;
      }
    }
    if (line) {
      if (y - size * 1.3 < margin) {
        currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      try {
        currentPage.drawText(line, { x: margin + indent, y, size, font: f, color });
      } catch {}
      y -= size * 1.35;
    }
  };

  const writeWrapped = (text: string, opts: any = {}) => {
    writeLine(text, opts);
  };

  // Title — large, bold, themed color
  const titleSize = 16;
  const titleText = useCJK ? title : sanitizeForPdf(title);
  // Wrap title by character when CJK (Chinese titles have no spaces)
  if (useCJK || containsCJK(title)) {
    const chars = Array.from(titleText);
    let line = "";
    for (const ch of chars) {
      const test = line + ch;
      if (boldFont.widthOfTextAtSize(test, titleSize) > maxWidth) {
        try {
          currentPage.drawText(line, {
            x: margin,
            y,
            size: titleSize,
            font: boldFont,
            color: rgb(0.1, 0.35, 0.3),
          });
        } catch {}
        y -= titleSize * 1.3;
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) {
      try {
        currentPage.drawText(line, {
          x: margin,
          y,
          size: titleSize,
          font: boldFont,
          color: rgb(0.1, 0.35, 0.3),
        });
      } catch {}
      y -= titleSize * 1.5;
    }
  } else {
    // Latin title — wrap by word (original behavior)
    const titleWords = titleText.split(" ");
    let titleLine = "";
    for (const w of titleWords) {
      const test = titleLine ? titleLine + " " + w : w;
      if (boldFont.widthOfTextAtSize(test, titleSize) > maxWidth) {
        currentPage.drawText(titleLine, {
          x: margin,
          y,
          size: titleSize,
          font: boldFont,
          color: rgb(0.1, 0.35, 0.3),
        });
        y -= titleSize * 1.3;
        titleLine = w;
      } else {
        titleLine = test;
      }
    }
    if (titleLine) {
      currentPage.drawText(titleLine, {
        x: margin,
        y,
        size: titleSize,
        font: boldFont,
        color: rgb(0.1, 0.35, 0.3),
      });
      y -= titleSize * 1.5;
    }
  }

  if (abstract) {
    writeWrapped(abstract, { font: italicFont, size: 10, color: rgb(0.4, 0.4, 0.4) });
    y -= 6;
  }

  // Track section bookmarks — each `## ` header becomes a PDF outline entry.
  // We capture the current page ref + y position so the bookmark jumps to
  // the start of that section.
  const sectionBookmarks: { title: string; pageRef: any; y: number }[] = [];

  // Body
  const blocks = content.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("## ")) {
      // Record bookmark BEFORE writing the header (so it points to the
      // top of the section, not after the heading text)
      sectionBookmarks.push({
        title: trimmed.replace(/^##\s+/, "").slice(0, 100),
        pageRef: currentPage.ref,
        y: y,
      });
      y -= 4;
      writeWrapped(trimmed.replace(/^##\s+/, ""), {
        font: boldFont,
        size: 12,
        color: rgb(0.12, 0.3, 0.27),
      });
      y -= 4;
    } else if (trimmed.startsWith("# ")) {
      // Top-level (# ) headers also get bookmarks (rare in our content)
      sectionBookmarks.push({
        title: trimmed.replace(/^#\s+/, "").slice(0, 100),
        pageRef: currentPage.ref,
        y: y,
      });
      y -= 4;
      writeWrapped(trimmed.replace(/^#\s+/, ""), {
        font: boldFont,
        size: 13,
        color: rgb(0.1, 0.35, 0.3),
      });
      y -= 4;
    } else {
      // strip inline citation brackets for PDF (plain text rendering)
      const plain = trimmed.replace(/\[([^\]]+)\]/g, "[$1]");
      writeWrapped(plain, { size: 10 });
      y -= 4;
    }
  }

  // Annotations
  if (annotations && annotations.length) {
    // Bookmark for Annotations section
    sectionBookmarks.push({
      title: "Annotations",
      pageRef: currentPage.ref,
      y: y,
    });
    y -= 8;
    writeWrapped("Annotations", {
      font: boldFont,
      size: 12,
      color: rgb(0.12, 0.3, 0.27),
    });
    y -= 4;
    annotations.forEach((a, i) => {
      writeWrapped(
        `[${i + 1}] ${a.type} (${a.severity})${a.resolved ? " — resolved" : ""}`,
        { font: boldFont, size: 9 }
      );
      if (a.selectedText) {
        writeWrapped(`"${a.selectedText}"`, { font: italicFont, size: 9, indent: 12 });
      }
      writeWrapped(a.comment, { size: 9, indent: 12 });
      y -= 2;
    });
  }

  // References — header language depends on content language
  if (refLines.length) {
    // Bookmark for References section
    const refsHeader = useCJK ? "参考文献 (References)" : "References";
    sectionBookmarks.push({
      title: refsHeader,
      pageRef: currentPage.ref,
      y: y,
    });
    y -= 8;
    writeWrapped(refsHeader, {
      font: boldFont,
      size: 12,
      color: rgb(0.12, 0.3, 0.27),
    });
    y -= 4;
    refLines.forEach((line) => {
      writeWrapped(line, { size: 8, indent: 0 });
      y -= 1;
    });
  }

  // Add page numbers to every page (footer) — useful for cross-referencing
  // when reading long PDFs. Renders "page / total" at the bottom center.
  // Uses the same font as the body (CJK font when content is Chinese, so
  // Chinese characters in the page number — if any — render correctly;
  // Helvetica otherwise to keep file size small).
  const pages = pdfDoc.getPages();
  const total = pages.length;
  // Reuse the already-embedded body font (no extra font bytes added)
  const pageNumFont = useCJK ? boldFont : await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (let idx = 0; idx < pages.length; idx++) {
    const page = pages[idx];
    const pageText = `${idx + 1} / ${total}`;
    try {
      const textWidth = pageNumFont.widthOfTextAtSize(pageText, 8);
      const pageWidth = page.getWidth();
      page.drawText(pageText, {
        x: (pageWidth - textWidth) / 2,
        y: 24,
        size: 8,
        font: pageNumFont,
        color: rgb(0.4, 0.4, 0.4),
      });
    } catch {}
  }

  // Build PDF outline (bookmarks) — each section becomes a navigable entry
  // in the PDF reader's sidebar. Uses raw catalog manipulation since
  // pdf-lib v1.17.1 doesn't expose a public outline API.
  if (sectionBookmarks.length > 0) {
    try {
      const ctx = pdfDoc.context;
      // Create one outline item per section
      const itemRefs: any[] = sectionBookmarks.map((bm) => {
        // Destination: [pageRef, /XYZ, x, y, zoom=0]
        // Using /XYZ keeps the user's zoom and scrolls to (x, y).
        const destArray = ctx.obj([
          bm.pageRef,
          PDFName.of("XYZ"),
          PDFNumber.of(56), // left margin
          PDFNumber.of(Math.max(bm.y, 56)), // top position (clamp to margin)
          PDFNumber.of(0), // zoom = 0 means "keep current zoom"
        ]);
        const itemDict = ctx.obj({
          Title: PDFString.of(bm.title),
          Dest: destArray,
        });
        return ctx.register(itemDict);
      });

      // Link siblings: each item gets Prev/Next pointers
      itemRefs.forEach((ref, i) => {
        const dict = ctx.lookup(ref);
        if (i > 0) dict.set(PDFName.of("Prev"), itemRefs[i - 1]);
        if (i < itemRefs.length - 1) dict.set(PDFName.of("Next"), itemRefs[i + 1]);
        // Parent will be set to the outlines root below
      });

      // Create the outlines root dict
      const outlinesDict = ctx.obj({
        Type: PDFName.of("Outlines"),
        First: itemRefs[0],
        Last: itemRefs[itemRefs.length - 1],
        Count: PDFNumber.of(itemRefs.length),
      });
      const outlinesRef = ctx.register(outlinesDict);

      // Set Parent on each item to the outlines root
      itemRefs.forEach((ref) => {
        const dict = ctx.lookup(ref);
        dict.set(PDFName.of("Parent"), outlinesRef);
      });

      // Attach outlines to the PDF catalog
      pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);

      // Also set PageMode to /UseOutlines so readers open the bookmarks
      // sidebar automatically when the PDF is opened.
      pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
    } catch (err: any) {
      // Bookmark creation is best-effort — if it fails, the PDF is still valid,
      // just without bookmarks. Log and continue.
      console.warn("[export] Failed to create PDF bookmarks:", err?.message || err);
    }
  }

  // Save without object streams for maximum PDF reader compatibility.
  // Object streams compress multiple small objects into a single stream,
  // which is more efficient but can confuse some older PDF readers (and
  // our own debug tooling). For an article export, raw object layout is
  // preferable — bookmarks work reliably in every PDF reader.
  return await pdfDoc.save({ useObjectStreams: false });
}

// ═══════════════════════════════════════════════════════════════════════════
// EPUB EXPORT
// ═══════════════════════════════════════════════════════════════════════════
// Builds a valid EPUB 3 archive using JSZip:
//   mimetype            (uncompressed, first entry — required by spec)
//   META-INF/container.xml
//   OEBPS/content.opf   (package manifest + spine)
//   OEBPS/nav.xhtml     (EPUB3 navigation document)
//   OEBPS/toc.ncx       (EPUB2 fallback table of contents)
//   OEBPS/style.css     (reader-friendly stylesheet)
//   OEBPS/chapter.xhtml (the article body as XHTML)
//
// Markdown → XHTML conversion covers: headings (#..######), paragraphs,
// bold (**..**), italic (*..* / _.._), inline code (`..`), links [t](u),
// unordered/ordered lists, blockquotes, and horizontal rules.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert a subset of Markdown to XHTML body content. */
function markdownToXhtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let inQuote = false;

  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
    if (inQuote) { out.push("</blockquote>"); inQuote = false; }
  };

  const inline = (s: string): string => {
    let r = escapeHtml(s);
    // inline code first to protect its content
    r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
    // bold
    r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // italic
    r = r.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    r = r.replace(/_([^_]+)_/g, "<em>$1</em>");
    // links [text](url)
    r = r.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2">$1</a>'
    );
    // citation markers [n] → styled span
    r = r.replace(
      /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g,
      '<span class="cite">[$1]</span>'
    );
    return r;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeLists(); continue; }

    // Headings
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      closeLists();
      const level = hm[1].length;
      out.push(`<h${level}>${inline(hm[2])}</h${level}>`);
      continue;
    }
    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeLists();
      out.push("<hr/>");
      continue;
    }
    // Blockquote
    if (line.startsWith("&gt; ") || line.startsWith("> ")) {
      if (!inQuote) { closeLists(); out.push("<blockquote>"); inQuote = true; }
      out.push(`<p>${inline(line.replace(/^[&gt;>]+\s*/, ""))}</p>`);
      continue;
    }
    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }
    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(line.replace(/^[-*+]\s+/, ""))}</li>`);
      continue;
    }
    // Paragraph
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();
  return out.join("\n");
}

async function buildEpub(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  dataSources: any[],
  annotations?: Annotation[]
): Promise<Buffer> {
  const zip = new JSZip();
  const bookId = "urn:uuid:" + (title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "sciwrite") + Date.now().toString(36);
  const titleEsc = escapeHtml(title);

  // 1. mimetype — must be the first entry, uncompressed (STORE, no compression)
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  // 2. META-INF/container.xml
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // 3. Build chapter XHTML body
  const abstractHtml = abstract
    ? `<section class="abstract"><h2>Abstract</h2>${markdownToXhtml(abstract)}</section>`
    : "";
  const bodyHtml = markdownToXhtml(content);
  const refsHtml = refLines.length
    ? `<section class="references"><h2>References</h2><ol>${refLines
        .map((r) => `<li>${escapeHtml(r)}</li>`)
        .join("\n")}</ol></section>`
    : "";
  const dsHtml = dataSources.length
    ? `<section class="datasources"><h2>Data Sources (${dataSources.length})</h2><ul>${dataSources
        .slice(0, 100)
        .map(
          (d) =>
            `<li><span class="ds-type">${escapeHtml(d.source || "web")}</span>: ${escapeHtml(
              d.title || d.externalId || d.url || ""
            )}</li>`
        )
        .join("\n")}</ul></section>`
    : "";
  const annHtml =
    annotations && annotations.length
      ? `<section class="annotations"><h2>Annotations (${annotations.length})</h2><ul>${annotations
          .slice(0, 50)
          .map(
            (a) =>
              `<li><strong>${escapeHtml(a.type)}</strong>: ${escapeHtml(a.comment || "")}</li>`
          )
          .join("\n")}</ul></section>`
      : "";

  const chapterXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${titleEsc}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1 class="title">${titleEsc}</h1>
  ${abstractHtml}
  <section class="body">
    ${bodyHtml}
  </section>
  ${refsHtml}
  ${dsHtml}
  ${annHtml}
</body>
</html>`;

  zip.file("OEBPS/chapter.xhtml", chapterXhtml);

  // 4. stylesheet
  zip.file(
    "OEBPS/style.css",
    `body{font-family:Georgia,"Times New Roman",serif;line-height:1.7;margin:5% 8%;color:#1a1a1a;}
h1.title{font-size:1.8em;border-bottom:3px solid #6366f1;padding-bottom:.3em;margin-bottom:1em;}
h2{font-size:1.3em;color:#4338ca;border-bottom:1px solid #e5e7eb;padding-bottom:.2em;margin-top:1.5em;}
h3{font-size:1.1em;color:#6b7280;}
p{margin:.6em 0;text-align:justify;}
.abstract{background:#f5f3ff;padding:1em 1.2em;border-left:4px solid #8b5cf6;border-radius:4px;margin-bottom:1.5em;}
.references ol{font-size:.9em;color:#374151;}
.references li{margin:.3em 0;}
.datasources ul{font-size:.85em;}
.ds-type{display:inline-block;background:#ede9fe;color:#6d28d9;padding:0 .4em;border-radius:3px;font-size:.8em;font-weight:600;margin-right:.4em;}
.cite{color:#7c3aed;font-weight:600;font-size:.85em;vertical-align:super;}
.annotations ul{font-size:.85em;}
blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:1em;color:#6b7280;}
code{background:#f3f4f6;padding:0 .3em;border-radius:3px;font-size:.9em;font-family:monospace;}
hr{border:none;border-top:1px solid #e5e7eb;margin:1.5em 0;}`
  );

  // 5. content.opf — package manifest + spine
  const manifestItems = [
    '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
  ].join("\n    ");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${titleEsc}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>SciWrite</dc:creator>
    <dc:description>${escapeHtml(abstract || "Exported research article")}</dc:description>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter"/>
  </spine>
</package>`
  );

  // 6. nav.xhtml — EPUB3 navigation document
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      <li><a href="chapter.xhtml">${titleEsc}</a></li>
    </ol>
  </nav>
</body>
</html>`
  );

  // 7. toc.ncx — EPUB2 fallback TOC
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
  </head>
  <docTitle><text>${titleEsc}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>${titleEsc}</text></navLabel>
      <content src="chapter.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
  );

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return buf as Buffer;
}

// ═══════════════════════════════════════════════════════════════════════════
// CITATION GRAPH REPORT (standalone HTML)
// ═══════════════════════════════════════════════════════════════════════════
// A self-contained, printable HTML report embedding:
//   - Project metadata + word-count statistics
//   - Citation coverage chart (cited vs. uncited refs, by source type)
//   - Data-source inventory grouped by database (PubMed/UniProt/RCSB/NCBI/BLAST/Web)
//   - A force-directed-style SVG graph rendered from theme clusters
//   - Full reference table with per-reference citation counts
//   - Annotation summary

function buildGraphReport(
  title: string,
  abstract: string,
  content: string,
  references: (Reference & { _count?: any })[],
  dataSources: any[],
  annotations: Annotation[]
): string {
  const esc = escapeHtml;
  const now = new Date().toISOString();

  // ── Citation coverage analysis ──────────────────────────────────────────
  const citedIndices = new Set<number>();
  const citeRe = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(content))) {
    const nums = m[1].split(/[,;]\s*/).flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
    for (const n of nums) citedIndices.add(n);
  }
  const totalRefs = references.length;
  const citedRefs = [...citedIndices].filter((n) => n >= 1 && n <= totalRefs).length;
  const uncitedRefs = totalRefs - citedRefs;
  const coverage = totalRefs > 0 ? Math.round((citedRefs / totalRefs) * 100) : 0;

  // ── Data sources by type ────────────────────────────────────────────────
  const dsTypeColors: Record<string, string> = {
    pubmed: "#3b82f6",
    uniprot: "#10b981",
    rcsb: "#f59e0b",
    ncbi: "#ef4444",
    blast: "#8b5cf6",
    web: "#6b7280",
  };

  // ── Word count ──────────────────────────────────────────────────────────
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  // ── Theme clusters for the graph (derive from reference titles) ─────────
  // Group references by their first significant word to form pseudo-themes.
  const themeMap: Record<string, number[]> = {};
  references.forEach((r, i) => {
    const firstWord = (r.title || "")
      .replace(/[^a-zA-Z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !["the", "and", "with", "from", "that", "this", "study"].includes(w.toLowerCase()))
      [0]?.toLowerCase() || "other";
    if (!themeMap[firstWord]) themeMap[firstWord] = [];
    themeMap[firstWord].push(i + 1);
  });
  const themes = Object.entries(themeMap)
    .map(([name, refs]) => ({ name, count: refs.length, refs }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // ── Build the SVG graph (circular cluster layout) ───────────────────────
  const svgSize = 600;
  const cx = svgSize / 2;
  const cy = svgSize / 2;
  const radius = 220;
  const clusterNodes = themes.map((t, i) => {
    const angle = (i / Math.max(themes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return {
      ...t,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      color: `hsl(${(i * 47) % 360}, 65%, 55%)`,
    };
  });
  const svgEdges = clusterNodes
    .map((n, i) => {
      const next = clusterNodes[(i + 1) % clusterNodes.length];
      return `<line x1="${n.x}" y1="${n.y}" x2="${next.x}" y2="${next.y}" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="3,3"/>`;
    })
    .join("");
  const svgNodes = clusterNodes
    .map(
      (n) => `
    <g class="gnode">
      <circle cx="${n.x}" cy="${n.y}" r="${12 + Math.min(n.count * 3, 24)}" fill="${n.color}" fill-opacity="0.7" stroke="${n.color}" stroke-width="2"/>
      <text x="${n.x}" y="${n.y + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="white">${n.count}</text>
      <text x="${n.x}" y="${n.y + 30}" text-anchor="middle" font-size="9" fill="#374151">${esc(n.name.slice(0, 12))}</text>
    </g>`
    )
    .join("");

  // ── Build reference table rows ──────────────────────────────────────────
  const refRows = references
    .slice(0, 200)
    .map((r, i) => {
      const isCited = citedIndices.has(i + 1);
      return `<tr class="${isCited ? "cited" : "uncited"}">
        <td>${i + 1}</td>
        <td><span class="badge ${r.type || "other"}">${esc(r.type || "other")}</span></td>
        <td>${esc((r.authors || "").slice(0, 40))}${(r.authors || "").length > 40 ? "…" : ""}</td>
        <td>${esc((r.title || "").slice(0, 60))}${(r.title || "").length > 60 ? "…" : ""}</td>
        <td>${esc(r.year || "—")}</td>
        <td>${isCited ? '<span class="yes">✓ cited</span>' : '<span class="no">uncited</span>'}</td>
      </tr>`;
    })
    .join("");

  // ── Data source inventory rows ──────────────────────────────────────────
  const dsRows = dataSources
    .slice(0, 100)
    .map((d, i) => {
      const color = dsTypeColors[d.source] || "#6b7280";
      return `<tr>
        <td>${i + 1}</td>
        <td><span class="ds-pill" style="background:${color}">${esc(d.source || "web")}</span></td>
        <td>${esc((d.title || "").slice(0, 70))}</td>
        <td>${esc(d.externalId || "—")}</td>
        <td>${d.url ? `<a href="${esc(d.url)}" target="_blank">link ↗</a>` : "—"}</td>
      </tr>`;
    })
    .join("");

  // ── Coverage bar widths ─────────────────────────────────────────────────
  const citedPct = totalRefs > 0 ? (citedRefs / totalRefs) * 100 : 0;
  const uncitedPct = totalRefs > 0 ? (uncitedRefs / totalRefs) * 100 : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} — Citation Graph Report</title>
<style>
  :root{--primary:#6366f1;--primary-dark:#4338ca;--bg:#fafafa;--card:#fff;--border:#e5e7eb;--text:#1f2937;--muted:#6b7280;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;}
  .container{max-width:1100px;margin:0 auto;padding:2rem 1.5rem;}
  header.report-head{background:linear-gradient(135deg,#4338ca,#7c3aed);color:#fff;padding:2.5rem 2rem;border-radius:12px;margin-bottom:2rem;box-shadow:0 4px 20px rgba(99,102,241,0.2);}
  header.report-head h1{font-size:1.8rem;margin-bottom:.5rem;}
  header.report-head .meta{font-size:.85rem;opacity:.9;display:flex;gap:1.5rem;flex-wrap:wrap;}
  header.report-head .meta span{display:inline-flex;align-items:center;gap:.3rem;}
  .grid-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem;}
  .stat-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.2rem;text-align:center;}
  .stat-card .num{font-size:2rem;font-weight:800;color:var(--primary-dark);}
  .stat-card .label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:.3rem;}
  section.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.5rem;margin-bottom:1.5rem;}
  section.card h2{font-size:1.1rem;color:var(--primary-dark);border-bottom:2px solid var(--border);padding-bottom:.5rem;margin-bottom:1rem;}
  .coverage-bar{height:28px;border-radius:6px;overflow:hidden;display:flex;background:#f3f4f6;margin:.8rem 0;}
  .coverage-bar .cited{background:linear-gradient(90deg,#10b981,#059669);transition:width .4s;}
  .coverage-bar .uncited{background:linear-gradient(90deg,#fbbf24,#f59e0b);}
  .coverage-bar span{color:#fff;font-size:.7rem;font-weight:700;display:flex;align-items:center;justify-content:center;}
  .graph-wrap{display:flex;justify-content:center;background:#fafafa;border-radius:8px;padding:1rem;}
  .graph-wrap svg{max-width:100%;height:auto;}
  .legend{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;margin-top:.8rem;}
  .legend span{display:inline-flex;align-items:center;gap:.3rem;font-size:.75rem;color:var(--muted);}
  .legend i{width:10px;height:10px;border-radius:50%;display:inline-block;}
  table{width:100%;border-collapse:collapse;font-size:.82rem;}
  th{text-align:left;padding:.5rem;background:#f9fafb;border-bottom:2px solid var(--border);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);}
  td{padding:.45rem .5rem;border-bottom:1px solid #f3f4f6;}
  tr.uncited{opacity:.55;}
  tr.cited td:first-child{color:#059669;font-weight:700;}
  .badge,.ds-pill{display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.68rem;font-weight:600;color:#fff;text-transform:uppercase;}
  .badge.pubmed,.ds-pill{background:#3b82f6;}
  .badge.uniprot{background:#10b981;}
  .badge.rcsb{background:#f59e0b;}
  .badge.ncbi{background:#ef4444;}
  .badge.journal{background:#8b5cf6;}
  .badge.other{background:#6b7280;}
  .yes{color:#059669;font-weight:600;}
  .no{color:#d97706;font-weight:600;}
  .abstract-box{background:#f5f3ff;border-left:4px solid #8b5cf6;padding:.8rem 1rem;border-radius:0 6px 6px 0;font-size:.9rem;color:#4b5563;}
  footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--border);text-align:center;color:var(--muted);font-size:.75rem;}
  @media print{header.report-head{background:#4338ca!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}section.card{break-inside:avoid;}}
</style>
</head>
<body>
<div class="container">
  <header class="report-head">
    <h1>${esc(title)}</h1>
    <div class="meta">
      <span>📊 Citation Graph Report</span>
      <span>📅 ${esc(new Date().toLocaleString())}</span>
      <span>📝 ${wordCount} words</span>
      <span>📚 ${totalRefs} references</span>
    </div>
  </header>

  ${abstract ? `<section class="card"><h2>Abstract</h2><div class="abstract-box">${esc(abstract)}</div></section>` : ""}

  <div class="grid-stats">
    <div class="stat-card"><div class="num">${totalRefs}</div><div class="label">Total References</div></div>
    <div class="stat-card"><div class="num">${citedRefs}</div><div class="label">Cited Inline</div></div>
    <div class="stat-card"><div class="num">${uncitedRefs}</div><div class="label">Uncited</div></div>
    <div class="stat-card"><div class="num">${coverage}%</div><div class="label">Coverage</div></div>
    <div class="stat-card"><div class="num">${dataSources.length}</div><div class="label">Data Sources</div></div>
    <div class="stat-card"><div class="num">${annotations.length}</div><div class="label">Annotations</div></div>
  </div>

  <section class="card">
    <h2>Citation Coverage</h2>
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:.5rem;">
      Of ${totalRefs} references in the bibliography, ${citedRefs} are cited inline in the body text
      and ${uncitedRefs} are gathered but unused.
    </p>
    <div class="coverage-bar">
      <div class="cited" style="width:${citedPct}%"><span>${citedRefs} cited (${coverage}%)</span></div>
      <div class="uncited" style="width:${uncitedPct}%"><span>${uncitedRefs} unused</span></div>
    </div>
  </section>

  <section class="card">
    <h2>Citation Graph — Theme Clusters</h2>
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:.8rem;">
      References clustered by their dominant keyword. Node size = cluster size.
    </p>
    <div class="graph-wrap">
      <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}">
        <circle cx="${cx}" cy="${cy}" r="${radius + 40}" fill="none" stroke="#f3f4f6" stroke-width="1"/>
        ${svgEdges}
        ${svgNodes}
        <circle cx="${cx}" cy="${cy}" r="20" fill="#4338ca" fill-opacity="0.15" stroke="#4338ca" stroke-width="2"/>
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#4338ca">${totalRefs}</text>
        <text x="${cx}" y="${cy + 35}" text-anchor="middle" font-size="9" fill="#6b7280">total refs</text>
      </svg>
    </div>
    <div class="legend">
      ${themes.map((t, i) => `<span><i style="background:hsl(${(i * 47) % 360},65%,55%)"></i>${esc(t.name)} (${t.count})</span>`).join("")}
    </div>
  </section>

  <section class="card">
    <h2>Reference Inventory</h2>
    <table>
      <thead><tr><th>#</th><th>Type</th><th>Authors</th><th>Title</th><th>Year</th><th>Status</th></tr></thead>
      <tbody>${refRows || '<tr><td colspan="6" style="text-align:center;color:var(--muted);">No references</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card">
    <h2>Data Source Inventory (${dataSources.length})</h2>
    <table>
      <thead><tr><th>#</th><th>Source</th><th>Title</th><th>ID</th><th>Link</th></tr></thead>
      <tbody>${dsRows || '<tr><td colspan="5" style="text-align:center;color:var(--muted);">No data sources</td></tr>'}</tbody>
    </table>
  </section>

  <footer>
    Generated by SciWrite · Citation Graph Report · ${esc(now)}
  </footer>
</div>
</body>
</html>`;
}
