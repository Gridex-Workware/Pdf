import fontkit from "@pdf-lib/fontkit";

/**
 * @pdf-lib/fontkit의 TrueType 서브셋 버그 우회.
 *
 * 서브셋을 만들 때 각 글리프 데이터를 그대로 이어 붙이는데, 길이가 홀수인 글리프가 있으면
 * short 형식 loca 테이블(offset/2)에서 오프셋이 잘려 그 뒤의 글리프가 모두 깨진다.
 * 글리프 버퍼를 4바이트 배수로 패딩해 오프셋이 항상 정렬되도록 한다.
 */

type GlyfBuffer = Uint8Array & { copy?: (target: Uint8Array) => void };

interface SubsetInternals {
  glyf: GlyfBuffer[];
  offset: number;
  _addGlyph(gid: number): number;
  __glyfPaddingPatched?: boolean;
}

interface FontInternals {
  createSubset?: () => unknown;
}

let patched = false;

export function getPatchedFontkit(): typeof fontkit {
  if (patched) return fontkit;
  patched = true;
  const fk = fontkit as unknown as { create: (...args: unknown[]) => FontInternals };
  const origCreate = fk.create.bind(fk);
  // 서브셋 클래스는 export되지 않으므로, create()를 감싸 실제 서브셋 객체의 프로토타입을 패치한다.
  fk.create = (...args: unknown[]) => {
    const font = origCreate(...args);
    if (font && typeof font.createSubset === "function") {
      const origCreateSubset = font.createSubset.bind(font);
      font.createSubset = () => {
        const subset = origCreateSubset();
        patchSubsetPrototype(Object.getPrototypeOf(subset) as SubsetInternals);
        return subset;
      };
    }
    return font;
  };
  return fontkit;
}

function patchSubsetPrototype(proto: SubsetInternals) {
  if (!proto || proto.__glyfPaddingPatched || typeof proto._addGlyph !== "function") return;
  const orig = proto._addGlyph;
  proto._addGlyph = function (this: SubsetInternals, gid: number) {
    const idx = orig.call(this, gid);
    const buf = this.glyf?.[idx];
    if (!buf) return idx;
    const pad = (4 - (buf.length % 4)) % 4;
    if (pad > 0) {
      const Ctor = buf.constructor as { alloc?: (n: number) => GlyfBuffer };
      let padded: GlyfBuffer;
      if (typeof Ctor.alloc === "function") {
        padded = Ctor.alloc(buf.length + pad);
        if (typeof buf.copy === "function") buf.copy(padded);
        else padded.set(buf);
      } else {
        padded = new Uint8Array(buf.length + pad);
        padded.set(buf);
      }
      this.glyf[idx] = padded;
      this.offset += pad;
    }
    return idx;
  };
  proto.__glyfPaddingPatched = true;
}
