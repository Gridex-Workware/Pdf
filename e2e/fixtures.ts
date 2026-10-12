import { test as base, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

/** 테스트용 샘플 PDF: 4쪽, 3쪽은 가로, 4쪽은 /Rotate 90 */
export async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 4; i++) {
    const page = doc.addPage(i === 3 ? [400, 300] : [595, 842]);
    page.drawText(`Page ${i}`, { x: 50, y: page.getHeight() - 80, size: 48, font, color: rgb(0.1, 0.1, 0.5) });
    page.drawRectangle({ x: 20, y: 20, width: page.getWidth() - 40, height: page.getHeight() - 40, borderColor: rgb(0.2, 0.7, 0.3), borderWidth: 3 });
    if (i === 4) page.setRotation(degrees(90));
  }
  return doc.save();
}

declare global {
  interface Window {
    pdfEditor: {
      doc: {
        pages: { id: string; sourceIndex: number; rotation: number; annotations: { type: string; id: string; [k: string]: unknown }[] }[];
        canUndo: boolean;
        rotatePages(ids: string[], d: number): void;
        deletePages(ids: string[]): void;
        movePages(ids: string[], to: number): void;
        addAsset(a: unknown): void;
        pageById(id: string): unknown;
      };
      viewer: { tool: string; scale: number; selection: { annotId: string } | null; pendingImage: unknown; scrollToPage(id: string): void; setZoom(z: number): void };
      sidebar: { selected: Set<string> };
      openBytes(file: File): Promise<void>;
      setTool(t: string): void;
    };
  }
}

/** 페이지에 바이트를 File로 넘겨 앱의 열기 경로를 그대로 탄다 */
export async function openPdf(page: Page, bytes: Uint8Array, name = "sample.pdf") {
  const b64 = Buffer.from(bytes).toString("base64");
  await page.evaluate(
    async ([b64, name]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.pdfEditor.openBytes(new File([bytes], name, { type: "application/pdf" }));
    },
    [b64, name] as const,
  );
  await page.waitForFunction(() => document.querySelectorAll(".page-canvas:not(.stale)").length >= 1);
}

export const test = base.extend<{ consoleErrors: string[] }>({
  // 콘솔 오류/페이지 오류가 하나라도 나오면 테스트 실패
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
      });
      await use(errors);
      expect(errors, "브라우저 콘솔 오류 없음").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
