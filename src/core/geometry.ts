import type { Annotation, Point } from "./model";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 텍스트 크기 측정 함수. (너비, 높이)를 pt 단위로 돌려준다. */
export type TextMeasurer = (text: string, fontSize: number) => { width: number; height: number };

/** 기본 측정기: 글자 폭을 fontSize*0.55(한글은 1.0)로 근사 */
export const approxMeasurer: TextMeasurer = (text, fontSize) => {
  const lines = text.split("\n");
  let max = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) w += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿぀-ヿ]/.test(ch) ? fontSize : fontSize * 0.55;
    max = Math.max(max, w);
  }
  return { width: max, height: lines.length * fontSize * 1.2 };
};

export function rotatePoint(p: Point, origin: Point, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

export function boundsOfPoints(points: readonly Point[], pad = 0): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

/** 주석의 콘텐츠 좌표계 경계 상자 */
export function annotBounds(a: Annotation, measure: TextMeasurer = approxMeasurer): Box {
  switch (a.type) {
    case "rect":
    case "highlight":
      return { x: a.x, y: a.y, width: a.width, height: a.height };
    case "ink":
      return boundsOfPoints(a.points, a.strokeWidth / 2);
    case "image": {
      const corners = [
        { x: 0, y: 0 },
        { x: a.width, y: 0 },
        { x: a.width, y: a.height },
        { x: 0, y: a.height },
      ].map((c) => rotatePoint({ x: a.x + c.x, y: a.y + c.y }, { x: a.x, y: a.y }, a.rotate));
      return boundsOfPoints(corners);
    }
    case "text": {
      const m = measure(a.text || " ", a.fontSize);
      const lines = a.text.split("\n").length;
      const ascent = a.fontSize * 0.8;
      // 베이스라인 원점 기준: 위로 ascent, 아래로 나머지 줄 + descent
      const top = ascent;
      const bottom = -(a.fontSize * 1.2 * (lines - 1) + a.fontSize * 0.25);
      const corners = [
        { x: 0, y: top },
        { x: m.width, y: top },
        { x: m.width, y: bottom },
        { x: 0, y: bottom },
      ].map((c) => rotatePoint({ x: a.x + c.x, y: a.y + c.y }, { x: a.x, y: a.y }, a.rotate));
      return boundsOfPoints(corners);
    }
  }
}

export function boxContains(b: Box, p: Point, tolerance = 0): boolean {
  return (
    p.x >= b.x - tolerance &&
    p.x <= b.x + b.width + tolerance &&
    p.y >= b.y - tolerance &&
    p.y <= b.y + b.height + tolerance
  );
}

/** 점에 가장 가까운(마지막에 그려진 것 우선) 주석을 찾는다 */
export function hitTest(
  annots: readonly Annotation[],
  p: Point,
  measure: TextMeasurer = approxMeasurer,
  tolerance = 3,
): Annotation | null {
  for (let i = annots.length - 1; i >= 0; i--) {
    const a = annots[i];
    if (boxContains(annotBounds(a, measure), p, tolerance)) return a;
  }
  return null;
}

/** 주석을 (dx, dy)만큼 이동한 사본 */
export function translateAnnot<A extends Annotation>(a: A, dx: number, dy: number): A {
  if (a.type === "ink") {
    return { ...a, points: a.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) };
  }
  return { ...a, x: a.x + dx, y: a.y + dy };
}

/** 두 점으로 정의된 사각형을 양수 폭/높이로 정규화 */
export function normalizeRect(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** 너무 촘촘한 점을 걸러낸다 */
export function simplifyPath(points: readonly Point[], minDist = 1): Point[] {
  if (points.length <= 2) return [...points];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = out[out.length - 1];
    const p = points[i];
    if (i === points.length - 1 || Math.hypot(p.x - last.x, p.y - last.y) >= minDist) out.push(p);
  }
  return out;
}
