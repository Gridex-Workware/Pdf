import { describe, expect, it } from "vitest";
import { annotBounds, hitTest, normalizeRect, simplifyPath, translateAnnot } from "../src/core/geometry";
import type { Annotation } from "../src/core/model";
import { applyInverseTransform, applyTransform, makeViewport } from "../src/core/transform";

const red = { r: 1, g: 0, b: 0 };

describe("annotBounds / hitTest", () => {
  const rect: Annotation = { id: "r", type: "rect", x: 10, y: 10, width: 20, height: 5, strokeColor: red, fillColor: null, strokeWidth: 1, opacity: 1 };
  const ink: Annotation = { id: "i", type: "ink", points: [{ x: 0, y: 0 }, { x: 10, y: 4 }], color: red, strokeWidth: 2, opacity: 1 };
  const text: Annotation = { id: "t", type: "text", x: 50, y: 50, text: "ab", fontSize: 10, color: red, opacity: 1, rotate: 0 };
  const rotated: Annotation = { ...text, id: "t90", rotate: 90 };

  it("computes bounds for rect and ink", () => {
    expect(annotBounds(rect)).toEqual({ x: 10, y: 10, width: 20, height: 5 });
    expect(annotBounds(ink)).toEqual({ x: -1, y: -1, width: 12, height: 6 });
  });
  it("text bounds start at baseline origin and rotate with the annotation", () => {
    const b = annotBounds(text);
    expect(b.x).toBe(50);
    expect(b.y).toBeLessThan(50);
    expect(b.y + b.height).toBeCloseTo(58);
    const r = annotBounds(rotated);
    // 90도 회전하면 텍스트가 위쪽으로 뻗는다
    expect(r.y).toBe(50);
    expect(r.x).toBeLessThan(50);
  });
  it("hitTest prefers the topmost annotation", () => {
    const both: Annotation = { ...rect, id: "r2" };
    expect(hitTest([rect, both], { x: 15, y: 12 })?.id).toBe("r2");
    expect(hitTest([rect], { x: 100, y: 100 })).toBeNull();
    expect(hitTest([rect], { x: 31, y: 12 }, undefined, 2)?.id).toBe("r");
  });
});

describe("translateAnnot / normalizeRect / simplifyPath", () => {
  it("moves ink points and rect origin", () => {
    const ink: Annotation = { id: "i", type: "ink", points: [{ x: 1, y: 1 }], color: red, strokeWidth: 1, opacity: 1 };
    expect((translateAnnot(ink, 2, 3) as typeof ink).points).toEqual([{ x: 3, y: 4 }]);
    const img: Annotation = { id: "m", type: "image", x: 0, y: 0, width: 1, height: 1, assetId: "a", rotate: 0, opacity: 1 };
    expect(translateAnnot(img, -1, 5)).toMatchObject({ x: -1, y: 5 });
  });
  it("normalizes to positive size", () => {
    expect(normalizeRect({ x: 5, y: 5 }, { x: 1, y: 2 })).toEqual({ x: 1, y: 2, width: 4, height: 3 });
  });
  it("drops near points but keeps the last", () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }];
    expect(simplifyPath(pts, 1)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }]);
  });
});

describe("makeViewport", () => {
  it("maps PDF bottom-left to canvas bottom-left at rotation 0", () => {
    const vp = makeViewport([0, 0, 100, 200], 2, 0);
    expect(vp.width).toBe(200);
    expect(vp.height).toBe(400);
    expect(applyTransform(vp.transform, { x: 0, y: 0 })).toEqual({ x: 0, y: 400 });
    expect(applyTransform(vp.transform, { x: 100, y: 200 })).toEqual({ x: 200, y: 0 });
  });
  it("swaps size at 90 degrees and inverts correctly", () => {
    const vp = makeViewport([0, 0, 100, 200], 1, 90);
    expect(vp.width).toBe(200);
    expect(vp.height).toBe(100);
    // 90도 시계방향 회전: PDF 좌하단(0,0)은 화면 좌상단으로 간다
    expect(applyTransform(vp.transform, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    const p = { x: 33, y: 77 };
    const back = applyInverseTransform(vp.transform, applyTransform(vp.transform, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
  it("respects a non-zero viewBox origin", () => {
    const vp = makeViewport([10, 20, 110, 220], 1, 0);
    expect(applyTransform(vp.transform, { x: 10, y: 20 })).toEqual({ x: 0, y: 200 });
  });
});
