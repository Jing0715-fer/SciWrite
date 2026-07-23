import type {
  DatabaseQueryResponse,
  DatabaseResultItem,
  WriteRequest,
  ComposeRequest,
  Annotation,
  Paragraph,
  Reference,
  DataSource,
  Project,
  Article,
} from "./types";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
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
    jfetch<{ project: Project & { paragraphs: any[]; dataSources: DataSource[]; articles: Article[] } }>(
      `/api/projects/${id}`
    ),
  updateProject: (id: string, input: Partial<Project>) =>
    jfetch<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteProject: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),

  /* Paragraphs */
  listParagraphs: (projectId?: string) =>
    jfetch<{ paragraphs: (Paragraph & { annotations: Annotation[]; references: Reference[] })[] }>(
      `/api/paragraphs${projectId ? `?projectId=${projectId}` : ""}`
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

  /* AI write */
  aiWrite: (input: WriteRequest) =>
    jfetch<{ paragraph: Paragraph | null; content: string }>(`/api/ai/write`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* AI compose */
  aiCompose: (input: ComposeRequest) =>
    jfetch<{ article: Article; content: string; wordCount: number; sourceParagraphs: number }>(
      `/api/ai/compose`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  /* AI gather sources (clarify / organize / critique) */
  aiGather: (input: any) =>
    jfetch<any>(`/api/ai/gather`, { method: "POST", body: JSON.stringify(input) }),

  /* Export */
  exportDoc: (input: {
    type: "paragraph" | "article";
    id: string;
    format: "docx" | "pdf" | "markdown";
    includeAnnotations?: boolean;
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
      return res.blob();
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

  /* Web search / reader */
  webSearch: (query: string, num = 8) =>
    jfetch<{ query: string; items: any[] }>(`/api/search`, {
      method: "POST",
      body: JSON.stringify({ query, num }),
    }),
  readPage: (url: string) =>
    jfetch<{ title?: string; text?: string; html?: string; url?: string }>(`/api/reader`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  /* References */
  listReferences: (projectId?: string) =>
    jfetch<{ references: Reference[] }>(`/api/references${projectId ? `?projectId=${projectId}` : ""}`),
  createReference: (input: Partial<Reference>) =>
    jfetch<{ reference: Reference }>(`/api/references`, { method: "POST", body: JSON.stringify(input) }),
  deleteReference: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/references/${id}`, { method: "DELETE" }),

  /* Data sources */
  listDataSources: (projectId?: string) =>
    jfetch<{ dataSources: DataSource[] }>(`/api/data-sources${projectId ? `?projectId=${projectId}` : ""}`),
  createDataSource: (input: Partial<DataSource> & { rawJson?: any }) =>
    jfetch<{ dataSource: DataSource }>(`/api/data-sources`, { method: "POST", body: JSON.stringify(input) }),
  updateDataSource: (id: string, input: Partial<DataSource>) =>
    jfetch<{ dataSource: DataSource }>(`/api/data-sources/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteDataSource: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/data-sources/${id}`, { method: "DELETE" }),

  /* Articles */
  listArticles: (projectId?: string) =>
    jfetch<{ articles: (Article & { _count: any })[] }>(`/api/articles${projectId ? `?projectId=${projectId}` : ""}`),
  getArticle: (id: string) =>
    jfetch<{ article: Article & { articleParagraph: any[] } }>(`/api/articles/${id}`),
  deleteArticle: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/articles/${id}`, { method: "DELETE" }),
};

export type { DatabaseResultItem };
