import type { Point, Rotation } from "./model";

/** [a, b, c, d, e, f] 형태의 2D 아핀 행렬 (PDF/Canvas 규약) */
export type Matrix = [number, number, number, number, number, number];

export function applyTransform(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function applyInverseTransform(m: Matrix, p: Point): Point {
  const det = m[0] * m[3] - m[1] * m[2];
  return {
    x: (p.x * m[3] - p.y * m[2] + m[2] * m[5] - m[4] * m[3]) / det,
    y: (-p.x * m[1] + p.y * m[0] + m[4] * m[1] - m[5] * m[0]) / det,
  };
}

export interface Viewport {
  width: number;
  height: number;
  transform: Matrix;
}

/**
 * pdf.js PageViewport와 동일한 규칙으로 뷰포트 행렬을 만든다.
 * viewBox = [x0, y0, x1, y1] (PDF 콘텐츠 좌표), 결과는 CSS px 기준.
 */
export function makeViewport(viewBox: [number, number, number, number], scale: number, rotation: Rotation): Viewport {
  const centerX = (viewBox[2] + viewBox[0]) / 2;
  const centerY = (viewBox[3] + viewBox[1]) / 2;
  let rA: number, rB: number, rC: number, rD: number;
  switch (rotation) {
    case 180:
      rA = -1; rB = 0; rC = 0; rD = 1;
      break;
    case 90:
      rA = 0; rB = 1; rC = 1; rD = 0;
      break;
    case 270:
      rA = 0; rB = -1; rC = -1; rD = 0;
      break;
    default:
      rA = 1; rB = 0; rC = 0; rD = -1;
  }
  let offsetX: number, offsetY: number, width: number, height: number;
  if (rA === 0) {
    offsetX = Math.abs(centerY - viewBox[1]) * scale;
    offsetY = Math.abs(centerX - viewBox[0]) * scale;
    width = (viewBox[3] - viewBox[1]) * scale;
    height = (viewBox[2] - viewBox[0]) * scale;
  } else {
    offsetX = Math.abs(centerX - viewBox[0]) * scale;
    offsetY = Math.abs(centerY - viewBox[1]) * scale;
    width = (viewBox[2] - viewBox[0]) * scale;
    height = (viewBox[3] - viewBox[1]) * scale;
  }
  const transform: Matrix = [
    rA * scale,
    rB * scale,
    rC * scale,
    rD * scale,
    offsetX - rA * scale * centerX - rC * scale * centerY,
    offsetY - rB * scale * centerX - rD * scale * centerY,
  ];
  return { width, height, transform };
}
