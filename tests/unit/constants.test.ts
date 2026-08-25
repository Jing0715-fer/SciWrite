import { test, expect, describe } from "bun:test";
import {
  DATABASE_SOURCES,
  PARAGRAPH_FORMATS,
  PARAGRAPH_SCENARIOS,
  ANNOTATION_TYPES,
  SEVERITY_STYLES,
  STATUS_STYLES,
  SOURCE_COLOR,
} from "@/lib/constants";

describe("DATABASE_SOURCES", () => {
  test("has exactly 5 sources", () => {
    expect(DATABASE_SOURCES).toHaveLength(5);
  });

  test("includes pubmed, uniprot, rcsb, ncbi, blast", () => {
    const ids = DATABASE_SOURCES.map((s) => s.id);
    expect(ids).toContain("pubmed");
    expect(ids).toContain("uniprot");
    expect(ids).toContain("rcsb");
    expect(ids).toContain("ncbi");
    expect(ids).toContain("blast");
  });

  test("every source id is unique", () => {
    const ids = DATABASE_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every source has all metadata fields", () => {
    for (const s of DATABASE_SOURCES) {
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.shortName).toBe("string");
      expect(s.shortName.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe("string");
      expect(s.description.length).toBeGreaterThan(0);
      expect(typeof s.color).toBe("string");
      expect(s.color.length).toBeGreaterThan(0);
      expect(typeof s.queryLabel).toBe("string");
      expect(s.queryLabel.length).toBeGreaterThan(0);
      expect(typeof s.queryPlaceholder).toBe("string");
      expect(typeof s.example).toBe("string");
    }
  });
});

describe("PARAGRAPH_FORMATS", () => {
  test("has at least 7 formats", () => {
    expect(PARAGRAPH_FORMATS.length).toBeGreaterThanOrEqual(7);
  });

  test("includes the core formats (abstract/intro/methods/results/discussion/conclusion)", () => {
    const ids = PARAGRAPH_FORMATS.map((f) => f.id);
    expect(ids).toContain("abstract");
    expect(ids).toContain("intro");
    expect(ids).toContain("methods");
    expect(ids).toContain("results");
    expect(ids).toContain("discussion");
    expect(ids).toContain("conclusion");
  });

  test("every format id is unique", () => {
    const ids = PARAGRAPH_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every format has a non-empty label and hint", () => {
    for (const f of PARAGRAPH_FORMATS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("PARAGRAPH_SCENARIOS", () => {
  test("has at least 7 scenarios", () => {
    expect(PARAGRAPH_SCENARIOS.length).toBeGreaterThanOrEqual(7);
  });

  test("includes literature-review and custom", () => {
    const ids = PARAGRAPH_SCENARIOS.map((s) => s.id);
    expect(ids).toContain("literature-review");
    expect(ids).toContain("custom");
  });

  test("every scenario id is unique", () => {
    const ids = PARAGRAPH_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every scenario has a non-empty label, hint, and icon", () => {
    for (const s of PARAGRAPH_SCENARIOS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("ANNOTATION_TYPES", () => {
  test("has exactly 5 types", () => {
    expect(ANNOTATION_TYPES).toHaveLength(5);
  });

  test("includes all 5 type ids (revise-request, comment, question, highlight, praise)", () => {
    const ids = ANNOTATION_TYPES.map((t) => t.id);
    expect(ids).toContain("revise-request");
    expect(ids).toContain("comment");
    expect(ids).toContain("question");
    expect(ids).toContain("highlight");
    expect(ids).toContain("praise");
  });

  test("every type id is unique", () => {
    const ids = ANNOTATION_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("SEVERITY_STYLES", () => {
  test("defines info, warning, and critical", () => {
    expect(SEVERITY_STYLES.info).toBeDefined();
    expect(SEVERITY_STYLES.warning).toBeDefined();
    expect(SEVERITY_STYLES.critical).toBeDefined();
  });

  test("every severity has a label and a color", () => {
    for (const key of Object.keys(SEVERITY_STYLES) as Array<keyof typeof SEVERITY_STYLES>) {
      const s = SEVERITY_STYLES[key];
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.color.length).toBeGreaterThan(0);
    }
  });
});

describe("STATUS_STYLES", () => {
  test("defines draft, annotated, revised, and finalized", () => {
    expect(STATUS_STYLES.draft).toBeDefined();
    expect(STATUS_STYLES.annotated).toBeDefined();
    expect(STATUS_STYLES.revised).toBeDefined();
    expect(STATUS_STYLES.finalized).toBeDefined();
  });

  test("every status has a label, color, and icon", () => {
    for (const key of Object.keys(STATUS_STYLES)) {
      const s = STATUS_STYLES[key];
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.color.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("SOURCE_COLOR", () => {
  test("maps every DATABASE_SOURCES id to a color", () => {
    for (const src of DATABASE_SOURCES) {
      expect(SOURCE_COLOR[src.id]).toBeDefined();
      expect(typeof SOURCE_COLOR[src.id]).toBe("string");
      expect(SOURCE_COLOR[src.id].length).toBeGreaterThan(0);
    }
  });

  test("includes the web color", () => {
    expect(SOURCE_COLOR.web).toBeDefined();
    expect(SOURCE_COLOR.web.length).toBeGreaterThan(0);
  });
});
