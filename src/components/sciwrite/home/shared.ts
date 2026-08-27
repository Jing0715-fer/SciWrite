// Derived progress stats
export function computeProgressStats(paragraphs: any[]) {
  const totalWords = paragraphs.reduce(
    (sum, p) => sum + (p.wordCount || 0),
    0
  );
  const totalCitations = paragraphs.reduce((sum, p) => {
    const matches = p.content?.match(
      /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g
    );
    return sum + (matches?.length || 0);
  }, 0);
  const paragraphsCited = paragraphs.filter(
    (p) => /\[\d{1,3}/.test(p.content || "") || /\[[A-Z]{2,12}:/i.test(p.content || "")
  ).length;
  const citationCoverage =
    paragraphs.length > 0
      ? Math.round((paragraphsCited / paragraphs.length) * 100)
      : 0;
  const unresolved = paragraphs.reduce(
    (s, p) => s + (p.annotations?.filter((a: any) => !a.resolved).length || 0),
    0
  );
  const resolved = paragraphs.reduce(
    (s, p) => s + (p.annotations?.filter((a: any) => a.resolved).length || 0),
    0
  );
  return {
    totalWords,
    totalParagraphs: paragraphs.length,
    totalCitations,
    citationCoverage,
    unresolvedAnnotations: unresolved,
    resolvedAnnotations: resolved,
  };
}
