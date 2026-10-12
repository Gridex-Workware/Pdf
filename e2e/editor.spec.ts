import { PDFDocument } from "pdf-lib";
import { unzipSync } from "fflate";
import { expect, makeSamplePdf, openPdf, test } from "./fixtures";

test.describe("PDF 편집기", () => {
  test("빈 상태에서 열기 버튼과 안내가 보인다", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "PDF 편집기" })).toBeVisible();
    await expect(page.getByRole("button", { name: "PDF 열기" })).toBeVisible();
  });

  test("열기 → 주석 → 페이지 조작 → 실행취소 → 저장", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "데스크톱 마우스 상호작용");
    await page.goto("/");
    await openPdf(page, await makeSamplePdf());
    await expect(page.locator(".thumb")).toHaveCount(4);
    await expect(page.locator(".page-indicator")).toHaveText("1 / 4");

    const first = page.locator(".page-wrap").first();
    const box = (await first.boundingBox())!;

    // 사각형
    await page.click('button[data-tool="rect"]');
    await page.mouse.move(box.x + 100, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 320, { steps: 5 });
    await page.mouse.up();
    // 형광펜
    await page.click('button[data-tool="highlight"]');
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 110, { steps: 5 });
    await page.mouse.up();
    // 펜
    await page.click('button[data-tool="ink"]');
    await page.mouse.move(box.x + 100, box.y + 450);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(box.x + 100 + i * 12, box.y + 450 + Math.sin(i / 2) * 30);
    await page.mouse.up();
    // 흰색 덮기
    await page.click('button[data-tool="whiteout"]');
    await page.mouse.move(box.x + 400, box.y + 600);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 650, { steps: 3 });
    await page.mouse.up();
    // 한글 텍스트
    await page.click('button[data-tool="text"]');
    await page.mouse.click(box.x + 100, box.y + 380);
    await page.waitForSelector(".text-editor");
    await page.keyboard.type("안녕하세요 Hello PDF");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".text-editor")).toHaveCount(0);

    const types = await page.evaluate(() => window.pdfEditor.doc.pages[0].annotations.map((a) => a.type));
    expect(types).toEqual(["rect", "highlight", "ink", "rect", "text"]);

    // 선택 후 이동
    await page.click('button[data-tool="select"]');
    const before = await page.evaluate(() => window.pdfEditor.doc.pages[0].annotations[0].x as number);
    await page.mouse.move(box.x + 200, box.y + 260);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 300, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.pdfEditor.doc.pages[0].annotations[0].x as number);
    expect(after).toBeGreaterThan(before);

    // 페이지 조작: 2쪽 회전, 3쪽 삭제, 1쪽을 끝으로
    await page.evaluate(() => {
      const d = window.pdfEditor.doc;
      d.rotatePages([d.pages[1].id], 90);
      d.deletePages([d.pages[2].id]);
      d.movePages([d.pages[0].id], 3);
    });
    await expect(page.locator(".thumb")).toHaveCount(3);
    expect(await page.evaluate(() => window.pdfEditor.doc.pages.map((p) => `${p.sourceIndex}:${p.rotation}`))).toEqual(["1:90", "3:0", "0:0"]);
    await page.keyboard.press("Control+z");
    expect(await page.evaluate(() => window.pdfEditor.doc.pages.map((p) => p.sourceIndex))).toEqual([0, 1, 3]);
    await page.keyboard.press("Control+y");

    // 저장 → 내려받은 PDF 검사
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("button.primary")]);
    const bytes = await streamToBytes(download);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 0]);
  });

  test("워터마크를 전체 페이지에 넣고 저장한다", async ({ page }) => {
    await page.goto("/");
    await openPdf(page, await makeSamplePdf());
    await page.getByRole("button", { name: "워터마크" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByPlaceholder("워터마크 문구").fill("대외비");
    await dlg.getByRole("button", { name: "글자 워터마크 추가" }).click();
    await expect(dlg).toHaveCount(0);
    const counts = await page.evaluate(() => window.pdfEditor.doc.pages.map((p) => p.annotations.length));
    expect(counts).toEqual([1, 1, 1, 1]);
    // 실행취소 한 번에 전부 사라진다
    await page.keyboard.press("Control+z");
    expect(await page.evaluate(() => window.pdfEditor.doc.pages.map((p) => p.annotations.length))).toEqual([0, 0, 0, 0]);
    await page.keyboard.press("Control+y");

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("button.primary")]);
    const pdf = await PDFDocument.load(await streamToBytes(download));
    expect(pdf.getPageCount()).toBe(4);
  });

  test("페이지별 분할 ZIP", async ({ page }) => {
    await page.goto("/");
    await openPdf(page, await makeSamplePdf());
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "분할 ZIP" }).click()]);
    const files = unzipSync(await streamToBytes(download));
    const names = Object.keys(files).sort();
    expect(names).toEqual(["sample-1.pdf", "sample-2.pdf", "sample-3.pdf", "sample-4.pdf"]);
    for (const n of names) expect((await PDFDocument.load(files[n])).getPageCount()).toBe(1);
  });

  test("다른 PDF를 추가(병합)하고 범위로 추출한다", async ({ page }) => {
    await page.goto("/");
    const sample = await makeSamplePdf();
    await openPdf(page, sample);
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await (window.pdfEditor as unknown as { appendBytes(f: File): Promise<void> }).appendBytes(new File([bytes], "second.pdf", { type: "application/pdf" }));
    }, Buffer.from(sample).toString("base64"));
    await expect(page.locator(".thumb")).toHaveCount(8);
    page.once("dialog", (d) => d.accept("2-3,7"));
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "추출" }).click()]);
    const pdf = await PDFDocument.load(await streamToBytes(download));
    expect(pdf.getPageCount()).toBe(3);
  });

  test("서명을 그려 저장하고 페이지에 놓는다", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "데스크톱 마우스 상호작용");
    await page.goto("/");
    await openPdf(page, await makeSamplePdf());
    await page.getByRole("button", { name: "서명/도장" }).click();
    const canvas = page.locator(".sig-canvas");
    const c = (await canvas.boundingBox())!;
    await page.mouse.move(c.x + 40, c.y + 80);
    await page.mouse.down();
    await page.mouse.move(c.x + 200, c.y + 60, { steps: 10 });
    await page.mouse.move(c.x + 300, c.y + 120, { steps: 10 });
    await page.mouse.up();
    await page.getByRole("button", { name: "저장 후 놓기" }).click();
    expect(await page.evaluate(() => window.pdfEditor.viewer.tool)).toBe("image");
    const box = (await page.locator(".page-wrap").first().boundingBox())!;
    await page.mouse.click(box.x + 300, box.y + 500);
    const types = await page.evaluate(() => window.pdfEditor.doc.pages[0].annotations.map((a) => a.type));
    expect(types).toEqual(["image"]);
    // 저장된 서명은 다시 열었을 때 목록에 남아 있다
    await page.getByRole("button", { name: "서명/도장" }).click();
    await expect(page.locator(".stamp-item")).toHaveCount(1);
  });
});

async function streamToBytes(download: { createReadStream(): Promise<NodeJS.ReadableStream> }): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return new Uint8Array(Buffer.concat(chunks));
}
