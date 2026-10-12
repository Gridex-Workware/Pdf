import { App } from "./ui/app";

const root = document.getElementById("app");
if (!root) throw new Error("#app 요소가 없습니다");
const app = new App(root);
// 디버깅/테스트용으로 전역에 노출
(window as unknown as { pdfEditor: App }).pdfEditor = app;
