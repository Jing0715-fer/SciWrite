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
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Annotation, Reference } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ExportBody {
  type: "paragraph" | "article" | "project-merge";
  id: string;
  format: "docx" | "pdf" | "markdown";
  includeAnnotations?: boolean;
  journalTemplate?: string;
  mergeExport?: boolean;
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

    // Fetch the record
    let title = "";
    let content = "";
    let abstract = "";
    let references: (Reference & { _count?: any })[] = [];
    let annotations: Annotation[] = [];
    let allUserData: any[] = [];

    if (body.type === "paragraph") {
      const p = await db.paragraph.findUnique({
        where: { id: body.id },
        include: { references: true, annotations: true },
      });
      if (!p) return NextResponse.json({ error: "Not found." }, { status: 404 });
      title = p.title;
      content = p.content;
      references = p.references;
      annotations = p.annotations;
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

      // Build merged content: all paragraphs as sections + latest article if exists
      const sections: string[] = [];
      for (const p of project.paragraphs) {
        const citeHeaderIdx = p.content.indexOf("### Citations");
        const cleanContent = citeHeaderIdx >= 0 ? p.content.slice(0, citeHeaderIdx).trim() : p.content.trim();
        sections.push(`## ${p.title}\n\n${cleanContent}`);
      }
      // If there's an article, use its content as the main body
      if (project.articles.length > 0) {
        const article = project.articles[0];
        const aCiteIdx = article.content.indexOf("### Citations");
        const aClean = aCiteIdx >= 0 ? article.content.slice(0, aCiteIdx).trim() : article.content.trim();
        content = aClean;
        if (article.abstract) abstract = article.abstract;
      } else {
        content = sections.join("\n\n");
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
      content = a.content;
      abstract = a.abstract || "";
      // Merge references from all paragraphs linked to this article
      const refMap = new Map<string, Reference>();
      for (const ap of a.articleParagraph) {
        for (const r of ap.paragraph.references) {
          const key = `${r.type}:${r.externalId || r.title}`;
          if (!refMap.has(key)) refMap.set(key, r);
        }
      }
      references = [...refMap.values()];
      annotations = a.articleParagraph.flatMap((ap) => ap.paragraph.annotations);
    }

    // Strip AI-generated reference/citation sections from content (we build our own)
    const citeHeaderIdx = content.indexOf("### Citations");
    const refHeaderIdx = content.indexOf("## References");
    let cleanEnd = content.length;
    if (citeHeaderIdx >= 0) cleanEnd = Math.min(cleanEnd, citeHeaderIdx);
    if (refHeaderIdx >= 0) cleanEnd = Math.min(cleanEnd, refHeaderIdx);
    const cleanContent = content.slice(0, cleanEnd).trim();

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

    if (body.format === "markdown") {
      const fullContent = appendixContent ? cleanContent + appendixContent : cleanContent;
      const md = buildMarkdown(title, abstract, fullContent, refLines, body.includeAnnotations ? annotations : undefined);
      return new NextResponse(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slug(title)}.md"`,
        },
      });
    }

    if (body.format === "docx") {
      const buffer = await buildDocx(
        title,
        abstract,
        cleanContent,
        refLines,
        body.includeAnnotations ? annotations : undefined
      );
      return new NextResponse(buffer, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${slug(title)}.docx"`,
        },
      });
    }

    if (body.format === "pdf") {
      const buffer = await buildPdf(
        title,
        abstract,
        cleanContent,
        refLines,
        body.includeAnnotations ? annotations : undefined
      );
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${slug(title)}.pdf"`,
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

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document"
  );
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

async function buildDocx(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  annotations?: Annotation[]
): Promise<ArrayBuffer> {
  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: title, bold: true })],
    })
  );
  if (abstract) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: abstract, italics: true, color: "555555" }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  // Body: split by markdown headings and paragraphs
  const blocks = content.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("## ")) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: trimmed.replace(/^##\s+/, "") })],
        })
      );
    } else if (trimmed.startsWith("# ")) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: trimmed.replace(/^#\s+/, "") })],
        })
      );
    } else {
      // inline citations [n] kept as-is; render runs
      const runs = parseInlineCitations(trimmed);
      children.push(
        new Paragraph({
          children: runs,
          spacing: { after: 160, line: 320 },
          alignment: AlignmentType.JUSTIFIED,
        })
      );
    }
  }

  // Annotations
  if (annotations && annotations.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "Annotations" })],
        spacing: { before: 300 },
      })
    );
    annotations.forEach((a, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[${i + 1}] ${a.type} (${a.severity})${
                a.resolved ? " — resolved" : ""
              }`,
              bold: true,
            }),
          ],
        })
      );
      if (a.selectedText) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `“${a.selectedText}”`, italics: true }),
            ],
          })
        );
      }
      children.push(new Paragraph({ children: [new TextRun({ text: a.comment })] }));
    });
  }

  // References
  if (refLines.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "References" })],
        spacing: { before: 300 },
      })
    );
    refLines.forEach((line) => {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: line, size: 20 })],
          spacing: { after: 80 },
        })
      );
    });
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
        },
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

async function buildPdf(
  title: string,
  abstract: string,
  content: string,
  refLines: string[],
  annotations?: Annotation[]
): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 56;
  const maxWidth = pageWidth - margin * 2;
  let y = pageHeight - margin;

  const drawPage = pdfDoc.addPage([pageWidth, pageHeight]);
  y = pageHeight - margin;

  const ensureSpace = (lineHeight: number) => {
    if (y - lineHeight < margin) {
      // new page
      const newPage = pdfDoc.addPage([pageWidth, pageHeight]);
      Object.assign(drawPage, { _current: newPage });
      y = pageHeight - margin;
      return newPage;
    }
    return drawPage;
  };

  let currentPage = drawPage;

  const writeLine = (
    text: string,
    opts: { font?: any; size?: number; color?: any; indent?: number } = {}
  ) => {
    const f = opts.font || font;
    const size = opts.size || 10;
    const indent = opts.indent || 0;
    const color = opts.color || rgb(0.15, 0.15, 0.15);
    const words = text.split(" ");
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(test, size) > maxWidth - indent) {
        if (y - size * 1.3 < margin) {
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        currentPage.drawText(line, { x: margin + indent, y, size, font: f, color });
        y -= size * 1.35;
        line = w;
      } else {
        line = test;
      }
    }
    if (line) {
      if (y - size * 1.3 < margin) {
        currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      currentPage.drawText(line, { x: margin + indent, y, size, font: f, color });
      y -= size * 1.35;
    }
  };

  const writeWrapped = (text: string, opts: any = {}) => {
    writeLine(text, opts);
  };

  // Title
  const titleSize = 16;
  const titleWords = title.split(" ");
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

  if (abstract) {
    writeWrapped(abstract, { font: italicFont, size: 10, color: rgb(0.4, 0.4, 0.4) });
    y -= 6;
  }

  // Body
  const blocks = content.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("## ")) {
      y -= 4;
      writeWrapped(trimmed.replace(/^##\s+/, ""), {
        font: boldFont,
        size: 12,
        color: rgb(0.12, 0.3, 0.27),
      });
      y -= 4;
    } else if (trimmed.startsWith("# ")) {
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

  // References
  if (refLines.length) {
    y -= 8;
    writeWrapped("References", {
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

  return await pdfDoc.save();
}
