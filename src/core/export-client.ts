import type { EditorDocument } from "./document";
import type { ExportInput, ExportResult } from "./export";
import type { ExportRequest, ExportResponse } from "./export.worker";
import { unicodeFontUrl } from "./fonts";

/**
 * 내보내기를 Web Worker에서 실행한다. pdf-lib/fontkit은 워커 청크에만 포함되므로
 * 처음 저장할 때 비로소 내려받는다. 워커를 만들 수 없으면 메인 스레드에서 실행한다.
 */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: ExportResult[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  worker.onmessage = (e: MessageEvent<ExportResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.results);
    else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    // 워커 로드 자체가 실패하면 대기 중인 요청을 모두 실패시키고 다음부터 메인 스레드로
    for (const p of pending.values()) p.reject(new Error(e.message || "내보내기 워커 오류"));
    pending.clear();
    worker?.terminate();
    worker = null;
    workerBroken = true;
  };
  return worker;
}

let workerBroken = false;

export function buildExportInput(doc: EditorDocument, pageIds?: string[], includeAnnotations = true): ExportInput {
  const pages = pageIds ? pageIds.map((id) => doc.pageById(id)).filter((p): p is NonNullable<typeof p> => !!p) : doc.pages;
  const neededSources = new Set(pages.map((p) => p.sourceId).filter((s): s is string => !!s));
  const neededAssets = new Set<string>();
  for (const p of pages) for (const a of p.annotations) if (a.type === "image") neededAssets.add(a.assetId);
  return {
    pages,
    sources: [...neededSources].map((id) => ({ id, bytes: doc.sources.get(id)!.bytes })),
    assets: [...neededAssets].map((id) => doc.assets.get(id)).filter((a): a is NonNullable<typeof a> => !!a),
    fontUrl: unicodeFontUrl(),
    includeAnnotations,
  };
}

/** 페이지 묶음별로 PDF를 만든다. groups가 null이면 input 전체로 하나. */
export async function runExport(input: ExportInput, groups: string[][] | null): Promise<ExportResult[]> {
  const w = workerBroken ? null : getWorker();
  if (w) {
    try {
      return await new Promise<ExportResult[]>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const req: ExportRequest = { id, input, groups };
        w.postMessage(req);
      });
    } catch (e) {
      if (!workerBroken) throw e;
      // 워커가 깨졌으면 아래 폴백으로
    }
  }
  const { exportGroups } = await import("./export");
  return exportGroups(input, groups ?? [input.pages.map((p) => p.id)]);
}

/** 문서 전체(또는 일부 페이지)를 PDF 하나로 */
export async function exportDocument(doc: EditorDocument, pageIds?: string[]): Promise<ExportResult> {
  const input = buildExportInput(doc, pageIds);
  const [r] = await runExport(input, null);
  return r;
}

/** 페이지별(또는 범위별)로 여러 PDF를 만든 뒤 ZIP으로 묶는다 */
export async function exportZip(
  doc: EditorDocument,
  groups: { name: string; pageIds: string[] }[],
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const allIds = [...new Set(groups.flatMap((g) => g.pageIds))];
  const input = buildExportInput(doc, allIds);
  const results = await runExport(input, groups.map((g) => g.pageIds));
  const { zipSync } = await import("fflate");
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  groups.forEach((g, i) => {
    files[g.name] = [results[i].bytes, { level: 0 }]; // PDF는 이미 압축돼 있다
  });
  return { bytes: zipSync(files), warnings: [...new Set(results.flatMap((r) => r.warnings))] };
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
