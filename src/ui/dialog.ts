/** 아주 작은 모달 대화상자 도우미 */

export interface DialogHandle {
  el: HTMLDivElement;
  body: HTMLDivElement;
  close(): void;
}

export function openDialog(title: string): DialogHandle {
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";
  const box = document.createElement("div");
  box.className = "dialog";
  box.setAttribute("role", "dialog");
  const h = document.createElement("h2");
  h.textContent = title;
  const body = document.createElement("div");
  box.append(h, body);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  const close = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  // 편집기 단축키가 대화상자 안 입력을 가로채지 않도록
  box.addEventListener("keydown", (e) => e.stopPropagation());
  return { el: backdrop, body, close };
}

export function row(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const r = document.createElement("div");
  r.className = "row";
  const s = document.createElement("span");
  s.textContent = label;
  r.append(s, ...controls);
  return r;
}

export function actions(...buttons: HTMLElement[]): HTMLDivElement {
  const a = document.createElement("div");
  a.className = "actions";
  a.append(...buttons);
  return a;
}

export function btn(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

export function input(type: string, value: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  // range/number는 min/max/step을 먼저 정해야 value가 잘리지 않는다
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  i.value = value;
  return i;
}
