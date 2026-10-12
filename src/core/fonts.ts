/** 유니코드(한글 등) 텍스트용 폰트 로딩 */

let cache: Promise<Uint8Array> | null = null;
let cachedUrl = "";

export const UNICODE_FONT_PATH = "fonts/NanumGothic-Regular.ttf";
export const UNICODE_FONT_FAMILY = "Nanum Gothic";

/** 현재 페이지 기준 절대 URL. 워커에서는 상대 경로가 다르게 풀리므로 메인 스레드에서 계산해 넘긴다. */
export function unicodeFontUrl(): string {
  const base = `${import.meta.env.BASE_URL}${UNICODE_FONT_PATH}`;
  if (typeof document !== "undefined") return new URL(base, document.baseURI).href;
  return base;
}

/** 표준 Helvetica(WinAnsi)로 표현할 수 없는 문자가 있는지 */
export function needsUnicodeFont(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xff && code !== 0x2019 && code !== 0x201c && code !== 0x201d) return true;
  }
  return false;
}

export function loadUnicodeFontBytes(url: string = unicodeFontUrl()): Promise<Uint8Array> {
  if (!cache || cachedUrl !== url) {
    cachedUrl = url;
    cache = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`폰트를 불러올 수 없습니다 (${r.status})`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b))
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

/** 화면 표시용으로 같은 폰트를 CSS에 등록 */
export async function ensureCssFont(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  if (document.fonts.check(`12px "${UNICODE_FONT_FAMILY}"`)) return;
  try {
    const face = new FontFace(UNICODE_FONT_FAMILY, `url(${unicodeFontUrl()})`);
    await face.load();
    document.fonts.add(face);
  } catch {
    /* 화면 표시는 시스템 폰트로 대체 */
  }
}
