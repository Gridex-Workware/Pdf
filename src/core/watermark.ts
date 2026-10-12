import type { TextMeasurer } from "./geometry";
import { approxMeasurer } from "./geometry";
import type { Annotation, PageRef, RGB } from "./model";
import { displayRotation, newId } from "./model";

export interface WatermarkOptions {
  text: string;
  fontSize: number;
  color: RGB;
  opacity: number;
  /** 화면 기준 반시계 회전(도). 45면 왼쪽 아래→오른쪽 위 대각선 */
  angle: number;
  /** 가로/세로로 반복해서 타일처럼 채운다 */
  tile: boolean;
}

export const DEFAULT_WATERMARK: WatermarkOptions = {
  text: "CONFIDENTIAL",
  fontSize: 48,
  color: { r: 0.6, g: 0.6, b: 0.6 },
  opacity: 0.3,
  angle: 45,
  tile: false,
};

/**
 * 페이지 중앙(또는 타일)에 글자 워터마크 주석을 만든다.
 * 좌표는 콘텐츠 좌표계이며, 회전된 페이지에서도 화면 기준으로 angle만큼 기울어 보이도록
 * 표시 회전을 더해 저장한다.
 */
export function makeTextWatermarks(page: PageRef, opts: WatermarkOptions, measure: TextMeasurer = approxMeasurer): Annotation[] {
  const disp = displayRotation(page);
  const m = measure(opts.text || " ", opts.fontSize);
  const textW = m.width;
  const textH = opts.fontSize; // 한 줄 기준 글자 높이
  const rotate = disp + opts.angle;
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // 글자 상자의 중심이 (cx, cy)에 오도록 베이스라인 원점을 계산한다.
  // 원점 기준 중심 벡터는 (textW/2, textH*0.3) (베이스라인 위쪽으로 약간)
  const originFor = (cx: number, cy: number) => {
    const vx = textW / 2;
    const vy = textH * 0.3;
    return { x: cx - (vx * cos - vy * sin), y: cy - (vx * sin + vy * cos) };
  };

  const centers: { x: number; y: number }[] = [];
  if (!opts.tile) {
    centers.push({ x: page.width / 2, y: page.height / 2 });
  } else {
    const stepX = Math.max(textW, 40) * 1.6;
    const stepY = Math.max(textH, 20) * 5;
    let row = 0;
    for (let y = stepY / 2; y < page.height + stepY; y += stepY, row++) {
      const offset = row % 2 ? stepX / 2 : 0;
      for (let x = offset; x < page.width + stepX; x += stepX) centers.push({ x, y });
    }
  }

  return centers.map((c) => {
    const o = originFor(c.x, c.y);
    return {
      id: newId("an"),
      type: "text",
      x: o.x,
      y: o.y,
      text: opts.text,
      fontSize: opts.fontSize,
      color: opts.color,
      opacity: opts.opacity,
      rotate,
    };
  });
}

/** 이미지 워터마크: 페이지 중앙에 지정 비율 크기로 */
export function makeImageWatermark(
  page: PageRef,
  asset: { id: string; width: number; height: number },
  opts: { scale: number; opacity: number; angle: number },
): Annotation {
  const disp = displayRotation(page);
  const maxW = Math.min(page.width, page.height) * opts.scale;
  const ratio = asset.height / asset.width;
  const w = maxW;
  const h = maxW * ratio;
  const rotate = disp + opts.angle;
  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const vx = w / 2;
  const vy = h / 2;
  const cx = page.width / 2;
  const cy = page.height / 2;
  return {
    id: newId("an"),
    type: "image",
    x: cx - (vx * cos - vy * sin),
    y: cy - (vx * sin + vy * cos),
    width: w,
    height: h,
    assetId: asset.id,
    rotate,
    opacity: opts.opacity,
  };
}
