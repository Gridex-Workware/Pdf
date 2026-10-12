import { describe, expect, it } from "vitest";
import { EditorDocument } from "../src/core/document";
import type { Annotation } from "../src/core/model";

const annot = (id: string): Annotation => ({
  id, type: "rect", x: 0, y: 0, width: 10, height: 10, strokeColor: { r: 0, g: 0, b: 0 }, fillColor: null, strokeWidth: 1, opacity: 1,
});

describe("EditorDocument history", () => {
  it("undoes and redoes page operations", () => {
    const doc = new EditorDocument();
    const a = doc.insertBlankPage(0);
    const b = doc.insertBlankPage(1);
    doc.rotatePages([a], 90);
    expect(doc.pageById(a)?.rotation).toBe(90);
    doc.undo();
    expect(doc.pageById(a)?.rotation).toBe(0);
    doc.redo();
    expect(doc.pageById(a)?.rotation).toBe(90);
    doc.deletePages([b]);
    expect(doc.pages.length).toBe(1);
    doc.undo();
    expect(doc.pages.length).toBe(2);
  });

  it("collapses a batch into a single undo step", () => {
    const doc = new EditorDocument();
    const p1 = doc.insertBlankPage(0);
    const p2 = doc.insertBlankPage(1);
    doc.batch(() => {
      doc.addAnnotations(p1, [annot("a")]);
      doc.addAnnotations(p2, [annot("b"), annot("c")]);
    });
    expect(doc.pageById(p1)?.annotations.length).toBe(1);
    expect(doc.pageById(p2)?.annotations.length).toBe(2);
    doc.undo();
    expect(doc.pageById(p1)?.annotations.length).toBe(0);
    expect(doc.pageById(p2)?.annotations.length).toBe(0);
    doc.redo();
    expect(doc.pageById(p2)?.annotations.length).toBe(2);
  });

  it("moves several pages keeping their order", () => {
    const doc = new EditorDocument();
    const ids = [0, 1, 2, 3].map((i) => doc.insertBlankPage(i));
    doc.movePages([ids[0], ids[2]], 4);
    expect(doc.pages.map((p) => p.id)).toEqual([ids[1], ids[3], ids[0], ids[2]]);
  });
});
