# DESIGN.md — Career Board (operator dashboard)

> Google Stitch DESIGN.md format — 9 sections. AI agents read this before writing UI for this codebase.
> Audience: mango (operator) + authorized agents. A private ops dashboard, read at a monitor, often at night.
> Surface: Vite + React + TS SPA on GitHub Pages. Data lives in a private repo, fetched client-side with a PAT.
> Sibling surfaces: resume (A4 print), portfolio (dark dev docs), mango-wiki (warm paper). Per DESIGN-shared.md, do NOT unify; this surface borrows the portfolio's dark harness aesthetic because the audience and medium match (operator at a dark monitor).

## 1. Visual Theme & Atmosphere

**Mood**: mission console. Dense, calm, legible at a glance. The board answers "지금 어디까지 왔나" in under 5 seconds: counts first, rows second, detail on demand.

**Adjectives**: dark, dense, status-driven, keyboard-friendly, audit-honest. **Identity: amber terminal ledger** — 무채색 차콜 위 앰버 단일 신호, IBM Plex 모노 원장 감성. 레퍼런스 계보: Teal(테이블+파이프라인 카운트 구조) · Linear(보더리스 행, 위계는 정렬·타이포로) · Geist(회색 역할 고정) · Raycast(다크 가독 보정).

**What it is not**: a marketing page, a kanban toy, a gradient dashboard template. No hero section, no illustrations, no emoji decoration, no card shadows stacked for depth. Rejections are shown plainly (red, not hidden) — the board exists to face the funnel, not to flatter it.

## 2. Color Palette & Roles

| Role | Hex | Usage |
|---|---|---|
| `bg` | `#0B0B0C` | Page. 무채색 (보라끼 금지). |
| `bg-panel` | `#121214` | Drawer, menu, inputs. |
| `bg-hover` / `bg-active` | `#18181B` / `#1F1F23` | 행 hover / 활성 필터. |
| `border` / `border-strong` | `#232327` / `#2F2F35` | 헤어라인 / 패널 보더. |
| `text` / `text-2` / `text-3` | `#ECECEE` / `#9F9FA6` / `#6B6B72` | 3단 고정. 즉석 회색 생성 금지. |
| `amber` | `#E8A33D` | 유일한 크롬 액센트: 링크·포커스·CTA·상단 파워 헤어라인. 블루 액센트 금지. |

**Status colors** (the only place color carries meaning — never reuse for decoration):

| Status | Key | Hex |
|---|---|---|
| 준비 | `ready` | `#6B6B72` |
| 제출 | `submitted` | `#C9C9CF` |
| 서류통과 | `screening` | `#E9C46A` |
| 과제 | `assignment` | `#E8A33D` |
| 면접 | `interview` | `#F08C00` |
| 오퍼 | `offer` | `#46C68A` |
| 서류탈락 | `rejected-docs` | `#A04A45` |
| 과제탈락 | `rejected-assignment` | `#B45A50` |
| 면접탈락 | `rejected-interview` | `#7E3B38` |
| 보류 | `hold` | `#515158` |

진행 단계 = 앰버 램프(밝→진), 탈락 = dim red 램프 + **행 텍스트 톤 강등(dim)**. 색은 7px 도트와 분포 스파인에만.

## 3. Typography Rules

Pairing (단일 패밀리 시스템 — 한·영·모노 모두 IBM Plex):

```
sans: 'IBM Plex Sans KR', 'Apple SD Gothic Neo', sans-serif   (400/500/600)
mono: 'IBM Plex Mono', ui-monospace, monospace                 (400/500/600)
```

mono의 역할: 워드마크(`career.board`, 앰버 마침표), 라인 넘버, 날짜·수치(tabular-nums), 컬럼 헤더, wave 헤더, 채널명, 드로어 섹션 라벨(uppercase tracking 0.1em). 본문·회사명·메모는 sans. **사이즈는 13/12/11/10.5px 4단으로 끝** — 큰 숫자 히어로(stat 카드) 금지.

## 4. Spacing & Layout Grid

- Max content width **1080px**, centered, `24px` side padding.
- Vertical rhythm in 8px steps. Stat strip → filters → table: `20px` gaps.
- **행: 높이 37px 고정, 행간 보더 없음, hover 배경 1단만.** 구분은 정렬·간격·wave 룰(헤어라인+카운트)로.
- 라인 넘버: CSS counter `decimal-leading-zero`, mono 10.5px, opacity 0.55 — 원장 시그니처.
- radius 4~6px로 통일. 그림자는 floating menu 1곳만.

## 5. Components

- **FunnelBar**: 4px stacked distribution bar under the title — the whole funnel in one glance. Status colors only, 2px gaps.
- **Metrics**: inline number row (`17px mono bold` + `12px` label), hairline-bottom. NOT cards — no borders around individual numbers.
- **FilterBar**: text toggles with 7px status dot; active = text bright + 1px accent underline. Search = borderless input with hairline underline, `margin-left auto`.
- **List**: wave-grouped rows (sticky-feel headers `W5 6`). Row grid: 회사/포지션(2줄) · 연차 · 제출일 · docs n · 상태(도트+텍스트) · 메모. Hairline separators only; hover = surface bg. Row click/Enter → Drawer.
- **StatusDot**: 8px colored dot + text. The trigger variant gets a 14%-alpha hover bg; non-interactive renders bare.
- **StatusMenu**: floating menu (the one allowed shadow), dot+label per item.
- **Drawer**: right panel 400px, hairline left border, backdrop. Sections: meta(dl) → 제출 문서(doc rows, fetch→Blob→new tab) → 메모 → 이력(mono). Esc/backdrop close, `role="dialog"`.
- **TokenGate / Toast**: unchanged from v1; toast `aria-live="polite"`.

## 6. Motion

Almost none. `transition: background 120ms, border-color 120ms` on rows/chips. No entrance animations, no skeleton shimmer (data is one small JSON; show a plain "불러오는 중…" line).

## 7. Accessibility

- Every interactive element keyboard-reachable; visible `:focus-visible` ring (`2px` accent).
- Status conveyed by text + color, never color alone.
- `prefers-reduced-motion` respected (transitions off).
- Contrast: all text ≥ 4.5:1 against `bg`/`surface` (the palette above passes).

## 8. Data & State Rules

- SSOT = `applications.json` in the private data repo. The app never holds divergent state past one optimistic update.
- Every mutation = one git commit, message `status: {company} {role} {from}→{to} (board:{user})`. History stays in git; the app does not reimplement audit logs.
- Status vocabulary is closed (10 keys above). career-ops mapping: Evaluada→ready, Aplicado→submitted, Entrevista→interview, Oferta→offer, Rechazada→rejected-docs (default; refine by stage when known), Descartada→hold.

## 9. Do / Don't

- DO keep the whole app under ~30KB JS gzip (no UI libraries, no icon packs, no chart libs — counts are text).
- DO render rejected rows at full opacity. DON'T gray them out or collapse them by default.
- DON'T add dark/light toggle (single dark theme), emojis, confetti on offer, or motivational copy.
- DON'T bake any application data, company names, or tokens into this public repo.
