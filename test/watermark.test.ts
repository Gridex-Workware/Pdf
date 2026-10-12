import { describe, expect, it } from "vitest";
import { annotBounds } from "../src/core/geometry";
import type { PageRef } from "../src/core/model";
import { DEFAULT_WATERMARK, makeImageWatermark, makeTextWatermarks } from "../src/core/watermark";

const page = (rotation: PageRef["rotation"] = 0): PageRef => ({
  id: "p", sourceId: null, sourceIndex: -1, baseRotation: 0, rotation, width: 600, height: 800, annotations: [],
});

describe("makeTextWatermarks", () => {
  it("centers a single watermark on the page", () => {
    const [a] = makeTextWatermarks(page(), { ...DEFAULT_WATERMARK, angle: 0, text: "WM", fontSize: 40 });
    expect(a.type).toBe("text");
    const b = annotBounds(a);
    expect(b.x + b.width / 2).toBeCloseTo(300, 0);
    expect(b.y + b.height / 2).toBeCloseTo(400, -1);
  });
  it("adds the display rotation so text looks upright-ish on rotated pages", () => {
    const [a] = makeTextWatermarks(page(90), { ...DEFAULT_WATERMARK, angle: 45 });
    expect(a.type === "text" && a.rotate).toBe(135);
  });
  it("tiles across the page", () => {
    const list = makeTextWatermarks(page(), { ...DEFAULT_WATERMARK, tile: true, fontSize: 20, text: "x" });
    expect(list.length).toBeGreaterThan(10);
  });
});

describe("makeImageWatermark", () => {
  it("centers the image with aspect ratio kept", () => {
    const a = makeImageWatermark(page(), { id: "img", width: 200, height: 100 }, { scale: 0.5, opacity: 0.4, angle: 0 });
    expect(a.type).toBe("image");
    if (a.type !== "image") return;
    expect(a.width).toBe(300);
    expect(a.height).toBe(150);
    expect(a.x + a.width / 2).toBeCloseTo(300);
    expect(a.y + a.height / 2).toBeCloseTo(400);
  });
});
