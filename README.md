# PDF 편집기

브라우저에서만 동작하는 PDF 편집기입니다. 파일은 서버로 전송되지 않고 전부 로컬에서 처리됩니다.

- 렌더링: [pdf.js](https://mozilla.github.io/pdf.js/)
- 편집/저장: [pdf-lib](https://pdf-lib.js.org/)
- 빌드: Vite + TypeScript (프레임워크 없음)

## 기능

| 구분 | 기능 |
| --- | --- |
| 파일 | PDF 열기, 다른 PDF 추가(병합), 끌어다 놓기, 저장(다운로드) |
| 페이지 | 회전, 삭제, 복제, 순서 변경(썸네일 드래그), 빈 페이지 추가, 선택/범위 추출 |
| 주석 | 텍스트(한글 지원), 사각형(선/채움), 형광펜, 자유 곡선(펜), 이미지 삽입 |
| 편집 | 선택·이동·크기 조절, 색/굵기/글꼴 크기/불투명도 변경, 실행 취소/다시 실행 |
| 보기 | 확대/축소, 폭 맞춤, 쪽 맞춤, 연속 스크롤, 썸네일 탐색 |

주석은 저장할 때 페이지 콘텐츠로 구워(burn-in) 들어가므로 어떤 뷰어에서도 똑같이 보입니다.

### 단축키

| 키 | 동작 |
| --- | --- |
| `V` `T` `R` `H` `P` `I` | 선택 / 텍스트 / 사각형 / 형광펜 / 펜 / 이미지 도구 |
| `Delete`, `Backspace` | 선택한 주석 삭제 |
| `Esc` | 선택 해제, 선택 도구로 복귀 |
| `Ctrl+Z`, `Ctrl+Y` (`Ctrl+Shift+Z`) | 실행 취소 / 다시 실행 |
| `Ctrl+O`, `Ctrl+S` | 열기 / 저장 |
| 텍스트 편집 중 `Ctrl+Enter` 또는 `Esc` | 편집 확정 |

## 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:5173)
npm run build      # 타입 검사 + 프로덕션 빌드 → dist/
npm run preview    # 빌드 결과 미리보기
npm test           # 단위 테스트 (vitest)
```

`dist/`는 정적 파일이므로 아무 정적 호스팅에나 올리면 됩니다 (`base: "./"`로 빌드되어 하위 경로 배포도 가능).

## 구조

```
src/
  core/
    model.ts            데이터 모델(페이지 참조, 주석), 색/회전 유틸
    document.ts         EditorDocument: 소스 PDF 관리, 페이지/주석 조작, 실행 취소 이력
    pageops.ts          페이지 배열 순수 조작 함수 + 범위 문자열 파서
    geometry.ts         주석 경계 상자, 히트 테스트, 이동/정규화
    transform.ts        pdf.js와 같은 규칙의 뷰포트 행렬(회전/배율)
    export.ts           pdf-lib로 PDF 생성(페이지 복사, 회전, 주석 굽기)
    fonts.ts            한글 폰트 로딩, 유니코드 필요 여부 판단
    fontkit-patched.ts  fontkit TrueType 서브셋 버그 우회
    pdfjs.ts            pdf.js 초기화(워커)
  ui/
    app.ts              툴바, 속성 패널, 파일 입출력, 단축키
    viewer.ts           페이지 렌더링, 도구 상호작용, 인라인 텍스트 편집
    sidebar.ts          썸네일 목록, 선택, 드래그 순서 변경
    overlay.ts          주석 캔버스 렌더링
    toast.ts            알림
public/fonts/           나눔고딕(OFL) — 한글 텍스트 임베딩용
test/                   vitest 단위 테스트
```

### 좌표계

주석은 PDF 콘텐츠 좌표계(pt, 원점 좌하단)로 저장합니다. 화면 표시와 입력 변환은 pdf.js 뷰포트 행렬을 그대로 사용하므로
페이지가 회전돼도 좌표가 어긋나지 않습니다. 텍스트와 이미지는 만들 당시의 표시 회전을 `rotate`로 기억해,
회전된 페이지에서도 화면 기준으로 똑바로 보이도록 저장됩니다.

### 한글 텍스트

pdf-lib의 기본 글꼴(Helvetica)은 한글을 표현할 수 없어서, 한글이 포함된 텍스트가 있으면 `public/fonts/NanumGothic-Regular.ttf`를
서브셋으로 임베딩합니다. `@pdf-lib/fontkit`의 TrueType 서브셋에는 글리프 길이가 홀수일 때 loca 테이블이 어긋나
일부 글자가 사라지는 버그가 있어 `fontkit-patched.ts`에서 글리프를 4바이트로 패딩해 우회합니다.

## 알려진 제한

- 기존 PDF의 텍스트를 직접 수정하거나 지우는 기능은 없습니다(주석을 덧씌우는 방식).
- 암호화된 PDF는 열 수 있는 경우에도 저장 시 암호가 제거됩니다.
- 폼 필드와 기존 주석은 페이지와 함께 복사되지만 편집할 수는 없습니다.
