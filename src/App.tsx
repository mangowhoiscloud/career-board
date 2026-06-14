import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  commitBoard, createFile, DATA_REPO_URL, fetchBoard, fetchDocBlobUrl, fetchJsonFile, fetchTextFile,
  updateTextFile, queueMailRead, mailFeed, mailGet, mailMarkRead,
  markNotificationsRead, putJsonFile, whoami,
  type InboxData, type InboxMessage, type MailDraft, type MailDraftsData,
  type NotifFile, type Notification, type OutboxData, type OutboxItem,
  type RequestType, type RunEvent, type RunnerRun, type RunnerState, type RunnerCombo, type SdkCredit,
} from './api'
import { clearStore, patchEntry, prefetchAll, revalidate, useEntry, type Entry, type StoreKey } from './store'
import { mailReadKey, markMailRead, pruneMailRead, useMailReadOverlay } from './mailRead'
import { httpMode, exchangeCodeFromUrl, loginRedirect, cpLogout, TOKEN_KEY } from './backend'
import type { Application, BoardData, Status } from './types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types'
const COMBO_KEY = 'agentCombo'
const MODEL_KEY = 'agentModel'
type Toast = { kind: 'ok' | 'err'; text: string } | null
type View = 'board' | 'mail' | 'agent' | 'notif'
const VIEWS: View[] = ['board', 'mail', 'agent', 'notif']
/* 뷰별 URL 경로 — Cloudflare(BASE '/')는 /board·/mail·/agent·/notif, Pages(BASE '/career/')는
   /career/board… SPA fallback(Cloudflare not_found=single-page-application)으로 딥링크 로드 가능. */
const ROUTE_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
function viewFromPath(): View {
  const seg = window.location.pathname.slice(ROUTE_BASE.length).replace(/^\/+|\/+$/g, '').split('/')[0]
  return (VIEWS as string[]).includes(seg) ? (seg as View) : 'board'
}
function pathForView(v: View): string {
  return `${ROUTE_BASE}/${v}`
}

/* 트랜스크립트·결과 마크다운 — CC 터미널처럼 절제된 렌더, 외부 링크만 앰버 */
function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/* 에이전트 초안 산출물 파서: "Subject:|제목:" 줄 + 빈 줄 + 본문.
   아카이브 md 헤더(#·> 줄)를 스킵 — 헤더 미스킵으로 제목 파싱이 항상 실패하던 결함 교정. */
function parseDraft(text: string): { subject?: string; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let s = 0
  while (s < lines.length && (lines[s].trim() === '' || lines[s].startsWith('# ') || lines[s].startsWith('> ')))
    s += 1
  const m = (lines[s] ?? '').trim().match(/^(?:Subject|제목)\s*[::]\s*(.+)$/i)
  if (!m) return { body: lines.slice(s).join('\n').trim() }
  let i = s + 1
  while (i < lines.length && lines[i].trim() === '') i += 1
  return { subject: m[1].trim(), body: lines.slice(i).join('\n').trim() }
}

const BOARD_SLUGS: Array<[string, string]> = [
  ['ashbyhq', 'ashby'],
  ['greenhouse', 'greenhouse'],
  ['lever', 'lever'],
  ['wanted', 'wanted'],
  ['greetinghr', 'greeting'],
  ['recruiter.co.kr', 'recruiter'],
]

function channelLabel(url?: string, channel?: string): string {
  if (channel) return channel
  if (!url) return ''
  try {
    const h = new URL(url).hostname
    for (const [k, v] of BOARD_SLUGS) if (h.includes(k)) return v
    const parts = h.replace(/^www\./, '').split('.')
    const slug = parts[0] === 'careers' || parts[0] === 'career' || parts[0] === 'jobs' || parts[0] === 'job-boards' ? parts[1] : parts[0]
    return (slug ?? '').slice(0, 12)
  } catch {
    return ''
  }
}

function todayLocal(): string {
  return new Intl.DateTimeFormat('sv-SE').format(new Date())
}

function fmtHistoryAt(iso: string): string {
  return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
}

/* 시각 표기: 오늘이면 HH:MM, 아니면 MM-DD */
function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* 날짜 그룹 라벨: 오늘 / 어제 / MM-DD */
function dateLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (diff === 0) return '오늘'
  if (diff === 1) return '어제'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* 메일 텍스트 정돈: 제로폭 문자 제거 · 줄별 trim · 3+ 연속 빈 줄 → 1 · 앞뒤 공백 제거 */
function cleanMailText(s: string): string {
  if (!s) return ''  // \uD14C\uC774\uBE14 \uD53C\uB4DC \uBAA9\uB85D \uB808\uCF54\uB4DC\uB294 \uBCF8\uBB38 \uC5C6\uC74C(\uC5F4 \uB54C mailGet\uC73C\uB85C \uCC44\uC6C0) \u2192 undefined \uD06C\uB798\uC2DC \uBC29\uC9C0
  return s
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* 목록 스니펫용 한 줄 정돈: 제로폭·연속 공백 제거 */
function cleanMailLine(s: string): string {
  if (!s) return ''
  return s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '').replace(/\s+/g, ' ').trim()
}

/* HTML 메일 srcDoc: <base target=_blank> + 기본 스타일 주입. 풀 문서면 head 에, 조각이면 래핑 */
function mailSrcDoc(html: string): string {
  const inject =
    '<base target="_blank"><style>body{margin:12px;font:13px -apple-system,sans-serif;color:#222}</style>'
  const head = html.match(/<head[^>]*>/i)
  if (head) return html.replace(head[0], head[0] + inject)
  return `<!doctype html><html><head><meta charset="utf-8">${inject}</head><body>${html}</body></html>`
}

/* "이름 <addr>" 헤더 파싱 */
function fromName(s: string): string {
  const m = s.match(/^"?([^"<]*)"?\s*</)
  const name = m?.[1]?.trim()
  return name || s.replace(/[<>]/g, '').trim()
}
function fromAddr(s: string): string {
  return s.match(/<([^>]+)>/)?.[1] ?? s.trim()
}

/* run 시작 시각: started 우선, 없으면 id 의 RUN-YYMMDDHHMMSS 타임스탬프 */
function runStartMs(r: { started: string | null; id: string }): number {
  if (r.started) return new Date(r.started).getTime()
  const m = r.id.match(/^RUN-(\d{12})/)
  if (m) {
    const s = m[1]
    return new Date(
      2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)),
      Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)),
    ).getTime()
  }
  return Date.now()
}

/* 러너 run id 생성 규칙: REQ-{ts} → RUN-{ts}.
   러너가 prompt 에 REQ 헤더를 더는 싣지 않아(## 요청 본문만) id 치환으로 결정론 매칭한다 */
function runIdOf(reqId: string): string {
  return reqId.replace('REQ-', 'RUN-')
}

function hhmm(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5)
}

function statusTone(s: Status): 'muted' | 'active' | 'closed' {
  if (s === 'ready' || s === 'submitted' || s === 'hold') return 'muted'
  if (s.startsWith('rejected')) return 'closed'
  return 'active'
}

/* 다이얼로그 공통: 포커스 이동·복원·Esc·스크롤 락·탭 트랩 */
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const node = ref.current
    node?.focus()
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && node) {
        const items = node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      prev?.focus()
    }
  }, [onClose])
  return ref
}

/* 클라이언트 윈도잉: 데이터는 전부 클라에 있고, 한 번에 step 개만 렌더한다.
   하단 센티넬이 viewport 에 들어오면 +step. items 길이가 바뀌면(필터·새 데이터)
   count 는 max(step, 현재) 유지하되 items.length 로 clamp — 스크롤 위치를 잃지 않으면서 과도 렌더 방지. */
function useInfiniteWindow<T>(items: T[], step = 30, resetKey?: string) {
  const [count, setCount] = useState(step)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const len = items.length

  /* items 길이 변동에 count 재정렬: 최소 step, 최대 len. 필터로 줄면 자연히 clamp 된다. */
  useEffect(() => {
    setCount((c) => Math.min(Math.max(c, step), Math.max(len, step)))
  }, [len, step])

  /* 필터·검색 등 명시적 컨텍스트 전환 시 count 를 step 으로 리셋 (스크롤 상단 복귀) */
  useEffect(() => {
    if (resetKey !== undefined) setCount(step)
  }, [resetKey, step])

  const visibleCount = Math.min(count, len)
  const hasMore = visibleCount < len

  useEffect(() => {
    if (!hasMore) return
    const node = sentinelRef.current
    if (!node) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + step)
      },
      { rootMargin: '200px' },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [hasMore, step, visibleCount])

  const visible = useMemo(() => items.slice(0, visibleCount), [items, visibleCount])
  return { visible, sentinelRef, hasMore }
}

/* 서버 메일 피드 어댑터 (httpMode 전용) — mail_messages 를 커서로 누적해 기존 InboxData 형태로 노출.
   서버가 relevance=recruiting 필터링(채용 메일만). 목록은 경량(body 제외) — 본문은 열 때 mailGet.
   blob 의 50건 캡이 없어 전량을 담는다(account별 페이지 누적, 안전상 account당 20페이지=1000건 캡).
   nonce 를 올리면 재취득(새로고침). httpMode 가 아니면 undefined → 호출부가 blob 경로로 폴백. */
function useServerInbox(token: string | null, nonce: number): Entry<InboxData> | undefined {
  const [entry, setEntry] = useState<Entry<InboxData> | undefined>(undefined)
  useEffect(() => {
    if (!httpMode || !token) return
    let live = true
    void (async () => {
      try {
        const all: InboxMessage[] = []
        for (const account of ['gmail', 'naver']) {
          let cursor: string | null = null
          for (let page = 0; page < 20; page++) {
            const res = await mailFeed(token, account, cursor)
            all.push(...res.messages.map((m) => ({ ...m, unread: !!m.unread })))
            cursor = res.next_cursor
            if (!cursor) break
          }
        }
        if (live) {
          setEntry({ data: { synced_at: new Date().toISOString(), messages: all },
                     sha: null, etag: null, at: Date.now(), missing: false })
        }
      } catch {
        if (live) setEntry({ data: null, sha: null, etag: null, at: Date.now(), missing: true })
      }
    })()
    return () => { live = false }
  }, [token, nonce])
  return entry
}

/* requests/REQ-*.md 큐 파일 — 컴포저·메일 초안이 공유하는 단일 포맷 */
function reqFileBody(opts: { id: string; typeId: string; label: string; combo: string; model: string; user: string; prompt: string; resume?: string; thread?: string }): string {
  return [
    `# ${opts.id} · ${opts.label}`,
    '',
    `- type: ${opts.typeId}`,
    `- runner: ${JSON.stringify({ combo: opts.combo, model: opts.model })}`,
    ...(opts.thread ? [`- thread: ${opts.thread}`] : []),
    ...(opts.resume ? [`- resume: ${opts.resume}`] : []),
    `- requested-by: board:${opts.user}`,
    `- requested-at: ${new Date().toISOString()}`,
    `- status: pending`,
    '',
    '## 요청',
    '',
    opts.prompt,
    '',
    '> 처리: runnerd(launchd)가 60초 루프로 Agent SDK in-process 집행. 완료 시 status: done + 산출물 경로 기재.',
    '',
  ].join('\n')
}

function StatusDot({ status, asButton, onClick }: { status: Status; asButton?: boolean; onClick?: () => void }) {
  const c = STATUS_COLOR[status]
  const tone = statusTone(status)
  const textColor = tone === 'active' ? 'var(--text)' : tone === 'closed' ? '#c9655c' : 'var(--text-3)'
  const inner = (
    <>
      <span className="dot" style={{ background: c }} aria-hidden="true" />
      <span style={{ color: textColor }}>{STATUS_LABEL[status]}</span>
    </>
  )
  if (!asButton) return <span className="status">{inner}</span>
  return (
    <button
      type="button"
      className="status status-trigger"
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      aria-label={`상태 ${STATUS_LABEL[status]}, 변경`}
    >
      {inner}
    </button>
  )
}

function StatusMenu({
  current,
  up,
  onPick,
  onClose,
}: {
  current: Status
  up?: boolean
  onPick: (s: Status) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll('button') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next]?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return (
    <div className={`status-menu ${up ? 'up' : ''}`} ref={ref} role="menu">
      {STATUS_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          role="menuitem"
          className={s === current ? 'current' : ''}
          onClick={(e) => {
            e.stopPropagation()
            onPick(s)
          }}
        >
          <span className="dot" style={{ background: STATUS_COLOR[s] }} aria-hidden="true" />
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  )
}

/* ── 서류통과(screening) 도달 판정: 현재 상태가 후속 단계이거나 이력에 screening 경유 ── */
const PAST_SCREENING: ReadonlySet<Status> = new Set([
  'screening', 'assignment', 'interview', 'offer', 'rejected-assignment', 'rejected-interview',
])
const reachedScreening = (a: Application): boolean =>
  PAST_SCREENING.has(a.status) || (a.history ?? []).some((h) => h.to === 'screening')

/* 상태 점프(제출→과제/면접 등) 시 경유한 screening 을 이력에 함께 기록 */
const STAGES_AFTER_SCREENING: ReadonlySet<Status> = new Set([
  'assignment', 'interview', 'offer', 'rejected-assignment', 'rejected-interview',
])
function historyHops(a: Application, next: Status, by: string): { at: string; from: Status | ''; to: Status; by: string }[] {
  const at = new Date().toISOString()
  const hops: { at: string; from: Status | ''; to: Status; by: string }[] = []
  const needsScreeningHop =
    STAGES_AFTER_SCREENING.has(next) && !reachedScreening(a) && a.status !== 'screening'
  if (needsScreeningHop) {
    hops.push({ at, from: a.status, to: 'screening', by })
    hops.push({ at, from: 'screening', to: next, by })
  } else {
    hops.push({ at, from: a.status, to: next, by })
  }
  return hops
}

function FunnelBar({ apps }: { apps: Application[] }) {
  const total = apps.length || 1
  return (
    <div className="funnel" role="img" aria-label="상태 분포">
      {STATUS_ORDER.map((s) => {
        const n = apps.filter((a) => a.status === s).length
        if (!n) return null
        return (
          <span
            key={s}
            style={{ width: `${(n / total) * 100}%`, background: STATUS_COLOR[s] }}
            title={`${STATUS_LABEL[s]} ${n}`}
          />
        )
      })}
    </div>
  )
}


/* ── Sankey: 제출 → 서류 → 과제 → 면접 → 오퍼 (이탈 포함) ── */
function Sankey({ apps }: { apps: Application[] }) {
  const W = 560
  const H = 168
  const NODE_W = 5
  const GAP = 9
  const by = (s: Status) => apps.filter((x) => x.status === s).length
  const submitted = apps.length - by('ready')
  const wait = by('submitted')
  const rejDocs = by('rejected-docs')
  const passDocs = apps.filter(reachedScreening).length
  const screening = by('screening')
  const rejAsg = by('rejected-assignment')
  const curAsg = by('assignment')
  const toInt = by('interview') + by('rejected-interview') + by('offer')
  const offer = by('offer')
  const curInt = by('interview')
  const rejInt = by('rejected-interview')
  if (submitted === 0) return null

  type Node = { label: string; count: number; color: string }
  const cols: { x: number; nodes: Node[] }[] = [
    { x: 8, nodes: [{ label: '제출', count: submitted, color: '#c9c9cf' }] },
    {
      x: 176,
      nodes: [
        { label: '서류 통과', count: passDocs, color: '#e9c46a' },
        { label: '응답 대기', count: wait, color: '#55555b' },
        { label: '서류 탈락', count: rejDocs, color: '#a04a45' },
      ],
    },
    {
      x: 344,
      nodes: [
        { label: '면접 진입', count: toInt, color: '#f08c00' },
        { label: '과제 진행', count: curAsg, color: '#e8a33d' },
        { label: '통과 대기', count: screening, color: '#e9c46a' },
        { label: '과제 탈락', count: rejAsg, color: '#b45a50' },
      ],
    },
    {
      x: 478,
      nodes: [
        { label: '오퍼', count: offer, color: '#46c68a' },
        { label: '면접 진행', count: curInt, color: '#f08c00' },
        { label: '면접 탈락', count: rejInt, color: '#c9655c' },
      ],
    },
  ]
  const scale = (H - 30) / submitted
  const h = (n: number) => Math.max(n * scale, n > 0 ? 3 : 0)
  // 컬럼별 y 배치
  const pos = cols.map((c) => {
    let y = 10
    return c.nodes.map((n) => {
      const node = { ...n, y, h: h(n.count) }
      if (n.count > 0) y += h(n.count) + GAP
      return node
    })
  })
  // 리본: src 컬럼의 소비 오프셋 추적
  const ribbon = (
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    rh: number,
    color: string,
    key: string,
  ) => {
    const mx = (sx + tx) / 2
    return (
      <path
        key={key}
        d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty} L ${tx} ${ty + rh} C ${mx} ${ty + rh}, ${mx} ${sy + rh}, ${sx} ${sy + rh} Z`}
        fill={color}
        opacity="0.28"
      />
    )
  }
  const ribbons: React.ReactNode[] = []
  const flowFrom = (ci: number, si: number, targets: number[]) => {
    let off = 0
    const s = pos[ci][si]
    targets.forEach((ti) => {
      const t = pos[ci + 1][ti]
      if (t.count <= 0) return
      ribbons.push(
        ribbon(cols[ci].x + NODE_W, s.y + off, cols[ci + 1].x, t.y, t.h, t.color, `${ci}-${si}-${ti}`),
      )
      off += t.h
    })
  }
  flowFrom(0, 0, [0, 1, 2])
  flowFrom(1, 0, [0, 1, 2, 3])
  flowFrom(2, 0, [0, 1, 2])

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sankey" role="img" aria-label="지원 퍼널 플로우">
      {ribbons}
      {pos.map((nodes, ci) =>
        nodes.map(
          (n, ni) =>
            n.count > 0 && (
              <g key={`${ci}-${ni}`}>
                <rect x={cols[ci].x} y={n.y} width={NODE_W} height={n.h} rx="1.5" fill={n.color} />
                <text
                  x={cols[ci].x + NODE_W + 7}
                  y={n.y + Math.min(n.h / 2, 14) + 3.5}
                  className="sankey-label"
                >
                  {n.label} {n.count}
                </text>
              </g>
            ),
        ),
      )}
    </svg>
  )
}

/* ── 캠페인 타임라인: 제출일 버스트 ── */
function Timeline({ apps }: { apps: Application[] }) {
  const W = 480
  const H = 168
  const dated = apps.filter((a) => a.submitted)
  if (dated.length === 0) return null
  const toDate = (s: string) => new Date(s.length === 7 ? s + '-15' : s).getTime()
  const times = dated.map((a) => toDate(a.submitted as string))
  const min = Math.min(...times)
  const max = Math.max(...times)
  const span = Math.max(max - min, 1)
  const x = (t: number) => 16 + ((t - min) / span) * (W - 50)
  // 날짜별 스택
  const byDay = new Map<string, Application[]>()
  for (const a of dated) {
    const k = a.submitted as string
    byDay.set(k, [...(byDay.get(k) ?? []), a])
  }
  // 월 눈금
  const months: { t: number; label: string }[] = []
  const cur = new Date(min)
  cur.setDate(1)
  while (cur.getTime() <= max) {
    if (cur.getTime() >= min - 25 * 86400000)
      months.push({ t: Math.max(cur.getTime(), min), label: String(cur.getMonth() + 1).padStart(2, '0') })
    cur.setMonth(cur.getMonth() + 1)
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="timeline" role="img" aria-label="제출 타임라인">
      <line x1="10" y1={H - 22} x2={W - 10} y2={H - 22} stroke="var(--border)" strokeWidth="1" />
      {months.map((m) => (
        <g key={m.label}>
          <line x1={x(m.t)} y1={H - 22} x2={x(m.t)} y2={H - 18} stroke="var(--border-strong)" strokeWidth="1" />
          <text x={x(m.t)} y={H - 8} className="tl-tick" textAnchor="middle">
            {m.label}
          </text>
        </g>
      ))}
      {[...byDay.entries()].map(([day, list]) =>
        list.map((a, i) => (
          <circle
            key={a.id}
            cx={x(toDate(day))}
            cy={H - 30 - i * 7.5}
            r="2.8"
            fill={STATUS_COLOR[a.status]}
            opacity={statusTone(a.status) === 'muted' ? 0.55 : 0.95}
          >
            <title>{`${a.company} · ${STATUS_LABEL[a.status]} · ${day}`}</title>
          </circle>
        )),
      )}
    </svg>
  )
}

function Drawer({
  app,
  token,
  onClose,
  onStatus,
  toast,
}: {
  app: Application
  token: string
  onClose: () => void
  onStatus: (s: Status) => void
  toast: (t: Toast) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const ref = useDialog(onClose)

  const openDoc = async (path: string) => {
    setOpening(path)
    try {
      const url = await fetchDocBlobUrl(token, path)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      toast({ kind: 'err', text: e instanceof Error ? e.message : '문서 열기 실패' })
    } finally {
      setOpening(null)
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${app.company} 상세`}
        ref={ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <div>
            <h2>{app.company}</h2>
            <p className="drawer-role">{app.role}</p>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기 (Esc)">
            esc
          </button>
        </header>

        <dl className="drawer-meta">
          <div>
            <dt>상태</dt>
            <dd className="status-cell">
              <StatusDot status={app.status} asButton onClick={() => setMenuOpen((v) => !v)} />
              {menuOpen && (
                <StatusMenu
                  current={app.status}
                  onPick={(s) => {
                    setMenuOpen(false)
                    onStatus(s)
                  }}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </dd>
          </div>
          <div>
            <dt>차수</dt>
            <dd className="mono">{app.wave}</dd>
          </div>
          {app.yearsReq && (
            <div>
              <dt>연차 요건</dt>
              <dd>{app.yearsReq}</dd>
            </div>
          )}
          {app.submitted && (
            <div>
              <dt>제출일</dt>
              <dd className="mono">
                {app.submitted}
                {app.status === 'submitted' &&
                  (() => {
                    const days = Math.floor((Date.now() - new Date(app.submitted as string).getTime()) / 86400000)
                    return days >= 14 ? ` · ${days}일 경과 — 팔로업 검토` : days >= 1 ? ` · ${days}일 경과` : ''
                  })()}
              </dd>
            </div>
          )}
          {app.url && (
            <div>
              <dt>공고</dt>
              <dd>
                <a href={app.url} target="_blank" rel="noreferrer">
                  {channelLabel(app.url, app.channel)}에서 보기
                </a>
              </dd>
            </div>
          )}
        </dl>

        {app.docs && app.docs.length > 0 && (
          <section className="drawer-docs">
            <h3>제출 문서</h3>
            {app.docs.map((d) => (
              <button
                key={d.path}
                type="button"
                className="doc-link"
                onClick={() => void openDoc(d.path)}
                disabled={opening === d.path}
              >
                <span className="doc-label">{d.label}</span>
                <span className="doc-open">{opening === d.path ? '여는 중…' : '보기'}</span>
              </button>
            ))}
          </section>
        )}

        {app.notes && (
          <section className="drawer-notes">
            <h3>메모</h3>
            <p>{app.notes}</p>
          </section>
        )}

        {app.history && app.history.length > 0 && (
          <section className="drawer-history">
            <h3>이력</h3>
            {[...app.history].reverse().map((h, i) => (
              <p key={i} className="mono">
                {fmtHistoryAt(h.at)} · {h.from ? `${STATUS_LABEL[h.from]} → ` : ''}
                {STATUS_LABEL[h.to]} · {h.by}
              </p>
            ))}
          </section>
        )}
      </aside>
    </>
  )
}

/* 부팅·로딩 스피너 — OAuth 복귀/데이터 prefetch 동안 표시. 로그인 화면이 잠깐 뜨는 깜빡임을 덮는다. */
function LoadingScreen() {
  return (
    <main className="gate">
      <h1 className="wordmark">
        mango<span className="wordmark-dot">.</span>career
      </h1>
      <div className="gate-loading" aria-live="polite">
        <span className="gate-spinner" aria-hidden="true" />
        <span className="gate-sub">불러오는 중…</span>
      </div>
    </main>
  )
}

/* 계정 로그인 게이트(httpMode) — Google OIDC. 세션 쿠키/Bearer는 백엔드가 발급. */
function GoogleGate({ onLogin, error }: { onLogin: () => void; error: string | null }) {
  return (
    <main className="gate">
      <h1 className="wordmark">
        mango<span className="wordmark-dot">.</span>career
      </h1>
      <p className="gate-sub">계정으로 로그인하세요. 세션은 이 브라우저에만 저장됩니다.</p>
      <button type="button" className="gate-google" onClick={onLogin}>
        Google로 로그인
      </button>
      {error && (
        <p className="gate-error" aria-live="polite">
          {error}
        </p>
      )}
    </main>
  )
}

function TokenGate({ onSubmit, error }: { onSubmit: (t: string) => void; error: string | null }) {
  const [value, setValue] = useState('')
  return (
    <main className="gate">
      <h1 className="wordmark">
        mango<span className="wordmark-dot">.</span>career
      </h1>
      <p className="gate-sub">
        지원 현황 데이터는 비공개 저장소에 있습니다. fine-grained PAT(career-data, Contents
        read/write)로 인증하세요. 토큰은 이 브라우저의 localStorage에만 저장됩니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <input
          type="password"
          name="token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="github_pat_…"
          aria-label="GitHub Personal Access Token"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <button type="submit">접속</button>
      </form>
      {error && (
        <p className="gate-error" aria-live="polite">
          {error}
        </p>
      )}
      <p className="gate-hint">
        에이전트는 보드를 거치지 않고 <a href={DATA_REPO_URL}>career-data</a>의{' '}
        <code>data/applications.json</code>을 git으로 직접 커밋합니다.
      </p>
    </main>
  )
}

/* ════════════════════════════════════════════════════════════════
   알림 v3 — Inbox/Done 이원 모델 (Linear·GitHub 차용, 렌더는 원장).
   행 = 대상 객체의 입구: 클릭이 유일한 내비게이션, 액션은 읽음뿐.
   ════════════════════════════════════════════════════════════════ */

function notifSource(source: string): string {
  return source === 'gmail' || source === 'naver' ? 'mail' : source
}

function NotifSection({
  items,
  onRead,
  onNavigate,
}: {
  items: Notification[]
  onRead: (ids: 'all' | string[]) => Promise<void>
  onNavigate: (n: Notification) => void
}) {
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const unread = items.filter((n) => !n.handled).length

  const shown = useMemo(() => {
    const list = items.filter((n) => (tab === 'open' ? !n.handled : n.handled))
    return [...list].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40)
  }, [items, tab])

  const groups = useMemo(() => {
    const out: [string, Notification[]][] = []
    for (const n of shown) {
      const label = dateLabel(n.at)
      const last = out[out.length - 1]
      if (last && last[0] === label) last[1].push(n)
      else out.push([label, [n]])
    }
    return out
  }, [shown])

  const read = (ids: 'all' | string[]) => {
    setBusy(true)
    setErr(null)
    onRead(ids)
      .catch((e) => setErr(e instanceof Error ? e.message : '읽음 처리 실패'))
      .finally(() => setBusy(false))
  }

  return (
    <section id="panel-notif" className="panel" aria-label="알림">
      <div className="panel-head">
        <span className="panel-title">알림</span>
        <span className="notif-tabs mono" role="tablist" aria-label="알림 탭">
          <button type="button" role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>
            미처리{unread > 0 ? ` ${unread}` : ''}
          </button>
          <span className="vt-sep" aria-hidden="true">|</span>
          <button type="button" role="tab" aria-selected={tab === 'done'} className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>
            처리됨
          </button>
        </span>
        <span className="panel-rule" aria-hidden="true" />
        {tab === 'open' && unread > 0 && (
          <button type="button" className="panel-action" disabled={busy} onClick={() => read('all')}>
            {busy ? '처리 중…' : '모두 읽음'}
          </button>
        )}
      </div>
      {err && <p className="panel-empty">{err}</p>}
      {shown.length === 0 ? (
        <p className="panel-empty">없음</p>
      ) : (
        groups.map(([label, rows]) => (
          <div key={label} role="list" aria-label={label}>
            <h3 className="notif-date mono">{label}</h3>
            {rows.map((n) => (
              <div
                key={n.id}
                role="listitem"
                tabIndex={0}
                className={`panel-row notif-row${n.handled ? ' handled' : ''}`}
                onClick={() => onNavigate(n)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) onNavigate(n)
                }}
              >
                <span className="p-time mono">{hhmm(n.at)}</span>
                <span className="n-fact">
                  {n.company && <strong>{n.company}</strong>}
                  {n.company ? ' · ' : ''}
                  {n.subject}
                  {n.statusChange ? ` · ${n.statusChange}` : ''}
                </span>
                <span className="n-src mono">{notifSource(n.source)}</span>
                {!n.handled && (
                  <button
                    type="button"
                    className="notif-read mono"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      read([n.id])
                    }}
                  >
                    읽음
                  </button>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════
   메일함 — 계정별 섹션(GMAIL/NAVER) + 중앙 정사각 메일 모달.
   발송은 outbox.json queued 커밋(발송 확정 게이트), 동기는 sync-request 플래그.
   ════════════════════════════════════════════════════════════════ */

const MAIL_KIND_LABEL: Record<string, string> = {
  receipt: '접수확인',
  screening: '서류',
  assignment: '과제',
  interview: '면접',
  rejection: '탈락',
}

function MailComposeForm({
  token,
  user,
  prefill,
  fill,
  onQueued,
}: {
  token: string
  user: string
  prefill?: { account: string; to: string; subject: string; in_reply_to?: string }
  fill?: { subject?: string; body: string; ts: number }
  onQueued: () => void
}) {
  const [account, setAccount] = useState(prefill?.account ?? 'gmail')
  const [to, setTo] = useState(prefill?.to ?? '')
  const [subject, setSubject] = useState(prefill?.subject ?? '')
  const [body, setBody] = useState('')
  const [phase, setPhase] = useState<'idle' | 'armed' | 'committing' | 'queued'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const armTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(armTimer.current), [])

  /* 에이전트 초안: 제목 필드 교체(파싱 성공 시) + 본문 textarea 채움 */
  useEffect(() => {
    if (!fill) return
    setBody(fill.body)
    if (fill.subject) setSubject(fill.subject)
  }, [fill])

  const ready = to.trim().length > 0 && subject.trim().length > 0 && body.trim().length > 0

  const onSendClick = async () => {
    if (phase === 'idle') {
      setErr(null)
      setPhase('armed')
      armTimer.current = window.setTimeout(() => setPhase((p) => (p === 'armed' ? 'idle' : p)), 5000)
      return
    }
    if (phase !== 'armed') return
    window.clearTimeout(armTimer.current)
    setPhase('committing')
    try {
      const fetched = await fetchJsonFile<OutboxData>(token, 'data/mail/outbox.json')
      const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
      const item: OutboxItem = {
        id: `OUT-${ts}`,
        account,
        to: to.trim(),
        subject: subject.trim(),
        body,
        ...(prefill?.in_reply_to ? { in_reply_to: prefill.in_reply_to } : {}),
        status: 'queued',
        queued_at: new Date().toISOString(),
      }
      await putJsonFile(
        token,
        'data/mail/outbox.json',
        { items: [...(fetched?.data.items ?? []), item] },
        fetched?.sha ?? null,
        `mail: outbox queue (board:${user})`,
      )
      setPhase('queued')
      onQueued()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '큐 등록 실패')
      setPhase('idle')
    }
  }

  return (
    <div className="compose-form">
      <label>
        보내는 계정
        <select name="account" value={account} onChange={(e) => setAccount(e.target.value)} disabled={phase === 'queued'}>
          <option value="gmail">gmail</option>
          <option value="naver">naver</option>
        </select>
      </label>
      <label>
        받는 사람
        <input
          type="email"
          name="to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="addr@example.com"
          spellCheck={false}
          disabled={phase === 'queued'}
        />
      </label>
      <label>
        제목
        <input type="text" name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={phase === 'queued'} />
      </label>
      <label>
        본문
        <textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} disabled={phase === 'queued'} />
      </label>
      {phase === 'queued' ? (
        <p className="plain-note">대기 · 러너가 60초 내 발송</p>
      ) : (
        <button type="button" className="compose-submit" disabled={!ready || phase === 'committing'} onClick={() => void onSendClick()}>
          {phase === 'armed' ? '발송 확정' : phase === 'committing' ? '등록 중…' : '발송'}
        </button>
      )}
      {err && <p className="plain-note err">큐 등록 실패: {err}</p>}
    </div>
  )
}

type MailModalState = { kind: 'message'; msg: InboxMessage } | { kind: 'compose' }

function MailModal({
  token,
  user,
  state,
  runner,
  drafts,
  onClose,
  onQueued,
}: {
  token: string
  user: string
  state: MailModalState
  runner: RunnerState | null
  drafts: MailDraft[] | null
  onClose: () => void
  onQueued: () => void
}) {
  const ref = useDialog(onClose)
  const msg = state.kind === 'message' ? state.msg : null
  const [replyOpen, setReplyOpen] = useState(false)
  const [fill, setFill] = useState<{ subject?: string; body: string; ts: number } | undefined>(undefined)
  const [draftBusy, setDraftBusy] = useState(false)
  const [requested, setRequested] = useState(false)
  const [applied, setApplied] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const replyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (replyOpen) replyRef.current?.scrollIntoView({ block: 'nearest' })
  }, [replyOpen])

  /* 모달이 열려 있는 동안 drafts·러너 상태 15s 재검증 — 초안 등장·실패를 자리에서 감지 */
  useEffect(() => {
    if (!msg) return
    const t = window.setInterval(() => {
      void revalidate(token, 'mail-drafts').catch(() => {})
      void revalidate(token, 'runner-state').catch(() => {})
    }, 15000)
    return () => window.clearInterval(t)
  }, [token, msg])

  /* 단일 소스: drafts.json 에서 이 메일(account:id) 항목. 본문이 있으면 채울 준비 완료 */
  const myDraft = useMemo(
    () => (msg ? (drafts ?? []).find((d) => d.account === msg.account && d.id === msg.id) : undefined),
    [drafts, msg],
  )
  const hasDraftBody = !!myDraft && myDraft.body.trim().length > 0

  /* 마커 일치 run — 본문 출처가 아니라 진행/실패 신호로만 사용 (drafts 가 본문 단일 소스) */
  const marker = msg ? `[mail-reply:${msg.account}:${msg.id}]` : ''
  const markerRuns = useMemo(
    () => (marker ? (runner?.recent_runs ?? []).filter((r) => r.prompt.includes(marker)) : []),
    [runner, marker],
  )
  const activeRun = markerRuns.find((r) => r.status === 'running')
  /* 실패 = run failed 이고 아직 drafts 에 본문이 없을 때만 (실패 후 다른 시도가 성공했을 수 있음) */
  const failedRun = markerRuns.find((r) => r.status === 'failed')
  const failed = !hasDraftBody && !!failedRun ? failedRun : undefined
  /* 대기 = 요청했거나 run 진행 중, 아직 본문 없음, 실패 아님 — "drafts 에 아직 없음" = waiting */
  const waiting = !applied && !failed && hasDraftBody === false && (requested || !!activeRun)

  const fillFromDraft = useCallback((d: MailDraft) => {
    const parsed = parseDraft(d.body)
    setReplyOpen(true)
    setFill({ ...parsed, ts: Date.now() })
    setApplied(true)
  }, [])

  /* drafts 에 본문 등장 → 제목·본문 자동 채움. 경로 fetch 없음 = 404 무한스피너 원천 차단. */
  useEffect(() => {
    if (applied || !requested || !myDraft || !hasDraftBody) return
    fillFromDraft(myDraft)
  }, [applied, requested, myDraft, hasDraftBody, fillFromDraft])

  const requestDraft = async () => {
    if (!msg) return
    setDraftBusy(true)
    setNote(null)
    try {
      const combo = localStorage.getItem(COMBO_KEY) || 'anthropic-subscription'
      const model = localStorage.getItem(MODEL_KEY) || 'claude-fable-5'
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      const id = `REQ-${ts}`
      const prompt = [
        marker,
        "Write a reply draft to the mail below, in the same language as the mail. Output format: first line 'Subject: ...', one blank line, then the body text only. Do not send anything.",
        '',
        `From: ${msg.from}`,
        `Subject: ${msg.subject}`,
        '',
        msg.body,
      ].join('\n')
      const body = reqFileBody({ id, typeId: 'mail-reply', label: '메일 답장 초안', combo, model, user, prompt })
      await createFile(token, `requests/${id}.md`, body, `request: 메일 답장 초안 (board:${user})`)
      setRequested(true)
      setApplied(false)
      setReplyOpen(true)
    } catch (e) {
      setNote(e instanceof Error ? e.message : '요청 실패')
    } finally {
      setDraftBusy(false)
    }
  }

  /* 수동 '초안 채우기': drafts 의 해당 항목을 동일 파서로 제목+본문에 적용 (경로 fetch 없음) */
  const fillDraft = () => {
    if (!myDraft || !hasDraftBody) return
    setNote(null)
    fillFromDraft(myDraft)
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="mail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={msg ? '메일 전문' : '메일 작성'}
        ref={ref as React.RefObject<HTMLDivElement>}
        tabIndex={-1}
      >
        <header className="mm-head">
          <h2>{msg ? msg.subject || '(제목 없음)' : '새 메일'}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기 (Esc)">
            esc
          </button>
        </header>

        <div className="mm-scroll">
          {msg ? (
            <>
              <dl className="mm-meta">
                <div>
                  <dt>보낸이</dt>
                  <dd>{msg.from}</dd>
                </div>
                <div>
                  <dt>받는이</dt>
                  <dd className="mono">{msg.to ?? msg.account}</dd>
                </div>
                <div>
                  <dt>시각</dt>
                  <dd className="mono">
                    {new Date(msg.at * 1000).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}
                  </dd>
                </div>
                <div>
                  <dt>계정</dt>
                  <dd className="mono">{msg.account}</dd>
                </div>
              </dl>
              {msg.html ? (
                /* text/plain 없던 메일: 새니타이즈드 HTML 원문을 격리 프레임으로 (sandbox="" — 스크립트·폼 차단) */
                <iframe className="mail-frame" sandbox="" srcDoc={mailSrcDoc(msg.html)} title="메일 본문" />
              ) : (
                <div className="mm-body">
                  {cleanMailText(msg.body) || (httpMode ? '불러오는 중…' : '(본문 없음)')}
                </div>
              )}
              {replyOpen && (
                <div className="mm-reply" ref={replyRef}>
                  <h3 className="mm-reply-label mono">답장</h3>
                  <MailComposeForm
                    token={token}
                    user={user}
                    prefill={{
                      account: msg.account,
                      to: fromAddr(msg.from),
                      subject: msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`,
                      ...(msg.message_id ? { in_reply_to: msg.message_id } : {}),
                    }}
                    fill={fill}
                    onQueued={onQueued}
                  />
                </div>
              )}
            </>
          ) : (
            <MailComposeForm token={token} user={user} onQueued={onQueued} />
          )}
        </div>

        {msg && (
          <footer className="mm-foot mono">
            <button type="button" className="text-action" onClick={() => setReplyOpen((v) => !v)}>
              답장
            </button>
            {applied ? (
              <span className="mm-note">초안 적용됨</span>
            ) : waiting ? (
              <span className="mm-note sync-progress">
                <span className="sync-spinner" aria-hidden="true" />
                초안 생성 중 · 최대 수 분
              </span>
            ) : (
              <button type="button" className="text-action" disabled={draftBusy} onClick={() => void requestDraft()}>
                {draftBusy ? '요청 중…' : '에이전트 초안'}
              </button>
            )}
            {hasDraftBody && !applied && (
              <button type="button" className="text-action" onClick={() => fillDraft()}>
                초안 채우기
              </button>
            )}
            {failed && <span className="mm-note err">초안 실패: {failed.error || 'exit 1'}</span>}
            {note && <span className="mm-note err">{note}</span>}
          </footer>
        )}
      </div>
    </>
  )
}

function outboxStatusText(o: OutboxItem): string {
  if (o.status === 'sent') return o.sent_at ? `발송됨 · ${fmtWhen(new Date(o.sent_at).getTime())}` : '발송됨'
  if (o.status === 'failed') return o.error ? `실패: ${o.error}` : '실패'
  return '대기 · 러너 발송'
}

const MAIL_ACCOUNTS: Array<['gmail' | 'naver', string]> = [
  ['gmail', 'GMAIL'],
  ['naver', 'NAVER'],
]

/* 수동 동기 진행 — 러너가 단계별 커밋하는 sync-progress.json 을 4s 간격 직접 fetch */
const SYNC_PROGRESS_PATH = 'data/mail/sync-progress.json'
const SYNC_POLL_MS = 4000
const SYNC_TIMEOUT_MS = 3 * 60 * 1000

interface SyncProgress {
  pct: number
  phase: string
  at: string
}

type SyncState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'polling'; since: number; pct: number; phase: string }
  | { kind: 'done'; at: string }

function MailView({
  token,
  user,
  inboxEntry,
  outboxEntry,
  draftsEntry,
  runner,
  focus,
  onFocusDone,
  onRefreshMail,
  onQueued,
}: {
  token: string
  user: string
  inboxEntry?: Entry<InboxData>
  outboxEntry?: Entry<OutboxData>
  draftsEntry?: Entry<MailDraftsData>
  runner: RunnerState | null
  focus?: { subject: string; ts: number }
  onFocusDone: () => void
  onRefreshMail: () => void
  onQueued: () => void
}) {
  const [modal, setModal] = useState<MailModalState | null>(null)
  const closeModal = useCallback(() => setModal(null), [])
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })
  const [syncErr, setSyncErr] = useState<string | null>(null)

  const inbox = inboxEntry?.data ?? null
  const synced = inbox?.synced_at ?? ''
  const overlayKeys = useMailReadOverlay()
  const overlay = useMemo(() => new Set(overlayKeys), [overlayKeys])

  /* 읽음 처리: localStorage 오버레이 즉시(서버 sync 보다 우선) + 낙관적 캐시 patch + read-queue 커밋(러너가 서버 반영).
     오버레이가 핵심 — 60초 inbox 재검증이 메일 서버 unread=true 로 덮어써도 회색을 유지한다. */
  const markRead = useCallback((m: InboxMessage) => {
    if (!m.unread) return
    markMailRead(m.account, m.id)  // 오버레이 즉시(서버 sync 보다 우선)
    if (httpMode) {
      // 서버 SSOT: DB unread=0 즉시 + read-queue(프로바이더 반영)는 엔드포인트가 처리.
      void mailMarkRead(token, m.account, m.id).catch(() => {})
      return
    }
    if (inboxEntry?.data) {
      patchEntry('inbox', {
        ...inboxEntry.data,
        messages: inboxEntry.data.messages.map((x) =>
          x.account === m.account && x.id === m.id ? { ...x, unread: false } : x),
      }, inboxEntry.sha)
    }
    void queueMailRead(token, m.account, m.id, user).catch(() => {})
  }, [inboxEntry, token, user])

  /* 목록은 경량(body 제외) — httpMode 에선 열 때 단건 본문을 조회해 모달을 갱신. */
  const openMail = useCallback((m: InboxMessage) => {
    setModal({ kind: 'message', msg: m })
    markRead(m)
    if (httpMode && !m.body) {
      void mailGet(token, m.account, m.id)
        .then((full) => setModal((cur) =>
          cur && cur.kind === 'message' && cur.msg.account === m.account && cur.msg.id === m.id
            ? { kind: 'message', msg: full } : cur))
        .catch(() => {})
    }
  }, [markRead, token])

  /* 알림 → 메일 진입: subject 일치 메일을 모달로 (없으면 뷰 전환만). 진입 메일도 동일 오버레이 반영. */
  useEffect(() => {
    if (!focus) return
    const msgs = inbox?.messages ?? []
    const m =
      msgs.find((x) => x.subject === focus.subject) ??
      msgs.find((x) => x.subject && (focus.subject.includes(x.subject) || x.subject.includes(focus.subject)))
    if (m) {
      selectTab(m.account)
      openMail(m)
    }
    onFocusDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  const requestSync = async () => {
    setSync({ kind: 'requesting' })
    setSyncErr(null)
    try {
      const cur = await fetchJsonFile<{ requested_at: string }>(token, 'data/mail/sync-request.json')
      await putJsonFile(
        token,
        'data/mail/sync-request.json',
        { requested_at: new Date().toISOString() },
        cur?.sha ?? null,
        `mail: sync request (board:${user})`,
      )
      setSync({ kind: 'polling', since: Date.now(), pct: 0, phase: '요청됨' })
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : '동기 요청 실패')
      setSync({ kind: 'idle' })
    }
  }

  /* 진행 폴링: 스토어 캐시 우회 직접 fetch. 요청 시각 이후의 at 만 유효 — 이전 동기의 잔존 100% 무시 */
  const pollingSince = sync.kind === 'polling' ? sync.since : null
  useEffect(() => {
    if (pollingSince === null) return
    let live = true
    let inFlight = false
    const tick = async () => {
      if (!live || inFlight) return
      if (Date.now() - pollingSince > SYNC_TIMEOUT_MS) {
        setSyncErr('응답 없음 · 러너 확인')
        setSync({ kind: 'idle' })
        return
      }
      inFlight = true
      try {
        const got = await fetchJsonFile<SyncProgress>(token, SYNC_PROGRESS_PATH)
        if (!live || !got) return
        const p = got.data
        if (new Date(p.at).getTime() < pollingSince) return
        if (p.pct >= 100) {
          onRefreshMail()  // httpMode: 테이블 재취득 / GitHub: blob 재검증
          if (!live) return
          setSync({ kind: 'done', at: hhmm(new Date().toISOString()) })
          return
        }
        setSync({ kind: 'polling', since: pollingSince, pct: Math.max(Math.round(p.pct), 0), phase: p.phase })
      } catch {
        /* 일시 오류는 다음 폴링에서 재시도 */
      } finally {
        inFlight = false
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), SYNC_POLL_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [token, pollingSince])

  /* '동기 완료 HH:MM' 평문 3초 후 새로고침 라벨 복귀 */
  useEffect(() => {
    if (sync.kind !== 'done') return
    const t = window.setTimeout(() => setSync({ kind: 'idle' }), 3000)
    return () => window.clearTimeout(t)
  }, [sync.kind])

  /* 계정별 메시지·미읽음 — 탭 카운트와 목록의 단일 출처. unread 는 오버레이 반영 후. */
  const byAccount = useMemo(() => {
    const msgs = inbox?.messages ?? []
    return MAIL_ACCOUNTS.map(([account]) => {
      const messages = msgs.filter((m) => m.account === account).sort((a, b) => b.at - a.at)
      const unread = messages.filter((m) => m.unread && !overlay.has(mailReadKey(m.account, m.id))).length
      return { account, messages, unread }
    })
  }, [inbox, overlay])

  /* 기본 선택: 미읽음 있는 계정 우선, 없으면 gmail. localStorage 로 마지막 선택 기억. */
  const [accountTab, setAccountTab] = useState<'gmail' | 'naver'>(() => {
    const saved = localStorage.getItem('mailAccountTab')
    return saved === 'naver' ? 'naver' : 'gmail'
  })
  const tabInit = useRef(false)
  useEffect(() => {
    if (tabInit.current || !inbox) return
    tabInit.current = true
    if (localStorage.getItem('mailAccountTab')) return
    const firstUnread = byAccount.find((g) => g.unread > 0)
    if (firstUnread) setAccountTab(firstUnread.account)
  }, [inbox, byAccount])
  const selectTab = useCallback((acc: 'gmail' | 'naver') => {
    setAccountTab(acc)
    localStorage.setItem('mailAccountTab', acc)
  }, [])

  const activeMessages = useMemo(
    () => byAccount.find((g) => g.account === accountTab)?.messages ?? [],
    [byAccount, accountTab],
  )
  const inboxWindow = useInfiniteWindow(activeMessages)

  /* 보낸 메일: 현재 탭 계정만 (account 필터) */
  const sentItems = useMemo(
    () =>
      [...(outboxEntry?.data?.items ?? [])]
        .filter((o) => o.account === accountTab)
        .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
        .slice(0, 5),
    [outboxEntry, accountTab],
  )

  /* inbox 로드 시 오버레이 정리: 서버가 아직 unread=true 인 키만 남기고, unread=false(서버 정합) 키는 제거 — 영구 증식 방지 */
  useEffect(() => {
    if (!inbox) return
    const stillUnread = new Set(inbox.messages.filter((m) => m.unread).map((m) => mailReadKey(m.account, m.id)))
    pruneMailRead(stillUnread)
  }, [inbox])

  return (
    <section className="mailbox" aria-label="메일함">
      <div className="mail-actions mono">
        <button type="button" className="text-action" onClick={() => setModal({ kind: 'compose' })}>
          새 메일
        </button>
        {sync.kind === 'polling' ? (
          <span className="mail-note sync-progress">
            <span className="sync-spinner" aria-hidden="true" />
            {sync.pct}% · {sync.phase}
          </span>
        ) : sync.kind === 'done' ? (
          <span className="mail-note">동기 완료 {sync.at}</span>
        ) : (
          <button
            type="button"
            className="text-action"
            disabled={sync.kind === 'requesting'}
            onClick={() => void requestSync()}
          >
            {sync.kind === 'requesting' ? '요청 중…' : '새로고침'}
          </button>
        )}
        {synced && <span className="mail-note">동기 {hhmm(synced)} 기준</span>}
        {syncErr && <span className="mail-note err">{syncErr}</span>}
      </div>

      {inboxEntry === undefined ? (
        <p className="plain-note">불러오는 중…</p>
      ) : inboxEntry.missing ? (
        <p className="plain-note">메일 동기본 없음 · 러너 확인</p>
      ) : (
        <>
          {/* 계정 탭: 뷰 토글·알림 탭과 같은 mono 텍스트 문법 (윤곽선 금지). 미읽음 수는 0 이면 생략 */}
          <nav className="mail-account-tabs mono" aria-label="계정">
            {byAccount.map((g, i) => (
              <span key={g.account} className="mat-slot">
                {i > 0 && <span className="vt-sep" aria-hidden="true">|</span>}
                <button
                  type="button"
                  className={accountTab === g.account ? 'on' : ''}
                  aria-pressed={accountTab === g.account}
                  onClick={() => selectTab(g.account)}
                >
                  {g.account}
                  {g.unread > 0 && <span className="mat-count"> {g.unread}</span>}
                </button>
              </span>
            ))}
          </nav>

          {activeMessages.length === 0 ? (
            <p className="plain-note">없음</p>
          ) : (
            <div className="mail-list" role="list">
              {inboxWindow.visible.map((m) => {
                const kindLabel = m.kind ? MAIL_KIND_LABEL[m.kind] : undefined
                /* 오버레이가 서버 sync 보다 우선: 한 번 읽으면 unread=true 가 와도 회색 유지 */
                const unread = m.unread && !overlay.has(mailReadKey(m.account, m.id))
                return (
                  <button
                    key={`${m.account}-${m.id}`}
                    type="button"
                    role="listitem"
                    className={`mail-row${unread ? ' unread' : ''}`}
                    onClick={() => openMail(m)}
                  >
                    <span className="mail-main">
                      <span className="mail-top">
                        <span className="mail-from">{fromName(m.from)}</span>
                        <span className="mail-subj">{m.subject || '(제목 없음)'}</span>
                      </span>
                      <span className="mail-snip">{cleanMailLine(m.snippet) || '–'}</span>
                    </span>
                    <span className="mail-right">
                      <span className="mail-time mono">{fmtWhen(m.at * 1000)}</span>
                      {kindLabel && <span className="mail-kind">{kindLabel}</span>}
                    </span>
                  </button>
                )
              })}
              {inboxWindow.hasMore && <div ref={inboxWindow.sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
            </div>
          )}
        </>
      )}

      {sentItems.length > 0 && (
        <>
          <div className="panel-head mail-sent-head">
            <span className="panel-title">보낸 메일</span>
            <span className="panel-rule" aria-hidden="true" />
          </div>
          <div className="panel-rows" role="list">
            {sentItems.map((o) => (
              <div key={o.id} role="listitem" className="panel-row out-row">
                <span className="p-time mono">{fmtWhen(new Date(o.queued_at).getTime())}</span>
                <span className="out-to">{o.to}</span>
                <span className="out-subj">{o.subject}</span>
                <span className={`out-status${o.status === 'failed' ? ' failed' : ''}`}>{outboxStatusText(o)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {modal && (
        <MailModal
          token={token}
          user={user}
          state={modal}
          runner={runner}
          drafts={draftsEntry?.data?.items ?? null}
          onClose={closeModal}
          onQueued={onQueued}
        />
      )}
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════
   에이전트 뷰 — 좌측 세션창(240px) + 우측 본문 (Claude.ai 사이드바 모델).
   세션 = runner-state.json recent_runs + 이 브라우저에서 제출한 대기 REQ.
   새 요청 = 4행 컴포저, 제출 = requests/REQ-*.md PAT 커밋(runner 줄 포함).
   ════════════════════════════════════════════════════════════════ */

const FALLBACK_TYPES: RequestType[] = [
  { id: 'terminal', label: '터미널', needs: 'files', cwd: 'resume' },
  { id: 'research', label: '회사·JD 리서치', needs: 'research', cwd: 'career-data' },
  { id: 'explore', label: '공고 탐색', needs: 'research', cwd: 'career-data' },
  { id: 'coverletter', label: '커버레터', needs: 'files', cwd: 'resume' },
  { id: 'package', label: '지원 패키지', needs: 'files', cwd: 'resume' },
  { id: 'submit', label: '제출 준비', needs: 'files', cwd: 'resume' },
  { id: 'mail-check', label: '메일 확인', needs: 'scan', cwd: 'career-data' },
]

/* fail-closed staleness (평가 보완 ②): 러너 하트비트(5분)의 3배를 넘으면 상태를 신뢰하지 않는다.
   stale이면 모든 콤보를 unknown으로 강등하고 제출을 차단 — 동결된 ready=true로 제출받지 않는다. */
const RUNNER_STALE_MS = 15 * 60 * 1000

export interface PendingReq {
  id: string
  type: string
  combo: string
  model: string
  prompt: string
  at: string
  /* 이어가는 thread (없으면 자기 id 가 곧 thread = 새 세션) */
  thread?: string
}

/* 한 turn = run 또는 대기 REQ. run 이 있으면 run, 없으면 req (제출 직후 러너 흡수 전) */
type AgentTurn = { id: string; ms: number; run?: RunnerRun; req?: PendingReq }
/* 한 세션 = 같은 thread 의 turn 들을 시간순 누적 (Claude Code 멀티턴 핑퐁) */
type AgentSession = { thread: string; ms: number; title: string; latestStatus?: RunnerRun['status']; turns: AgentTurn[] }

/* turn 의 thread 키: run.thread → run.id, req.thread → req.id 순 (러너가 thread 미게시 시 run id 가 thread) */
function turnThread(t: AgentTurn): string {
  return t.run?.thread ?? t.run?.id ?? t.req?.thread ?? t.req?.id ?? ''
}

/* 외부 취소 표면: REQ 파일을 cancel-requested로 전이 — 러너가 60초 내 집행 중단 */
function CancelRunAction({ token, runId }: { token: string; runId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'err'>('idle')
  if (state === 'sent') return <span>중단 요청됨 · 러너 주기 60초</span>
  if (state === 'err') return <span>중단 요청 실패</span>
  return (
    <button
      type="button"
      className="text-action"
      disabled={state === 'busy'}
      onClick={() => {
        setState('busy')
        updateTextFile(
          token,
          `requests/${runId.replace('RUN-', 'REQ-')}.md`,
          (t) => t.replace('status: processing', 'status: cancel-requested').replace('status: pending', 'status: cancel-requested'),
          `request: 중단 요청 ${runId}`,
        )
          .then(() => setState('sent'))
          .catch(() => setState('err'))
      }}
    >
      중단
    </button>
  )
}

function runStatusText(r: RunnerRun): string {
  if (r.status === 'queued') return '대기'
  if (r.status === 'running') return '실행 중'
  if (r.status === 'failed') return '실패'
  if (r.status === 'cancelled') return '중단됨'
  return '완료'
}

function typeLabelOf(types: RequestType[], id: string): string {
  return types.find((t) => t.id === id)?.label ?? id
}

/* 세션 제목용 프롬프트 요약: 마커·REQ 헤더 잔재를 걷어내고 첫 의미 줄만 (제목은 CSS가 1줄 말줄임) */
function sessTitleText(prompt: string): string {
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('[mail-reply:') && !l.startsWith('#') && !l.startsWith('- ') && !l.startsWith('##'))
  return (line ?? prompt).slice(0, 80)
}

/* 완료 run 산출물: reports/runs/*.md PAT fetch → 트랜스크립트 마지막에 마크다운 렌더 */
function RunOutput({ token, run }: { token: string; run: RunnerRun }) {
  const [output, setOutput] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setOutput(null)
    setErr(null)
    if (!run.output) return
    fetchTextFile(token, run.output)
      .then(setOutput)
      .catch((e) => setErr(e instanceof Error ? e.message : '산출물 로드 실패'))
  }, [token, run.id, run.output])

  if (!run.output) return <p className="plain-note">산출물 경로 없음</p>
  if (err) return <p className="plain-note err">{err}</p>
  if (output === null) return <p className="plain-note">불러오는 중…</p>
  return (
    <div className="cc-result">
      <Md text={output} />
    </div>
  )
}

/* 풀 트랜스크립트: 완료·실패 run 은 reports/runs/*.events.jsonl 아카이브를 PAT fetch.
   파일이 없거나(실패 run 은 output 경로가 없다) 실행 중이면 events_tail(최대 30건) 폴백 */
function useRunEvents(token: string, run: RunnerRun | undefined): RunEvent[] {
  const [full, setFull] = useState<{ id: string; events: RunEvent[] } | null>(null)
  const archive = run && run.status !== 'running' && run.output ? run.output.replace(/\.md$/, '.events.jsonl') : null
  const runId = run?.id
  useEffect(() => {
    if (!runId || !archive) return
    let live = true
    fetchTextFile(token, archive)
      .then((txt) => {
        if (!live) return
        const events = txt
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as RunEvent)
        setFull({ id: runId, events })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [token, runId, archive])
  if (run && full?.id === run.id) return full.events
  return run?.events_tail ?? []
}

/* 한 turn 렌더 — Claude Code 문법: 헤더 라인(첫 turn만) → ❯ 프롬프트 에코 → ⏺ 이벤트 스트림 → 결과.
   세션은 같은 thread 의 turn 들을 시간순으로 이 컴포넌트를 반복 렌더해 ❯p1→resp1→❯p2→resp2 를 한 화면에 쌓는다. */
/* 추론 상태줄 — Claude Code 인디케이터의 mango.career 번안.
   캐릭터 = 단일 앰버 시그널(✶) 프레임 회전 + 옅은 맥동. 정적 '실행 중' 대신 살아 움직이는 상태:
   위트 있는 진행어(약 4초 주기 회전) + 라이브 경과시간 + 모델 메타. */
const THINK_GLYPHS = ['✶', '✸', '✹', '✺', '✷', '✦']
const THINK_WORDS = ['여물리는', '톺아보는', '갈무리하는', '벼리는', '곱씹는', '추리는', '헤아리는', '짚어보는', '여투는', '벼려내는']

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function ThinkingStatus({ run }: { run: RunnerRun }) {
  const startMs = useMemo(() => (run.started ? new Date(run.started).getTime() : Date.now()), [run.started])
  const seed = useMemo(() => Math.floor(Math.random() * THINK_WORDS.length), [run.id])
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const g = setInterval(() => setTick((t) => t + 1), 130) // 글리프 트윙클
    const c = setInterval(() => setNow(Date.now()), 1000) // 경과시간
    return () => {
      clearInterval(g)
      clearInterval(c)
    }
  }, [])
  const glyph = THINK_GLYPHS[tick % THINK_GLYPHS.length]
  const word = THINK_WORDS[(seed + Math.floor((now - startMs) / 4000)) % THINK_WORDS.length]
  return (
    <span className="cc-thinking mono" role="status" aria-label="추론 중">
      <span className="cc-thinking-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="cc-thinking-word">{word} 중…</span>
      <span className="cc-thinking-meta">
        ({fmtElapsed(now - startMs)}
        {run.model ? ` · ${run.model}` : ''})
      </span>
    </span>
  )
}

function TurnDetail({ token, turn, types, showHead }: { token: string; turn: AgentTurn; types: RequestType[]; showHead: boolean }) {
  const run = turn.run
  const req = turn.req
  const events = useRunEvents(token, run)
  const startEv = events.find((e) => e.type === 'start')
  const stream = events.filter((e) => e.type !== 'start')
  const head =
    startEv?.text ??
    `${run?.combo ?? req?.combo ?? '–'}/${run?.model ?? req?.model ?? '–'} · ${typeLabelOf(types, run?.type ?? req?.type ?? '')}`

  return (
    <div className="agent-turn">
      {showHead && <p className="cc-head mono">{head}</p>}
      <div className="cc-prompt mono">
        <span className="cc-caret" aria-hidden="true">❯</span>
        <span className="cc-prompt-text">{sessTitleText(run?.prompt ?? req?.prompt ?? '')}</span>
      </div>
      {stream.map((ev, i) => {
        if (ev.type === 'tool')
          return (
            <p key={i} className="cc-tool mono">
              ⏺ {ev.text}
            </p>
          )
        if (ev.type === 'done')
          return (
            <p key={i} className="cc-done mono">
              ⏺ {ev.text} · {ev.at}
            </p>
          )
        if (ev.type === 'error')
          return (
            <p key={i} className="cc-error">
              {ev.text}
            </p>
          )
        return (
          <div key={i} className="cc-text">
            <Md text={ev.text} />
          </div>
        )
      })}
      {req && <p className="plain-note">대기 중 · 러너 주기 60초</p>}
      {run?.status === 'queued' && (
        <p className="plain-note">
          대기열 · <CancelRunAction token={token} runId={run.id} />
        </p>
      )}
      {run?.status === 'running' && (
        <p className="plain-note cc-thinking-row">
          <ThinkingStatus run={run} />
          {' · '}
          <CancelRunAction token={token} runId={run.id} />
        </p>
      )}
      {run?.status === 'cancelled' && <p className="plain-note">중단됨</p>}
      {run?.status === 'failed' && <p className="cc-error">{run.error || '실패 사유 없음'}</p>}
      {run?.status === 'done' && <RunOutput token={token} run={run} />}
    </div>
  )
}

/* 세션 누적 트랜스크립트 — 한 thread 의 모든 turn 을 시간순 렌더 (멀티턴 핑퐁) */
function SessionDetail({ token, session, types }: { token: string; session: AgentSession; types: RequestType[] }) {
  return (
    <div className="agent-detail">
      {session.turns.map((t, i) => (
        <TurnDetail key={t.id} token={token} turn={t} types={types} showHead={i === 0} />
      ))}
    </div>
  )
}

/* ── 컴포저 설정 칩: Cursor 식 텍스트 칩 + 팝오버 메뉴 (StatusMenu 문법 재사용).
   보더·배경 없는 mono 텍스트 + ⌄, 선택은 텍스트 톤 600으로만 구분.
   not-ready 항목은 disabled 톤 + 아래 "{reason} · {action}" 한 줄. ── */
interface ChipOption {
  id: string
  label: string
  disabled?: boolean
  sub?: string
}

function ConfigChip({
  ariaLabel,
  text,
  options,
  value,
  disabled,
  onPick,
}: {
  ariaLabel: string
  text: string
  options: ChipOption[]
  value: string
  disabled?: boolean
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  /* 열릴 때 위치 판정(하단 근접 시 위로 플립, StatusMenu 패턴) + 선택 항목 포커스 */
  useLayoutEffect(() => {
    if (!open) return
    const wrap = wrapRef.current
    const menu = menuRef.current
    if (wrap && menu) {
      const r = wrap.getBoundingClientRect()
      setUp(window.innerHeight - r.bottom < menu.offsetHeight + 12)
    }
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const sel = items.find((b) => b.dataset.id === value)
    ;(sel ?? items[0])?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) =>
      wrapRef.current && !wrapRef.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next]?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="chip-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className={`cfg-chip mono${open ? ' open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {text}
        <span className="chev" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className={`chip-menu${up ? ' up' : ''}`} ref={menuRef} role="menu" aria-label={ariaLabel}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={o.id === value}
              aria-disabled={o.disabled || undefined}
              data-id={o.id}
              className={`${o.id === value ? 'cur' : ''}${o.disabled ? ' off' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (o.disabled) return
                onPick(o.id)
                setOpen(false)
                btnRef.current?.focus()
              }}
            >
              <span className="chip-opt">{o.label}</span>
              {o.sub && <span className="chip-sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentComposer({
  token,
  user,
  state,
  types,
  stale,
  thread,
  resumeSession,
  lockType,
  lockCombo,
  lockModel,
  onSubmitted,
}: {
  token: string
  user: string
  state: RunnerState | null
  types: RequestType[]
  stale?: boolean
  thread?: string // 이어갈 세션 키 (없으면 새 세션 = 새 REQ id 가 thread)
  resumeSession?: string // 선택 세션 직전 done turn 의 Claude session_id — 같은 맥락에서 이어감 (resume)
  lockType?: string // thread 이어가기 시 직전 turn 의 유형
  lockCombo?: string // thread 이어가기 시 직전 turn 의 콤보 (프로바이더 일관성)
  lockModel?: string // thread 이어가기 시 직전 turn 의 모델
  onSubmitted: (p: PendingReq) => void
}) {
  const locked = thread !== undefined
  const combos = useMemo(() => state?.combos ?? [], [state])
  /* 기본 유형 = terminal (CC 프롬프트 관성) — 러너 목록에 없으면 첫 유형 */
  const defaultType = (list: RequestType[]) => list.find((t) => t.id === 'terminal')?.id ?? list[0]?.id ?? ''
  const [typeId, setTypeId] = useState(() => defaultType(types))
  useEffect(() => {
    if (!types.some((t) => t.id === typeId)) setTypeId(defaultType(types))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types])

  const needs = types.find((t) => t.id === typeId)?.needs
  /* needs=files 면 파일 능력 콤보만 노출 (능력 경계 — 정직 표면) */
  const eligible = useMemo(
    () => combos.filter((c) => needs !== 'files' || c.capabilities.includes('files')),
    [combos, needs],
  )
  const [comboId, setComboId] = useState('')
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  /* thread 이어가기 = 직전 turn 의 유형·콤보·모델 고정 (프로바이더 일관성). 새 세션이면 자유 선택. */
  const effType = locked ? (lockType ?? typeId) : typeId
  const effComboId = locked ? (lockCombo ?? comboId) : comboId
  const effModelId = locked ? (lockModel ?? modelId) : modelId
  /* 고정 콤보는 needs 필터를 우회해 전체 combos 에서 조회 — 이어가기는 능력 경계를 다시 적용하지 않는다 */
  const combo = (locked ? combos : eligible).find((c) => c.id === effComboId)

  /* 적격 콤보 변동 시: localStorage 선호 콤보 → 첫 ready 콤보 순 (새 세션 전용) */
  useEffect(() => {
    if (locked) return
    if (!eligible.some((c) => c.id === comboId && c.ready)) {
      const stored = localStorage.getItem(COMBO_KEY)
      const pick =
        (stored && eligible.find((c) => c.id === stored && c.ready)) || eligible.find((c) => c.ready)
      setComboId(pick?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, locked])

  /* 콤보 변경 시: localStorage 선호 모델 → 기본 모델 순 (새 세션 전용) */
  useEffect(() => {
    if (locked) return
    const c = eligible.find((x) => x.id === comboId)
    const stored = localStorage.getItem(MODEL_KEY)
    const m =
      (stored && c?.models.find((x) => x.id === stored)) ||
      c?.models.find((x) => x.default) ||
      c?.models[0]
    setModelId(m?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comboId, locked])

  /* 선택한 콤보·모델 영속 — 메일 '에이전트 초안'이 참조 (새 세션 선택만; 고정 이어가기는 선호를 덮지 않음) */
  useEffect(() => {
    if (!locked && comboId) localStorage.setItem(COMBO_KEY, comboId)
  }, [comboId, locked])
  useEffect(() => {
    if (!locked && modelId) localStorage.setItem(MODEL_KEY, modelId)
  }, [modelId, locked])

  const submit = async () => {
    if (!prompt.trim() || !combo || !combo.ready) return
    setBusy(true)
    setNote(null)
    try {
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      const id = `REQ-${ts}`
      /* 새 세션 = 자기 id 가 thread. 이어가기 = 선택 thread 유지. */
      const reqThread = thread ?? id
      const label = typeLabelOf(types, effType)
      const body = reqFileBody({
        id, typeId: effType, label, combo: combo.id, model: effModelId, user,
        prompt: prompt.trim(), resume: resumeSession, thread: reqThread,
      })
      await createFile(token, `requests/${id}.md`, body, `request: ${label} (board:${user})`)
      const pendingReq: PendingReq = {
        id,
        type: effType,
        combo: combo.id,
        model: effModelId,
        prompt: prompt.trim(),
        at: new Date().toISOString(),
        thread: reqThread,
      }
      setPrompt('')
      onSubmitted(pendingReq)
    } catch (e) {
      setNote(e instanceof Error ? e.message : '요청 실패')
    } finally {
      setBusy(false)
    }
  }

  /* CC 입력부 문법: 컨피그 라인(유형·콤보·모델 inline select) 위, ❯ 텍스트영역 아래. 본문 하단 고정 */
  /* fail-closed: 러너 상태가 오래되면 ready 표시를 신뢰하지 않고 제출을 막는다 */
  if (stale)
    return (
      <div className="cc-composer">
        <p className="plain-note">러너 상태가 오래됨 (하트비트 15분 초과) · 인증 상태 불명 — 제출 차단. Mac에서 launchd 확인.</p>
      </div>
    )

  return (
    <form
      className="cc-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {note && <p className="plain-note err">{note}</p>}
      <div className="cc-box">
        <div className="cc-input">
          <span className="cc-caret" aria-hidden="true">❯</span>
          <textarea
            name="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              /* Enter 제출 + Cmd/Ctrl+Enter 병행, Shift+Enter 줄바꿈. 한글 IME 조합 중엔 보류 */
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              void submit()
            }}
            rows={3}
            placeholder={locked ? "이어서 입력…" : "새 요청…"}
            aria-label="프롬프트"
          />
        </div>
        {/* 하단 칩 행: 유형·경로·모델 텍스트 칩(Cursor 컴포저 문법) 좌측, 전송 글리프 우측.
            제출은 Enter — 별도 '실행' 텍스트 라벨 없음. 입력이 있을 때만 ↑ 글리프 노출.
            thread 이어가기 시엔 직전 turn 의 설정으로 고정 — 칩 비활성. */}
        <div className="cc-chips">
          <ConfigChip
            ariaLabel="유형"
            text={typeLabelOf(types, effType)}
            value={effType}
            disabled={locked}
            options={types.map((t) => ({ id: t.id, label: t.label }))}
            onPick={setTypeId}
          />
          <ConfigChip
            ariaLabel="실행 경로"
            text={combo?.label ?? (eligible.length === 0 ? '경로 없음' : '경로 선택')}
            value={effComboId}
            disabled={locked || eligible.length === 0}
            options={eligible.map((c) => ({
              id: c.id,
              label: c.label,
              disabled: !c.ready,
              sub: c.ready ? undefined : `${c.reason ?? '사용 불가'}${c.action ? ` · ${c.action}` : ''}`,
            }))}
            onPick={setComboId}
          />
          <ConfigChip
            ariaLabel="모델"
            text={combo?.models.find((m) => m.id === effModelId)?.label ?? '–'}
            value={effModelId}
            disabled={locked || !combo}
            options={(combo?.models ?? []).map((m) => ({ id: m.id, label: m.label }))}
            onPick={setModelId}
          />
          {prompt.trim() && (
            <button
              type="submit"
              className="cc-send"
              disabled={busy || !combo}
              aria-label="전송 (Enter)"
              title="전송 (Enter)"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

/* ── SDK 크레딧: 러너가 게시한 월간 사용액 — mono 평문 한 줄.
   80% 도달 시 텍스트 톤만 앰버(보더·배지 금지). note 는 title 로만. ── */
function SdkCreditLine({ credit }: { credit: SdkCredit }) {
  const { month, spent_usd, limit_usd, note } = credit
  const warn = limit_usd !== null && limit_usd > 0 && spent_usd >= limit_usd * 0.8
  const text =
    limit_usd !== null && limit_usd > 0
      ? `SDK 크레딧 ${month} · $${spent_usd.toFixed(2)} / $${limit_usd} (${Math.round((spent_usd / limit_usd) * 100)}%)`
      : `SDK 크레딧 ${month} · $${spent_usd.toFixed(2)} 사용`
  return (
    <p className={`sdk-credit mono${warn ? ' warn' : ''}`} title={note || undefined}>
      {text}
    </p>
  )
}

function AgentView({
  token,
  user,
  runnerEntry,
  pending,
  onPendingAdd,
  focus,
  onFocusDone,
}: {
  token: string
  user: string
  runnerEntry?: Entry<RunnerState>
  pending: PendingReq[]
  onPendingAdd: (p: PendingReq) => void
  focus?: { runId: string; ts: number }
  onFocusDone: () => void
}) {
  const state = runnerEntry?.data ?? null
  const types = state?.request_types?.length ? state.request_types : FALLBACK_TYPES
  const runs = useMemo(() => state?.recent_runs ?? [], [state])

  /* 세션 = thread 그룹. turn(run·대기 REQ)을 thread 별로 묶어 시간순 누적. */
  const sessions = useMemo<AgentSession[]>(() => {
    /* 러너가 집행을 시작하면 해당 REQ 의 대기 항목은 run 으로 흡수 (run id = REQ id 의 RUN 치환) */
    const visiblePending = pending.filter((p) => !runs.some((r) => r.id === runIdOf(p.id)))
    const turns: AgentTurn[] = [
      ...visiblePending.map((p) => ({ id: p.id, ms: new Date(p.at).getTime(), req: p })),
      ...runs.map((r) => ({ id: r.id, ms: runStartMs(r), run: r })),
    ]
    const byThread = new Map<string, AgentTurn[]>()
    for (const t of turns) {
      const key = turnThread(t)
      const arr = byThread.get(key) ?? []
      arr.push(t)
      byThread.set(key, arr)
    }
    const list: AgentSession[] = []
    for (const [thread, arr] of byThread) {
      arr.sort((a, b) => a.ms - b.ms) // turn 시간 오름차순 (트랜스크립트 누적 순서)
      const first = arr[0]
      const latest = arr[arr.length - 1]
      list.push({
        thread,
        ms: latest.ms,
        title: `${typeLabelOf(types, first.run?.type ?? first.req?.type ?? '')} · ${sessTitleText(first.run?.prompt ?? first.req?.prompt ?? '')}`,
        latestStatus: latest.run?.status,
        turns: arr,
      })
    }
    return list.sort((a, b) => b.ms - a.ms) // 세션은 최근 turn 기준 내림차순
  }, [pending, runs, types])

  const [selRaw, setSel] = useState<string | null>(null)
  const sel = selRaw ?? sessions[0]?.thread ?? 'new'
  const selected = sessions.find((s) => s.thread === sel)
  const railWindow = useInfiniteWindow(sessions)

  /* 알림 → run 세션 선택: runId 가 속한 thread 로 (없으면 runId 자체가 thread) */
  useEffect(() => {
    if (!focus) return
    const run = runs.find((r) => r.id === focus.runId)
    setSel(run?.thread ?? focus.runId)
    onFocusDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  /* 선택 세션의 직전 done turn — 후속 입력의 resume 토큰·고정 콤보 출처 (프로바이더 무관) */
  const lastDone = useMemo(() => {
    const ts = selected?.turns ?? []
    for (let i = ts.length - 1; i >= 0; i--) if (ts[i].run?.status === 'done') return ts[i].run
    return undefined
  }, [selected])
  const lastTurn = selected?.turns[selected.turns.length - 1]
  const lastTurnRun = lastTurn?.run
  const lastTurnReq = lastTurn?.req

  const aliveAt = state?.runner_alive_at ? new Date(state.runner_alive_at).getTime() : null
  const runnerStale = aliveAt !== null && Date.now() - aliveAt > RUNNER_STALE_MS

  /* 세션창 키보드 ↑↓ 순회 (CMUX 세션 이동) — 선택과 포커스가 같이 움직인다 */
  const railRef = useRef<HTMLElement>(null)
  const onRailKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    /* 순회는 DOM 에 렌더된 세션(윈도 visible)만 대상 — 버튼 인덱스와 일치 유지 */
    const order = ['new', ...railWindow.visible.map((s) => s.thread)]
    const i = Math.max(order.indexOf(sel), 0)
    const ni = Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), order.length - 1)
    setSel(order[ni])
    railRef.current?.querySelectorAll('button')[ni]?.focus()
  }

  /* 세션 도트 = 최근 turn 상태: 실행 중=앰버, 실패=red, 그 외=음소거 */
  const sessDot = (s: AgentSession): string => {
    if (s.latestStatus === 'running') return 'var(--amber)'
    if (s.latestStatus === 'failed') return 'var(--danger)'
    return 'var(--text-3)'
  }

  return (
    <section className="agent" aria-label="에이전트">
      <nav className="agent-rail" aria-label="세션" ref={railRef} onKeyDown={onRailKey}>
        <button type="button" className={`sess-new mono${sel === 'new' ? ' sel' : ''}`} onClick={() => setSel('new')}>
          + 새 요청
        </button>
        {railWindow.visible.map((s) => {
          const latest = s.turns[s.turns.length - 1]
          const statusText = latest.run ? runStatusText(latest.run) : '대기'
          const turnCount = s.turns.length
          return (
            <button
              key={s.thread}
              type="button"
              className={`sess-row${sel === s.thread ? ' sel' : ''}`}
              onClick={() => setSel(s.thread)}
            >
              <span className="sess-line">
                <span className="dot sess-dot" style={{ background: sessDot(s) }} aria-hidden="true" />
                <span className="sess-title">{s.title}</span>
              </span>
              <span className="sess-sub mono">
                {fmtWhen(s.ms)} · {statusText}
                {turnCount > 1 && ` · ${turnCount}턴`}
              </span>
            </button>
          )
        })}
        {railWindow.hasMore && <div ref={railWindow.sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
        {sessions.length === 0 && runnerEntry !== undefined && <p className="plain-note sess-empty">없음</p>}
      </nav>

      <div className="agent-body">
        {runnerEntry === undefined && <p className="plain-note">불러오는 중…</p>}
        {runnerEntry !== undefined && !state && <p className="plain-note">러너 상태 없음 · Mac에서 launchd 확인</p>}
        {runnerStale && state && (
          <p className="plain-note">러너 마지막 응답 {fmtHistoryAt(state.runner_alive_at)} · Mac에서 launchd 확인</p>
        )}
        {state?.sdk_credit && <SdkCreditLine credit={state.sdk_credit} />}
        {sel !== 'new' && selected && <SessionDetail token={token} session={selected} types={types} />}
        {/* 터미널 REPL: 세션을 보는 중에도 입력부는 본문 하단 상시.
            새 세션이면 자유 컴포저, thread 선택 중이면 직전 turn 의 콤보·모델로 고정해 이어감(resume). */}
        <AgentComposer
          token={token}
          user={user}
          state={state}
          types={types}
          stale={runnerStale}
          thread={sel !== 'new' && selected ? selected.thread : undefined}
          resumeSession={lastDone?.session_id}
          lockType={lastTurnRun?.type ?? lastTurnReq?.type}
          lockCombo={lastTurnRun?.combo ?? lastTurnReq?.combo ?? undefined}
          lockModel={lastTurnRun?.model ?? lastTurnReq?.model}
          onSubmitted={(p) => {
            onPendingAdd(p)
            /* 새 turn 이 누적되도록 그 thread 선택 유지 (새 세션이면 새 thread = p.thread) */
            setSel(p.thread ?? p.id)
          }}
        />
      </div>
    </section>
  )
}

/* 설정(기어) — 에이전트·메일분류 백엔드 선택. 외부 SaaS 패턴(JetBrains/Kilo: 기어→프로바이더/모델).
   토글 + 프로바이더 + 인증{구독|API} + 모델 → data/agent-config.json. 구독은 OpenAI만(디렉티브).
   런너는 cp_get으로 이 설정을 읽는다(#21 브리지). combos는 runner-state에서. */
type AgentConfig = { enabled: boolean; combo: string; model: string }

function SettingsModal({ token, combos, onClose }: {
  token: string
  combos: RunnerCombo[]
  onClose: () => void
}) {
  const [enabled, setEnabled] = useState(true)
  const [provider, setProvider] = useState('openai')
  const [auth, setAuth] = useState('subscription')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // 구독은 OpenAI만(디렉티브) — anthropic-subscription 숨김
  const shown = useMemo(
    () => combos.filter((c) => !(c.provider === 'anthropic' && c.auth === 'subscription')),
    [combos],
  )
  const providers = useMemo(() => [...new Set(shown.map((c) => c.provider))], [shown])
  const authsFor = (p: string) => [...new Set(shown.filter((c) => c.provider === p).map((c) => c.auth))]
  const comboFor = (p: string, a: string) => shown.find((c) => c.provider === p && c.auth === a)
  const current = comboFor(provider, auth)

  useEffect(() => {
    void fetchJsonFile<AgentConfig>(token, 'data/agent-config.json').then((r) => {
      const c = r?.data
      if (c?.combo) {
        const i = c.combo.indexOf('-')
        if (i > 0) { setProvider(c.combo.slice(0, i)); setAuth(c.combo.slice(i + 1)) }
        setEnabled(c.enabled !== false)
        if (c.model) setModel(c.model)
      }
    }).catch(() => {})
  }, [token])

  useEffect(() => {
    const c = comboFor(provider, auth)
    if (c && !c.models.some((m) => m.id === model)) {
      setModel(c.models.find((m) => m.default)?.id ?? c.models[0]?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, auth, combos])

  const save = async () => {
    const c = comboFor(provider, auth)
    if (!c) { setNote('사용할 수 없는 조합'); return }
    setBusy(true); setNote(null)
    try {
      const cur = await fetchJsonFile<AgentConfig>(token, 'data/agent-config.json').catch(() => null)
      await putJsonFile(token, 'data/agent-config.json',
        { enabled, combo: `${provider}-${auth}`, model }, cur?.sha ?? null, 'settings: agent config')
      setNote('저장됨'); window.setTimeout(onClose, 600)
    } catch (e) {
      setNote(e instanceof Error ? e.message : '저장 실패')
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="설정">
        <header className="mm-head">
          <span className="mm-subject">설정 · 에이전트</span>
          <button type="button" className="mm-close" onClick={onClose} aria-label="닫기">✕</button>
        </header>
        <div className="settings-body">
          <label className="set-toggle">
            <span>메일 분류 · 에이전트 켜기</span>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          </label>
          <div className="set-field">
            <span className="set-label mono">프로바이더</span>
            <div className="set-opts mono">
              {providers.map((p) => (
                <button key={p} type="button" className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>{p}</button>
              ))}
            </div>
          </div>
          <div className="set-field">
            <span className="set-label mono">인증</span>
            <div className="set-opts mono">
              {authsFor(provider).map((a) => (
                <button key={a} type="button" className={auth === a ? 'on' : ''} onClick={() => setAuth(a)}>
                  {a === 'subscription' ? '구독' : 'API'}
                </button>
              ))}
            </div>
          </div>
          <div className="set-field">
            <span className="set-label mono">모델</span>
            <select className="set-select mono" value={model} onChange={(e) => setModel(e.target.value)}>
              {(current?.models ?? []).map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
            </select>
          </div>
          <p className="set-status mono">
            {current ? (current.ready ? '✓ 준비됨' : `· ${current.reason ?? '자격증명 미등록'}`) : '· 사용 불가 조합'}
          </p>
        </div>
        <footer className="settings-foot">
          {note && <span className="set-note mono">{note}</span>}
          <button type="button" className="text-action" disabled={busy || !current} onClick={() => void save()}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </footer>
      </div>
    </>
  )
}

/* ════════════════════════════════════════════════════════════════ */

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  /* 부팅 스피너: 저장 토큰 또는 OAuth 콜백(#code) 복귀면 인증 시도 중 → 로그인 화면 깜빡임 방지 */
  const [booting, setBooting] = useState<boolean>(() => {
    const hasCode = httpMode && /[#&]code=/.test(window.location.hash)
    return !!(localStorage.getItem(TOKEN_KEY) || hasCode)
  })
  const [user, setUser] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set())
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuUp, setMenuUp] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const [view, setViewState] = useState<View>(() => viewFromPath())
  const setView = useCallback((v: View) => {
    setViewState(v)
    if (window.location.pathname !== pathForView(v)) {
      window.history.pushState({ view: v }, '', pathForView(v))
    }
  }, [])
  const [mailFocus, setMailFocus] = useState<{ subject: string; ts: number } | undefined>(undefined)
  const [agentFocus, setAgentFocus] = useState<{ runId: string; ts: number } | undefined>(undefined)
  const [pendingReqs, setPendingReqs] = useState<PendingReq[]>([])

  const boardEntry = useEntry<BoardData>('applications')
  const notifEntry = useEntry<NotifFile>('notifications')
  const blobInbox = useEntry<InboxData>('inbox')
  const [mailNonce, setMailNonce] = useState(0)
  const serverInbox = useServerInbox(token, mailNonce)  // httpMode: mail_messages 커서 피드
  const inboxEntry = httpMode ? serverInbox : blobInbox
  const refreshMail = useCallback(() => {
    if (httpMode) setMailNonce((n) => n + 1)            // 테이블 재취득
    else if (token) void revalidate(token, 'inbox').catch(() => {})
  }, [token])
  const outboxEntry = useEntry<OutboxData>('outbox')
  const draftsEntry = useEntry<MailDraftsData>('mail-drafts')
  const runnerEntry = useEntry<RunnerState>('runner-state')
  const [settingsOpen, setSettingsOpen] = useState(false)

  const board = boardEntry?.data ?? null
  const sha = boardEntry?.sha ?? ''
  const notifItems = useMemo(() => notifEntry?.data?.items ?? [], [notifEntry])

  const toastTimer = useRef<number | undefined>(undefined)
  const searchRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((t: Toast) => {
    window.clearTimeout(toastTimer.current)
    setToast(t)
    if (t) toastTimer.current = window.setTimeout(() => setToast(null), t.kind === 'err' ? 8000 : 4000)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /* 인증: whoami + 5개 데이터원 병렬 prefetch (캐시가 있으면 그동안에도 렌더) */
  const login = useCallback(async (tok: string) => {
    setLoading(true)
    try {
      const lg = await whoami(tok)
      await prefetchAll(tok)
      setUser(lg)
      setGateError(null)
      localStorage.setItem(TOKEN_KEY, tok)
      setToken(tok)
    } catch (e) {
      setGateError(e instanceof Error ? e.message : String(e))
      localStorage.removeItem(TOKEN_KEY)
      clearStore()
      setToken(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        let tok = token
        if (httpMode) {
          const fromCode = await exchangeCodeFromUrl() // OAuth 콜백 복귀 #code → 세션 토큰
          if (fromCode) tok = fromCode
        }
        if (tok) await login(tok) // 완료까지 booting 유지 → 로그인 화면 깜빡임 없음
      } finally {
        setBooting(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 브라우저 뒤로/앞으로 → 경로에서 뷰 복원 (URL ↔ view 동기) */
  useEffect(() => {
    const onPop = () => setViewState(viewFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /* 백그라운드 재검증: 활성 뷰 관련 파일만 60s, ETag 조건부 (304 면 자리 유지) */
  const hasBoard = board !== null
  useEffect(() => {
    if (!token || !hasBoard) return
    const VIEW_KEYS: Record<View, StoreKey[]> = {
      board: ['applications', 'notifications'],
      mail: ['inbox', 'outbox', 'mail-drafts', 'notifications', 'runner-state'],
      agent: ['runner-state', 'notifications'],
      notif: ['notifications'],
    }
    const t = window.setInterval(() => {
      for (const k of VIEW_KEYS[view]) void revalidate(token, k).catch(() => {})
    }, 60000)
    return () => window.clearInterval(t)
  }, [token, hasBoard, view])

  const readNotifs = useCallback(
    async (ids: 'all' | string[]) => {
      if (!token) return
      await markNotificationsRead(token, ids, user || 'unknown')
      await revalidate(token, 'notifications').catch(() => {})
    },
    [token, user],
  )

  const apps = useMemo(() => board?.applications ?? [], [board])

  /* 알림 행 클릭 = 읽음 + 대상 객체로 이동: 낙관적 handled 패치 후 비동기 커밋 */
  const readOnNavigate = useCallback(
    (n: Notification) => {
      if (n.handled || !token) return
      const cur = notifEntry
      if (cur?.data) {
        patchEntry<NotifFile>(
          'notifications',
          { ...cur.data, items: cur.data.items.map((i) => (i.id === n.id ? { ...i, handled: true } : i)) },
          cur.sha,
        )
      }
      markNotificationsRead(token, [n.id], user || 'unknown')
        .then(() => revalidate(token, 'notifications').catch(() => {}))
        .catch(() => void revalidate(token, 'notifications').catch(() => {}))
    },
    [token, user, notifEntry],
  )

  /* 알림 행 = 대상 객체의 입구 (Linear 원칙) */
  const navigateFromNotif = useCallback(
    (n: Notification) => {
      readOnNavigate(n)
      if (n.kind?.startsWith('run') && n.runId) {
        setView('agent')
        setAgentFocus({ runId: n.runId, ts: Date.now() })
        return
      }
      if (n.source === 'gmail' || n.source === 'naver' || n.source === 'mail') {
        setView('mail')
        setMailFocus({ subject: n.subject, ts: Date.now() })
        return
      }
      if (n.appId && apps.some((a) => a.id === n.appId)) {
        setView('board')
        setOpenId(n.appId)
        return
      }
      if (n.statusChange || n.appId) setView('board')
    },
    [apps, readOnNavigate],
  )

  const changeStatus = useCallback(
    async (app: Application, next: Status) => {
      if (!board || !token || next === app.status) {
        setMenuFor(null)
        return
      }
      const prev = board
      const prevSha = sha
      const stamped = next === 'submitted' && !app.submitted ? todayLocal() : app.submitted
      const updated: BoardData = {
        ...board,
        updated: todayLocal(),
        applications: board.applications.map((a) =>
          a.id === app.id
            ? {
                ...a,
                status: next,
                submitted: stamped,
                history: [...(a.history ?? []), ...historyHops(a, next, `board:${user}`)],
              }
            : a,
        ),
      }
      patchEntry('applications', updated, prevSha)
      setMenuFor(null)
      const message = `status: ${app.company} ${app.role} ${app.status}→${next} (board:${user})`
      try {
        let newSha: string
        let committed = updated
        try {
          newSha = await commitBoard(token, updated, prevSha, message)
        } catch {
          // 409 등: 최신 sha 재취득 후 1회 재시도 (서버 본문 기준 재구성)
          const fresh = await fetchBoard(token)
          const merged: BoardData = {
            ...fresh.data,
            updated: todayLocal(),
            applications: fresh.data.applications.map((a) =>
              a.id === app.id
                ? {
                    ...a,
                    status: next,
                    submitted: next === 'submitted' && !a.submitted ? todayLocal() : a.submitted,
                    history: [...(a.history ?? []), ...historyHops(a, next, `board:${user}`)],
                  }
                : a,
            ),
          }
          newSha = await commitBoard(token, merged, fresh.sha, message)
          committed = merged
        }
        patchEntry('applications', committed, newSha)
        showToast({
          kind: 'ok',
          text:
            next === 'submitted' && !app.submitted
              ? `${app.company} 제출 확인 · ${todayLocal()} 기록`
              : `${app.company} → ${STATUS_LABEL[next]}`,
        })
      } catch (e) {
        patchEntry('applications', prev, prevSha)
        showToast({ kind: 'err', text: e instanceof Error ? e.message : '커밋 실패' })
      }
    },
    [board, token, sha, user, showToast],
  )

  const counts = useMemo(() => {
    const m = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>
    for (const a of apps) m[a.status] += 1
    return m
  }, [apps])

  const screeningReached = useMemo(() => apps.filter(reachedScreening).length, [apps])

  const stats = useMemo(() => {
    const inProgress = counts.screening + counts.assignment + counts.interview
    const rejected = counts['rejected-docs'] + counts['rejected-assignment'] + counts['rejected-interview']
    const submittedTotal = apps.length - counts.ready
    const responded = inProgress + counts.offer + rejected
    return {
      total: apps.length,
      ready: counts.ready,
      waiting: counts.submitted,
      inProgress,
      rejected,
      rate: submittedTotal ? Math.round((responded / submittedTotal) * 100) : 0,
    }
  }, [apps.length, counts])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = apps.filter((a) => {
      if (statusFilter.size > 0) {
        const direct = statusFilter.has(a.status)
        const viaScreening = statusFilter.has('screening') && reachedScreening(a)
        if (!direct && !viaScreening) return false
      }
      if (q && !`${a.company} ${a.role} ${a.notes ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
    const byWave = new Map<string, Application[]>()
    for (const a of visible) {
      const list = byWave.get(a.wave) ?? []
      list.push(a)
      byWave.set(a.wave, list)
    }
    const sortedGroups = [...byWave.entries()].sort((x, y) => y[0].localeCompare(x[0]))
    /* 평탄화된 행 목록 — 윈도잉 기준. 라인 넘버는 차수 내 인덱스로 미리 고정 (윈도와 무관하게 일관). */
    const flatRows = sortedGroups.flatMap(([wave, rows]) =>
      rows.map((app, idx) => ({ wave, app, idx })),
    )
    return { groups: sortedGroups, flatRows, visibleCount: visible.length }
  }, [apps, statusFilter, query])

  /* 보드 행 윈도잉: 평탄화된 행 기준. 필터·검색 변경 시 step 으로 리셋. */
  const boardWindow = useInfiniteWindow(
    groups.flatRows,
    30,
    `${[...statusFilter].sort().join(',')}|${query.trim()}`,
  )
  /* 가시 행을 다시 차수별로 그룹핑 — 그룹 헤더는 가시 행이 1개 이상인 차수만 (차수 카운트는 전체 유지). */
  const visibleGroups = useMemo(() => {
    const fullCount = new Map(groups.groups.map(([wave, rows]) => [wave, rows.length]))
    const acc: Array<{ wave: string; total: number; rows: Array<{ app: Application; idx: number }> }> = []
    let cur: { wave: string; total: number; rows: Array<{ app: Application; idx: number }> } | null = null
    for (const r of boardWindow.visible) {
      if (!cur || cur.wave !== r.wave) {
        cur = { wave: r.wave, total: fullCount.get(r.wave) ?? 0, rows: [] }
        acc.push(cur)
      }
      cur.rows.push({ app: r.app, idx: r.idx })
    }
    return acc
  }, [boardWindow.visible, groups.groups])

  const openApp = openId ? apps.find((a) => a.id === openId) : null
  const filtered = statusFilter.size > 0 || query.trim().length > 0

  const openRowMenu = (id: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuUp(window.innerHeight - rect.bottom < 320)
    setMenuFor(menuFor === id ? null : id)
  }

  if (!token) {
    // 미인증: 부팅(토큰 복원·OAuth #code 교환) 또는 로그인 진행 중이면 스피너 — 로그인 화면 깜빡임 방지.
    // 그 외(신규 방문)에만 로그인 화면을 즉시 보인다.
    if (booting || loading) return <LoadingScreen />
    return httpMode ? (
      <GoogleGate onLogin={loginRedirect} error={gateError} />
    ) : (
      <TokenGate onSubmit={(t) => void login(t)} error={gateError} />
    )
  }
  if (!board) {
    return <LoadingScreen />  // 토큰은 있고 데이터 prefetch 중 (캐시 있으면 이 분기 안 옴)
  }

  const unreadCount = notifItems.filter((n) => !n.handled).length

  return (
    <main className="board">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="wordmark">
            mango<span className="wordmark-dot">.</span>career
          </h1>
          <nav className="view-toggle mono" aria-label="뷰 전환">
            <button type="button" className={view === 'board' ? 'on' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')}>
              보드
            </button>
            <span className="vt-sep" aria-hidden="true">
              |
            </span>
            <button type="button" className={view === 'mail' ? 'on' : ''} aria-pressed={view === 'mail'} onClick={() => setView('mail')}>
              메일
            </button>
            <span className="vt-sep" aria-hidden="true">
              |
            </span>
            <button type="button" className={view === 'agent' ? 'on' : ''} aria-pressed={view === 'agent'} onClick={() => setView('agent')}>
              에이전트
            </button>
          </nav>
        </div>
        <div className="topbar-right mono">
          <button
            type="button"
            className={`topbar-action${view === 'notif' ? ' on' : ''}`}
            aria-pressed={view === 'notif'}
            onClick={() => setView('notif')}
          >
            알림{unreadCount > 0 ? ` ${unreadCount}` : ''}
          </button>
          <span className="sep">·</span>
          <span>{user}</span>
          <span className="sep">·</span>
          <span>updated {board.updated}</span>
          <span className="sep">·</span>
          <button type="button" className="gear-btn" onClick={() => setSettingsOpen(true)} aria-label="설정" title="설정">⚙</button>
          <span className="sep">·</span>
          <button
            type="button"
            className="linkish"
            onClick={() => {
              if (httpMode && token) void cpLogout(token) // 서버 세션 폐기
              localStorage.removeItem(TOKEN_KEY)
              clearStore()
              setToken(null)
              setUser('')
            }}
          >
            로그아웃
          </button>
        </div>
      </header>

      {view === 'notif' ? (
        <NotifSection items={notifItems} onRead={readNotifs} onNavigate={navigateFromNotif} />
      ) : view === 'mail' ? (
        <MailView
          token={token}
          user={user}
          inboxEntry={inboxEntry}
          outboxEntry={outboxEntry}
          draftsEntry={draftsEntry}
          runner={runnerEntry?.data ?? null}
          focus={mailFocus}
          onFocusDone={() => setMailFocus(undefined)}
          onRefreshMail={refreshMail}
          onQueued={() => void revalidate(token, 'outbox').catch(() => {})}
        />
      ) : view === 'agent' ? (
        <AgentView
          token={token}
          user={user}
          runnerEntry={runnerEntry}
          pending={pendingReqs}
          onPendingAdd={(p) => setPendingReqs((cur) => [...cur, p])}
          focus={agentFocus}
          onFocusDone={() => setAgentFocus(undefined)}
        />
      ) : (
        <>
          <section className="overview" aria-label="파이프라인 요약">
            <FunnelBar apps={apps} />
            <div className="metrics">
              <span>
                <strong>{stats.total}</strong> 전체
              </span>
              <span>
                <strong>{stats.ready}</strong> 준비
              </span>
              <span>
                <strong>{stats.waiting}</strong> 응답 대기
              </span>
              <span>
                <strong>{stats.inProgress}</strong> 진행 중
              </span>
              <span>
                <strong className="num-rejected">{stats.rejected}</strong> 탈락
              </span>
              <span>
                <strong>{stats.rate}<span className="unit">%</span></strong> 응답률
              </span>
              {filtered && (
                <span className="metrics-filtered" aria-live="polite">
                  {groups.visibleCount}건 표시 중
                </span>
              )}
            </div>
          </section>

          <section className="insights" aria-label="시각화">
            <div className="viz">
              <h2 className="viz-label mono">FLOW</h2>
              <Sankey apps={apps} />
            </div>
            <div className="viz">
              <h2 className="viz-label mono">TIMELINE</h2>
              <Timeline apps={apps} />
            </div>
          </section>

          <section className="filters" aria-label="필터">
            {STATUS_ORDER.map((s, i) => (
              <span key={s} className="filter-slot">
                {(i === 6 || i === 9) && <span className="filter-div" aria-hidden="true" />}
                <button
                  type="button"
                  className={`filter ${statusFilter.has(s) ? 'active' : ''}`}
                  aria-pressed={statusFilter.has(s)}
                  onClick={() =>
                    setStatusFilter((prev) => {
                      const next = new Set(prev)
                      if (next.has(s)) next.delete(s)
                      else next.add(s)
                      return next
                    })
                  }
                >
                  <span className="dot" style={{ background: STATUS_COLOR[s] }} aria-hidden="true" />
                  {STATUS_LABEL[s]}
                  <span className="filter-count mono">{s === 'screening' ? screeningReached : counts[s]}</span>
                </button>
              </span>
            ))}
            <input
              ref={searchRef}
              type="search"
              className="search"
              name="q"
              placeholder="검색…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="회사·포지션 검색"
              spellCheck={false}
            />
            <kbd className="search-kbd mono" aria-hidden="true">
              ⌘K
            </kbd>
          </section>

          <div className="list" role="table" aria-label="지원 목록">
            <div className="row head" role="row">
              <span role="columnheader" className="cell-num" aria-label="행 번호" />
              <span role="columnheader">회사 · 포지션</span>
              <span role="columnheader">연차</span>
              <span role="columnheader">공고</span>
              <span role="columnheader" className="ta-r">
                제출일
              </span>
              <span role="columnheader" className="ta-r">
                문서
              </span>
              <span role="columnheader">상태</span>
              <span role="columnheader">메모</span>
            </div>
            {visibleGroups.map((g) => (
              <section key={g.wave} className="wave-group" role="rowgroup">
                <h2 className="wave-head mono" aria-label={`${g.wave} 차수 ${g.total}건`}>
                  {g.wave}
                  <span className="wave-count">{g.total}건</span>
                </h2>
                {g.rows.map(({ app: a, idx }) => (
                  <div
                    key={a.id}
                    role="row"
                    tabIndex={0}
                    className="row"
                    onClick={() => setOpenId(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) setOpenId(a.id)
                    }}
                  >
                    <span role="cell" className="cell-num mono">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span role="cell" className="cell-main">
                      <span className="company">{a.company}</span>
                      <span className="role">{a.role}</span>
                    </span>
                    <span role="cell" className="cell-years mono">
                      {a.yearsReq || '–'}
                    </span>
                    <span role="cell" className="cell-channel">
                      {a.url ? (
                        <a href={a.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          {channelLabel(a.url, a.channel)}
                        </a>
                      ) : (
                        '–'
                      )}
                    </span>
                    <span role="cell" className="cell-date mono ta-r">
                      {a.submitted ?? '–'}
                    </span>
                    <span role="cell" className="cell-docs mono ta-r">
                      {a.docs?.length ?? '–'}
                    </span>
                    <span role="cell" className="cell-status">
                      <StatusDot status={a.status} asButton onClick={undefined} />
                      <button
                        type="button"
                        className="status-hit"
                        aria-label={`${a.company} 상태 변경`}
                        onClick={(e) => {
                          e.stopPropagation()
                          openRowMenu(a.id, e)
                        }}
                      />
                      {menuFor === a.id && (
                        <StatusMenu
                          current={a.status}
                          up={menuUp}
                          onPick={(s) => void changeStatus(a, s)}
                          onClose={() => setMenuFor(null)}
                        />
                      )}
                    </span>
                    <span role="cell" className="cell-notes">
                      {a.notes ?? '–'}
                    </span>
                  </div>
                ))}
              </section>
            ))}
            {boardWindow.hasMore && <div ref={boardWindow.sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
            {groups.visibleCount === 0 && (
              <div className="empty">
                <p>조건에 맞는 항목 없음</p>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setStatusFilter(new Set())
                    setQuery('')
                  }}
                >
                  필터 해제
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {openApp && (
        <Drawer
          app={openApp}
          token={token}
          onClose={() => setOpenId(null)}
          onStatus={(s) => void changeStatus(openApp, s)}
          toast={showToast}
        />
      )}

      {toast && (
        <button type="button" className={`toast ${toast.kind}`} role="status" aria-live="polite" onClick={() => setToast(null)}>
          {toast.text}
        </button>
      )}

      {settingsOpen && (
        <SettingsModal token={token} combos={runnerEntry?.data?.combos ?? []} onClose={() => setSettingsOpen(false)} />
      )}
    </main>
  )
}
