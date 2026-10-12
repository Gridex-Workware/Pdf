import type { EditorDocument } from "../core/document";
import { annotBounds, hitTest, normalizeRect, simplifyPath, translateAnnot, type TextMeasurer } from "../core/geometry";
import type { Annotation, ImageAsset, PageRef, Point, RGB } from "../core/model";
import { displayRotation, displaySize, newId } from "../core/model";
import type { PDFPageProxy } from "../core/pdfjs";
import { applyInverseTransform, applyTransform, makeViewport, type Matrix, type Viewport } from "../core/transform";
import { HANDLE_PX, ImageCache, createCanvasMeasurer, drawOverlay, fontFor, hasResizeHandle } from "./overlay";

export type Tool = "select" | "text" | "rect" | "highlight" | "ink" | "image" | "whiteout";

export interface StyleState {
  color: RGB;
  fillColor: RGB | null;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
}

export interface Selection {
  pageId: string;
  annotId: string;
}

/** 96dpi 화면에서 100% 배율일 때 1pt당 CSS px */
const PT_TO_PX = 96 / 72;

interface PageView {
  ref: PageRef;
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  label: HTMLDivElement;
  viewport: Viewport;
  proxy: PDFPageProxy | null;
  renderTask: { cancel(): void; promise: Promise<unknown> } | null;
  renderedKey: string; // 마지막으로 그린 (scale, rotation) 키
  visible: boolean;
  /** 아직 그리지 않았거나 그리는 중인 키 */
  pendingKey: string;
  /** 같은 캔버스에 render()가 겹치지 않도록 직렬화하는 체인 */
  busy: Promise<void>;
}

type Drag =
  | { kind: "move"; pageId: string; annotId: string; last: Point; before: PageRef[]; moved: boolean }
  | { kind: "resize"; pageId: string; annotId: string; before: PageRef[] }
  | { kind: "draw"; pageId: string; start: Point; draft: Annotation }
  | { kind: "ink"; pageId: string; points: Point[]; draft: Annotation };

export class Viewer {
  readonly el: HTMLDivElement;
  zoom = 1;
  tool: Tool = "select";
  style: StyleState = {
    color: { r: 0.86, g: 0.15, b: 0.15 },
    fillColor: null,
    strokeWidth: 2,
    fontSize: 14,
    opacity: 1,
  };
  selection: Selection | null = null;
  pendingImage: ImageAsset | null = null;
  currentPageId: string | null = null;

  onSelectionChange: (sel: Selection | null) => void = () => {};
  onCurrentPageChange: (pageId: string | null) => void = () => {};
  onToolDone: () => void = () => {};

  private views = new Map<string, PageView>();
  private drag: Drag | null = null;
  private observer: IntersectionObserver;
  private images: ImageCache;
  private measure: TextMeasurer;
  private editor: { textarea: HTMLTextAreaElement; pageId: string; annotId: string } | null = null;
  private visibleRatio = new Map<string, number>();

  constructor(private doc: EditorDocument, container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "viewer";
    container.appendChild(this.el);
    this.measure = createCanvasMeasurer();
    this.images = new ImageCache(() => this.redrawAllOverlays());

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.pageId!;
          const v = this.views.get(id);
          if (!v) continue;
          v.visible = e.isIntersecting;
          this.visibleRatio.set(id, e.isIntersecting ? e.intersectionRatio : 0);
          if (e.isIntersecting) this.renderPage(v);
        }
        this.updateCurrentPage();
      },
      { root: this.el, rootMargin: "300px 0px", threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    doc.subscribe((kind, detail) => {
      if (kind === "pages") this.rebuild();
      else if (kind === "annotations") {
        if (detail?.pageId) this.redrawOverlay(detail.pageId);
        else this.redrawAllOverlays();
      }
    });

    this.el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.el.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    this.el.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    this.el.addEventListener("scroll", () => this.updateCurrentPage(), { passive: true });
  }

  get scale() {
    return this.zoom * PT_TO_PX;
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.el.dataset.tool = tool;
    if (tool !== "select") this.select(null);
  }

  setZoom(zoom: number, anchorRatio?: number) {
    const clamped = Math.max(0.25, Math.min(5, zoom));
    if (clamped === this.zoom) return;
    const ratio = anchorRatio ?? (this.el.scrollHeight > 0 ? this.el.scrollTop / this.el.scrollHeight : 0);
    this.zoom = clamped;
    this.commitEditor();
    for (const v of this.views.values()) this.layoutPage(v);
    this.el.scrollTop = ratio * this.el.scrollHeight;
    for (const v of this.views.values()) if (v.visible) this.renderPage(v);
  }

  /** 가장 넓은 페이지가 뷰어 너비에 맞도록 배율 조정 */
  fitWidth() {
    if (this.doc.isEmpty) return;
    const maxW = Math.max(...this.doc.pages.map((p) => displaySize(p).width));
    const avail = this.el.clientWidth - 48;
    this.setZoom(avail / (maxW * PT_TO_PX));
  }

  fitPage() {
    if (this.doc.isEmpty) return;
    const page = this.doc.pageById(this.currentPageId ?? this.doc.pages[0].id) ?? this.doc.pages[0];
    const size = displaySize(page);
    const zw = (this.el.clientWidth - 48) / (size.width * PT_TO_PX);
    const zh = (this.el.clientHeight - 48) / (size.height * PT_TO_PX);
    this.setZoom(Math.min(zw, zh));
  }

  scrollToPage(pageId: string) {
    const v = this.views.get(pageId);
    if (!v) return;
    this.el.scrollTo({ top: v.wrap.offsetTop - 16, behavior: "smooth" });
    this.setCurrentPage(pageId);
  }

  select(sel: Selection | null) {
    const prev = this.selection;
    this.selection = sel;
    if (prev && prev.pageId !== sel?.pageId) this.redrawOverlay(prev.pageId);
    if (sel) this.redrawOverlay(sel.pageId);
    else if (prev) this.redrawOverlay(prev.pageId);
    this.onSelectionChange(sel);
  }

  selectedAnnotation(): Annotation | null {
    if (!this.selection) return null;
    return this.doc.pageById(this.selection.pageId)?.annotations.find((a) => a.id === this.selection!.annotId) ?? null;
  }

  deleteSelected() {
    if (!this.selection) return;
    const { pageId, annotId } = this.selection;
    this.select(null);
    this.doc.removeAnnotation(pageId, annotId);
  }

  /** 선택된 주석의 속성을 바꾼다 */
  updateSelected(patch: Partial<Annotation>) {
    if (!this.selection) return;
    this.doc.updateAnnotation(this.selection.pageId, this.selection.annotId, patch);
  }

  /** 텍스트 주석의 인라인 편집을 시작한다 */
  editText(pageId: string, annotId: string) {
    this.commitEditor();
    const v = this.views.get(pageId);
    const a = v?.ref.annotations.find((x) => x.id === annotId);
    if (!v || !a || a.type !== "text") return;
    this.select({ pageId, annotId });

    const ta = document.createElement("textarea");
    ta.className = "text-editor";
    ta.value = a.text;
    const top = applyTransform(v.viewport.transform, { x: a.x, y: a.y + a.fontSize * 0.8 });
    const rot = displayRotation(v.ref);
    const sizePx = a.fontSize * this.scale;
    ta.style.font = fontFor(a.text || "가", sizePx);
    ta.style.lineHeight = "1.2";
    ta.style.color = `rgb(${a.color.r * 255}, ${a.color.g * 255}, ${a.color.b * 255})`;
    ta.style.left = `${top.x}px`;
    ta.style.top = `${top.y}px`;
    ta.style.transformOrigin = "0 0";
    // 주석의 rotate는 페이지 표시 회전을 상쇄하도록 저장되므로, 화면에서는 (표시회전 - rotate)만큼 기울어진다
    const screenRot = (rot - a.rotate + 360) % 360;
    ta.style.transform = screenRot ? `rotate(${screenRot}deg)` : "";
    const fit = () => {
      ta.style.width = "0px";
      ta.style.height = "0px";
      ta.style.width = `${Math.max(ta.scrollWidth, sizePx * 2) + 8}px`;
      ta.style.height = `${ta.scrollHeight + 4}px`;
    };
    ta.addEventListener("input", fit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.commitEditor();
      }
      e.stopPropagation();
    });
    ta.addEventListener("blur", () => this.commitEditor());
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    v.wrap.appendChild(ta);
    this.editor = { textarea: ta, pageId, annotId };
    this.redrawOverlay(pageId);
    fit();
    // pointerdown 처리 중이면 포커스가 바로 빼앗길 수 있으므로 다음 틱에 포커스
    setTimeout(() => {
      if (this.editor?.textarea === ta) {
        ta.focus();
        ta.select();
      }
    }, 0);
  }

  /** 인라인 편집을 끝내고 결과를 문서에 반영 */
  commitEditor() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const text = ed.textarea.value;
    ed.textarea.remove();
    const page = this.doc.pageById(ed.pageId);
    const a = page?.annotations.find((x) => x.id === ed.annotId);
    if (!page || !a || a.type !== "text") return;
    if (!text.trim()) {
      if (this.selection?.annotId === ed.annotId) this.select(null);
      this.doc.removeAnnotation(ed.pageId, ed.annotId);
    } else if (text !== a.text) {
      this.doc.updateAnnotation(ed.pageId, ed.annotId, { text });
    } else {
      this.redrawOverlay(ed.pageId);
    }
  }

  get isEditingText() {
    return this.editor !== null;
  }

  // ---------- DOM 구성 ----------

  private rebuild() {
    this.commitEditor();
    const alive = new Set(this.doc.pages.map((p) => p.id));
    for (const [id, v] of this.views) {
      if (!alive.has(id)) {
        v.renderTask?.cancel();
        this.observer.unobserve(v.wrap);
        v.wrap.remove();
        this.views.delete(id);
        this.visibleRatio.delete(id);
      }
    }
    if (this.selection && !alive.has(this.selection.pageId)) this.select(null);

    this.doc.pages.forEach((ref, i) => {
      let v = this.views.get(ref.id);
      if (!v) {
        v = this.createView(ref);
        this.views.set(ref.id, v);
      }
      const changed = v.ref.rotation !== ref.rotation || v.ref.width !== ref.width || v.ref.height !== ref.height;
      v.ref = ref;
      v.label.textContent = String(i + 1);
      if (this.el.children[i] !== v.wrap) this.el.insertBefore(v.wrap, this.el.children[i] ?? null);
      if (changed) {
        this.layoutPage(v);
        if (v.visible) this.renderPage(v);
      } else {
        this.redrawOverlay(ref.id);
      }
    });

    if (this.selection) {
      const page = this.doc.pageById(this.selection.pageId);
      if (!page?.annotations.some((a) => a.id === this.selection!.annotId)) this.select(null);
    }
    this.updateCurrentPage();
  }

  private createView(ref: PageRef): PageView {
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.pageId = ref.id;
    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    const overlay = document.createElement("canvas");
    overlay.className = "overlay-canvas";
    const label = document.createElement("div");
    label.className = "page-label";
    wrap.append(canvas, overlay, label);
    const v: PageView = {
      ref,
      wrap,
      canvas,
      overlay,
      label,
      viewport: makeViewport([0, 0, ref.width, ref.height], this.scale, displayRotation(ref)),
      proxy: null,
      renderTask: null,
      renderedKey: "",
      visible: false,
      pendingKey: "",
      busy: Promise.resolve(),
    };
    this.layoutPage(v);
    this.observer.observe(wrap);
    return v;
  }

  private layoutPage(v: PageView) {
    const dpr = window.devicePixelRatio || 1;
    const ref = v.ref;
    const rot = displayRotation(ref);
    v.viewport = v.proxy
      ? (v.proxy.getViewport({ scale: this.scale, rotation: rot }) as unknown as Viewport)
      : makeViewport([0, 0, ref.width, ref.height], this.scale, rot);
    const w = Math.round(v.viewport.width);
    const h = Math.round(v.viewport.height);
    v.wrap.style.width = `${w}px`;
    v.wrap.style.height = `${h}px`;
    for (const c of [v.canvas, v.overlay]) {
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    v.canvas.classList.add("stale");
    v.renderedKey = "";
    this.redrawOverlay(ref.id);
  }

  private renderPage(v: PageView): Promise<void> {
    const key = `${this.scale}:${displayRotation(v.ref)}:${window.devicePixelRatio}`;
    if (v.renderedKey === key || v.pendingKey === key) return v.busy;
    v.pendingKey = key;
    v.renderTask?.cancel();
    // 이전 렌더링(취소 포함)이 끝난 뒤 시작해야 pdf.js가 같은 캔버스 사용을 거부하지 않는다
    const run = v.busy.then(() => (v.pendingKey === key ? this.renderPageNow(v, key) : undefined));
    v.busy = run.catch(() => undefined);
    return v.busy;
  }

  private async renderPageNow(v: PageView, key: string) {
    const ref = v.ref;
    if (!this.views.has(ref.id)) return;
    if (!ref.sourceId) {
      const ctx = v.canvas.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, v.canvas.width, v.canvas.height);
      v.renderedKey = key;
      v.canvas.classList.remove("stale");
      return;
    }

    const source = this.doc.sources.get(ref.sourceId);
    if (!source) return;
    if (!v.proxy) {
      v.proxy = await source.proxy.getPage(ref.sourceIndex + 1);
      if (v.ref !== ref && !this.views.has(ref.id)) return;
      this.layoutPage(v);
    }
    const dpr = window.devicePixelRatio || 1;
    const viewport = v.proxy.getViewport({ scale: this.scale, rotation: displayRotation(v.ref) });
    if (v.pendingKey !== key) return; // 그 사이 배율/회전이 바뀌었다
    const task = v.proxy.render({
      canvas: v.canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    } as Parameters<PDFPageProxy["render"]>[0]);
    v.renderTask = task;
    try {
      await task.promise;
      v.renderedKey = key;
      v.canvas.classList.remove("stale");
    } catch (e) {
      if ((e as Error)?.name !== "RenderingCancelledException") console.error(e);
    } finally {
      if (v.renderTask === task) v.renderTask = null;
      if (v.pendingKey === key) v.pendingKey = "";
    }
  }

  private redrawOverlay(pageId: string) {
    const v = this.views.get(pageId);
    if (!v) return;
    // 주석 변경은 'pages' 이벤트 없이 일어나므로 최신 PageRef로 갱신한다
    v.ref = this.doc.pageById(pageId) ?? v.ref;
    const draft = this.drag && "draft" in this.drag && this.drag.pageId === pageId ? this.drag.draft : null;
    drawOverlay(v.overlay, {
      transform: v.viewport.transform as Matrix,
      dpr: window.devicePixelRatio || 1,
      annotations: v.ref.annotations,
      draft,
      selectedId: this.selection?.pageId === pageId ? this.selection.annotId : null,
      assets: this.doc.assets,
      images: this.images,
      measure: this.measure,
      hiddenId: this.editor?.pageId === pageId ? this.editor.annotId : null,
    });
  }

  private redrawAllOverlays() {
    for (const id of this.views.keys()) this.redrawOverlay(id);
  }

  private updateCurrentPage() {
    let best: string | null = null;
    let bestRatio = -1;
    const mid = this.el.scrollTop + this.el.clientHeight / 2;
    let bestDist = Infinity;
    for (const p of this.doc.pages) {
      const ratio = this.visibleRatio.get(p.id) ?? 0;
      const v = this.views.get(p.id);
      if (!v) continue;
      const center = v.wrap.offsetTop + v.wrap.offsetHeight / 2;
      const dist = Math.abs(center - mid);
      if (ratio > 0 && (ratio > bestRatio + 0.2 || (Math.abs(ratio - bestRatio) <= 0.2 && dist < bestDist))) {
        best = p.id;
        bestRatio = ratio;
        bestDist = dist;
      }
    }
    if (best === null && this.doc.pages.length > 0) best = this.currentPageId ?? this.doc.pages[0].id;
    this.setCurrentPage(best);
  }

  private setCurrentPage(id: string | null) {
    if (id === this.currentPageId) return;
    this.currentPageId = id;
    this.onCurrentPageChange(id);
  }

  // ---------- 포인터 상호작용 ----------

  private viewAt(e: PointerEvent | MouseEvent): { v: PageView; view: Point; pdf: Point } | null {
    const wrap = (e.target as HTMLElement).closest<HTMLElement>(".page-wrap");
    if (!wrap) return null;
    const v = this.views.get(wrap.dataset.pageId!);
    if (!v) return null;
    const rect = v.overlay.getBoundingClientRect();
    const view = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return { v, view, pdf: applyInverseTransform(v.viewport.transform as Matrix, view) };
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const hit = this.viewAt(e);
    if (!hit) {
      if (this.tool === "select") this.select(null);
      return;
    }
    const { v, view, pdf } = hit;
    // 뒤따르는 mousedown 기본 동작(포커스 이동, 텍스트 선택)을 막는다
    e.preventDefault();
    this.commitEditor();
    this.setCurrentPage(v.ref.id);
    const pageId = v.ref.id;
    const s = this.style;

    switch (this.tool) {
      case "select": {
        const sel = this.selection?.pageId === pageId ? this.selectedAnnotation() : null;
        if (sel && hasResizeHandle(sel)) {
          const corner = applyTransform(v.viewport.transform as Matrix, { x: sel.x + sel.width, y: sel.y + sel.height });
          if (Math.abs(corner.x - view.x) <= HANDLE_PX && Math.abs(corner.y - view.y) <= HANDLE_PX) {
            this.drag = { kind: "resize", pageId, annotId: sel.id, before: this.doc.pages };
            v.overlay.setPointerCapture(e.pointerId);
            return;
          }
        }
        const target = hitTest(v.ref.annotations, pdf, this.measure, 4 / this.scale);
        if (target) {
          this.select({ pageId, annotId: target.id });
          this.drag = { kind: "move", pageId, annotId: target.id, last: pdf, before: this.doc.pages, moved: false };
          v.overlay.setPointerCapture(e.pointerId);
        } else {
          this.select(null);
        }
        return;
      }
      case "text": {
        const rot = displayRotation(v.ref);
        const origin = applyInverseTransform(v.viewport.transform as Matrix, { x: view.x, y: view.y + s.fontSize * 0.8 * this.scale });
        const annot: Annotation = {
          id: newId("an"),
          type: "text",
          x: origin.x,
          y: origin.y,
          text: "",
          fontSize: s.fontSize,
          color: s.color,
          opacity: s.opacity,
          rotate: rot,
        };
        this.doc.addAnnotation(pageId, annot);
        this.editText(pageId, annot.id);
        this.onToolDone();
        return;
      }
      case "rect":
      case "highlight":
      case "whiteout": {
        const base = { id: newId("an"), x: pdf.x, y: pdf.y, width: 0, height: 0 };
        const draft: Annotation =
          this.tool === "rect"
            ? { ...base, type: "rect", strokeColor: s.color, fillColor: s.fillColor, strokeWidth: s.strokeWidth, opacity: s.opacity }
            : this.tool === "highlight"
              ? { ...base, type: "highlight", color: s.color, opacity: Math.min(s.opacity, 0.5) }
              : // 흰색 덮기: 기존 내용을 가리는 불투명 흰 사각형
                { ...base, type: "rect", strokeColor: { r: 1, g: 1, b: 1 }, fillColor: { r: 1, g: 1, b: 1 }, strokeWidth: 0, opacity: 1 };
        this.drag = { kind: "draw", pageId, start: pdf, draft };
        v.overlay.setPointerCapture(e.pointerId);
        return;
      }
      case "ink": {
        const draft: Annotation = { id: newId("an"), type: "ink", points: [pdf], color: s.color, strokeWidth: s.strokeWidth, opacity: s.opacity };
        this.drag = { kind: "ink", pageId, points: [pdf], draft };
        v.overlay.setPointerCapture(e.pointerId);
        this.redrawOverlay(pageId);
        return;
      }
      case "image": {
        const asset = this.pendingImage;
        if (!asset) return;
        const pageW = v.ref.width;
        const pageH = v.ref.height;
        let w = asset.width * 0.75; // px -> pt (96dpi 기준)
        let h = asset.height * 0.75;
        const maxW = Math.min(pageW, pageH) * 0.5;
        if (w > maxW) {
          h *= maxW / w;
          w = maxW;
        }
        const rot = displayRotation(v.ref);
        const origin = applyInverseTransform(v.viewport.transform as Matrix, { x: view.x, y: view.y + h * this.scale });
        const annot: Annotation = { id: newId("an"), type: "image", x: origin.x, y: origin.y, width: w, height: h, assetId: asset.id, rotate: rot, opacity: s.opacity };
        this.doc.addAnnotation(pageId, annot);
        this.pendingImage = null;
        this.setTool("select");
        this.select({ pageId, annotId: annot.id });
        this.onToolDone();
        return;
      }
    }
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const v = this.views.get(d.pageId);
    if (!v) return;
    const rect = v.overlay.getBoundingClientRect();
    const pdf = applyInverseTransform(v.viewport.transform as Matrix, { x: e.clientX - rect.left, y: e.clientY - rect.top });

    switch (d.kind) {
      case "move": {
        const dx = pdf.x - d.last.x;
        const dy = pdf.y - d.last.y;
        if (dx === 0 && dy === 0) return;
        d.last = pdf;
        d.moved = true;
        const a = v.ref.annotations.find((x) => x.id === d.annotId);
        if (a) this.doc.replaceAnnotation(d.pageId, translateAnnot(a, dx, dy), false);
        return;
      }
      case "resize": {
        const a = v.ref.annotations.find((x) => x.id === d.annotId);
        if (!a || !hasResizeHandle(a)) return;
        const width = Math.max(2, pdf.x - a.x);
        const height = Math.max(2, pdf.y - a.y);
        this.doc.updateAnnotation(d.pageId, a.id, { width, height } as Partial<Annotation>, false);
        return;
      }
      case "draw": {
        const box = normalizeRect(d.start, pdf);
        d.draft = { ...d.draft, ...box } as Annotation;
        this.redrawOverlay(d.pageId);
        return;
      }
      case "ink": {
        d.points.push(pdf);
        (d.draft as Extract<Annotation, { type: "ink" }>).points = d.points;
        this.redrawOverlay(d.pageId);
        return;
      }
    }
  }

  private onPointerUp(_e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    switch (d.kind) {
      case "move":
        if (d.moved) this.doc.commitSnapshot(d.before);
        return;
      case "resize":
        this.doc.commitSnapshot(d.before);
        return;
      case "draw": {
        const a = d.draft;
        if ("width" in a && a.width >= 2 && a.height >= 2) {
          this.doc.addAnnotation(d.pageId, a);
          this.select({ pageId: d.pageId, annotId: a.id });
        } else this.redrawOverlay(d.pageId);
        return;
      }
      case "ink": {
        const points = simplifyPath(d.points, 0.75);
        const a = { ...(d.draft as Extract<Annotation, { type: "ink" }>), points };
        this.doc.addAnnotation(d.pageId, a);
        return;
      }
    }
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.tool !== "select") return;
    const hit = this.viewAt(e);
    if (!hit) return;
    const target = hitTest(hit.v.ref.annotations, hit.pdf, this.measure, 4 / this.scale);
    if (target?.type === "text") this.editText(hit.v.ref.id, target.id);
  }

  /** 선택 주석의 경계(디버그/패널용) */
  selectedBounds() {
    const a = this.selectedAnnotation();
    return a ? annotBounds(a, this.measure) : null;
  }
}
