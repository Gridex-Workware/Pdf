import type { ImageAsset } from "../core/model";
import { newId } from "../core/model";
import { actions, btn, input, openDialog } from "./dialog";
import { toast } from "./toast";

/** 저장된 서명/도장. 브라우저 localStorage에 PNG data URL로 보관한다. */
export interface SavedStamp {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: number;
}

const STORAGE_KEY = "pdf-editor.stamps";

export function loadStamps(): SavedStamp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedStamp[]) : [];
  } catch {
    return [];
  }
}

export function saveStamps(list: SavedStamp[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    toast(`저장 공간이 부족해 서명을 보관하지 못했습니다: ${(e as Error).message}`, "error");
  }
}

export function stampToAsset(s: SavedStamp): ImageAsset {
  const b64 = s.dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { id: newId("img"), mime: "image/png", bytes, width: s.width, height: s.height };
}

/** 투명 배경 캔버스에서 그려진 부분만 잘라낸 PNG data URL */
function trimCanvas(src: HTMLCanvasElement, pad = 8): { dataUrl: string; width: number; height: number } | null {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL("image/png"), width: out.width, height: out.height };
}

async function fileToStamp(file: File): Promise<SavedStamp> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("이미지를 읽을 수 없습니다"));
      i.src = url;
    });
    // 너무 큰 이미지는 저장 공간을 아끼기 위해 줄인다
    const max = 800;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return { id: newId("st"), name: file.name.replace(/\.[^.]+$/, ""), dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height, createdAt: Date.now() };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 서명/도장 패널. 그리기, 텍스트 서명, 이미지 업로드로 만든 항목을 저장하고
 * 클릭하면 onPick으로 자산을 넘겨 페이지에 놓을 수 있게 한다.
 */
export function openStampPanel(onPick: (asset: ImageAsset) => void) {
  const dlg = openDialog("서명 / 도장");
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const pane = document.createElement("div");
  const listEl = document.createElement("div");
  listEl.className = "stamp-list";
  dlg.body.append(tabs, pane, document.createElement("hr"), listEl);

  let stamps = loadStamps();
  const renderList = () => {
    listEl.innerHTML = "";
    if (stamps.length === 0) {
      const p = document.createElement("div");
      p.className = "wm-preview";
      p.textContent = "저장된 서명/도장이 없습니다. 위에서 만들어 보세요.";
      listEl.appendChild(p);
      return;
    }
    for (const s of stamps) {
      const item = document.createElement("div");
      item.className = "stamp-item";
      item.title = "클릭하면 페이지에 놓을 수 있습니다";
      const img = document.createElement("img");
      img.src = s.dataUrl;
      img.alt = s.name;
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = s.name;
      const rm = btn("×", () => {
        stamps = stamps.filter((x) => x.id !== s.id);
        saveStamps(stamps);
        renderList();
      }, "remove");
      rm.title = "삭제";
      rm.addEventListener("click", (e) => e.stopPropagation());
      item.append(img, name, rm);
      item.addEventListener("click", () => {
        onPick(stampToAsset(s));
        dlg.close();
      });
      listEl.appendChild(item);
    }
  };

  const addStamp = (s: SavedStamp, place: boolean) => {
    stamps = [s, ...stamps].slice(0, 30);
    saveStamps(stamps);
    renderList();
    if (place) {
      onPick(stampToAsset(s));
      dlg.close();
    }
  };

  // --- 탭 1: 그리기 ---
  const drawPane = () => {
    pane.innerHTML = "";
    const canvas = document.createElement("canvas");
    canvas.className = "sig-canvas";
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 420 * dpr;
    canvas.height = 160 * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const color = input("color", "#1e3a8a");
    const width = input("range", "2.5", { min: "1", max: "8", step: "0.5" });
    let drawing = false;
    let last: { x: number; y: number } | null = null;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      last = pos(e);
      canvas.setPointerCapture(e.pointerId);
      ctx.strokeStyle = color.value;
      ctx.lineWidth = parseFloat(width.value);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x + 0.01, last.y);
      ctx.stroke();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing || !last) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    });
    const stop = () => {
      drawing = false;
      last = null;
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    const name = input("text", "서명", { placeholder: "이름" });
    const clear = btn("지우기", () => ctx.clearRect(0, 0, 420, 160));
    const save = (place: boolean) => {
      const t = trimCanvas(canvas);
      if (!t) return toast("먼저 서명을 그려 주세요", "error");
      addStamp({ id: newId("st"), name: name.value || "서명", ...t, createdAt: Date.now() }, place);
      ctx.clearRect(0, 0, 420, 160);
    };
    const controls = document.createElement("div");
    controls.className = "row";
    controls.append(color, width, name, clear);
    pane.append(canvas, controls, actions(btn("저장", () => save(false)), btn("저장 후 놓기", () => save(true), "primary")));
  };

  // --- 탭 2: 텍스트 서명 ---
  const textPane = () => {
    pane.innerHTML = "";
    const text = input("text", "", { placeholder: "이름을 입력하세요" });
    const color = input("color", "#1e3a8a");
    const preview = document.createElement("div");
    preview.className = "sig-text-preview";
    const update = () => {
      preview.textContent = text.value || " ";
      preview.style.color = color.value;
    };
    text.addEventListener("input", update);
    color.addEventListener("input", update);
    update();
    const save = (place: boolean) => {
      if (!text.value.trim()) return toast("이름을 입력하세요", "error");
      const c = document.createElement("canvas");
      const g = c.getContext("2d")!;
      const font = `64px ${getComputedStyle(preview).fontFamily}`;
      g.font = font;
      const w = Math.ceil(g.measureText(text.value).width) + 40;
      c.width = w;
      c.height = 110;
      const g2 = c.getContext("2d")!;
      g2.font = font;
      g2.fillStyle = color.value;
      g2.textBaseline = "middle";
      g2.fillText(text.value, 20, 55);
      const t = trimCanvas(c);
      if (!t) return;
      addStamp({ id: newId("st"), name: text.value, ...t, createdAt: Date.now() }, place);
    };
    const r = document.createElement("div");
    r.className = "row";
    r.append(text, color);
    pane.append(r, preview, actions(btn("저장", () => save(false)), btn("저장 후 놓기", () => save(true), "primary")));
  };

  // --- 탭 3: 이미지 도장 ---
  const imagePane = () => {
    pane.innerHTML = "";
    const p = document.createElement("p");
    p.className = "wm-preview";
    p.textContent = "도장이나 로고 이미지(PNG 권장, 투명 배경 가능)를 올리면 목록에 저장됩니다.";
    const file = input("file", "", { accept: "image/*" });
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        addStamp(await fileToStamp(f), false);
        toast("도장이 저장되었습니다. 목록에서 클릭해 놓으세요");
      } catch (e) {
        toast((e as Error).message, "error");
      }
      file.value = "";
    });
    pane.append(p, file);
  };

  const tabDefs: [string, () => void][] = [
    ["그리기", drawPane],
    ["텍스트 서명", textPane],
    ["이미지 도장", imagePane],
  ];
  const tabButtons = tabDefs.map(([label, fn]) => {
    const b = btn(label, () => {
      tabButtons.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      fn();
    });
    tabs.appendChild(b);
    return b;
  });
  tabButtons[0].classList.add("active");
  drawPane();
  renderList();
}
