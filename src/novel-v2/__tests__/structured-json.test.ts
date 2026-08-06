import { describe, expect, it } from "vitest";
import { parseStructuredJson } from "../structured-json";

describe("parseStructuredJson fault-tolerant JSON parsing", () => {
  it("parses clean JSON and fenced JSON", () => {
    expect(parseStructuredJson('{"name":"a","score":1}')).toEqual({ name: "a", score: 1 });
    expect(parseStructuredJson('结果：\n```json\n{"name":"a","score":1}\n```')).toEqual({ name: "a", score: 1 });
    expect(parseStructuredJson('```\n{"name":"a","score":1}\n```')).toEqual({ name: "a", score: 1 });
  });

  it("recovers from trailing commas before closing braces", () => {
    expect(parseStructuredJson('{"name":"a","score":1,}')).toEqual({ name: "a", score: 1 });
    expect(parseStructuredJson('{"list":[1,2,],}')).toEqual({ list: [1, 2] });
  });

  it("normalizes single-quote strings to double quotes", () => {
    expect(parseStructuredJson("{'name':'a','score':1}")).toEqual({ name: "a", score: 1 });
  });

  it("normalizes full-width Chinese quotes used as JSON string delimiters", () => {
    expect(parseStructuredJson("{\u201cname\u201d:\u201ca\u201d,\u201cscore\u201d:1}")).toEqual({ name: "a", score: 1 });
  });

  it("keeps full-width quotes inside string values intact", () => {
    expect(parseStructuredJson('{"name":"a","desc":"他说：\u201c你好\u201d"}')).toEqual({ name: "a", desc: "他说：\u201c你好\u201d" });
  });

  it("recovers from truncated JSON by closing unterminated structures", () => {
    expect(parseStructuredJson('{"name":"a","score":1')).toEqual({ name: "a", score: 1 });
    expect(parseStructuredJson('{"name":"a"')).toEqual({ name: "a" });
  });

  it("handles mixed pollution: fence + single quotes + trailing comma", () => {
    expect(parseStructuredJson("```\n{'name':'a','score':1,}\n```")).toEqual({ name: "a", score: 1 });
  });

  it("returns undefined for pure text without JSON", () => {
    expect(parseStructuredJson("这篇正文很好，没有 JSON")).toBeUndefined();
    expect(parseStructuredJson("")).toBeUndefined();
    expect(parseStructuredJson("   ")).toBeUndefined();
  });
});
