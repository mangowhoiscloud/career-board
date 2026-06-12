# mango.career board — Agent Context

공개 셸(Vite + React + TS, GitHub Pages). 데이터는 private repo(career-data)에서 PAT로 런타임 fetch. UI 작업 전 [DESIGN.md](./DESIGN.md) 필독. 신규 표면(메일함·알림·에이전트 요청) 스펙은 `career-data/docs/SPEC-surface-v2.md`.

## UI slop 신호 — 금지 목록

발견 즉시 교정. "현대적 미니멀"을 흉내 내는 기성 패턴이 곧 slop이다.

- **활성/선택/클릭 상태에서 겉 테두리에 상징색(앰버 등 액센트) 노출 금지.** 선택 상태는 텍스트 톤으로만 구분한다. 카드·행·칩·인풋 전부 해당. *예외: 키보드 `:focus-visible` 링은 접근성 장치라 유지(§DESIGN 7). 마우스 클릭·선택 상태에 액센트 보더를 칠하는 것이 slop이다.* (지시 2026-06-12)
- **윤곽선 마크 전반 금지.** 행 좌측 세로 틱(`inset box-shadow`·`border-left` 조각 — radius를 따라 휘어 괄호처럼 보인다), 칩·버튼의 상시 보더 박스, active 언더라인 바. 미읽음·활성·선택은 **텍스트 톤(밝기)과 카운트 색**으로 구분한다. hover의 일시적 배경 1단만 허용. (지시 2026-06-13, 스크린샷 2건)
- **클릭 시 행 아래로 인라인 줄/패널이 끼어드는 전개 금지.** 상세·폼은 드로어 또는 고정 섹션으로. 리스트 행이 늘어났다 줄었다 하는 아코디언은 원장 리듬을 깬다. (지시 2026-06-12)
- 액센트 글로우·그라데이션·box-shadow 중첩 금지. 그림자는 floating menu 1곳만 (DESIGN §4).
- 상태·강조를 위한 이모지·아이콘 팩·배지 남발 금지. 색 도트 + 텍스트로 끝.
- 엔트런스 애니메이션·skeleton shimmer·spinner 금지. 로딩은 평문 한 줄. *예외(사용자 지시 2026-06-13): 메일 수동 동기의 진행 표시는 스피너 + 실시간 % — 러너가 게시하는 sync-progress.json 기반.*
- 모든 인터랙션 요소에 `transition: all` 금지. background/border-color 120ms 두 속성만.
- pill 버튼 + 풀라운드 radius 금지. radius 4~6px 고정.
- 마이크로카피 slop: 느낌표, "성공적으로 ~되었습니다", 의인화("제가 처리할게요") 금지. 결과는 사실 평서문 ("발송됨 · 14:02", "실행 실패: exit 1").
- 빈 상태(empty state) 일러스트·격려 문구 금지. "없음" 한 줄.
- 토스트 남발 금지. 사용자가 보고 있는 요소의 상태가 바뀌면 그 자리에서 바뀐 상태를 보여주는 것으로 충분.

## 카피 원칙 (Fable5 프롬프트 그라운딩)

leaked Fable5 시스템 프롬프트(`career-data/reference/fable5-system-prompt-leak.md`)의 tone_and_formatting 절을 UI 카피에 적용:

- 최소 포맷팅: 명료성에 필수일 때만 구조(리스트·헤더). 기본은 평문.
- 도구·기능 안내 보이스: "Not like a salesperson. Not like a feature announcement." 기능을 광고하지 않고 사실만.
- 외부로 나가는 액션(메일 발송, 폼 제출)은 명시적 1회 확인 게이트. 자동 발송 절대 금지.

## 데이터·보안 불변식

- 이 공개 repo에 지원 데이터·회사명·토큰·자격증명 절대 커밋 금지 (DESIGN §9).
- 보드는 localhost 데몬에 접근하지 않는다 (2026-06-13 제거 지시). 전송 수단은 private repo(career-data) PAT 단일 경로: 메일 전문은 `data/mail/inbox.json` 동기본, 발송은 `data/mail/outbox.json` 큐, 에이전트 실행은 `requests/REQ-*.md` 큐 + `data/runner-state.json`(러너가 갱신하는 인증·실행 상태).
- 모든 변이는 git 커밋 1건 = 감사 로그 1건. 보드가 감사 로그를 재구현하지 않는다.
