import { BlendMode, LineCapStyle, PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from "pdf-lib";
import { getPatchedFontkit } from "./fontkit-patched";
import { loadUnicodeFontBytes, needsUnicodeFont } from "./fonts";
import type { Annotation, ImageAsset, PageRef, RGB } from "./model";
import { displayRotation } from "./model";

/**
 * 내보내기에 필요한 순수 데이터. EditorDocument와 분리해 두어
 * Web Worker로 structured clone 해서 보낼 수 있다.
 */
export interface ExportInput {
  pages: PageRef[];
  sources: { id: string; bytes: Uint8Array }[];
  assets: ImageAsset[];
  /** 한글 등 유니코드 글꼴 파일의 절대 URL */
  fontUrl: string;
  includeAnnotations?: boolean;
}

export interface ExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

const col = (c: RGB) => rgb(c.r, c.g, c.b);

type EmbeddedImage = Awaited<ReturnType<PDFDocument["embedPng"]>>;

/**
 * 같은 입력으로 여러 PDF(예: 페이지별 분할)를 만들 때 원본 파싱을 공유하기 위한 내보내기 객체.
 */
export class Exporter {
  private srcDocs = new Map<string, Promise<PDFDocument>>();
  private fontBytes: Promise<Uint8Array> | null = null;
  private pageById = new Map<string, PageRef>();
  private sources = new Map<string, Uint8Array>();
  private assets = new Map<string, ImageAsset>();

  constructor(private input: ExportInput) {
    for (const p of input.pages) this.pageById.set(p.id, p);
    for (const s of input.sources) this.sources.set(s.id, s.bytes);
    for (const a of input.assets) this.assets.set(a.id, a);
  }

  private getSource(id: string): Promise<PDFDocument> {
    let d = this.srcDocs.get(id);
    if (!d) {
      const bytes = this.sources.get(id);
      if (!bytes) throw new Error("원본 문서를 찾을 수 없습니다");
      d = PDFDocument.load(bytes, { ignoreEncryption: true });
      this.srcDocs.set(id, d);
    }
    return d;
  }

  private getFontBytes(): Promise<Uint8Array> {
    if (!this.fontBytes) this.fontBytes = loadUnicodeFontBytes(this.input.fontUrl);
    return this.fontBytes;
  }

  /** 지정한 페이지들(순서 유지)로 PDF 하나를 만든다. 생략하면 전체. */
  async export(pageIds?: string[]): Promise<ExportResult> {
    const includeAnnotations = this.input.includeAnnotations ?? true;
    const pages = pageIds
      ? pageIds.map((id) => this.pageById.get(id)).filter((p): p is PageRef => !!p)
      : this.input.pages;
    const warnings: string[] = [];

    const out = await PDFDocument.create();
    out.setProducer("PDF 편집기");
    out.setModificationDate(new Date());
    const helvetica = await out.embedFont(StandardFonts.Helvetica);
    let unicode: PDFFont | null = null;

    const hasUnicode =
      includeAnnotations && pages.some((p) => p.annotations.some((a) => a.type === "text" && needsUnicodeFont(a.text)));
    if (hasUnicode) {
      try {
        out.registerFontkit(getPatchedFontkit());
        unicode = await out.embedFont(await this.getFontBytes(), { subset: true });
      } catch (e) {
        warnings.push(`한글 폰트를 불러오지 못해 일부 글자가 '?'로 저장됩니다: ${(e as Error).message}`);
      }
    }

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
      const src = await this.getSource(sourceId);
      const result = await out.copyPages(src, refs.map((r) => r.sourceIndex));
      refs.forEach((r, i) => copied.set(r.id, result[i]));
    }

    const images = new Map<string, EmbeddedImage>();
    const ctx = { out, helvetica, unicode, images, warnings };
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
        for (const a of ref.annotations) await this.drawAnnotation(ctx, page, a);
      }
    }

    return { bytes: await out.save({ useObjectStreams: true }), warnings };
  }

  private async drawAnnotation(
    ctx: { out: PDFDocument; helvetica: PDFFont; unicode: PDFFont | null; images: Map<string, EmbeddedImage>; warnings: string[] },
    page: PDFPage,
    a: Annotation,
  ) {
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
          borderColor: a.strokeWidth > 0 ? col(a.strokeColor) : undefined,
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
        const pts = a.points.length === 1 ? [a.points[0], a.points[0]] : a.points;
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`).join(" ");
        page.drawSvgPath(d, {
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
        const asset = this.assets.get(a.assetId);
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
}

function replaceUnencodable(text: string): string {
  let out = "";
  for (const ch of text) out += (ch.codePointAt(0) ?? 0) > 0xff ? "?" : ch;
  return out;
}

/** 여러 페이지 묶음을 각각 PDF로 만든다 (예: 페이지별 분할) */
export async function exportGroups(input: ExportInput, groups: string[][]): Promise<ExportResult[]> {
  const exporter = new Exporter(input);
  const results: ExportResult[] = [];
  for (const g of groups) results.push(await exporter.export(g));
  return results;
}
