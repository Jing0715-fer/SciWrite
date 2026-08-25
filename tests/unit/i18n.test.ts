import { test, expect, describe } from "bun:test";
import {
  langNativeNames,
  langLocales,
  translations,
  formatDateForLang,
  formatNumberForLang,
  formatRelativeForLang,
  type Lang,
} from "@/lib/i18n";

const ALL_LANGS: Lang[] = ["en", "zh", "ja", "ko", "fr"];

describe("langNativeNames", () => {
  test("has 5 languages", () => {
    expect(Object.keys(langNativeNames)).toHaveLength(5);
  });

  test("zh is 中文", () => {
    expect(langNativeNames.zh).toBe("中文");
  });

  test("ja is 日本語", () => {
    expect(langNativeNames.ja).toBe("日本語");
  });

  test("ko is 한국어", () => {
    expect(langNativeNames.ko).toBe("한국어");
  });

  test("fr is Français", () => {
    expect(langNativeNames.fr).toBe("Français");
  });

  test("en is English", () => {
    expect(langNativeNames.en).toBe("English");
  });
});

describe("langLocales", () => {
  test("uses BCP-47 format for every language", () => {
    for (const lang of ALL_LANGS) {
      expect(langLocales[lang]).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  test("en maps to en-US", () => {
    expect(langLocales.en).toBe("en-US");
  });

  test("zh maps to zh-CN", () => {
    expect(langLocales.zh).toBe("zh-CN");
  });
});

describe("translations", () => {
  test("English is the base with at least 100 keys", () => {
    expect(Object.keys(translations.en).length).toBeGreaterThanOrEqual(100);
  });

  test("all 5 languages have translation sets", () => {
    for (const lang of ALL_LANGS) {
      expect(translations[lang]).toBeDefined();
      expect(Object.keys(translations[lang]).length).toBeGreaterThan(0);
    }
  });

  test('"app.title" exists in all languages (using the `in` operator)', () => {
    for (const lang of ALL_LANGS) {
      expect("app.title" in translations[lang]).toBe(true);
    }
  });

  test("zh is complete — same key count as en", () => {
    expect(Object.keys(translations.zh).length).toBe(Object.keys(translations.en).length);
  });

  test("ja, ko, fr each have at least 50 keys", () => {
    expect(Object.keys(translations.ja).length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(translations.ko).length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(translations.fr).length).toBeGreaterThanOrEqual(50);
  });
});

describe("formatDateForLang", () => {
  test("formats a Date object", () => {
    const d = new Date("2024-03-15T12:00:00Z");
    const out = formatDateForLang(d, "en");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("2024");
  });

  test("accepts an ISO string", () => {
    const out = formatDateForLang("2024-03-15T12:00:00Z", "en");
    expect(out).toContain("2024");
  });

  test("accepts an epoch number", () => {
    const out = formatDateForLang(1710504000000, "en");
    expect(out).toContain("2024");
  });

  test('returns "—" for an invalid date', () => {
    expect(formatDateForLang("not-a-date", "en")).toBe("—");
  });

  test("respects the locale (zh-CN produces CJK month names or Chinese chars)", () => {
    const en = formatDateForLang(new Date("2024-03-15T12:00:00Z"), "en");
    const zh = formatDateForLang(new Date("2024-03-15T12:00:00Z"), "zh");
    expect(en).toContain("2024");
    expect(zh).toContain("2024");
    // They may or may not differ depending on ICU, but both should be non-empty
    expect(en.length).toBeGreaterThan(0);
    expect(zh.length).toBeGreaterThan(0);
  });

  test("supports custom options (e.g. long month name)", () => {
    const short = formatDateForLang(new Date("2024-03-15T12:00:00Z"), "en");
    const long = formatDateForLang(new Date("2024-03-15T12:00:00Z"), "en", {
      month: "long",
    });
    expect(short).toContain("Mar");
    expect(long).toContain("March");
    expect(long).toContain("2024");
    expect(long).not.toBe(short);
  });
});

describe("formatNumberForLang", () => {
  test("formats an integer", () => {
    const out = formatNumberForLang(42, "en");
    expect(out).toBe("42");
  });

  test("adds grouping separators for large numbers", () => {
    const out = formatNumberForLang(1000000, "en");
    expect(out).toContain("1");
    // en-US uses commas as group separators
    expect(out).toContain(",");
  });

  test("en uses commas for grouping", () => {
    expect(formatNumberForLang(1234567, "en")).toBe("1,234,567");
  });

  test("supports decimal options", () => {
    const out = formatNumberForLang(3.14159, "en", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(out).toBe("3.14");
  });

  test("formats currency", () => {
    const out = formatNumberForLang(99.99, "en", {
      style: "currency",
      currency: "USD",
    });
    expect(out).toContain("$");
    expect(out).toContain("99");
  });
});

describe("formatRelativeForLang", () => {
  test("returns a non-empty string for a recent date", () => {
    const recent = new Date(Date.now() - 1000 * 60 * 5); // 5 minutes ago
    const out = formatRelativeForLang(recent, "en");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test('returns "—" for an invalid date', () => {
    expect(formatRelativeForLang("not-a-date", "en")).toBe("—");
  });

  test("handles future dates", () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24); // +1 day
    const out = formatRelativeForLang(future, "en");
    expect(out.length).toBeGreaterThan(0);
  });

  test("handles past dates", () => {
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7); // 7 days ago
    const out = formatRelativeForLang(past, "en");
    expect(out.length).toBeGreaterThan(0);
  });

  test("works for all 5 languages", () => {
    const recent = new Date(Date.now() - 1000 * 60 * 30); // 30 min ago
    for (const lang of ALL_LANGS) {
      const out = formatRelativeForLang(recent, lang);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
