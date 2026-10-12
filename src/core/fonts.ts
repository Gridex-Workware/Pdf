/** 유니코드(한글 등) 텍스트용 폰트 로딩 */

let cache: Promise<Uint8Array> | null = null;

export const UNICODE_FONT_URL = `${import.meta.env.BASE_URL}fonts/NanumGothic-Regular.ttf`;
export const UNICODE_FONT_FAMILY = "Nanum Gothic";

/** 표준 Helvetica(WinAnsi)로 표현할 수 없는 문자가 있는지 */
export function needsUnicodeFont(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xff && code !== 0x2019 && code !== 0x201c && code !== 0x201d) return true;
  }
  return false;
}

export function loadUnicodeFontBytes(): Promise<Uint8Array> {
  if (!cache) {
    cache = fetch(UNICODE_FONT_URL)
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
    const face = new FontFace(UNICODE_FONT_FAMILY, `url(${UNICODE_FONT_URL})`);
    await face.load();
    document.fonts.add(face);
  } catch {
    /* 화면 표시는 시스템 폰트로 대체 */
  }
}
