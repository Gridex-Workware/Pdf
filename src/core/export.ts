import { getPatchedFontkit } from "./fontkit-patched";
import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import type { EditorDocument } from "./document";
import { loadUnicodeFontBytes, needsUnicodeFont } from "./fonts";
import type { Annotation, ImageAsset, PageRef, RGB } from "./model";
import { displayRotation } from "./model";

export interface ExportOptions {
  /** 지정하면 이 페이지들만(순서 유지) 내보낸다 */
  pageIds?: string[];
  /** 주석을 포함할지 */
  includeAnnotations?: boolean;
}

const col = (c: RGB) => rgb(c.r, c.g, c.b);

interface Ctx {
  out: PDFDocument;
  helvetica: PDFFont;
  unicode: PDFFont | null;
  images: Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>;
  warnings: string[];
}

/** 편집 문서를 PDF 바이트로 직렬화한다 */
export async function exportPdf(doc: EditorDocument, opts: ExportOptions = {}): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const includeAnnotations = opts.includeAnnotations ?? true;
  const pages = opts.pageIds
    ? opts.pageIds.map((id) => doc.pageById(id)).filter((p): p is PageRef => !!p)
    : doc.pages;

  const out = await PDFDocument.create();
  out.setProducer("PDF 편집기");
  out.setModificationDate(new Date());

  const ctx: Ctx = {
    out,
    helvetica: await out.embedFont(StandardFonts.Helvetica),
    unicode: null,
    images: new Map(),
    warnings: [],
  };

  const hasUnicode =
    includeAnnotations &&
    pages.some((p) => p.annotations.some((a) => a.type === "text" && needsUnicodeFont(a.text)));
  if (hasUnicode) {
    try {
      out.registerFontkit(getPatchedFontkit());
      ctx.unicode = await out.embedFont(await loadUnicodeFontBytes(), { subset: true });
    } catch (e) {
      ctx.warnings.push(`한글 폰트를 불러오지 못해 일부 글자가 '?'로 저장됩니다: ${(e as Error).message}`);
    }
  }

  // 원본별 pdf-lib 문서는 한 번만 로드
  const srcDocs = new Map<string, PDFDocument>();
  const getSrc = async (id: string) => {
    let d = srcDocs.get(id);
    if (!d) {
      const s = doc.sources.get(id);
      if (!s) throw new Error("원본 문서를 찾을 수 없습니다");
      d = await PDFDocument.load(s.bytes, { ignoreEncryption: true });
      srcDocs.set(id, d);
    }
    return d;
  };

  // 같은 원본의 페이지는 한 번에 복사해야 공유 리소스가 중복되지 않는다
  const copied = new Map<string, PDFPage>();
  const bySource = new Map<string, PageRef[]>();
  for (const p of pages) {
    if (!p.sourceId) continue;
    const list = bySource.get(p.sourceId) ?? [];
    list.push(p);
    bySource.set(p.sourceId, list);
  }
  for (const [sourceId, refs] of bySource) {
    const src = await getSrc(sourceId);
    const result = await out.copyPages(src, refs.map((r) => r.sourceIndex));
    refs.forEach((r, i) => copied.set(r.id, result[i]));
  }

  for (const ref of pages) {
    let page: PDFPage;
    if (ref.sourceId) {
      page = copied.get(ref.id)!;
      out.addPage(page);
    } else {
      page = out.addPage([ref.width, ref.height]);
    }
    page.setRotation(degrees(displayRotation(ref)));
    if (includeAnnotations) {
      for (const a of ref.annotations) await drawAnnotation(ctx, page, a, doc.assets);
    }
  }

  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, warnings: ctx.warnings };
}

async function drawAnnotation(ctx: Ctx, page: PDFPage, a: Annotation, assets: Map<string, ImageAsset>) {
  switch (a.type) {
    case "text": {
      let font = ctx.helvetica;
      let text = a.text;
      if (needsUnicodeFont(text)) {
        if (ctx.unicode) font = ctx.unicode;
        else text = replaceUnencodable(text);
      }
      if (!text.trim()) return;
      page.drawText(text, {
        x: a.x,
        y: a.y,
        size: a.fontSize,
        font,
        color: col(a.color),
        opacity: a.opacity,
        rotate: degrees(a.rotate),
        lineHeight: a.fontSize * 1.2,
      });
      return;
    }
    case "rect":
      page.drawRectangle({
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        borderColor: col(a.strokeColor),
        borderWidth: a.strokeWidth,
        color: a.fillColor ? col(a.fillColor) : undefined,
        opacity: a.opacity,
        borderOpacity: a.opacity,
      });
      return;
    case "highlight":
      page.drawRectangle({
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        color: col(a.color),
        opacity: a.opacity,
        blendMode: BlendMode.Multiply,
      });
      return;
    case "ink": {
      if (a.points.length === 0) return;
      // drawSvgPath는 y축이 아래로 증가하므로 부호를 뒤집는다
      const d = a.points
        .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`)
        .join(" ");
      page.drawSvgPath(a.points.length === 1 ? `${d} L ${a.points[0].x.toFixed(2)} ${(-a.points[0].y).toFixed(2)}` : d, {
        x: 0,
        y: 0,
        borderColor: col(a.color),
        borderWidth: a.strokeWidth,
        borderOpacity: a.opacity,
        borderLineCap: LineCapStyle.Round,
      });
      return;
    }
    case "image": {
      const asset = assets.get(a.assetId);
      if (!asset) {
        ctx.warnings.push("이미지 데이터를 찾을 수 없어 건너뜁니다");
        return;
      }
      let img = ctx.images.get(asset.id);
      if (!img) {
        img = asset.mime === "image/png" ? await ctx.out.embedPng(asset.bytes) : await ctx.out.embedJpg(asset.bytes);
        ctx.images.set(asset.id, img);
      }
      page.drawImage(img, {
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        rotate: degrees(a.rotate),
        opacity: a.opacity,
      });
      return;
    }
  }
}

function replaceUnencodable(text: string): string {
  let out = "";
  for (const ch of text) out += (ch.codePointAt(0) ?? 0) > 0xff ? "?" : ch;
  return out;
}

/** 브라우저에서 바이트를 파일로 내려받는다 */
export function downloadBytes(bytes: Uint8Array, filename: string, mime = "application/pdf") {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
