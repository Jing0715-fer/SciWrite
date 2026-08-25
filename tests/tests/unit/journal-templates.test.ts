import { test, expect, describe } from "bun:test";
import { JOURNAL_TEMPLATES, getJournalTemplate } from "@/lib/journal-templates";

describe("JOURNAL_TEMPLATES registry", () => {
  test("has at least 7 templates", () => {
    expect(JOURNAL_TEMPLATES.length).toBeGreaterThanOrEqual(7);
  });

  test("every template has a unique id", () => {
    const ids = JOURNAL_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("includes nature, cell, science, and generic", () => {
    const ids = JOURNAL_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("nature");
    expect(ids).toContain("cell");
    expect(ids).toContain("science");
    expect(ids).toContain("generic");
  });

  test("every template has at least 4 sections", () => {
    for (const t of JOURNAL_TEMPLATES) {
      expect(t.sections.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("every template has at least one required section", () => {
    for (const t of JOURNAL_TEMPLATES) {
      expect(t.sections.some((s) => s.required)).toBe(true);
    }
  });

  test("every template declares a citation style (numeric/author-year/superscript)", () => {
    const valid = new Set(["numeric", "author-year", "superscript"]);
    for (const t of JOURNAL_TEMPLATES) {
      expect(valid.has(t.citation.style)).toBe(true);
    }
  });

  test("every template has a positive abstract maxWords", () => {
    for (const t of JOURNAL_TEMPLATES) {
      expect(t.abstract.maxWords).toBeGreaterThan(0);
    }
  });

  test("every section has a non-empty label and guideline", () => {
    for (const t of JOURNAL_TEMPLATES) {
      for (const s of t.sections) {
        expect(s.label.length).toBeGreaterThan(0);
        expect(s.guideline.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("getJournalTemplate", () => {
  test("returns the template for a known id", () => {
    const t = getJournalTemplate("nature");
    expect(t).not.toBeNull();
    expect(t?.id).toBe("nature");
  });

  test("returns null for an unknown id", () => {
    expect(getJournalTemplate("does-not-exist")).toBeNull();
  });

  test("returns null for null", () => {
    expect(getJournalTemplate(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(getJournalTemplate(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(getJournalTemplate("")).toBeNull();
  });

  test("Nature uses superscript citations", () => {
    expect(getJournalTemplate("nature")?.citation.style).toBe("superscript");
  });

  test("Cell uses author-year citations", () => {
    expect(getJournalTemplate("cell")?.citation.style).toBe("author-year");
  });

  test("Science uses numeric citations", () => {
    expect(getJournalTemplate("science")?.citation.style).toBe("numeric");
  });
});
