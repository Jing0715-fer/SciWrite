import { test, expect, describe } from "bun:test";

const BASE = "http://localhost:3000";

/**
 * Helper: make a JSON fetch against the dev server.
 * Returns { status, body } where body is the parsed JSON (or null if non-JSON).
 */
async function api(
  path: string,
  init?: RequestInit & { body?: unknown }
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (init?.body !== undefined && init?.body !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    body,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// Shared state across tests (bun:test runs tests sequentially within a file).
let testProjectId: string;
let testParagraphId: string;
let testReferenceId: string;
const createdProjectIds: string[] = [];

// 1. API health
describe("API health", () => {
  test("GET /api/projects returns 200", async () => {
    const { status, body } = await api("/api/projects");
    expect(status).toBe(200);
    expect(Array.isArray(body.projects)).toBe(true);
  });

  test("GET /api/llm-cache/stats returns 200 with stats shape", async () => {
    const { status, body } = await api("/api/llm-cache/stats");
    expect(status).toBe(200);
    expect(body.stats).toBeDefined();
    expect(typeof body.stats.size).toBe("number");
    expect(typeof body.stats.hits).toBe("number");
    expect(typeof body.stats.misses).toBe("number");
    expect(typeof body.stats.hitRate).toBe("number");
  });
});

// 2. Project CRUD
describe("Project CRUD", () => {
  test("POST /api/projects creates a project", async () => {
    const { status, body } = await api("/api/projects", {
      method: "POST",
      body: {
        title: "RESTORE-TESTS Project",
        topic: "Integration testing for SciWrite",
        field: "structural biology",
        notes: "created by automated test",
      },
    });
    expect(status).toBe(200);
    expect(body.project).toBeDefined();
    expect(body.project.id).toBeTruthy();
    expect(body.project.title).toBe("RESTORE-TESTS Project");
    testProjectId = body.project.id;
    createdProjectIds.push(testProjectId);
  });

  test("GET /api/projects/[id] fetches the project", async () => {
    const { status, body } = await api(`/api/projects/${testProjectId}`);
    expect(status).toBe(200);
    expect(body.project).toBeDefined();
    expect(body.project.id).toBe(testProjectId);
    expect(body.project.topic).toBe("Integration testing for SciWrite");
  });

  test("PATCH /api/projects/[id] updates the project", async () => {
    const { status, body } = await api(`/api/projects/${testProjectId}`, {
      method: "PATCH",
      body: { title: "RESTORE-TESTS Updated" },
    });
    expect(status).toBe(200);
    expect(body.project).toBeDefined();
    expect(body.project.title).toBe("RESTORE-TESTS Updated");
  });
});

// 3. Paragraph CRUD
describe("Paragraph CRUD", () => {
  test("POST /api/paragraphs creates a paragraph", async () => {
    const { status, body } = await api("/api/paragraphs", {
      method: "POST",
      body: {
        projectId: testProjectId,
        title: "Test paragraph",
        content: "This is a test paragraph citing [1].",
        format: "intro",
        scenario: "custom",
      },
    });
    expect(status).toBe(200);
    expect(body.paragraph).toBeDefined();
    expect(body.paragraph.id).toBeTruthy();
    expect(body.paragraph.projectId).toBe(testProjectId);
    testParagraphId = body.paragraph.id;
  });

  test("PATCH /api/paragraphs/[id] updates the paragraph", async () => {
    const { status, body } = await api(`/api/paragraphs/${testParagraphId}`, {
      method: "PATCH",
      body: { content: "Updated content with [1] and [2]." },
    });
    expect(status).toBe(200);
    expect(body.paragraph).toBeDefined();
    expect(body.paragraph.content).toContain("Updated content");
  });

  test("GET /api/paragraphs/[id]/validate-citations returns results", async () => {
    const { status, body } = await api(
      `/api/paragraphs/${testParagraphId}/validate-citations`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.results)).toBe(true);
  });
});

// 4. Reference CRUD
describe("Reference CRUD", () => {
  test("POST /api/references creates a reference", async () => {
    const { status, body } = await api("/api/references", {
      method: "POST",
      body: {
        projectId: testProjectId,
        type: "manual",
        title: "Test Reference Title",
        authors: "Smith J, Doe K",
        year: "2020",
        journal: "Nature",
        doi: "10.1038/test-restore-tests",
      },
    });
    expect(status).toBe(200);
    expect(body.reference).toBeDefined();
    expect(body.reference.id).toBeTruthy();
    expect(body.reference.title).toBe("Test Reference Title");
    testReferenceId = body.reference.id;
  });

  test("DELETE /api/references/[id] removes the reference", async () => {
    const { status, body } = await api(`/api/references/${testReferenceId}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test(
    "POST /api/references/search-by-title returns 200 or 429",
    async () => {
      const { status, body } = await api("/api/references/search-by-title", {
        method: "POST",
        body: { query: "CRISPR Cas9 off-target", rows: 3 },
      });
      expect([200, 429]).toContain(status);
      if (status === 200) {
        expect(body.results).toBeDefined();
      }
    },
    { timeout: 15000 }
  );
});

// 5. Article operations
describe("Article operations", () => {
  test("GET /api/articles?trash=true returns 200 with articles array", async () => {
    const { status, body } = await api(
      `/api/articles?trash=true&projectId=${testProjectId}`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.articles)).toBe(true);
  });

  test("GET /api/articles (project list) returns 200", async () => {
    const { status, body } = await api(
      `/api/articles?trash=false&projectId=${testProjectId}`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.articles)).toBe(true);
  });
});

// 6. Project share
describe("Project share", () => {
  test("POST /api/projects/[id]/share create returns a shareToken (200 or 201)", async () => {
    const { status, body } = await api(`/api/projects/${testProjectId}/share`, {
      method: "POST",
      body: { action: "create" },
    });
    expect([200, 201]).toContain(status);
    expect(body.shareToken).toBeTruthy();
  });

  test("POST /api/projects/[id]/share revoke returns shareToken: null", async () => {
    const { status, body } = await api(`/api/projects/${testProjectId}/share`, {
      method: "POST",
      body: { action: "revoke" },
    });
    expect(status).toBe(200);
    expect(body.shareToken).toBeNull();
  });
});

// 7. Project import/export
describe("Project import/export", () => {
  test("GET /api/projects/export?projectId=... returns 200", async () => {
    const { status } = await api(
      `/api/projects/export?projectId=${testProjectId}`
    );
    expect(status).toBe(200);
  });

  test("GET /api/projects/export without projectId returns 400", async () => {
    const { status } = await api(`/api/projects/export`);
    expect(status).toBe(400);
  });
});

// 8. Prompt templates
describe("Prompt templates", () => {
  test("GET /api/prompt-templates returns 200 with templates array", async () => {
    const { status, body } = await api("/api/prompt-templates");
    expect(status).toBe(200);
    expect(Array.isArray(body.templates)).toBe(true);
  });

  test("POST /api/prompt-templates with missing required fields returns 400", async () => {
    // missing name
    const r1 = await api("/api/prompt-templates", {
      method: "POST",
      body: { taskType: "write" },
    });
    expect(r1.status).toBe(400);
    // missing taskType
    const r2 = await api("/api/prompt-templates", {
      method: "POST",
      body: { name: "Missing TaskType" },
    });
    expect(r2.status).toBe(400);
  });

  test("POST + DELETE /api/prompt-templates round-trip", async () => {
    const create = await api("/api/prompt-templates", {
      method: "POST",
      body: {
        name: "RESTORE-TESTS Template",
        taskType: "write",
        systemPrompt: "Be concise.",
        instruction: "Write one paragraph.",
      },
    });
    expect(create.status).toBe(201);
    expect(create.body.template).toBeDefined();
    const tplId = create.body.template.id;
    expect(tplId).toBeTruthy();

    const del = await api(`/api/prompt-templates/${tplId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
  });
});

// 9. Comments
describe("Comments", () => {
  test("GET /api/comments without params returns 400", async () => {
    const { status } = await api("/api/comments");
    expect(status).toBe(400);
  });

  test("GET /api/comments?paragraphId=... returns 200 with comments array", async () => {
    const { status, body } = await api(
      `/api/comments?paragraphId=${testParagraphId}`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.comments)).toBe(true);
  });
});

// 10. Annotations
describe("Annotations", () => {
  test("POST /api/paragraphs/[id]/annotate creates an annotation", async () => {
    const { status, body } = await api(
      `/api/paragraphs/${testParagraphId}/annotate`,
      {
        method: "POST",
        body: {
          type: "comment",
          severity: "info",
          comment: "RESTORE-TESTS annotation",
          selectedText: "Updated content",
        },
      }
    );
    expect(status).toBe(200);
    expect(body.annotation).toBeDefined();
    expect(body.annotation.id).toBeTruthy();
    expect(body.annotation.comment).toBe("RESTORE-TESTS annotation");
  });
});

// 11. Data sources
describe("Data sources", () => {
  test("POST /api/data-sources creates a data source", async () => {
    const { status, body } = await api("/api/data-sources", {
      method: "POST",
      body: {
        projectId: testProjectId,
        source: "pubmed",
        externalId: "RESTORE-TESTS-12345",
        title: "RESTORE-TESTS Data Source",
        authors: "Author A",
        journal: "Cell",
        year: "2021",
        url: "http://example.com/restore-tests",
      },
    });
    expect(status).toBe(200);
    expect(body.dataSource).toBeDefined();
    expect(body.dataSource.id).toBeTruthy();
    expect(body.dataSource.source).toBe("pubmed");
  });
});

// 12. Purge expired
describe("Purge expired articles", () => {
  test("POST /api/articles/purge-expired returns 200 with purged number", async () => {
    const { status, body } = await api("/api/articles/purge-expired", {
      method: "POST",
    });
    expect(status).toBe(200);
    expect(typeof body.purged).toBe("number");
  });
});

// 13. Cleanup
describe("Cleanup", () => {
  test("delete all created projects and verify they are gone from the list", async () => {
    // Add a fresh project so cleanup has at least 1 to delete beyond the shared one.
    const extra = await api("/api/projects", {
      method: "POST",
      body: {
        title: "RESTORE-TESTS Cleanup Extra",
        topic: "to be deleted",
        field: "biology",
        notes: "",
      },
    });
    expect(extra.status).toBe(200);
    createdProjectIds.push(extra.body.project.id);

    // Delete every created project.
    for (const id of createdProjectIds) {
      const del = await api(`/api/projects/${id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
    }

    // Verify none of them appear in the projects list.
    const list = await api("/api/projects");
    expect(list.status).toBe(200);
    const ids = list.body.projects.map((p: any) => p.id);
    for (const id of createdProjectIds) {
      expect(ids).not.toContain(id);
    }
  });
});
