import type { Annotation, ImageAsset, PageRef, Rotation } from "./model";
import { newId, normalizeRotation } from "./model";
import { insertAt, movePage, removePages, rotatePages } from "./pageops";
import { loadPdfjs, type PDFDocumentProxy } from "./pdfjs";

export interface SourceDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  proxy: PDFDocumentProxy;
}

export type ChangeKind = "pages" | "annotations" | "selection";
export type Listener = (kind: ChangeKind, detail?: { pageId?: string }) => void;

const HISTORY_LIMIT = 100;

/**
 * 편집 중인 문서. 페이지 목록과 주석은 불변 데이터처럼 다루며,
 * 변경마다 스냅샷을 쌓아 실행취소/다시실행을 지원한다.
 */
export class EditorDocument {
  pages: PageRef[] = [];
  readonly sources = new Map<string, SourceDoc>();
  readonly assets = new Map<string, ImageAsset>();
  name = "문서";

  private undoStack: PageRef[][] = [];
  private redoStack: PageRef[][] = [];
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: ChangeKind, detail?: { pageId?: string }) {
    for (const fn of this.listeners) fn(kind, detail);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** 현재 상태를 이력에 저장하고 새 페이지 배열을 적용한다 */
  private commit(next: PageRef[], kind: ChangeKind, detail?: { pageId?: string }) {
    this.undoStack.push(this.pages);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.pages = next;
    this.emit(kind, detail);
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.pages);
    this.pages = prev;
    this.emit("pages");
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.pages);
    this.pages = next;
    this.emit("pages");
  }

  get isEmpty() {
    return this.pages.length === 0;
  }

  pageById(id: string): PageRef | undefined {
    return this.pages.find((p) => p.id === id);
  }

  pageIndex(id: string): number {
    return this.pages.findIndex((p) => p.id === id);
  }

  /** PDF 바이트를 읽어 소스로 등록하고 페이지 참조 목록을 만든다 */
  private async loadSource(bytes: Uint8Array, name: string): Promise<{ source: SourceDoc; pages: PageRef[] }> {
    const pdfjs = await loadPdfjs();
    // pdf.js는 전달된 버퍼를 워커로 넘기므로(transfer) 사본을 준다
    const proxy = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const source: SourceDoc = { id: newId("src"), name, bytes, proxy };
    this.sources.set(source.id, source);
    const pages: PageRef[] = [];
    for (let i = 1; i <= proxy.numPages; i++) {
      const page = await proxy.getPage(i);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      pages.push({
        id: newId("pg"),
        sourceId: source.id,
        sourceIndex: i - 1,
        baseRotation: normalizeRotation(page.rotate),
        rotation: 0,
        width: vp.width,
        height: vp.height,
        annotations: [],
      });
    }
    return { source, pages };
  }

  /** 새 문서로 연다 (기존 내용 대체) */
  async open(bytes: Uint8Array, name: string) {
    const { pages } = await this.loadSource(bytes, name);
    this.name = name.replace(/\.pdf$/i, "");
    this.undoStack = [];
    this.redoStack = [];
    this.pages = pages;
    this.emit("pages");
  }

  /** 다른 PDF의 페이지를 지정 위치에 삽입(병합) */
  async insertPdf(bytes: Uint8Array, name: string, index = this.pages.length) {
    const { pages } = await this.loadSource(bytes, name);
    this.commit(insertAt(this.pages, index, pages), "pages");
    return pages.map((p) => p.id);
  }

  insertBlankPage(index: number, width = 595.28, height = 841.89) {
    const page: PageRef = {
      id: newId("pg"),
      sourceId: null,
      sourceIndex: -1,
      baseRotation: 0,
      rotation: 0,
      width,
      height,
      annotations: [],
    };
    this.commit(insertAt(this.pages, index, [page]), "pages");
    return page.id;
  }

  duplicatePage(id: string) {
    const i = this.pageIndex(id);
    if (i < 0) return;
    const src = this.pages[i];
    const copy: PageRef = {
      ...src,
      id: newId("pg"),
      annotations: src.annotations.map((a) => ({ ...a, id: newId("an") })),
    };
    this.commit(insertAt(this.pages, i + 1, [copy]), "pages");
  }

  deletePages(ids: string[]) {
    if (ids.length === 0) return;
    this.commit(removePages(this.pages, ids), "pages");
  }

  rotatePages(ids: string[], delta: 90 | -90 | 180) {
    if (ids.length === 0) return;
    this.commit(rotatePages(this.pages, ids, delta), "pages");
  }

  movePage(from: number, to: number) {
    this.commit(movePage(this.pages, from, to), "pages");
  }

  /** 선택된 페이지들의 순서를 유지한 채 특정 인덱스 앞으로 이동 */
  movePages(ids: string[], toIndex: number) {
    const set = new Set(ids);
    const moving = this.pages.filter((p) => set.has(p.id));
    if (moving.length === 0) return;
    const rest = this.pages.filter((p) => !set.has(p.id));
    const before = this.pages.slice(0, toIndex).filter((p) => !set.has(p.id)).length;
    this.commit(insertAt(rest, before, moving), "pages");
  }

  // ---- 주석 ----

  addAnnotation(pageId: string, annot: Annotation) {
    this.commit(
      this.pages.map((p) => (p.id === pageId ? { ...p, annotations: [...p.annotations, annot] } : p)),
      "annotations",
      { pageId },
    );
  }

  addAnnotations(pageId: string, annots: Annotation[]) {
    if (annots.length === 0) return;
    this.commit(
      this.pages.map((p) => (p.id === pageId ? { ...p, annotations: [...p.annotations, ...annots] } : p)),
      "annotations",
      { pageId },
    );
  }

  private batchDepth = 0;
  private batchBefore: PageRef[] | null = null;

  /** 여러 변경을 실행취소 한 단계로 묶는다 */
  batch(fn: () => void) {
    if (this.batchDepth === 0) this.batchBefore = this.pages;
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.batchBefore) {
        // commit()이 쌓은 중간 이력을 시작 상태 하나로 합친다
        const before = this.batchBefore;
        this.batchBefore = null;
        if (this.pages === before) return; // 아무 변경도 없었다
        while (this.undoStack.length && this.undoStack[this.undoStack.length - 1] !== before) this.undoStack.pop();
        if (this.undoStack[this.undoStack.length - 1] !== before) this.undoStack.push(before);
        this.emit("pages");
      }
    }
  }

  updateAnnotation(pageId: string, annotId: string, patch: Partial<Annotation>, record = true) {
    const next = this.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            annotations: p.annotations.map((a) => (a.id === annotId ? ({ ...a, ...patch } as Annotation) : a)),
          }
        : p,
    );
    if (record) this.commit(next, "annotations", { pageId });
    else {
      this.pages = next;
      this.emit("annotations", { pageId });
    }
  }

  replaceAnnotation(pageId: string, annot: Annotation, record = true) {
    this.updateAnnotation(pageId, annot.id, annot, record);
  }

  /** 드래그 중 기록 없이 바꾼 뒤, 시작 상태를 이력에 넣고 싶을 때 */
  commitSnapshot(before: PageRef[]) {
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  removeAnnotation(pageId: string, annotId: string) {
    this.commit(
      this.pages.map((p) =>
        p.id === pageId ? { ...p, annotations: p.annotations.filter((a) => a.id !== annotId) } : p,
      ),
      "annotations",
      { pageId },
    );
  }

  clearAnnotations(pageId: string) {
    this.commit(this.pages.map((p) => (p.id === pageId ? { ...p, annotations: [] } : p)), "annotations", {
      pageId,
    });
  }

  addAsset(asset: ImageAsset) {
    this.assets.set(asset.id, asset);
  }

  rotationOf(id: string): Rotation {
    return this.pageById(id)?.rotation ?? 0;
  }
}
