import type { EditorDocument } from "../core/document";
import type { TextMeasurer } from "../core/geometry";
import type { ImageAsset } from "../core/model";
import { hexToRgb, rgbToHex } from "../core/model";
import { DEFAULT_WATERMARK, makeImageWatermark, makeTextWatermarks, type WatermarkOptions } from "../core/watermark";
import { actions, btn, input, openDialog, row } from "./dialog";
import { toast } from "./toast";

/**
 * 워터마크 대화상자. 글자 또는 이미지 워터마크를 전체/선택 페이지에 주석으로 추가한다.
 * 주석이므로 추가 후에도 페이지별로 선택해 옮기거나 지울 수 있다.
 */
export function openWatermarkDialog(
  doc: EditorDocument,
  measure: TextMeasurer,
  selectedIds: string[],
  pickImage: () => Promise<ImageAsset | null>,
) {
  const dlg = openDialog("워터마크");
  const opts: WatermarkOptions = { ...DEFAULT_WATERMARK };

  const text = input("text", opts.text, { placeholder: "워터마크 문구" });
  const size = input("number", String(opts.fontSize), { min: "8", max: "300" });
  const color = input("color", rgbToHex(opts.color));
  const opacity = input("range", String(opts.opacity), { min: "0.05", max: "1", step: "0.05" });
  const angle = input("number", String(opts.angle), { min: "-180", max: "180" });
  const tile = input("checkbox", "");
  const scope = document.createElement("select");
  for (const [v, l] of [
    ["all", `전체 페이지 (${doc.pages.length}쪽)`],
    ["selected", `선택한 페이지 (${selectedIds.length}쪽)`],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    scope.appendChild(o);
  }
  if (selectedIds.length > 0) scope.value = "selected";
  const scopeCount = () => (scope.value === "selected" ? selectedIds : doc.pages.map((p) => p.id));

  const preview = document.createElement("div");
  preview.className = "wm-preview";
  const updatePreview = () => {
    preview.textContent = `"${text.value}" · ${size.value}pt · ${Math.round(parseFloat(opacity.value) * 100)}% · ${angle.value}° · ${tile.checked ? "타일" : "가운데 1개"}`;
  };
  for (const el of [text, size, opacity, angle, tile]) el.addEventListener("input", updatePreview);
  updatePreview();

  const readOpts = (): WatermarkOptions => ({
    text: text.value,
    fontSize: Math.max(8, parseFloat(size.value) || 48),
    color: hexToRgb(color.value),
    opacity: parseFloat(opacity.value) || 0.3,
    angle: parseFloat(angle.value) || 0,
    tile: tile.checked,
  });

  const applyText = () => {
    const o = readOpts();
    if (!o.text.trim()) return toast("워터마크 문구를 입력하세요", "error");
    const ids = scopeCount();
    if (ids.length === 0) return toast("대상 페이지가 없습니다", "error");
    let count = 0;
    doc.batch(() => {
      for (const id of ids) {
        const page = doc.pageById(id);
        if (!page) continue;
        const annots = makeTextWatermarks(page, o, measure);
        doc.addAnnotations(id, annots);
        count += annots.length;
      }
    });
    toast(`${ids.length}쪽에 워터마크 ${count}개 추가됨`);
    dlg.close();
  };

  const applyImage = async () => {
    const asset = await pickImage();
    if (!asset) return;
    const ids = scopeCount();
    if (ids.length === 0) return toast("대상 페이지가 없습니다", "error");
    doc.addAsset(asset);
    const o = readOpts();
    doc.batch(() => {
      for (const id of ids) {
        const page = doc.pageById(id);
        if (page) doc.addAnnotations(id, [makeImageWatermark(page, asset, { scale: 0.5, opacity: o.opacity, angle: o.angle })]);
      }
    });
    toast(`${ids.length}쪽에 이미지 워터마크 추가됨`);
    dlg.close();
  };

  dlg.body.append(
    row("문구", text),
    row("크기(pt)", size),
    row("색", color),
    row("불투명도", opacity),
    row("각도", angle),
    row("타일", tile),
    row("대상", scope),
    preview,
    actions(btn("취소", () => dlg.close()), btn("이미지 워터마크…", () => void applyImage()), btn("글자 워터마크 추가", applyText, "primary")),
  );
  text.focus();
  text.select();
}
