import type {
  DatabaseQueryResponse,
  WriteRequest,
  ComposeRequest,
  Annotation,
  Paragraph,
  Reference,
  DataSource,
  Project,
  Article,
} from "./types";
import { consumeSSEStream } from "./sse";

/**
 * Fetch timeouts. Plain CRUD never takes >90s; LLM-backed sync routes
 * (summarize / verify / compose / revise / gather / ...) can legitimately run
 * for minutes, so they get a 5-minute budget instead of hanging forever.
 */
const DEFAULT_TIMEOUT_MS = 90_000;
const LLM_TIMEOUT_MS = 5 * 60_000;
const LLM_ROUTE_RE =
  /^\/api\/(ai\/|insights|databases|data-sources\/[^/]+\/deep-read|articles\/[^/]+\/(summarize|verify-citations|generate-diagram|suggest-citations|optimize-structure|generate-captions|analyze-style|submission-check)|paragraphs\/[^/]+\/(validate-citations|auto-fix-citations|revise|regenerate)|projects\/[^/]+\/validate-citations|projects\/[^/]+\/citation-health)/;

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const timeoutMs = LLM_ROUTE_RE.test(url) ? LLM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw err;
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data && (data.error || data.message)) ||
      `Request failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

export const api = {
  /* Projects */
  listProjects: () => jfetch<{ projects: (Project & { _count: any })[] }>("/api/projects"),
  createProject: (input: {
    title: string;
    topic: string;
    description?: string;
    field?: string;
  }) => jfetch<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(input) }),
  getProject: (id: string) =>
    jfetch<{
      project: Project & {
        paragraphs: any[];
        dataSources: DataSource[];
        articles: Article[];
        // Project-level references (paragraphId = null) — returned by
        // GET /api/projects/[id] alongside per-paragraph references.
        references: Reference[];
      };
    }>(`/api/projects/${id}`),
  updateProject: (id: string, input: Partial<Project>) =>
    jfetch<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteProject: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  exportProject: (projectId: string) =>
    fetch(`/api/projects/export?projectId=${projectId}`).then(async (res) => {
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Export failed (${res.status})`);
      }
      return res.json();
    }),
  importProject: (data: unknown) =>
    jfetch<{ project: Project; stats: any }>(`/api/projects/import`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  /* Paragraphs */
  listTrashedParagraphs: (projectId?: string) =>
    jfetch<{ paragraphs: Paragraph[] }>(
      `/api/paragraphs?trash=true${projectId ? `&projectId=${projectId}` : ""}`
    ),
  createParagraph: (input: {
    projectId: string;
    title: string;
    content: string;
    format: string;
    scenario: string;
  }) => jfetch<{ paragraph: Paragraph }>("/api/paragraphs", { method: "POST", body: JSON.stringify(input) }),
  updateParagraph: (id: string, input: Partial<Paragraph>) =>
    jfetch<{ paragraph: Paragraph }>(`/api/paragraphs/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteParagraph: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/paragraphs/${id}`, { method: "DELETE" }),
  permanentDeleteParagraph: (id: string) =>
    jfetch<{ ok: boolean; permanent: boolean }>(`/api/paragraphs/${id}?permanent=true`, { method: "DELETE" }),
  restoreParagraph: (id: string) =>
    jfetch<{ ok: boolean; paragraph: Paragraph }>(`/api/paragraphs/${id}/restore`, { method: "POST" }),
  batchParagraphs: (action: "restore" | "delete", ids: string[]) =>
    jfetch<{ ok: boolean; action: string; affected: number }>(`/api/paragraphs/batch`, {
      method: "POST",
      body: JSON.stringify({ action, ids }),
    }),

  /* Article version history */
  listArticleVersions: (articleId: string) =>
    jfetch<{ versions: { id: string; label: string | null; wordCount: number; createdAt: string; title: string }[] }>(
      `/api/articles/${articleId}/versions`
    ),
  createArticleVersion: (articleId: string, label?: string) =>
    jfetch<{ version: any }>(`/api/articles/${articleId}/versions`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  getArticleVersion: (articleId: string, versionId: string) =>
    jfetch<{ version: { id: string; content: string; contentZh: string | null; title: string; label: string | null; wordCount: number; createdAt: string } }>(
      `/api/articles/${articleId}/versions/${versionId}`
    ),
  restoreArticleVersion: (articleId: string, versionId: string) =>
    jfetch<{ ok: boolean; article: Article }>(`/api/articles/${articleId}/versions/${versionId}?restore=true`, { method: "POST" }),

  /* Prompt templates */
  listPromptTemplates: (taskType?: string) =>
    jfetch<{ templates: { id: string; name: string; taskType: string; systemPrompt: string | null; instruction: string | null; isDefault: boolean }[] }>(
      `/api/prompt-templates${taskType ? `?taskType=${taskType}` : ""}`
    ),
  createPromptTemplate: (input: { name: string; taskType: string; systemPrompt?: string; instruction?: string }) =>
    jfetch<{ template: any }>(`/api/prompt-templates`, { method: "POST", body: JSON.stringify(input) }),
  updatePromptTemplate: (id: string, input: Partial<{ name: string; systemPrompt: string | null; instruction: string | null }>) =>
    jfetch<{ template: any }>(`/api/prompt-templates/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deletePromptTemplate: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/prompt-templates/${id}`, { method: "DELETE" }),

  /* Citation verification */
  verifyCitations: (articleId: string) =>
    jfetch<{
      results: {
        citation: number;
        refTitle: string | null;
        refIndex: number;
        sentence: string;
        score: number;
        status: "supported" | "weak" | "unsupported" | "missing";
        message: string;
      }[];
      summary: { total: number; supported: number; weak: number; unsupported: number; missing: number };
    }>(`/api/articles/${articleId}/verify-citations`, { method: "POST" }),

  /* AI Summarization */
  summarizeArticle: (articleId: string) =>
    jfetch<{
      overall: string;
      sections: { title: string; summary: string }[];
    }>(`/api/articles/${articleId}/summarize`, { method: "POST" }),

  /* AI Diagram generation */
  generateDiagram: (articleId: string) =>
    jfetch<{
      table: string;
      flowchart: string;
      keyFindings: string[];
    }>(`/api/articles/${articleId}/generate-diagram`, { method: "POST" }),

  /* AI citation suggestions */
  suggestCitations: (articleId: string) =>
    jfetch<{
      suggestions: {
        id: string;
        title: string;
        authors?: string;
        journal?: string;
        year?: string;
        source: string;
        reason: string;
        relevance: number;
      }[];
      totalUncited?: number;
      message?: string;
    }>(`/api/articles/${articleId}/suggest-citations`, { method: "POST" }),

  /* AI structure optimization */
  optimizeStructure: (articleId: string) =>
    jfetch<{
      score: number;
      strengths: string[];
      weaknesses: string[];
      suggestions: {
        type: string;
        section: string;
        priority: string;
        suggestion: string;
      }[];
      recommendedOrder: string[];
      missingSections: string[];
      analyzedSections: number;
      totalWords: number;
    }>(`/api/articles/${articleId}/optimize-structure`, { method: "POST" }),

  /* AI figure/table caption generation */
  generateCaptions: (articleId: string) =>
    jfetch<{
      captions: {
        type: "figure" | "table";
        number: number;
        reference: string;
        context: string;
        caption: string;
      }[];
      totalDetected: number;
      generated: number;
      message?: string;
    }>(`/api/articles/${articleId}/generate-captions`, { method: "POST" }),

  /* AI writing style analysis */
  analyzeStyle: (articleId: string) =>
    jfetch<{
      readabilityScore: number;
      gradeLevel: number;
      academicRegister: number | null;
      clarity: number | null;
      conciseness: number | null;
      metrics: {
        totalWords: number;
        totalSentences: number;
        totalParagraphs: number;
        avgSentenceLength: number;
        passiveVoicePct: number;
        longSentences: number;
        citations: number;
        citationDensity: number;
        lexicalDiversity: number;
      };
      sections: {
        title: string;
        words: number;
        sentences: number;
        paragraphs: number;
        avgSentenceLen: number;
        fleschReadingEase: number;
        fleschKincaidGrade: number;
        passiveVoicePct: number;
        longSentences: number;
        citations: number;
        citationDensity: number;
        lexicalDiversity: number;
      }[];
      issues: {
        issue: string;
        example: string;
        severity: string;
      }[];
      suggestions: {
        priority: string;
        suggestion: string;
      }[];
      readabilityLabel: string;
    }>(`/api/articles/${articleId}/analyze-style`, { method: "POST" }),

  /* Submission readiness check */
  submissionCheck: (articleId: string) =>
    jfetch<{
      overallScore: number;
      ready: boolean;
      readyLabel: string;
      checks: {
        id: string;
        label: string;
        status: "pass" | "warn" | "fail";
        severity: "info" | "low" | "medium" | "high";
        message: string;
        details?: string[];
      }[];
      summary: {
        totalWords: number;
        abstractWords: number;
        sectionsFound: number;
        sectionsTotal: number;
        refCount: number;
        incompleteRefs: number;
        figuresMentioned: number;
        tablesMentioned: number;
        doiCoverage: number;
        passivePct: number;
        longSentences: number;
        totalCitations: number;
      };
      journalTemplate: string | null;
      journalTemplateName: string | null;
      failCount: number;
      warnCount: number;
      passCount: number;
    }>(`/api/articles/${articleId}/submission-check`, { method: "POST" }),

  /* Batch-enrich references via CrossRef (DOI + title search) */
  enrichReferences: (projectId: string) =>
    jfetch<{
      enriched: number;
      skipped: number;
      failed: number;
      total: number;
      processed: number;
      details: {
        id: string;
        title: string;
        strategy: string;
        fields: string[];
        status: string;
        error?: string;
      }[];
      message?: string;
    }>(`/api/projects/${projectId}/enrich-references`, { method: "POST" }),

  /* Search CrossRef by title to find DOIs */
  searchReferencesByTitle: (query: string, rows?: number) =>
    jfetch<{
      results: {
        doi?: string;
        title: string;
        authors?: string;
        journal?: string;
        year?: string;
        url?: string;
        abstract?: string;
        type: string;
        similarity: number;
      }[];
      total: number;
    }>(`/api/references/search-by-title`, {
      method: "POST",
      body: JSON.stringify({ query, rows }),
      headers: { "Content-Type": "application/json" },
    }),

  /* Import references from .bib/.ris file content */
  importReferences: (projectId: string, content: string, format: "bib" | "ris") =>
    jfetch<{
      imported: number;
      skipped: number;
      total: number;
      details: {
        citationKey: string;
        title: string;
        status: string;
        fields: string[];
      }[];
      message?: string;
    }>(`/api/projects/${projectId}/import-references`, {
      method: "POST",
      body: JSON.stringify({ content, format }),
      headers: { "Content-Type": "application/json" },
    }),

  /* Project sharing */
  shareProject: (projectId: string, action: "create" | "revoke") =>
    jfetch<{ shareToken: string | null }>(`/api/projects/${projectId}/share`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  /* Comments */
  listComments: (params: { articleId?: string; paragraphId?: string }) => {
    const qs = new URLSearchParams();
    if (params.articleId) qs.set("articleId", params.articleId);
    if (params.paragraphId) qs.set("paragraphId", params.paragraphId);
    return jfetch<{ comments: any[] }>(`/api/comments?${qs.toString()}`);
  },
  createComment: (input: { articleId?: string; paragraphId?: string; parentId?: string; content: string }) =>
    jfetch<{ comment: any }>(`/api/comments`, { method: "POST", body: JSON.stringify(input) }),
  updateComment: (id: string, input: { content?: string; resolved?: boolean }) =>
    jfetch<{ comment: any }>(`/api/comments/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteComment: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/comments/${id}`, { method: "DELETE" }),

  /* Annotations */
  addAnnotation: (paragraphId: string, input: Partial<Annotation>) =>
    jfetch<{ annotation: Annotation }>(`/api/paragraphs/${paragraphId}/annotate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAnnotation: (id: string, input: Partial<Annotation>) =>
    jfetch<{ annotation: Annotation }>(`/api/annotations/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAnnotation: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/annotations/${id}`, { method: "DELETE" }),

  /* AI revise */
  reviseParagraph: (id: string, input: { mode?: string; instructions?: string }) =>
    jfetch<{ paragraph: Paragraph; revised: string; addressedCount: number }>(
      `/api/paragraphs/${id}/revise`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  /* Citation validation */
  validateCitations: (id: string) =>
    jfetch<any>(`/api/paragraphs/${id}/validate-citations`),

  /* Load saved reviews for an article */
  getSavedReview: (articleId: string) =>
    jfetch<any>(`/api/reviews?articleId=${articleId}`),

  /* Load saved relationship analysis */
  getSavedRelationships: (projectId: string) =>
    jfetch<any>(`/api/ai/source-relationships?projectId=${projectId}`),

  /* Auto-fix missing citations */
  autoFixCitations: (id: string) =>
    jfetch<any>(`/api/paragraphs/${id}/auto-fix-citations`, { method: "POST" }),

  /* Citation health report (project-level aggregate audit) */
  getCitationHealth: (projectId: string) =>
    jfetch<any>(`/api/projects/${projectId}/citation-health`),

  /* Regenerate a paragraph via LLM (rewrites body with fresh citations) */
  regenerateParagraph: (id: string) =>
    jfetch<{ paragraph: any; content: string }>(
      `/api/paragraphs/${id}/regenerate`,
      { method: "POST" }
    ),

  /* Batch citation validation (project-level) */
  validateProjectCitations: (projectId: string) =>
    jfetch<any>(`/api/projects/${projectId}/validate-citations`),

  /* AI write */
  aiWrite: (input: WriteRequest) =>
    jfetch<{ paragraph: Paragraph | null; content: string }>(`/api/ai/write`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* AI write (streaming SSE with progress + live log) */
  aiWriteStream: (
    input: WriteRequest,
    onEvent: (event: string, data: any) => void
  ) => consumeSSEStream(`/api/ai/write`, input, onEvent),

  /* AI compose */
  aiCompose: (input: ComposeRequest) =>
    jfetch<{ article: Article; content: string; wordCount: number; sourceParagraphs: number }>(
      `/api/ai/compose`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  /* AI compose (streaming SSE) */
  aiComposeStream: (
    input: ComposeRequest,
    onEvent: (event: string, data: any) => void
  ) => consumeSSEStream(`/api/ai/compose`, input, onEvent),

  /* AI gather sources (clarify / organize / critique) */
  aiGather: (input: any) =>
    jfetch<any>(`/api/ai/gather`, { method: "POST", body: JSON.stringify(input) }),

  /* AI gather (streaming SSE) */
  aiGatherStream: (
    input: any,
    onEvent: (event: string, data: any) => void
  ) => consumeSSEStream(`/api/ai/gather`, input, onEvent),

  /* AI generate outline */
  aiOutline: (input: { projectId: string; purpose?: string }) =>
    jfetch<{ summary: string; outline: any[] }>(`/api/ai/outline`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* AI outline (streaming SSE) */
  aiOutlineStream: (
    input: { projectId: string; purpose?: string },
    onEvent: (event: string, data: any) => void
  ) => consumeSSEStream(`/api/ai/outline`, input, onEvent),

  /* AI review (review / revise / auto-iterate) */
  aiReview: (input: {
    mode: "review" | "revise" | "auto-iterate";
    articleId: string;
    reviewId?: string;
    rounds?: number;
  }) => jfetch<any>(`/api/ai/review`, { method: "POST", body: JSON.stringify(input) }),

  /* AI generate full article (streaming SSE — gather → plan → generate → compose) */
  aiGenerateFullStream: (
    input: {
      projectId: string;
      journalTemplate?: string;
      language?: string;
      targetWords?: number;
      /** Advanced tuning — all optional, backend applies clamped defaults. */
      maxDbQueries?: number;
      maxWebSearchQueries?: number;
      gatherJsonCharLimit?: number;
      sectionRefTopN?: number;
      sectionRefMinN?: number;
      sectionDsTopN?: number;
      sectionDsMinN?: number;
      maxTokens?: number;
      /** Custom instruction from a selected prompt template — appended to
       *  the section-generation prompt to customize LLM behavior. */
      promptInstruction?: string;
    },
    onEvent: (event: string, data: any) => void
  ): Promise<any> =>
    consumeSSEStream(`/api/ai/generate-full`, input, onEvent, {
      emitComplete: true,
      rejectOnError: true,
    }),

  /**
   * v2 evidence-grounded generation pipeline (analyze → allocate → keyed-
   * citation writing → adversarial verification). Same SSE contract as
   * aiGenerateFullStream, but posts to /api/ai/generate-full-v2.
   */
  aiGenerateFullV2Stream: (
    input: {
      projectId: string;
      journalTemplate?: string;
      language?: string;
      targetWords?: number;
      maxDbQueries?: number;
      maxWebSearchQueries?: number;
      maxTokens?: number;
      promptInstruction?: string;
    },
    onEvent: (event: string, data: any) => void
  ): Promise<any> =>
    consumeSSEStream(`/api/ai/generate-full-v2`, input, onEvent, {
      emitComplete: true,
      rejectOnError: true,
    }),

  /**
   * Adversarial citation review — hostile-critic verification of every
   * (claim, citation) pair in a composed article, with optional surgical
   * removal of unsupported citations.
   */
  adversarialReviewArticle: (articleId: string, autoFix = true): Promise<any> =>
    fetch(`/api/articles/${articleId}/adversarial-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoFix }),
    }).then(async (res) => {
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Adversarial review failed (${res.status})`);
      }
      return res.json();
    }),

  /* Export */
  exportDoc: (input: {
    type: "paragraph" | "article";
    id: string;
    format: "docx" | "pdf" | "markdown" | "latex" | "epub" | "graph-report";
    includeAnnotations?: boolean;
    journalTemplate?: string;
    /** Language variant: "en" (default), "zh", or "both" */
    language?: "en" | "zh" | "both";
  }) =>
    fetch(`/api/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then(async (res) => {
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      // Extract export validation warnings from the response header
      const warningHeader = res.headers.get("X-Export-Warnings");
      if (warningHeader) {
        try {
          (blob as any).__exportWarnings = decodeURIComponent(warningHeader);
        } catch {}
      }
      return blob;
    }),

  /* Project insights */
  getInsights: (projectId: string) =>
    jfetch<any>(`/api/insights?projectId=${projectId}`),

  /* Database queries */
  queryDatabase: (input: {
    source: string;
    query: string;
    program?: string;
    database?: string;
  }) => jfetch<DatabaseQueryResponse>(`/api/databases`, {
    method: "POST",
    body: JSON.stringify(input),
  }),

  /* References */
  createReference: (input: Partial<Reference>) =>
    jfetch<{ reference: Reference }>(`/api/references`, { method: "POST", body: JSON.stringify(input) }),
  deleteReference: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/references/${id}`, { method: "DELETE" }),

  /* Data sources */
  // rawJson is typed `unknown` (not DataSource["rawJson"] = string) because the
  // server route accepts EITHER a pre-stringified JSON string or a raw JSON
  // value (it stringifies the latter itself) — see POST /api/data-sources.
  createDataSource: (input: Omit<Partial<DataSource>, "rawJson"> & { rawJson?: unknown }) =>
    jfetch<{ dataSource: DataSource }>(`/api/data-sources`, { method: "POST", body: JSON.stringify(input) }),
  updateDataSource: (id: string, input: Partial<DataSource>) =>
    jfetch<{ dataSource: DataSource }>(`/api/data-sources/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deepReadDataSource: (id: string) =>
    jfetch<{ dataSource: DataSource; summary: string; contentLength: number }>(
      `/api/data-sources/${id}/deep-read`,
      { method: "POST" }
    ),
  /** Molcraft fusion: analyze the 3D protein structure of an RCSB data source.
   * Downloads the PDB file, runs the full structure-analysis battery (Kabsch,
   * SASA, Ramachandran, B-factor, H-bonds, ligands, cavities, charge/pI),
   * caches the result, and appends a structural summary to the data source. */
  analyzeDataSourceStructure: (id: string, opts?: { force?: boolean }) =>
    jfetch<{
      ok: boolean;
      pdbId: string;
      dataSourceId: string;
      cached: boolean;
      title: string;
      atomCount: number;
      residueCount: number;
      chainCount: number;
      ligandCount: number;
      contextMarkdown: string;
      analysis: any;
      updatedAt: string;
    }>(`/api/data-sources/${id}/analyze-structure`, {
      method: "POST",
      body: JSON.stringify({ force: opts?.force ?? false, includeInterfaces: true, updateSummary: true }),
    }),
  /** Analyze a structure directly by PDB ID (no data source required). */
  analyzeStructureById: (pdbId: string, opts?: { force?: boolean }) =>
    jfetch<{
      ok: boolean;
      pdbId: string;
      cached: boolean;
      title: string;
      atomCount: number;
      residueCount: number;
      chainCount: number;
      ligandCount: number;
      contextMarkdown: string;
      analysis: any;
      updatedAt: string;
    }>(`/api/structures/analyze`, {
      method: "POST",
      body: JSON.stringify({ pdbId, force: opts?.force ?? false, includeInterfaces: true }),
    }),
  /** Get a cached structure analysis (404 if not yet analyzed). */
  getCachedStructureAnalysis: (pdbId: string) =>
    jfetch<{
      ok: boolean;
      pdbId: string;
      analysis: any;
      contextMarkdown: string;
      title: string;
    }>(`/api/structures/${pdbId.toUpperCase()}`),
  /** Molcraft fusion: compare two structures (Kabsch RMSD + TM-score + sequence identity). */
  compareStructures: (
    referencePdbId: string,
    mobilePdbId: string,
    opts?: { refChain?: string; mobChain?: string; method?: "sequence" | "residue-number" }
  ) =>
    jfetch<{
      ok: boolean;
      comparison: any;
      contextMarkdown: string;
    }>(`/api/structures/compare`, {
      method: "POST",
      body: JSON.stringify({
        referencePdbId,
        mobilePdbId,
        refChain: opts?.refChain,
        mobChain: opts?.mobChain,
        method: opts?.method ?? "sequence",
      }),
    }),
  /** List all analyzed structures for a project (for the "Insert structure analysis" popover). */
  listProjectStructures: (projectId: string) =>
    jfetch<{
      analyses: Array<{
        pdbId: string;
        title: string;
        chainCount: number;
        residueCount: number;
        ligandCount: number;
        atomCount: number;
        contextMarkdown: string;
        updatedAt: string;
      }>;
    }>(`/api/structures/list?projectId=${projectId}`),
  /** Batch-analyze all unanalyzed RCSB structures in a project. */
  batchAnalyzeStructures: (projectId: string, opts?: { force?: boolean }) =>
    jfetch<{
      ok: boolean;
      total: number;
      analyzed: number;
      skipped: number;
      failed: number;
      results: Array<{
        pdbId: string;
        status: "analyzed" | "failed";
        chainCount?: number;
        residueCount?: number;
        ligandCount?: number;
        error?: string;
      }>;
      message?: string;
    }>(`/api/structures/batch-analyze`, {
      method: "POST",
      body: JSON.stringify({ projectId, force: opts?.force ?? false }),
    }),
  /** Compute pairwise comparison matrix (RMSD/TM-score/identity) for a project.
   * If force=true, bypasses the cache and recomputes. */
  computeComparisonMatrix: (projectId: string, opts?: { force?: boolean }) =>
    jfetch<{
      ok: boolean;
      matrix: {
        pdbIds: string[];
        rmsdMatrix: number[][];
        tmScoreMatrix: number[][];
        identityMatrix: number[][];
        entries: Array<{
          referencePdbId: string;
          mobilePdbId: string;
          rmsd: number;
          tmScore: number;
          sequenceIdentity: number;
          numAligned: number;
          foldAssessment: string;
        }>;
        n: number;
      };
      cached: boolean;
      message?: string;
    }>(`/api/structures/comparison-matrix`, {
      method: "POST",
      body: JSON.stringify({ projectId, force: opts?.force ?? false }),
    }),
  deleteDataSource: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/data-sources/${id}`, { method: "DELETE" }),

  /* Articles */
  listTrashedArticles: (projectId?: string) =>
    jfetch<{ articles: (Article & { _count: any })[] }>(`/api/articles?trash=true${projectId ? `&projectId=${projectId}` : ""}`),
  deleteArticle: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/articles/${id}`, { method: "DELETE" }),
  permanentDeleteArticle: (id: string) =>
    jfetch<{ ok: boolean; permanent: boolean }>(`/api/articles/${id}?permanent=true`, { method: "DELETE" }),
  restoreArticle: (id: string) =>
    jfetch<{ ok: boolean; article: Article }>(`/api/articles/${id}/restore`, { method: "POST" }),
  batchArticles: (action: "restore" | "delete", ids: string[]) =>
    jfetch<{ ok: boolean; action: string; affected: number }>(`/api/articles/batch`, {
      method: "POST",
      body: JSON.stringify({ action, ids }),
    }),
};
