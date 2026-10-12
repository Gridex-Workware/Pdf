/// <reference lib="webworker" />
import { exportGroups, type ExportInput, type ExportResult } from "./export";

export interface ExportRequest {
  id: number;
  input: ExportInput;
  /** 각 묶음이 PDF 하나가 된다. null이면 전체 문서 하나. */
  groups: string[][] | null;
}

export type ExportResponse =
  | { id: number; ok: true; results: ExportResult[] }
  | { id: number; ok: false; error: string };

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const { id, input, groups } = e.data;
  try {
    const results = await exportGroups(input, groups ?? [input.pages.map((p) => p.id)]);
    const msg: ExportResponse = { id, ok: true, results };
    (self as unknown as Worker).postMessage(msg, results.map((r) => r.bytes.buffer as ArrayBuffer));
  } catch (err) {
    const msg: ExportResponse = { id, ok: false, error: (err as Error)?.message ?? String(err) };
    (self as unknown as Worker).postMessage(msg);
  }
};
