/** 0..1 범위의 RGB 색상 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/** PDF 콘텐츠 좌표계(포인트, 원점 좌하단)의 점 */
export interface Point {
  x: number;
  y: number;
}

interface AnnotBase {
  id: string;
  opacity: number; // 0..1
}

export interface TextAnnot extends AnnotBase {
  type: "text";
  /** 첫 줄 베이스라인의 시작점 */
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: RGB;
  /** 콘텐츠 좌표계 기준 반시계 회전(도). 회전된 페이지에서 글자가 바로 보이도록 한다. */
  rotate: number;
}

export interface RectAnnot extends AnnotBase {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: RGB;
  fillColor: RGB | null;
  strokeWidth: number;
}

export interface HighlightAnnot extends AnnotBase {
  type: "highlight";
  x: number;
  y: number;
  width: number;
  height: number;
  color: RGB;
}

export interface InkAnnot extends AnnotBase {
  type: "ink";
  points: Point[];
  color: RGB;
  strokeWidth: number;
}

export interface ImageAnnot extends AnnotBase {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  assetId: string;
  rotate: number;
}

export type Annotation = TextAnnot | RectAnnot | HighlightAnnot | InkAnnot | ImageAnnot;
export type AnnotType = Annotation["type"];

/** 편집 문서의 한 페이지. 원본 PDF의 페이지를 참조하거나 빈 페이지다. */
export interface PageRef {
  id: string;
  /** 원본 문서 id. 빈 페이지면 null */
  sourceId: string | null;
  /** 원본 문서 내 0-based 페이지 번호 */
  sourceIndex: number;
  /** 원본 페이지의 /Rotate 값 */
  baseRotation: Rotation;
  /** 사용자가 추가로 적용한 회전 */
  rotation: Rotation;
  /** 회전 전(콘텐츠 좌표계) 페이지 크기(pt) */
  width: number;
  height: number;
  annotations: Annotation[];
}

export interface ImageAsset {
  id: string;
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
}

let counter = 0;
export function newId(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function normalizeRotation(deg: number): Rotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

/** 화면에 표시되는 총 회전 */
export function displayRotation(page: Pick<PageRef, "baseRotation" | "rotation">): Rotation {
  return normalizeRotation(page.baseRotation + page.rotation);
}

/** 화면에 표시되는(회전 반영) 페이지 크기 */
export function displaySize(page: PageRef): { width: number; height: number } {
  const r = displayRotation(page);
  return r === 90 || r === 270
    ? { width: page.height, height: page.width }
    : { width: page.width, height: page.height };
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex(c: RGB): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}
