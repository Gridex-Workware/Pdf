import type { EditorDocument } from "../core/document";
import type { PageRef } from "../core/model";
import { displayRotation, displaySize } from "../core/model";

const THUMB_WIDTH = 120;

interface ThumbView {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  check: HTMLInputElement;
  num: HTMLSpanElement;
  key: string;
  task: { cancel(): void } | null;
  /** 같은 캔버스에 render()가 겹치지 않도록 직렬화하는 체인 */
  busy: Promise<void>;
}

/** 페이지 썸네일 목록. 선택/드래그 재배열/현재 페이지 표시를 담당한다. */
export class Sidebar {
  readonly el: HTMLDivElement;
  readonly list: HTMLDivElement;
  readonly selected = new Set<string>();
  onNavigate: (pageId: string) => void = () => {};
  onSelectionChange: () => void = () => {};

  private views = new Map<string, ThumbView>();
  private currentId: string | null = null;
  private observer: IntersectionObserver;
  private dragIds: string[] = [];
  private dropIndex = -1;

  constructor(private doc: EditorDocument, container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "sidebar";
    this.list = document.createElement("div");
    this.list.className = "thumb-list";
    this.el.appendChild(this.list);
    container.appendChild(this.el);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.pageId!;
          const page = this.doc.pageById(id);
          const v = this.views.get(id);
          if (page && v) void this.renderThumb(v, page);
        }
      },
      { root: this.list, rootMargin: "200px 0px" },
    );

    doc.subscribe((kind) => {
      if (kind === "pages") this.rebuild();
    });

    this.list.addEventListener("dragover", (e) => this.onDragOver(e));
    this.list.addEventListener("drop", (e) => this.onDrop(e));
    this.list.addEventListener("dragleave", (e) => {
      if (e.target === this.list) this.clearDropMarker();
    });
  }

  setCurrent(id: string | null) {
    if (this.currentId && this.views.get(this.currentId)) this.views.get(this.currentId)!.el.classList.remove("current");
    this.currentId = id;
    if (id && this.views.get(id)) {
      const v = this.views.get(id)!;
      v.el.classList.add("current");
      const r = v.el.getBoundingClientRect();
      const lr = this.list.getBoundingClientRect();
      if (r.top < lr.top || r.bottom > lr.bottom) v.el.scrollIntoView({ block: "nearest" });
    }
  }

  /** 체크된 페이지가 없으면 현재 페이지를 대상으로 한다 */
  targetIds(): string[] {
    const ids = this.doc.pages.filter((p) => this.selected.has(p.id)).map((p) => p.id);
    if (ids.length > 0) return ids;
    return this.currentId ? [this.currentId] : [];
  }

  selectAll(on: boolean) {
    this.selected.clear();
    if (on) for (const p of this.doc.pages) this.selected.add(p.id);
    this.syncChecks();
    this.onSelectionChange();
  }

  private syncChecks() {
    for (const [id, v] of this.views) {
      v.check.checked = this.selected.has(id);
      v.el.classList.toggle("selected", v.check.checked);
    }
  }

  private rebuild() {
    const alive = new Set(this.doc.pages.map((p) => p.id));
    for (const [id, v] of this.views) {
      if (!alive.has(id)) {
        this.observer.unobserve(v.el);
        v.el.remove();
        this.views.delete(id);
        this.selected.delete(id);
      }
    }
    this.doc.pages.forEach((page, i) => {
      let v = this.views.get(page.id);
      if (!v) {
        v = this.createThumb(page);
        this.views.set(page.id, v);
      }
      v.num.textContent = String(i + 1);
      const size = displaySize(page);
      const h = Math.round((THUMB_WIDTH * size.height) / size.width);
      v.canvas.style.width = `${THUMB_WIDTH}px`;
      v.canvas.style.height = `${h}px`;
      if (this.list.children[i] !== v.el) this.list.insertBefore(v.el, this.list.children[i] ?? null);
      const key = this.keyOf(page);
      if (v.key !== key) {
        v.key = "";
        const r = v.el.getBoundingClientRect();
        const lr = this.list.getBoundingClientRect();
        if (r.bottom >= lr.top - 200 && r.top <= lr.bottom + 200) void this.renderThumb(v, page);
      }
    });
    this.syncChecks();
    this.onSelectionChange();
  }

  private keyOf(page: PageRef) {
    return `${page.sourceId}:${page.sourceIndex}:${displayRotation(page)}:${page.width}x${page.height}`;
  }

  private createThumb(page: PageRef): ThumbView {
    const el = document.createElement("div");
    el.className = "thumb";
    el.dataset.pageId = page.id;
    el.draggable = true;
    const canvas = document.createElement("canvas");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "thumb-check";
    check.title = "페이지 선택";
    const num = document.createElement("span");
    num.className = "thumb-num";
    el.append(check, canvas, num);

    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(page.id);
      else this.selected.delete(page.id);
      el.classList.toggle("selected", check.checked);
      this.onSelectionChange();
    });
    el.addEventListener("click", (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        check.checked = !check.checked;
        check.dispatchEvent(new Event("change"));
        return;
      }
      this.onNavigate(page.id);
    });
    el.addEventListener("dragstart", (e) => {
      const ids = this.selected.has(page.id) ? this.doc.pages.filter((p) => this.selected.has(p.id)).map((p) => p.id) : [page.id];
      this.dragIds = ids;
      e.dataTransfer?.setData("text/plain", ids.join(","));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      this.clearDropMarker();
      this.dragIds = [];
    });
    this.observer.observe(el);
    return { el, canvas, check, num, key: "", task: null, busy: Promise.resolve() };
  }

  private renderThumb(v: ThumbView, page: PageRef): Promise<void> {
    const key = this.keyOf(page);
    if (v.key === key) return v.busy;
    v.key = key;
    v.task?.cancel();
    // 이전 렌더링이 (취소 포함) 완전히 끝난 뒤에 시작해야 pdf.js가 같은 캔버스 사용을 거부하지 않는다
    const run = v.busy.then(async () => {
      if (v.key !== key) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = displaySize(page);
      const scale = THUMB_WIDTH / size.width;
      v.canvas.width = Math.round(THUMB_WIDTH * dpr);
      v.canvas.height = Math.round(size.height * scale * dpr);
      const ctx = v.canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, v.canvas.width, v.canvas.height);
      if (!page.sourceId) return;
      const source = this.doc.sources.get(page.sourceId);
      if (!source) return;
      try {
        const proxy = await source.proxy.getPage(page.sourceIndex + 1);
        if (v.key !== key) return;
        const viewport = proxy.getViewport({ scale: scale * dpr, rotation: displayRotation(page) });
        const task = proxy.render({ canvas: v.canvas, viewport } as Parameters<typeof proxy.render>[0]);
        v.task = task;
        await task.promise;
      } catch (e) {
        if ((e as Error)?.name !== "RenderingCancelledException") console.error(e);
      } finally {
        v.task = null;
      }
    });
    v.busy = run.catch(() => undefined);
    return v.busy;
  }

  // ---- 드래그 재배열 ----

  private indexFromPointer(e: DragEvent): number {
    const items = [...this.list.children] as HTMLElement[];
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return i;
    }
    return items.length;
  }

  private onDragOver(e: DragEvent) {
    if (this.dragIds.length === 0) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const idx = this.indexFromPointer(e);
    if (idx === this.dropIndex) return;
    this.clearDropMarker();
    this.dropIndex = idx;
    const items = [...this.list.children] as HTMLElement[];
    if (idx < items.length) items[idx].classList.add("drop-before");
    else if (items.length) items[items.length - 1].classList.add("drop-after");
  }

  private clearDropMarker() {
    this.dropIndex = -1;
    for (const c of this.list.children) c.classList.remove("drop-before", "drop-after");
  }

  private onDrop(e: DragEvent) {
    if (this.dragIds.length === 0) return;
    e.preventDefault();
    const idx = this.indexFromPointer(e);
    const ids = this.dragIds;
    this.clearDropMarker();
    this.dragIds = [];
    this.doc.movePages(ids, idx);
  }
}
