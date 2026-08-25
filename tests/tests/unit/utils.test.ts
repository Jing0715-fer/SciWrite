import { test, expect, describe } from "bun:test";
import { cn } from "@/lib/utils";

describe("cn", () => {
  test("joins multiple class strings", () => {
    expect(cn("foo", "bar", "baz")).toBe("foo bar baz");
  });

  test("returns a single class unchanged", () => {
    expect(cn("only")).toBe("only");
  });

  test("returns an empty string when given no arguments", () => {
    expect(cn()).toBe("");
  });

  test("filters falsy values (false, null, undefined, empty string)", () => {
    expect(cn("foo", false, null, undefined, "", "bar")).toBe("foo bar");
  });

  test("supports conditional objects", () => {
    expect(cn("foo", { bar: true, baz: false })).toBe("foo bar");
  });

  test("supports arrays", () => {
    expect(cn("foo", ["bar", "baz"])).toBe("foo bar baz");
  });

  test("tailwind-merge deduplicates conflicting classes (px-2 + px-4 = px-4)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  test("preserves non-conflicting classes", () => {
    expect(cn("px-2", "py-4", "text-center")).toBe("px-2 py-4 text-center");
  });

  test("handles mixed inputs (strings, objects, arrays, falsy)", () => {
    const result = cn("base", ["arr-1", "arr-2"], { on: true, off: false }, false && "no", "end");
    expect(result).toBe("base arr-1 arr-2 on end");
  });
});
