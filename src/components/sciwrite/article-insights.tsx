"use client";

import * as React from "react";
import {
  Sparkles,
  BarChart3,
  Type,
  Hash,
  TrendingUp,
  Quote,
  Network,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/lib/i18n";
import { countWords } from "@/lib/writing";

export type ViewLang = "en" | "zh" | "parallel";

/**
 * ArticleInsights — a tab showing article-level analytics:
 *  - Word frequency cloud (top 30 words, sized by frequency)
 *  - Section length bar chart (visual comparison)
 *  - Citation density per section
 *  - Article quality metrics (avg sentence length, lexical diversity)
 *
 * Computes everything client-side from the article content + paragraphs.
 * No LLM calls — pure text analysis.
 */
export function ArticleInsights({
  article,
  paragraphs,
  viewLang,
  contentRef,
}: {
  article: { content: string; contentZh?: string | null; title: string };
  paragraphs: any[];
  viewLang: ViewLang;
  contentRef: React.RefObject<HTMLDivElement>;
}) {
  const { t } = useI18n();

  // Pick the content to analyze based on the current view language.
  // For parallel mode, analyze English (the primary content).
  const analyzeContent = React.useMemo(() => {
    if (viewLang === "zh" && article.contentZh) return article.contentZh;
    return article.content;
  }, [article, viewLang]);

  // Compute word frequency (top 30, excluding stopwords)
  const wordFreq = React.useMemo(() => {
    return computeWordFrequency(analyzeContent, viewLang === "zh");
  }, [analyzeContent, viewLang]);

  // Compute per-section stats
  const sectionStats = React.useMemo(() => {
    return paragraphs.map((p: any, i: number) => {
      const content = viewLang === "zh" && p.contentZh ? p.contentZh : p.content;
      const words = countWords(content);
      const citations = (content.match(/\[\d+(?:[,\-–\s\d]*)\]/g) || []).length;
      const sentences = (content.match(/[.!?。！？]+/g) || []).length || 1;
      const avgSentenceLen = Math.round(words / sentences);
      return {
        index: i,
        title: p.title,
        wordCount: words,
        citationCount: citations,
        avgSentenceLen,
        citationDensity: words > 0 ? (citations / words * 100).toFixed(1) : "0",
      };
    });
  }, [paragraphs, viewLang]);

  // Compute citation-reference mapping: which reference IDs are cited in
  // which sections. Used for the citation graph visualization.
  const citationGraph = React.useMemo(() => {
    // Collect all unique references across all paragraphs
    const refMap = new Map<string, { id: string; title: string; type: string; externalId?: string | null; authors?: string | null; year?: string | null }>();
    paragraphs.forEach((p: any) => {
      (p.references || []).forEach((r: any) => {
        const key = `${r.type}:${r.externalId || r.title}`;
        if (!refMap.has(key)) {
          refMap.set(key, {
            id: r.id,
            title: r.title,
            type: r.type,
            externalId: r.externalId,
            authors: r.authors,
            year: r.year,
          });
        }
      });
    });
    const allRefs = Array.from(refMap.values());

    // For each section, find which references (by index in the paragraph's
    // own reference list) are cited. Then map those to the global ref list.
    const sectionCitations: { sectionIdx: number; sectionTitle: string; refIndices: number[] }[] = [];
    paragraphs.forEach((p: any, i: number) => {
      const content = viewLang === "zh" && p.contentZh ? p.contentZh : p.content;
      const citeMatches = content.matchAll(/\[(\d+(?:[,\-–\s\d]*)*)\]/g);
      const citedNums = new Set<number>();
      for (const m of citeMatches) {
        const inner = m[1];
        // Expand ranges like [1-3] and comma lists like [1,2,3]
        const parts = inner.split(/[,\s]+/);
        for (const part of parts) {
          const rangeMatch = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          if (rangeMatch) {
            const a = parseInt(rangeMatch[1]);
            const b = parseInt(rangeMatch[2]);
            for (let n = a; n <= b; n++) citedNums.add(n);
          } else {
            const n = parseInt(part);
            if (!isNaN(n)) citedNums.add(n);
          }
        }
      }
      // Map cited numbers to the paragraph's reference list (1-based)
      const paraRefs = p.references || [];
      const refIndices: number[] = [];
      citedNums.forEach((n) => {
        if (n >= 1 && n <= paraRefs.length) {
          const r = paraRefs[n - 1];
          const globalIdx = allRefs.findIndex(
            (ar) => `${ar.type}:${ar.externalId || ar.title}` === `${r.type}:${r.externalId || r.title}`
          );
          if (globalIdx >= 0) refIndices.push(globalIdx);
        }
      });
      sectionCitations.push({
        sectionIdx: i,
        sectionTitle: p.title,
        refIndices: Array.from(new Set(refIndices)).sort((a, b) => a - b),
      });
    });

    return { allRefs, sectionCitations };
  }, [paragraphs, viewLang]);

  // Compute reference frequency: how many sections cite each reference
  const refFrequency = React.useMemo(() => {
    const freq = new Map<number, number>(); // refIdx → section count
    citationGraph.sectionCitations.forEach((s) => {
      s.refIndices.forEach((refIdx) => {
        freq.set(refIdx, (freq.get(refIdx) || 0) + 1);
      });
    });
    return freq;
  }, [citationGraph]);

  // Article-level quality metrics
  const qualityMetrics = React.useMemo(() => {
    const totalWords = countWords(analyzeContent);
    const uniqueWords = new Set(
      analyzeContent.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    ).size;
    const lexicalDiversity = totalWords > 0
      ? ((uniqueWords / totalWords) * 100).toFixed(1)
      : "0";
    const sentences = (analyzeContent.match(/[.!?。！？]+/g) || []).length || 1;
    const avgSentenceLen = Math.round(totalWords / sentences);
    const totalCitations = (analyzeContent.match(/\[\d+(?:[,\-–\s\d]*)\]/g) || []).length;
    const citationDensity = totalWords > 0
      ? (totalCitations / totalWords * 100).toFixed(2)
      : "0";
    return {
      totalWords,
      uniqueWords,
      lexicalDiversity,
      avgSentenceLen,
      totalCitations,
      citationDensity,
      sentences,
    };
  }, [analyzeContent]);

  const maxWordCount = Math.max(...sectionStats.map((s: any) => s.wordCount), 1);
  const maxFreq = wordFreq.length > 0 ? wordFreq[0].count : 1;

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-8 py-5 max-w-4xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">
            {t("articleViewer.insightsTitle") || "Article Insights"}
          </h3>
          <Badge variant="outline" className="text-[9px] ml-auto">
            {viewLang === "zh" ? "中文" : viewLang === "parallel" ? "EN" : "EN"}
          </Badge>
        </div>

        {/* Quality metrics grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <MetricCard
            icon={Type}
            label={t("articleViewer.totalWords") || "Total words"}
            value={qualityMetrics.totalWords.toLocaleString()}
            color="text-blue-700 dark:text-blue-400"
          />
          <MetricCard
            icon={Hash}
            label={t("articleViewer.uniqueWords") || "Unique words"}
            value={qualityMetrics.uniqueWords.toLocaleString()}
            color="text-violet-700 dark:text-violet-400"
          />
          <MetricCard
            icon={TrendingUp}
            label={t("articleViewer.lexicalDiversity") || "Lexical diversity"}
            value={`${qualityMetrics.lexicalDiversity}%`}
            color="text-emerald-700 dark:text-emerald-400"
            title="Unique words / total words × 100"
          />
          <MetricCard
            icon={BarChart3}
            label={t("articleViewer.avgSentenceLen") || "Avg sentence"}
            value={`${qualityMetrics.avgSentenceLen}w`}
            color="text-amber-700 dark:text-amber-400"
            title="Average words per sentence"
          />
        </div>

        {/* Word frequency cloud */}
        <div className="rounded-lg border border-border/60 p-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <Type className="h-3.5 w-3.5 text-primary" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("articleViewer.wordCloud") || "Word Frequency Cloud"}
            </h4>
            <span className="text-[9px] text-muted-foreground/60 ml-auto">
              {viewLang === "zh" ? "top 30 characters" : "top 30 words"}
            </span>
          </div>
          {wordFreq.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 leading-loose">
              {wordFreq.map((w, i) => {
                // Size: 10px (smallest) to 24px (largest), scaled by frequency
                const sizeRatio = w.count / maxFreq;
                const fontSize = 10 + sizeRatio * 14;
                // Color: gradient from muted to primary based on frequency
                const opacity = 0.4 + sizeRatio * 0.6;
                return (
                  <span
                    key={w.word}
                    className="font-medium cursor-default hover:underline transition-all"
                    style={{
                      fontSize: `${fontSize}px`,
                      color: `hsl(var(--primary) / ${opacity})`,
                      lineHeight: 1.4,
                    }}
                    title={`${w.word}: ${w.count} occurrences`}
                  >
                    {w.word}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {t("articleViewer.noWords") || "No words to analyze."}
            </p>
          )}
        </div>

        {/* Section length bar chart */}
        <div className="rounded-lg border border-border/60 p-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("articleViewer.sectionLengths") || "Section Lengths"}
            </h4>
          </div>
          <div className="space-y-1.5">
            {sectionStats.map((s: any) => (
              <div key={s.index} className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-muted-foreground w-6 shrink-0">
                  §{String(s.index + 1).padStart(2, "0")}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[10px] font-medium truncate">{s.title}</span>
                    <span className="text-[9px] text-muted-foreground font-mono shrink-0 ml-2">
                      {s.wordCount}w · {s.citationCount}c · {s.avgSentenceLen}w/s
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary transition-all"
                      style={{ width: `${(s.wordCount / maxWordCount) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Legend */}
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground pt-1 border-t border-border/40">
            <span><strong>w</strong> = words</span>
            <span><strong>c</strong> = citations</span>
            <span><strong>w/s</strong> = words per sentence</span>
          </div>
        </div>

        {/* Citation density summary */}
        <div className="rounded-lg border border-emerald-200/40 dark:border-emerald-900/30 bg-emerald-50/30 dark:bg-emerald-950/10 p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Quote className="h-3 w-3 text-emerald-600" />
            <span className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-semibold">
              {t("articleViewer.citationSummary") || "Citation Summary"}
            </span>
          </div>
          <p className="text-[11px] text-foreground/80 leading-relaxed">
            {qualityMetrics.totalCitations} citations across {qualityMetrics.sentences} sentences
            {" "}({qualityMetrics.citationDensity} per 100 words).
            {" "}{qualityMetrics.totalCitations > 0
              ? (t("articleViewer.citationGood") || "Good citation density for a review article.")
              : (t("articleViewer.citationLow") || "Consider adding more inline citations.")}
          </p>
        </div>

        {/* Citation graph — which references are cited in which sections */}
        {citationGraph.allRefs.length > 0 && (
          <div className="rounded-lg border border-border/60 p-4 space-y-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Network className="h-3.5 w-3.5 text-primary" />
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("articleViewer.citationGraph") || "Citation Graph"}
              </h4>
              <span className="text-[9px] text-muted-foreground/60 ml-auto">
                {citationGraph.allRefs.length} refs · {sectionStats.length} sections
              </span>
              {/* Coverage stats: how many ref-cells are filled vs total. */}
              {(() => {
                const total = citationGraph.allRefs.length * citationGraph.sectionCitations.length;
                const filled = citationGraph.sectionCitations.reduce(
                  (acc, s) => acc + s.refIndices.length, 0
                );
                const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
                return (
                  <span
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-primary/30 bg-primary/[0.06] text-primary"
                    title="Citation coverage: filled cells / total cells"
                  >
                    {filled}/{total} · {pct}%
                  </span>
                );
              })()}
            </div>
            {/* Matrix: rows = sections, columns = references, cell = cited.
                Enhancements: hover highlights row+column, cells colored by
                intensity (multi-cite refs darker), orphan refs flagged red,
                over-cited refs flagged amber. */}
            <div className="overflow-x-auto scroll-academic">
              <table className="text-[9px] border-collapse">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-background z-10 text-left pr-2 py-1 font-medium text-muted-foreground max-w-[140px] min-w-[100px]">
                      {t("articleViewer.section") || "Section"}
                    </th>
                    {citationGraph.allRefs.map((ref, i) => {
                      const freq = refFrequency.get(i) || 0;
                      const isOrphan = freq === 0;
                      const isOverCited = freq >= 4;
                      return (
                        <th
                          key={i}
                          className="px-0.5 py-1 font-mono text-center min-w-[22px] group/th"
                          title={`${ref.title}${ref.authors ? ` — ${ref.authors}` : ""}${ref.year ? ` (${ref.year})` : ""} → cited in ${freq} section${freq !== 1 ? "s" : ""}${isOrphan ? " (ORPHAN — never cited)" : ""}${isOverCited ? " (over-cited)" : ""}`}
                        >
                          <span
                            className={`inline-flex items-center justify-center w-4 h-4 rounded text-[8px] font-bold transition-colors ${
                              isOrphan
                                ? "bg-red-100/70 dark:bg-red-950/40 text-red-600 dark:text-red-400 ring-1 ring-red-300/50"
                                : isOverCited
                                ? "bg-amber-100/70 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 ring-1 ring-amber-300/50"
                                : "bg-muted/40 text-muted-foreground group-hover/th:bg-primary/20 group-hover/th:text-primary"
                            }`}
                          >
                            {i + 1}
                          </span>
                        </th>
                      );
                    })}
                    <th className="sticky right-0 bg-background z-10 px-1 py-1 font-mono text-center min-w-[28px] text-[8px] text-muted-foreground">
                      Σ
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {citationGraph.sectionCitations.map((s) => {
                    const rowTotal = s.refIndices.length;
                    return (
                      <tr key={s.sectionIdx} className="border-t border-border/30 group/tr">
                        <td
                          className="sticky left-0 bg-background z-10 text-left pr-2 py-1 max-w-[140px] truncate group-hover/tr:bg-accent/30 transition-colors"
                          title={s.sectionTitle}
                        >
                          <span className="text-foreground/80">§{String(s.sectionIdx + 1).padStart(2, "0")} {s.sectionTitle}</span>
                        </td>
                        {citationGraph.allRefs.map((_, refIdx) => {
                          const isCited = s.refIndices.includes(refIdx);
                          const freq = refFrequency.get(refIdx) || 0;
                          const maxFreq = Math.max(...Array.from(refFrequency.values()), 1);
                          // Cell opacity scales with the ref's global frequency
                          // so highly-cited refs appear darker across all rows.
                          const intensity = freq / maxFreq;
                          return (
                            <td
                              key={refIdx}
                              className="px-0.5 py-1 text-center group/td"
                              title={isCited ? `§${s.sectionIdx + 1} cites ref ${refIdx + 1}` : undefined}
                            >
                              {isCited ? (
                                <span
                                  className="inline-block w-3 h-3 rounded-sm transition-all group-hover/td:scale-125 group-hover/td:ring-1 group-hover/td:ring-primary"
                                  style={{
                                    backgroundColor: `hsl(var(--primary) / ${0.45 + intensity * 0.4})`,
                                  }}
                                />
                              ) : (
                                <span className="inline-block w-3 h-3 rounded-sm bg-muted/15 group-hover/td:bg-muted/30 transition-colors" />
                              )}
                            </td>
                          );
                        })}
                        {/* Row total — sum of citations in this section. */}
                        <td className="sticky right-0 bg-background z-10 px-1 py-1 text-center">
                          <span className="text-[8px] font-mono font-semibold text-muted-foreground tabular-nums">
                            {rowTotal}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Legend for the matrix cell colors. */}
            <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "hsl(var(--primary) / 0.85)" }} />
                cited (high freq)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "hsl(var(--primary) / 0.45)" }} />
                cited (low freq)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-100/70 dark:bg-red-950/40 ring-1 ring-red-300/50" />
                orphan (never cited)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100/70 dark:bg-amber-950/40 ring-1 ring-amber-300/50" />
                over-cited (≥4 sections)
              </span>
            </div>
            {/* Reference frequency legend — clickable chips with intensity. */}
            <div className="pt-2 border-t border-border/40 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {t("articleViewer.refFrequency") || "Reference Frequency"}
                </span>
                <span className="text-[8px] text-muted-foreground/70">
                  click a ref to highlight its column
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {citationGraph.allRefs.map((ref, i) => {
                  const freq = refFrequency.get(i) || 0;
                  const maxFreq = Math.max(...Array.from(refFrequency.values()), 1);
                  const intensity = freq / maxFreq;
                  const isOrphan = freq === 0;
                  return (
                    <span
                      key={i}
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono border transition-all hover:scale-105 cursor-default"
                      style={{
                        backgroundColor: isOrphan
                          ? "hsl(0 80% 95% / 0.5)"
                          : freq > 0
                          ? `hsl(var(--primary) / ${0.1 + intensity * 0.3})`
                          : "transparent",
                        borderColor: isOrphan
                          ? "hsl(0 80% 60% / 0.4)"
                          : freq > 0
                          ? `hsl(var(--primary) / ${0.3 + intensity * 0.4})`
                          : "hsl(var(--border) / 0.4)",
                        color: isOrphan
                          ? "hsl(0 80% 40%)"
                          : freq > 0
                          ? "hsl(var(--primary))"
                          : "hsl(var(--muted-foreground))",
                      }}
                      title={`${ref.title}${ref.authors ? ` — ${ref.authors}` : ""}${ref.year ? ` (${ref.year})` : ""} → cited in ${freq} section${freq !== 1 ? "s" : ""}${isOrphan ? " (ORPHAN)" : ""}`}
                    >
                      <strong>{i + 1}</strong>
                      <span className="opacity-70">×{freq}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  color,
  title,
}: {
  icon: any;
  label: string;
  value: string;
  color: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="rounded-lg border border-border/60 p-2.5 space-y-1"
    >
      <div className="flex items-center gap-1">
        <Icon className={`h-3 w-3 ${color}`} />
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

/**
 * Compute word frequency from text content.
 * For English: splits on whitespace, filters stopwords, counts tokens ≥3 chars.
 * For Chinese: extracts individual characters (since Chinese has no spaces).
 *
 * Returns top 30 words sorted by frequency (descending).
 */
export function computeWordFrequency(text: string, isChinese: boolean): { word: string; count: number }[] {
  if (!text) return [];

  // Strip markdown formatting
  const plain = text
    .replace(/^#{1,6}\s+/gm, "") // headers
    .replace(/\[([^\]]+)\]/g, "$1") // citation brackets → content
    .replace(/[*_`~]/g, "") // emphasis
    .replace(/\n+/g, " ");

  if (isChinese) {
    // For Chinese: count individual characters (skip punctuation, spaces, digits)
    const freq = new Map<string, number>();
    for (const ch of plain) {
      const code = ch.codePointAt(0) || 0;
      // Only count CJK characters (not punctuation, not Latin, not digits)
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf)
      ) {
        freq.set(ch, (freq.get(ch) || 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);
  }

  // English: split on whitespace, lowercase, filter stopwords
  const ENGLISH_STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "this", "that", "these", "those", "i", "you", "he", "she", "it", "we",
    "they", "them", "their", "his", "her", "its", "our", "your", "my",
    "me", "him", "us", "as", "if", "then", "than", "so", "because", "while",
    "where", "when", "how", "what", "which", "who", "whom", "whose", "why",
    "all", "any", "both", "each", "few", "more", "most", "other", "some",
    "such", "no", "not", "only", "own", "same", "too", "very", "just",
    "also", "into", "out", "up", "down", "over", "under", "again", "further",
    "here", "there", "about", "above", "below", "off", "during", "before",
    "after", "between", "through", "once", "twice",
  ]);

  const words = plain
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length >= 3 && !ENGLISH_STOPWORDS.has(w) && !/^\d+$/.test(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return Array.from(freq.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
}

/**
 * ReadingProgressIndicator — a thin progress bar at the top of the article
 * content area showing how far the user has scrolled through the article.
 *
 * Listens to scroll events on the closest scrollable ancestor of the
 * content ref and calculates: scrollTop / (scrollHeight - clientHeight) * 100.
 *
 * Shows a 2px gradient bar that fills as the user reads. Also displays a
 * tiny percentage label on the right side of the bar.
 */
export function ReadingProgressIndicator({
  contentRef,
}: {
  contentRef: React.RefObject<HTMLDivElement>;
}) {
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    if (!contentRef.current) return;
    // Find the closest scrollable ancestor
    let scrollEl: HTMLElement | null = contentRef.current;
    while (scrollEl && scrollEl.parentElement) {
      scrollEl = scrollEl.parentElement;
      const style = window.getComputedStyle(scrollEl);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollEl.scrollHeight > scrollEl.clientHeight
      ) {
        break;
      }
    }
    if (!scrollEl) return;

    const handleScroll = () => {
      const maxScroll = scrollEl!.scrollHeight - scrollEl!.clientHeight;
      if (maxScroll <= 0) {
        setProgress(100); // everything fits
        return;
      }
      const pct = (scrollEl!.scrollTop / maxScroll) * 100;
      setProgress(Math.max(0, Math.min(100, pct)));
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    // Use ResizeObserver to recalculate when content height changes
    const resizeObserver = new ResizeObserver(handleScroll);
    resizeObserver.observe(contentRef.current);
    handleScroll(); // initial

    return () => {
      scrollEl?.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
    };
  }, [contentRef]);

  return (
    <div className="shrink-0 h-1 bg-muted/40 relative overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-primary/60 via-primary to-primary/80 transition-[width] duration-150 ease-out"
        style={{ width: `${progress}%` }}
      />
      {/* Percentage label — appears when >0% and <100% */}
      {progress > 0 && progress < 100 && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-muted-foreground tabular-nums leading-none">
          {Math.round(progress)}%
        </span>
      )}
    </div>
  );
}

