import { UNICODE_FONT_FAMILY, needsUnicodeFont } from "../core/fonts";
import { annotBounds, type TextMeasurer } from "../core/geometry";
import type { Annotation, ImageAsset, RGB } from "../core/model";
import type { Matrix } from "../core/transform";

const css = (c: RGB, a = 1) =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`;

export function fontFor(text: string, size: number): string {
  const family = needsUnicodeFont(text) ? `"${UNICODE_FONT_FAMILY}", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif` : "Helvetica, Arial, sans-serif";
  return `${size}px ${family}`;
}

/** 캔버스 글꼴로 텍스트 크기를 측정한다 (pt 단위) */
export function createCanvasMeasurer(): TextMeasurer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  return (text, fontSize) => {
    ctx.font = fontFor(text, fontSize);
    let width = 0;
    const lines = text.split("\n");
    for (const line of lines) width = Math.max(width, ctx.measureText(line || " ").width);
    return { width, height: lines.length * fontSize * 1.2 };
  };
}

/** 이미지 자산을 <img>로 변환해 캐시한다 */
export class ImageCache {
  private map = new Map<string, HTMLImageElement>();
  constructor(private onLoad: () => void) {}

  get(asset: ImageAsset): HTMLImageElement | null {
    let img = this.map.get(asset.id);
    if (!img) {
      img = new Image();
      const url = URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mime }));
      img.onload = () => {
        URL.revokeObjectURL(url);
        this.onLoad();
      };
      img.src = url;
      this.map.set(asset.id, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }
}

export interface OverlayDrawOptions {
  transform: Matrix; // PDF -> CSS px
  dpr: number;
  annotations: readonly Annotation[];
  draft?: Annotation | null;
  selectedId?: string | null;
  assets: Map<string, ImageAsset>;
  images: ImageCache;
  measure: TextMeasurer;
  /** 인라인 편집 중인 텍스트 주석은 그리지 않는다 */
  hiddenId?: string | null;
}

export function drawOverlay(canvas: HTMLCanvasElement, o: OverlayDrawOptions) {
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const m = o.transform;
  const base: Matrix = [m[0] * o.dpr, m[1] * o.dpr, m[2] * o.dpr, m[3] * o.dpr, m[4] * o.dpr, m[5] * o.dpr];

  for (const a of o.annotations) {
    if (a.id === o.hiddenId) continue;
    drawAnnot(ctx, base, a, o);
  }
  if (o.draft) drawAnnot(ctx, base, o.draft, o);

  if (o.selectedId) {
    const sel = o.annotations.find((a) => a.id === o.selectedId);
    if (sel) drawSelection(ctx, base, sel, o);
  }
}

function drawAnnot(ctx: CanvasRenderingContext2D, base: Matrix, a: Annotation, o: OverlayDrawOptions) {
  ctx.save();
  ctx.setTransform(...base);
  ctx.globalAlpha = a.opacity;
  switch (a.type) {
    case "rect":
      if (a.fillColor) {
        ctx.fillStyle = css(a.fillColor);
        ctx.fillRect(a.x, a.y, a.width, a.height);
      }
      if (a.strokeWidth > 0) {
        ctx.strokeStyle = css(a.strokeColor);
        ctx.lineWidth = a.strokeWidth;
        ctx.strokeRect(a.x, a.y, a.width, a.height);
      }
      break;
    case "highlight":
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = css(a.color);
      ctx.fillRect(a.x, a.y, a.width, a.height);
      break;
    case "ink":
      ctx.strokeStyle = css(a.color);
      ctx.lineWidth = a.strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      a.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (a.points.length === 1) ctx.lineTo(a.points[0].x, a.points[0].y);
      ctx.stroke();
      break;
    case "text": {
      ctx.translate(a.x, a.y);
      ctx.rotate((a.rotate * Math.PI) / 180);
      ctx.scale(1, -1); // 글자는 y축이 아래로 향하는 좌표계에서 그린다
      ctx.font = fontFor(a.text, a.fontSize);
      ctx.fillStyle = css(a.color);
      ctx.textBaseline = "alphabetic";
      const lines = a.text.split("\n");
      lines.forEach((line, i) => ctx.fillText(line, 0, i * a.fontSize * 1.2));
      break;
    }
    case "image": {
      const asset = o.assets.get(a.assetId);
      const img = asset ? o.images.get(asset) : null;
      ctx.translate(a.x, a.y);
      ctx.rotate((a.rotate * Math.PI) / 180);
      ctx.scale(1, -1);
      if (img) ctx.drawImage(img, 0, -a.height, a.width, a.height);
      else {
        ctx.fillStyle = "rgba(0,0,0,0.08)";
        ctx.fillRect(0, -a.height, a.width, a.height);
      }
      break;
    }
  }
  ctx.restore();
}

export const HANDLE_PX = 8;

export function hasResizeHandle(a: Annotation): a is Extract<Annotation, { width: number }> {
  return a.type === "rect" || a.type === "highlight" || a.type === "image";
}

function drawSelection(ctx: CanvasRenderingContext2D, base: Matrix, a: Annotation, o: OverlayDrawOptions) {
  const b = annotBounds(a, o.measure);
  ctx.save();
  ctx.setTransform(...base);
  const scale = Math.hypot(base[0], base[1]);
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1 / scale * o.dpr;
  ctx.setLineDash([4 / scale * o.dpr, 3 / scale * o.dpr]);
  const pad = 2;
  ctx.strokeRect(b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2);
  ctx.setLineDash([]);
  if (hasResizeHandle(a)) {
    const h = (HANDLE_PX / scale) * o.dpr;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(a.x + a.width - h / 2, a.y + a.height - h / 2, h, h);
  }
  ctx.restore();
}
