import { EditorDocument } from "../core/document";
import { downloadBytes, exportPdf } from "../core/export";
import { ensureCssFont } from "../core/fonts";
import type { Annotation, ImageAsset, RGB } from "../core/model";
import { hexToRgb, newId, rgbToHex } from "../core/model";
import { parsePageRanges } from "../core/pageops";
import { Sidebar } from "./sidebar";
import { toast } from "./toast";
import { Viewer, type Tool } from "./viewer";

const TOOLS: { id: Tool; label: string; key: string; title: string }[] = [
  { id: "select", label: "선택", key: "V", title: "선택/이동 (V)" },
  { id: "text", label: "텍스트", key: "T", title: "텍스트 추가 (T)" },
  { id: "rect", label: "사각형", key: "R", title: "사각형 그리기 (R)" },
  { id: "highlight", label: "형광펜", key: "H", title: "형광펜 (H)" },
  { id: "ink", label: "펜", key: "P", title: "자유 곡선 (P)" },
  { id: "image", label: "이미지", key: "I", title: "이미지 삽입 (I)" },
];

function button(label: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function separator() {
  const s = document.createElement("span");
  s.className = "sep";
  return s;
}

async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** 이미지 파일을 PDF에 넣을 수 있는 PNG/JPEG 자산으로 변환 */
async function loadImageAsset(file: File): Promise<ImageAsset> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("이미지를 읽을 수 없습니다"));
      i.src = url;
    });
    if (file.type === "image/png" || file.type === "image/jpeg") {
      return { id: newId("img"), mime: file.type, bytes: await readFile(file), width: img.naturalWidth, height: img.naturalHeight };
    }
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("이미지 변환 실패");
    return { id: newId("img"), mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()), width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

export class App {
  readonly doc = new EditorDocument();
  readonly viewer: Viewer;
  readonly sidebar: Sidebar;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private zoomLabel!: HTMLSpanElement;
  private pageLabel!: HTMLSpanElement;
  private empty!: HTMLDivElement;
  private props!: {
    color: HTMLInputElement;
    fillOn: HTMLInputElement;
    fill: HTMLInputElement;
    stroke: HTMLInputElement;
    font: HTMLInputElement;
    opacity: HTMLInputElement;
    deleteBtn: HTMLButtonElement;
  };

  constructor(root: HTMLElement) {
    root.innerHTML = "";
    root.className = "app";
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const body = document.createElement("div");
    body.className = "body";
    root.append(toolbar, body);

    this.sidebar = new Sidebar(this.doc, body);
    this.buildSidebarTools();
    const main = document.createElement("div");
    main.className = "main";
    body.appendChild(main);
    this.viewer = new Viewer(this.doc, main);
    this.buildEmptyState(main);
    this.buildToolbar(toolbar);

    this.viewer.onSelectionChange = () => this.syncProps();
    this.viewer.onCurrentPageChange = (id) => {
      this.sidebar.setCurrent(id);
      this.updatePageLabel();
    };
    this.viewer.onToolDone = () => this.setTool("select");
    this.sidebar.onNavigate = (id) => this.viewer.scrollToPage(id);

    this.doc.subscribe(() => {
      this.undoBtn.disabled = !this.doc.canUndo;
      this.redoBtn.disabled = !this.doc.canRedo;
      this.empty.hidden = !this.doc.isEmpty;
      this.updatePageLabel();
    });

    this.bindKeyboard();
    this.bindFileDrop(main);
    this.setTool("select");
    this.syncProps();
    void ensureCssFont();
  }

  // ---------- 툴바 ----------

  private buildToolbar(bar: HTMLElement) {
    bar.append(
      button("열기", "PDF 열기 (Ctrl+O)", () => void this.openFile()),
      button("PDF 추가", "다른 PDF의 페이지를 끝에 추가(병합)", () => void this.appendFile()),
      button("저장", "편집 결과를 PDF로 내려받기 (Ctrl+S)", () => void this.save(), "primary"),
      separator(),
    );
    this.undoBtn = button("↶", "실행 취소 (Ctrl+Z)", () => this.doc.undo());
    this.redoBtn = button("↷", "다시 실행 (Ctrl+Y)", () => this.doc.redo());
    bar.append(this.undoBtn, this.redoBtn, separator());

    for (const t of TOOLS) {
      const b = button(t.label, t.title, () => {
        if (t.id === "image") void this.startImageTool();
        else this.setTool(t.id);
      });
      b.dataset.tool = t.id;
      this.toolButtons.set(t.id, b);
      bar.appendChild(b);
    }
    bar.appendChild(separator());

    // 속성
    const props = document.createElement("div");
    props.className = "props";
    const color = document.createElement("input");
    color.type = "color";
    color.title = "색";
    const fillOn = document.createElement("input");
    fillOn.type = "checkbox";
    fillOn.title = "채우기 사용";
    const fill = document.createElement("input");
    fill.type = "color";
    fill.title = "채우기 색";
    const stroke = document.createElement("input");
    stroke.type = "number";
    stroke.min = "0";
    stroke.max = "50";
    stroke.step = "0.5";
    stroke.title = "선 굵기(pt)";
    const font = document.createElement("input");
    font.type = "number";
    font.min = "4";
    font.max = "200";
    font.title = "글꼴 크기(pt)";
    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0.05";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.title = "불투명도";
    const deleteBtn = button("삭제", "선택한 주석 삭제 (Delete)", () => this.viewer.deleteSelected(), "danger");

    const field = (label: string, ...els: HTMLElement[]) => {
      const l = document.createElement("label");
      l.className = "field";
      const s = document.createElement("span");
      s.textContent = label;
      l.append(s, ...els);
      return l;
    };
    props.append(
      field("색", color),
      field("채움", fillOn, fill),
      field("굵기", stroke),
      field("글꼴", font),
      field("투명", opacity),
      deleteBtn,
    );
    this.props = { color, fillOn, fill, stroke, font, opacity, deleteBtn };
    for (const input of [color, fillOn, fill, stroke, font, opacity]) {
      input.addEventListener("input", () => this.applyProps(false));
      input.addEventListener("change", () => this.applyProps(true));
    }
    bar.append(props, separator());

    // 배율
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "zoom-label";
    bar.append(
      button("−", "축소", () => this.zoomBy(1 / 1.2)),
      this.zoomLabel,
      button("+", "확대", () => this.zoomBy(1.2)),
      button("폭 맞춤", "페이지 폭을 화면에 맞춤", () => {
        this.viewer.fitWidth();
        this.updateZoomLabel();
      }),
      button("쪽 맞춤", "페이지 전체를 화면에 맞춤", () => {
        this.viewer.fitPage();
        this.updateZoomLabel();
      }),
    );
    this.pageLabel = document.createElement("span");
    this.pageLabel.className = "page-indicator";
    bar.appendChild(this.pageLabel);
    this.updateZoomLabel();
    this.updatePageLabel();
  }

  private buildSidebarTools() {
    const bar = document.createElement("div");
    bar.className = "sidebar-tools";
    const sb = this.sidebar;
    bar.append(
      button("전체", "모든 페이지 선택/해제", () => sb.selectAll(sb.selected.size < this.doc.pages.length)),
      button("↺", "왼쪽으로 회전", () => this.doc.rotatePages(sb.targetIds(), -90)),
      button("↻", "오른쪽으로 회전", () => this.doc.rotatePages(sb.targetIds(), 90)),
      button("복제", "페이지 복제", () => {
        for (const id of sb.targetIds()) this.doc.duplicatePage(id);
      }),
      button("빈 쪽", "현재 페이지 뒤에 빈 페이지 추가", () => this.insertBlank()),
      button("추출", "선택 페이지를 새 PDF로 내려받기", () => void this.extract()),
      button("삭제", "선택 페이지 삭제", () => this.deletePages(), "danger"),
    );
    sb.el.insertBefore(bar, sb.list);
    const hint = document.createElement("div");
    hint.className = "sidebar-hint";
    hint.textContent = "클릭: 이동 · Ctrl/Shift+클릭 또는 체크: 선택 · 드래그: 순서 변경";
    sb.el.appendChild(hint);
  }

  private buildEmptyState(main: HTMLElement) {
    this.empty = document.createElement("div");
    this.empty.className = "empty";
    this.empty.innerHTML = `
      <div class="empty-card">
        <h1>PDF 편집기</h1>
        <p>PDF 파일을 열거나 이 영역에 끌어다 놓으세요.</p>
        <div class="empty-actions"></div>
        <ul>
          <li>페이지 회전 · 삭제 · 순서 변경 · 복제 · 병합 · 추출</li>
          <li>텍스트(한글 지원) · 사각형 · 형광펜 · 펜 · 이미지 삽입</li>
          <li>모든 처리는 브라우저 안에서만 이루어집니다. 파일이 서버로 전송되지 않습니다.</li>
        </ul>
      </div>`;
    this.empty.querySelector(".empty-actions")!.append(
      button("PDF 열기", "PDF 파일 선택", () => void this.openFile(), "primary"),
      button("새 빈 문서", "A4 빈 페이지로 시작", () => this.newBlankDocument()),
    );
    main.appendChild(this.empty);
  }

  // ---------- 동작 ----------

  setTool(tool: Tool) {
    this.viewer.setTool(tool);
    for (const [id, b] of this.toolButtons) b.classList.toggle("active", id === tool);
    this.syncProps();
  }

  private async startImageTool() {
    const [file] = await pickFiles("image/*");
    if (!file) return;
    try {
      const asset = await loadImageAsset(file);
      this.doc.addAsset(asset);
      this.viewer.pendingImage = asset;
      this.setTool("image");
      toast("이미지를 놓을 위치를 페이지에서 클릭하세요");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async openFile() {
    const [file] = await pickFiles("application/pdf,.pdf");
    if (file) await this.openBytes(file);
  }

  async openBytes(file: File) {
    try {
      await this.doc.open(await readFile(file), file.name);
      this.viewer.fitWidth();
      this.updateZoomLabel();
      toast(`${file.name} (${this.doc.pages.length}쪽) 열림`);
    } catch (e) {
      toast(`PDF를 열 수 없습니다: ${(e as Error).message}`, "error", 5000);
    }
  }

  async appendFile() {
    const files = await pickFiles("application/pdf,.pdf", true);
    for (const f of files) await this.appendBytes(f);
  }

  async appendBytes(file: File) {
    try {
      if (this.doc.isEmpty) return this.openBytes(file);
      const ids = await this.doc.insertPdf(await readFile(file), file.name);
      toast(`${file.name}에서 ${ids.length}쪽 추가됨`);
      if (ids[0]) this.viewer.scrollToPage(ids[0]);
    } catch (e) {
      toast(`PDF를 추가할 수 없습니다: ${(e as Error).message}`, "error", 5000);
    }
  }

  newBlankDocument() {
    this.doc.name = "새 문서";
    this.doc.insertBlankPage(0);
    this.viewer.fitWidth();
    this.updateZoomLabel();
  }

  insertBlank() {
    const cur = this.viewer.currentPageId;
    const idx = cur ? this.doc.pageIndex(cur) + 1 : this.doc.pages.length;
    const ref = this.doc.pageById(cur ?? "");
    const id = this.doc.insertBlankPage(idx, ref?.width, ref?.height);
    this.viewer.scrollToPage(id);
  }

  deletePages() {
    const ids = this.sidebar.targetIds();
    if (ids.length === 0) return;
    if (ids.length === this.doc.pages.length && !confirm("모든 페이지를 삭제할까요?")) return;
    this.doc.deletePages(ids);
    this.sidebar.selected.clear();
  }

  async save() {
    if (this.doc.isEmpty) return toast("저장할 페이지가 없습니다", "error");
    this.viewer.commitEditor();
    try {
      const { bytes, warnings } = await exportPdf(this.doc);
      downloadBytes(bytes, `${this.doc.name}-편집.pdf`);
      for (const w of warnings) toast(w, "error", 6000);
      toast("PDF가 저장되었습니다");
    } catch (e) {
      console.error(e);
      toast(`저장 실패: ${(e as Error).message}`, "error", 6000);
    }
  }

  async extract() {
    if (this.doc.isEmpty) return;
    let ids = this.doc.pages.filter((p) => this.sidebar.selected.has(p.id)).map((p) => p.id);
    if (ids.length === 0) {
      const input = prompt(`추출할 페이지 범위 (예: 1-3,5) — 전체 ${this.doc.pages.length}쪽`, "");
      if (!input) return;
      try {
        ids = parsePageRanges(input, this.doc.pages.length).map((i) => this.doc.pages[i].id);
      } catch (e) {
        return toast((e as Error).message, "error");
      }
    }
    try {
      const { bytes, warnings } = await exportPdf(this.doc, { pageIds: ids });
      downloadBytes(bytes, `${this.doc.name}-추출(${ids.length}쪽).pdf`);
      for (const w of warnings) toast(w, "error", 6000);
    } catch (e) {
      toast(`추출 실패: ${(e as Error).message}`, "error", 6000);
    }
  }

  private zoomBy(f: number) {
    this.viewer.setZoom(this.viewer.zoom * f);
    this.updateZoomLabel();
  }

  private updateZoomLabel() {
    this.zoomLabel.textContent = `${Math.round(this.viewer.zoom * 100)}%`;
  }

  private updatePageLabel() {
    const cur = this.viewer.currentPageId;
    const idx = cur ? this.doc.pageIndex(cur) : -1;
    this.pageLabel.textContent = this.doc.isEmpty ? "" : `${idx + 1} / ${this.doc.pages.length}`;
  }

  // ---------- 속성 패널 ----------

  /** 선택 주석(없으면 기본 스타일)을 입력에 반영 */
  private syncProps() {
    const p = this.props;
    const a = this.viewer.selectedAnnotation();
    const s = this.viewer.style;
    p.deleteBtn.disabled = !a;
    const set = (hex: string, fillOn: boolean, fill: RGB | null, stroke: number | null, font: number | null, opacity: number) => {
      p.color.value = hex;
      p.fillOn.checked = fillOn;
      p.fill.value = rgbToHex(fill ?? { r: 1, g: 0.95, b: 0.6 });
      p.fill.disabled = !fillOn;
      p.stroke.value = stroke === null ? "" : String(stroke);
      p.stroke.disabled = stroke === null;
      p.font.value = font === null ? "" : String(font);
      p.font.disabled = font === null;
      p.opacity.value = String(opacity);
    };
    if (!a) {
      const t = this.viewer.tool;
      set(
        rgbToHex(s.color),
        !!s.fillColor,
        s.fillColor,
        t === "text" || t === "highlight" || t === "image" ? null : s.strokeWidth,
        t === "text" || t === "select" ? s.fontSize : null,
        s.opacity,
      );
      p.fillOn.disabled = t !== "rect" && t !== "select";
      p.fill.disabled = p.fillOn.disabled || !s.fillColor;
      p.color.disabled = t === "image";
      return;
    }
    p.fillOn.disabled = a.type !== "rect";
    p.color.disabled = a.type === "image";
    switch (a.type) {
      case "text":
        set(rgbToHex(a.color), false, null, null, a.fontSize, a.opacity);
        break;
      case "rect":
        set(rgbToHex(a.strokeColor), !!a.fillColor, a.fillColor, a.strokeWidth, null, a.opacity);
        break;
      case "highlight":
        set(rgbToHex(a.color), false, null, null, null, a.opacity);
        break;
      case "ink":
        set(rgbToHex(a.color), false, null, a.strokeWidth, null, a.opacity);
        break;
      case "image":
        set("#000000", false, null, null, null, a.opacity);
        break;
    }
    p.fill.disabled = p.fillOn.disabled || !p.fillOn.checked;
  }

  private applyProps(record: boolean) {
    const p = this.props;
    const color = hexToRgb(p.color.value);
    const fillColor = p.fillOn.checked ? hexToRgb(p.fill.value) : null;
    const strokeWidth = Math.max(0, parseFloat(p.stroke.value) || 0);
    const fontSize = Math.max(4, parseFloat(p.font.value) || 14);
    const opacity = parseFloat(p.opacity.value) || 1;
    p.fill.disabled = p.fillOn.disabled || !p.fillOn.checked;

    const s = this.viewer.style;
    if (!p.color.disabled) s.color = color;
    if (!p.fillOn.disabled) s.fillColor = fillColor;
    if (!p.stroke.disabled) s.strokeWidth = strokeWidth;
    if (!p.font.disabled) s.fontSize = fontSize;
    s.opacity = opacity;

    const a = this.viewer.selectedAnnotation();
    if (!a || !this.viewer.selection) return;
    let patch: Partial<Annotation>;
    switch (a.type) {
      case "text":
        patch = { color, fontSize, opacity } as Partial<Annotation>;
        break;
      case "rect":
        patch = { strokeColor: color, fillColor, strokeWidth, opacity } as Partial<Annotation>;
        break;
      case "highlight":
        patch = { color, opacity } as Partial<Annotation>;
        break;
      case "ink":
        patch = { color, strokeWidth, opacity } as Partial<Annotation>;
        break;
      case "image":
        patch = { opacity } as Partial<Annotation>;
        break;
    }
    this.doc.updateAnnotation(this.viewer.selection.pageId, a.id, patch, record);
  }

  // ---------- 키보드 / 드롭 ----------

  private bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      const inInput = target.closest("input, textarea, select, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void this.openFile();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.save();
        return;
      }
      if (inInput) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.doc.redo();
        else this.doc.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.doc.redo();
        return;
      }
      if (mod) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.viewer.selection) {
          e.preventDefault();
          this.viewer.deleteSelected();
        }
        return;
      }
      if (e.key === "Escape") {
        this.viewer.pendingImage = null;
        this.viewer.select(null);
        this.setTool("select");
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        if (t.id === "image") void this.startImageTool();
        else this.setTool(t.id);
      }
    });
  }

  private bindFileDrop(zone: HTMLElement) {
    zone.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        zone.classList.add("drop-target");
      }
    });
    zone.addEventListener("dragleave", (e) => {
      if (e.target === zone) zone.classList.remove("drop-target");
    });
    zone.addEventListener("drop", async (e) => {
      zone.classList.remove("drop-target");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) {
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) await this.appendBytes(f);
        else if (f.type.startsWith("image/")) {
          try {
            const asset = await loadImageAsset(f);
            this.doc.addAsset(asset);
            this.viewer.pendingImage = asset;
            this.setTool("image");
            toast("이미지를 놓을 위치를 페이지에서 클릭하세요");
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }
      }
    });
  }
}
