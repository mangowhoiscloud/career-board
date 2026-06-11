# DESIGN.md — Career Board (operator dashboard)

> Google Stitch DESIGN.md format — 9 sections. AI agents read this before writing UI for this codebase.
> Audience: mango (operator) + authorized agents. A private ops dashboard, read at a monitor, often at night.
> Surface: Vite + React + TS SPA on GitHub Pages. Data lives in a private repo, fetched client-side with a PAT.
> Sibling surfaces: resume (A4 print), portfolio (dark dev docs), mango-wiki (warm paper). Per DESIGN-shared.md, do NOT unify; this surface borrows the portfolio's dark harness aesthetic because the audience and medium match (operator at a dark monitor).

## 1. Visual Theme & Atmosphere

**Mood**: mission console. Dense, calm, legible at a glance. The board answers "지금 어디까지 왔나" in under 5 seconds: counts first, rows second, detail on demand.

**Adjectives**: dark, dense, status-driven, keyboard-friendly, audit-honest.

**What it is not**: a marketing page, a kanban toy, a gradient dashboard template. No hero section, no illustrations, no emoji decoration, no card shadows stacked for depth. Rejections are shown plainly (red, not hidden) — the board exists to face the funnel, not to flatter it.

## 2. Color Palette & Roles

| Role | Hex | Usage |
|---|---|---|
| `bg` | `#0E1116` | Page background. |
| `surface` | `#161B22` | Table rows, stat cards, modal. |
| `surface-raised` | `#1C2330` | Hover rows, dropdown. |
| `border` | `#262D37` | 1px hairlines everywhere. No shadows. |
| `text` | `#E6EDF3` | Primary text. |
| `text-2` | `#9DA7B3` | Secondary: dates, channels, notes. |
| `text-3` | `#6E7681` | Tertiary: row numbers, placeholders. |
| `accent` | `#58A6FF` | Links, focus rings, active filter. |

**Status colors** (the only place color carries meaning — never reuse for decoration):

| Status | Key | Hex |
|---|---|---|
| 준비 | `ready` | `#8B949E` |
| 제출 | `submitted` | `#58A6FF` |
| 서류통과 | `screening` | `#BC8CFF` |
| 과제 | `assignment` | `#F2CC60` |
| 면접 | `interview` | `#56D364` |
| 오퍼 | `offer` | `#3FB950` |
| 탈락 | `rejected` | `#F85149` |
| 보류·마감 | `hold` | `#6E7681` |

Status chips: `color` at full hex, `background` at 14% alpha of the same hex, 1px border at 35% alpha. No filled solid chips.

## 3. Typography Rules

Stack (Korean-first, no webfont fetch for text):

```
'Apple SD Gothic Neo', 'Pretendard', 'Malgun Gothic', -apple-system, sans-serif
```

Numerals/dates/IDs use `ui-monospace, 'SF Mono', Menlo, monospace`.

| Element | Size | Weight |
|---|---|---|
| page title | 18px | 700 |
| stat number | 26px mono | 700 |
| stat label | 11px | 500, letter-spacing 0.06em, uppercase-like muted |
| table header | 11px | 600, `text-3` |
| table cell | 13px / 1.45 | 400 |
| company name | 13px | 600 |
| status chip | 11px | 600 |
| notes | 12px | 400 `text-2` |

## 4. Spacing & Layout Grid

- Max content width **1080px**, centered, `24px` side padding.
- Vertical rhythm in 8px steps. Stat strip → filters → table: `20px` gaps.
- Table rows `10px 12px` padding, hairline-separated. No zebra striping (status chips already carry color load).
- Stat strip: CSS grid `repeat(auto-fit, minmax(120px, 1fr))`, cards `12px` padding.

## 5. Components

- **StatStrip**: total / active(준비+제출+진행) / 진행(서류통과·과제·면접) / 탈락 / 응답률. Numbers mono, label below.
- **FilterBar**: status chip toggles (multi), free-text search (company·role), wave select. Active filter = accent border.
- **Row**: `# · 회사 · 포지션 · 연차요건 · 채널 · 제출일 · 상태칩 · 메모`. Company links to JD url when present.
- **StatusMenu**: click chip → small menu of 8 statuses → optimistic update → commit via API. On failure, revert + toast.
- **TokenGate**: first-run screen asking for a fine-grained PAT; explains scope (career-data, Contents RW). Token in `localStorage` only. A "에이전트는 git으로 직접 커밋" hint links to the data repo.
- **Toast**: bottom-right, single line, auto-dismiss 4s. Error = red border, success = green border.

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
- Status vocabulary is closed (8 keys above). career-ops mapping: Evaluada→ready, Aplicado→submitted, Entrevista→interview, Oferta→offer, Rechazada→rejected, Descartada→hold.

## 9. Do / Don't

- DO keep the whole app under ~30KB JS gzip (no UI libraries, no icon packs, no chart libs — counts are text).
- DO render rejected rows at full opacity. DON'T gray them out or collapse them by default.
- DON'T add dark/light toggle (single dark theme), emojis, confetti on offer, or motivational copy.
- DON'T bake any application data, company names, or tokens into this public repo.
