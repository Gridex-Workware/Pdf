import { describe, expect, it } from "vitest";
import { insertAt, movePage, parsePageRanges, removePages, rotatePages } from "../src/core/pageops";
import type { PageRef } from "../src/core/model";

const page = (id: string, rotation: PageRef["rotation"] = 0): PageRef => ({
  id, sourceId: "s", sourceIndex: 0, baseRotation: 0, rotation, width: 100, height: 200, annotations: [],
});

describe("movePage", () => {
  it("moves forward and backward", () => {
    expect(movePage(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(movePage(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
  it("clamps target and does not mutate input", () => {
    const src = ["a", "b"];
    expect(movePage(src, 0, 99)).toEqual(["b", "a"]);
    expect(src).toEqual(["a", "b"]);
  });
  it("throws on bad source index", () => {
    expect(() => movePage(["a"], 5, 0)).toThrow(RangeError);
  });
});

describe("removePages / insertAt", () => {
  it("removes by id", () => {
    expect(removePages([page("a"), page("b"), page("c")], ["b"]).map((p) => p.id)).toEqual(["a", "c"]);
  });
  it("inserts at clamped index", () => {
    expect(insertAt(["a", "c"], 1, ["b"])).toEqual(["a", "b", "c"]);
    expect(insertAt(["a"], 10, ["b"])).toEqual(["a", "b"]);
    expect(insertAt(["a"], -1, ["b"])).toEqual(["b", "a"]);
  });
});

describe("rotatePages", () => {
  it("wraps rotation", () => {
    const out = rotatePages([page("a", 270), page("b")], ["a"], 90);
    expect(out[0].rotation).toBe(0);
    expect(out[1].rotation).toBe(0);
    expect(rotatePages([page("a")], ["a"], -90)[0].rotation).toBe(270);
  });
});

describe("parsePageRanges", () => {
  it("parses lists and ranges to 0-based sorted unique indexes", () => {
    expect(parsePageRanges("3, 1-2, 5-4, 3", 10)).toEqual([0, 1, 2, 3, 4]);
  });
  it("rejects out of range or garbage", () => {
    expect(() => parsePageRanges("0", 3)).toThrow();
    expect(() => parsePageRanges("4", 3)).toThrow();
    expect(() => parsePageRanges("a-b", 3)).toThrow();
  });
});
