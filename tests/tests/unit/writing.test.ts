import { test, expect, describe } from "bun:test";
import {
  formatLabel,
  scenarioLabel,
  buildCitationContext,
  writingSystemPrompt,
  buildWritePrompt,
  buildRevisePrompt,
  renumberByAppearance,
  summarizeDataSource,
  countWords,
  cleanArticleContent,
  sanitizeSectionContent,
} from "@/lib/writing";
import type { Annotation } from "@/lib/types";

describe("formatLabel", () => {
  test("known format returns its label", () => {
    expect(formatLabel("abstract")).toBe("Abstract");
    expect(formatLabel("intro")).toBe("Introduction");
    expect(formatLabel("results")).toBe("Results");
    expect(formatLabel("discussion")).toBe("Discussion");
  });

  test("unknown format returns the raw id", () => {
    expect(formatLabel("nonexistent" as any)).toBe("nonexistent");
  });
});

describe("scenarioLabel", () => {
  test("known scenario returns its label", () => {
    expect(scenarioLabel("literature-review")).toBe("Literature Review");
    expect(scenarioLabel("protein-structure")).toBe("Protein Structure Analysis");
    expect(scenarioLabel("custom")).toBe("Custom");
  });

  test("unknown scenario returns the raw id", () => {
    expect(scenarioLabel("does-not-exist" as any)).toBe("does-not-exist");
  });
});

describe("buildCitationContext", () => {
  test("empty array returns empty string", () => {
    expect(buildCitationContext([])).toBe("");
  });

  test("builds a numbered REFERENCES block", () => {
    const out = buildCitationContext([
      { title: "Title A", authors: "Smith J", journal: "Nature", year: "2020", url: "http://a" },
      { title: "Title B", authors: "Doe K", journal: "Cell", year: "2021", url: "http://b" },
    ]);
    expect(out.startsWith("REFERENCES:")).toBe(true);
    expect(out).toContain("[1] Smith J (2020), *Nature*. Title A.");
    expect(out).toContain("[2] Doe K (2021), *Cell*. Title B.");
  });

  test("uses Anonymous when no authors", () => {
    const out = buildCitationContext([{ title: "Anon title", year: "2022" }]);
    expect(out).toContain("Anonymous (2022)");
  });

  test("supports custom prefix", () => {
    const out = buildCitationContext([{ title: "T", authors: "X", year: "2023" }], "MY REFS");
    expect(out.startsWith("MY REFS:")).toBe(true);
  });

  test("includes url when present", () => {
    const out = buildCitationContext([
      { title: "WithUrl", authors: "A", year: "2020", url: "https://example.com/x" },
    ]);
    expect(out).toContain("— https://example.com/x");
  });

  test("includes source:ID marker when externalId present", () => {
    const out = buildCitationContext([
      { title: "T", authors: "A", year: "2020", externalId: "12345", source: "pubmed" },
    ]);
    expect(out).toContain("[PUBMED:12345]");
  });
});

describe("writingSystemPrompt", () => {
  test("includes format and scenario labels", () => {
    const p = writingSystemPrompt({ format: "abstract", scenario: "literature-review" });
    expect(p).toContain("Abstract");
    expect(p).toContain("Literature Review");
  });

  test("defaults to English", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom" });
    expect(p.toLowerCase()).toContain("english");
  });

  test("switches to Chinese for zh", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom", language: "zh" });
    expect(p).toContain("中文");
  });

  test("switches to Chinese for 中文", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom", language: "中文" });
    expect(p).toContain("中文");
  });

  test("switches to Chinese for Chinese", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom", language: "Chinese" });
    expect(p).toContain("中文");
  });

  test("bilingual for both", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom", language: "both" });
    expect(p.toLowerCase()).toContain("english");
    expect(p).toContain("中文");
    expect(p).toContain("## 中文");
  });

  test("bilingual for 中英", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom", language: "中英" });
    expect(p.toLowerCase()).toContain("english");
    expect(p).toContain("中文");
  });

  test("includes field when provided", () => {
    const p = writingSystemPrompt({
      format: "intro",
      scenario: "custom",
      field: "structural biology",
    });
    expect(p).toContain("structural biology");
  });

  test("forbids fabricated citations", () => {
    const p = writingSystemPrompt({ format: "intro", scenario: "custom" });
    expect(p.toLowerCase()).toContain("no fabricated");
  });
});

describe("buildWritePrompt", () => {
  test("always includes the topic", () => {
    const p = buildWritePrompt({
      topic: "CRISPR off-target effects",
      format: "intro",
      scenario: "custom",
      referencesContext: "",
      searchContext: "",
    });
    expect(p).toContain("CRISPR off-target effects");
    expect(p).toContain("RESEARCH TOPIC");
  });

  test("includes focus when provided", () => {
    const p = buildWritePrompt({
      topic: "T",
      focus: "focus-angle",
      format: "intro",
      scenario: "custom",
      referencesContext: "",
      searchContext: "",
    });
    expect(p).toContain("focus-angle");
    expect(p).toContain("FOCUS");
  });

  test("includes referencesContext when provided", () => {
    const p = buildWritePrompt({
      topic: "T",
      format: "intro",
      scenario: "custom",
      referencesContext: "REFERENCES:\n[1] X (2020) Y.",
      searchContext: "",
    });
    expect(p).toContain("REFERENCES:");
    expect(p).toContain("[1] X (2020) Y.");
  });

  test("includes searchContext when provided", () => {
    const p = buildWritePrompt({
      topic: "T",
      format: "intro",
      scenario: "custom",
      referencesContext: "",
      searchContext: "Some web snippet about topic",
    });
    expect(p).toContain("WEB-RETRIEVED CONTEXT");
    expect(p).toContain("Some web snippet about topic");
  });
});

describe("buildRevisePrompt", () => {
  const baseContent = "This is the paragraph. It cites [1].";

  test("includes the content", () => {
    const p = buildRevisePrompt({
      content: baseContent,
      annotations: [],
      mode: "polish",
    });
    expect(p).toContain(baseContent);
    expect(p).toContain("CURRENT PARAGRAPH");
  });

  test("lists annotations in annotations mode", () => {
    const annotations: Annotation[] = [
      {
        id: "a1",
        paragraphId: "p1",
        startOffset: 0,
        endOffset: 5,
        selectedText: "This is",
        comment: "Reword this",
        type: "revise-request",
        severity: "warning",
        resolved: false,
      },
      {
        id: "a2",
        paragraphId: "p1",
        startOffset: 5,
        endOffset: 10,
        selectedText: "paragraph",
        comment: "Unclear",
        type: "comment",
        severity: "info",
        resolved: false,
      },
    ];
    const p = buildRevisePrompt({
      content: baseContent,
      annotations,
      mode: "annotations",
    });
    expect(p).toContain("REVIEWER ANNOTATIONS");
    expect(p).toContain("Reword this");
    expect(p).toContain("Unclear");
    expect(p).toContain("[1]");
    expect(p).toContain("[2]");
  });

  test("includes instructions in instructions mode", () => {
    const p = buildRevisePrompt({
      content: baseContent,
      annotations: [],
      mode: "instructions",
      instructions: "Make it more concise and active voice.",
    });
    expect(p).toContain("REVISION INSTRUCTIONS");
    expect(p).toContain("Make it more concise and active voice.");
  });

  test("polish mode has no annotation list", () => {
    const p = buildRevisePrompt({
      content: baseContent,
      annotations: [
        {
          id: "x",
          paragraphId: "p",
          startOffset: 0,
          endOffset: 1,
          selectedText: "T",
          comment: "should-not-appear",
          type: "comment",
          severity: "info",
          resolved: false,
        },
      ],
      mode: "polish",
    });
    expect(p).not.toContain("REVIEWER ANNOTATIONS");
    expect(p).not.toContain("should-not-appear");
    expect(p.toLowerCase()).toContain("polish");
  });
});

describe("renumberByAppearance", () => {
  const refs = [
    { id: "r1", title: "First" },
    { id: "r2", title: "Second" },
    { id: "r3", title: "Third" },
    { id: "r4", title: "Fourth" },
  ];

  test("empty refs returns content unchanged", () => {
    const { content, references } = renumberByAppearance("hello [1] world", []);
    expect(content).toBe("hello [1] world");
    expect(references).toEqual([]);
  });

  test("renumbers by first appearance", () => {
    // [3] appears before [1] → new numbering should be [1]=old3, [2]=old1
    const { content, references } = renumberByAppearance("see [3] and [1] and [3] again", refs);
    expect(content).toBe("see [1] and [2] and [1] again");
    expect(references.map((r) => r.id)).toEqual(["r3", "r1"]);
  });

  test("excludes uncited refs", () => {
    const { content, references } = renumberByAppearance("only [2] is cited", refs);
    expect(content).toBe("only [1] is cited");
    expect(references).toHaveLength(1);
    expect(references[0].id).toBe("r2");
  });

  test("expands ranges [1-3]", () => {
    const { content, references } = renumberByAppearance("as reported [1-3]", refs);
    expect(content).toBe("as reported [1,2,3]");
    expect(references.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  test("handles comma-separated [1,3]", () => {
    const { content, references } = renumberByAppearance("see [1,3]", refs);
    expect(content).toBe("see [1,2]");
    expect(references.map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  test("preserves ### Citations tail", () => {
    const contentWithTail =
      "body [2] text\n\n### Citations\n[1] Old\n[2] Old\n[3] Old\n[4] Old\n";
    const { content, references } = renumberByAppearance(contentWithTail, refs);
    expect(content).toContain("### Citations");
    expect(content).toContain("body [1] text");
    // The tail is preserved as-is (we don't rewrite inside it)
    expect(content).toContain("[1] Old");
  });

  test("keeps out-of-range numbers unchanged", () => {
    // [99] is out of range (refs.length === 4)
    const { content, references } = renumberByAppearance("see [99] and [1]", refs);
    expect(content).toContain("[99]");
    expect(content).toContain("[1]");
    expect(references.map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("summarizeDataSource", () => {
  test("empty array returns empty string", () => {
    expect(summarizeDataSource([])).toBe("");
  });

  test("limits to 8 items", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      externalId: `id-${i}`,
      title: `Title ${i}`,
      source: "pubmed" as const,
      url: `http://${i}`,
    }));
    const out = summarizeDataSource(items);
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(8);
    // numbering should be 1..8
    expect(lines[0]).toContain("[1]");
    expect(lines[7]).toContain("[8]");
  });

  test("includes source:ID marker", () => {
    const out = summarizeDataSource([
      {
        externalId: "ABC123",
        title: "Some title",
        source: "pdb",
        url: "http://x",
      } as any,
    ]);
    expect(out).toContain("[PDB:ABC123]");
  });
});

describe("countWords", () => {
  test("normal sentence", () => {
    expect(countWords("The quick brown fox jumps")).toBe(5);
  });

  test("empty string returns 0", () => {
    expect(countWords("")).toBe(0);
  });

  test("whitespace-only returns 0", () => {
    expect(countWords("   \t\t\n  ")).toBe(0);
  });

  test("handles leading and trailing whitespace", () => {
    expect(countWords("   hello   world   ")).toBe(2);
  });
});

describe("cleanArticleContent", () => {
  test("no duplicates returns unchanged", () => {
    const content = "Intro paragraph.\n\n## Methods\n\nSome methods text.";
    expect(cleanArticleContent(content)).toBe(content);
  });

  test("removes duplicates keeping the last", () => {
    const content =
      "Intro paragraph.\n\nMore body text.\n\n## References\n\n[1] Old\n\n## References\n\n[1] New";
    const cleaned = cleanArticleContent(content);
    // Only the last ## References block survives
    const matches = cleaned.match(/## References/g) || [];
    expect(matches).toHaveLength(1);
    expect(cleaned).toContain("[1] New");
    expect(cleaned).not.toContain("[1] Old");
    // Body text BEFORE the first reference header is preserved
    expect(cleaned).toContain("Intro paragraph.");
    expect(cleaned).toContain("More body text.");
  });

  test("handles uppercase REFERENCES", () => {
    const content =
      "Body.\n\nREFERENCES\n\n[1] Old\n\nMore.\n\nREFERENCES\n\n[1] New";
    const cleaned = cleanArticleContent(content);
    const matches = cleaned.match(/^REFERENCES$/gm) || [];
    expect(matches).toHaveLength(1);
    expect(cleaned).toContain("[1] New");
  });
});

describe("sanitizeSectionContent", () => {
  test("empty string is returned unchanged", () => {
    expect(sanitizeSectionContent("")).toBe("");
  });

  test("removes ### Citations block", () => {
    const content = "Real body text here.\n\n### Citations\n[1] X (2020) Y.";
    const cleaned = sanitizeSectionContent(content);
    expect(cleaned).not.toContain("### Citations");
    expect(cleaned).not.toContain("[1] X (2020) Y.");
    expect(cleaned).toContain("Real body text here.");
  });

  test("removes horizontal rules", () => {
    const content = "Paragraph one.\n\n---\n\nParagraph two.";
    const cleaned = sanitizeSectionContent(content);
    expect(cleaned).not.toContain("---");
    expect(cleaned).toContain("Paragraph one.");
    expect(cleaned).toContain("Paragraph two.");
  });

  test("removes preambles", () => {
    const content =
      "Now I'll compose the section about proteins.\n\nThe protein structure reveals...";
    const cleaned = sanitizeSectionContent(content);
    expect(cleaned).not.toContain("Now I'll compose");
    expect(cleaned.startsWith("The protein structure")).toBe(true);
  });

  test("detects meta-summary and returns placeholder", () => {
    const content =
      "This section covers the structural biology of TMC1 and summarizes the findings.";
    const cleaned = sanitizeSectionContent(content);
    expect(cleaned).toContain("[Content generation issue");
    expect(cleaned).toContain("Original LLM output:");
  });

  test("removes leading markdown header", () => {
    const content = "## Section Title\n\nReal paragraph content goes here.";
    const cleaned = sanitizeSectionContent(content);
    expect(cleaned.startsWith("## Section Title")).toBe(false);
    expect(cleaned.startsWith("Real paragraph content")).toBe(true);
  });

  test("collapses excessive newlines", () => {
    const content = "Paragraph one.\n\n\n\n\n\nParagraph two.";
    const cleaned = sanitizeSectionContent(content);
    expect(cleaned).not.toMatch(/\n{3,}/);
  });
});
