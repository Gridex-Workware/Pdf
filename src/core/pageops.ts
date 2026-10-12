import type { PageRef, Rotation } from "./model";
import { normalizeRotation } from "./model";

/** 순수 함수로 구현한 페이지 배열 조작. 입력을 변경하지 않는다. */

export function movePage<T>(pages: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= pages.length) throw new RangeError(`from out of range: ${from}`);
  const target = Math.max(0, Math.min(pages.length - 1, to));
  if (from === target) return [...pages];
  const next = [...pages];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export function removePages<T extends { id: string }>(pages: readonly T[], ids: Iterable<string>): T[] {
  const set = new Set(ids);
  return pages.filter((p) => !set.has(p.id));
}

export function rotatePages(pages: readonly PageRef[], ids: Iterable<string>, delta: number): PageRef[] {
  const set = new Set(ids);
  return pages.map((p) =>
    set.has(p.id) ? { ...p, rotation: normalizeRotation(p.rotation + delta) as Rotation } : p,
  );
}

export function insertAt<T>(pages: readonly T[], index: number, items: readonly T[]): T[] {
  const i = Math.max(0, Math.min(pages.length, index));
  return [...pages.slice(0, i), ...items, ...pages.slice(i)];
}

/** "1,3-5,8" 같은 페이지 범위 문자열을 0-based 인덱스 배열로 변환 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const result = new Set<number>();
  for (const raw of input.split(/[,\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`잘못된 범위: "${part}"`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo < 1 || hi > pageCount) throw new Error(`범위를 벗어남: "${part}" (1-${pageCount})`);
    for (let i = lo; i <= hi; i++) result.add(i - 1);
  }
  return [...result].sort((x, y) => x - y);
}
