/**
 * pdf.js는 번들이 커서 처음 PDF를 열 때 지연 로드한다.
 * legacy 빌드는 최신 JS 기능(Map.prototype.getOrInsertComputed 등)의 폴리필을 포함해
 * 조금 오래된 브라우저에서도 동작한다.
 */
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export type PDFDocumentProxy = import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
export type PDFPageProxy = import("pdfjs-dist/legacy/build/pdf.mjs").PDFPageProxy;

let loading: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  if (!loading) {
    loading = Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]).then(([mod, worker]) => {
      mod.GlobalWorkerOptions.workerSrc = worker.default;
      return mod;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
