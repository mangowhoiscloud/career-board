import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  commitBoard, createFile, DATA_REPO_URL, fetchBoard, fetchDocBlobUrl, fetchJsonFile, fetchTextFile,
  markNotificationsRead, putJsonFile, whoami,
  type InboxData, type InboxMessage, type NotifFile, type Notification, type OutboxData, type OutboxItem,
  type RequestType, type RunnerRun, type RunnerState,
} from './api'
import { clearStore, patchEntry, prefetchAll, revalidate, useEntry, type Entry, type StoreKey } from './store'
import type { Application, BoardData, Status } from './types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types'

const TOKEN_KEY = 'career-board:token'
const COMBO_KEY = 'agentCombo'
const MODEL_KEY = 'agentModel'
type Toast = { kind: 'ok' | 'err'; text: string } | null
type View = 'board' | 'mail' | 'agent'

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

/* requests/REQ-*.md 큐 파일 — 컴포저·메일 초안이 공유하는 단일 포맷 */
function reqFileBody(opts: { id: string; typeId: string; label: string; combo: string; model: string; user: string; prompt: string }): string {
  return [
    `# ${opts.id} · ${opts.label}`,
    '',
    `- type: ${opts.typeId}`,
    `- runner: ${JSON.stringify({ combo: opts.combo, model: opts.model })}`,
    `- requested-by: board:${opts.user}`,
    `- requested-at: ${new Date().toISOString()}`,
    `- status: pending`,
    '',
    '## 요청',
    '',
    opts.prompt,
    '',
    '> 처리 규약: 러너 또는 로컬 세션이 requests/ 를 확인해 처리한다. 완료 시 status: done 으로 수정하고 산출물 경로를 기재한다.',
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
  fill?: { text: string; ts: number }
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

  /* 에이전트 초안 채우기: 초안 텍스트를 본문 textarea 에 삽입 */
  useEffect(() => {
    if (fill) setBody(fill.text)
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
  onClose,
  onQueued,
}: {
  token: string
  user: string
  state: MailModalState
  runner: RunnerState | null
  onClose: () => void
  onQueued: () => void
}) {
  const ref = useDialog(onClose)
  const msg = state.kind === 'message' ? state.msg : null
  const [replyOpen, setReplyOpen] = useState(false)
  const [fill, setFill] = useState<{ text: string; ts: number } | undefined>(undefined)
  const [fillBusy, setFillBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftRequested, setDraftRequested] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const replyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (replyOpen) replyRef.current?.scrollIntoView({ block: 'nearest' })
  }, [replyOpen])

  const marker = msg ? `[mail-reply:${msg.account}:${msg.id}]` : ''
  const markerRuns = useMemo(
    () => (marker ? (runner?.recent_runs ?? []).filter((r) => r.prompt.startsWith(marker)) : []),
    [runner, marker],
  )
  const doneDraft = markerRuns.find((r) => r.status === 'done')
  const activeDraft = markerRuns.find((r) => r.status === 'running')
  const requested = draftRequested || !!activeDraft

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
        '아래 메일에 한국어로 답장 초안을 작성해. 발송하지 말고 본문 텍스트만.',
        '',
        `보낸이: ${msg.from}`,
        `제목: ${msg.subject}`,
        '',
        msg.body,
      ].join('\n')
      const body = reqFileBody({ id, typeId: 'mail-reply', label: '메일 답장 초안', combo, model, user, prompt })
      await createFile(token, `requests/${id}.md`, body, `request: 메일 답장 초안 (board:${user})`)
      setDraftRequested(true)
    } catch (e) {
      setNote(e instanceof Error ? e.message : '요청 실패')
    } finally {
      setDraftBusy(false)
    }
  }

  const fillDraft = async () => {
    if (!doneDraft) return
    if (!doneDraft.output) {
      setNote('산출물 경로 없음')
      return
    }
    setFillBusy(true)
    setNote(null)
    try {
      const text = await fetchTextFile(token, doneDraft.output)
      setReplyOpen(true)
      setFill({ text, ts: Date.now() })
    } catch (e) {
      setNote(e instanceof Error ? e.message : '초안 로드 실패')
    } finally {
      setFillBusy(false)
    }
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
              <div className="mm-body">{msg.body || '(본문 없음)'}</div>
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
            {requested ? (
              <span className="mm-note">초안 요청됨 · 에이전트 탭</span>
            ) : (
              <button type="button" className="text-action" disabled={draftBusy} onClick={() => void requestDraft()}>
                {draftBusy ? '요청 중…' : '에이전트 초안'}
              </button>
            )}
            {doneDraft && (
              <button type="button" className="text-action" disabled={fillBusy} onClick={() => void fillDraft()}>
                {fillBusy ? '불러오는 중…' : '초안 채우기'}
              </button>
            )}
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

function MailView({
  token,
  user,
  inboxEntry,
  outboxEntry,
  runner,
  focus,
  onFocusDone,
  onQueued,
}: {
  token: string
  user: string
  inboxEntry?: Entry<InboxData>
  outboxEntry?: Entry<OutboxData>
  runner: RunnerState | null
  focus?: { subject: string; ts: number }
  onFocusDone: () => void
  onQueued: () => void
}) {
  const [modal, setModal] = useState<MailModalState | null>(null)
  const closeModal = useCallback(() => setModal(null), [])
  const [syncSnapshot, setSyncSnapshot] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncErr, setSyncErr] = useState<string | null>(null)

  const inbox = inboxEntry?.data ?? null
  const synced = inbox?.synced_at ?? ''

  /* 알림 → 메일 진입: subject 일치 메일을 모달로 (없으면 뷰 전환만) */
  useEffect(() => {
    if (!focus) return
    const msgs = inbox?.messages ?? []
    const m =
      msgs.find((x) => x.subject === focus.subject) ??
      msgs.find((x) => x.subject && (focus.subject.includes(x.subject) || x.subject.includes(focus.subject)))
    if (m) setModal({ kind: 'message', msg: m })
    onFocusDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  /* 동기 요청 후 synced_at 전진 감지 → 라벨 복귀 */
  useEffect(() => {
    if (syncSnapshot !== null && synced !== syncSnapshot) setSyncSnapshot(null)
  }, [synced, syncSnapshot])

  const requestSync = async () => {
    setSyncBusy(true)
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
      setSyncSnapshot(synced)
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : '동기 요청 실패')
    } finally {
      setSyncBusy(false)
    }
  }

  const groups = useMemo(() => {
    const msgs = inbox?.messages ?? []
    return MAIL_ACCOUNTS.map(([account, label]) => ({
      account,
      label,
      messages: msgs.filter((m) => m.account === account).sort((a, b) => b.at - a.at),
    })).filter((g) => g.messages.length > 0)
  }, [inbox])

  const sentItems = useMemo(
    () => [...(outboxEntry?.data?.items ?? [])].sort((a, b) => b.queued_at.localeCompare(a.queued_at)).slice(0, 5),
    [outboxEntry],
  )

  const syncPending = syncSnapshot !== null && synced === syncSnapshot

  return (
    <section className="mailbox" aria-label="메일함">
      <div className="mail-actions mono">
        <button type="button" className="text-action" onClick={() => setModal({ kind: 'compose' })}>
          새 메일
        </button>
        {syncPending ? (
          <span className="mail-note">동기 요청됨</span>
        ) : (
          <button type="button" className="text-action" disabled={syncBusy} onClick={() => void requestSync()}>
            {syncBusy ? '요청 중…' : '새로고침'}
          </button>
        )}
        {synced && <span className="mail-note">동기 {hhmm(synced)} 기준</span>}
        {syncErr && <span className="mail-note err">{syncErr}</span>}
      </div>

      {inboxEntry === undefined ? (
        <p className="plain-note">불러오는 중…</p>
      ) : inboxEntry.missing ? (
        <p className="plain-note">메일 동기본 없음 · 러너 확인</p>
      ) : groups.length === 0 ? (
        <p className="plain-note">없음</p>
      ) : (
        groups.map((g) => (
          <div key={g.account} className="mail-group">
            <h2 className="wave-head mono" aria-label={`${g.label} ${g.messages.length}건`}>
              {g.label}
              <span className="wave-count">{g.messages.length}</span>
            </h2>
            <div className="mail-list" role="list">
              {g.messages.map((m) => {
                const kindLabel = m.kind ? MAIL_KIND_LABEL[m.kind] : undefined
                return (
                  <button
                    key={`${m.account}-${m.id}`}
                    type="button"
                    role="listitem"
                    className={`mail-row${m.unread ? ' unread' : ''}`}
                    onClick={() => setModal({ kind: 'message', msg: m })}
                  >
                    <span className="mail-main">
                      <span className="mail-top">
                        <span className="mail-from">{fromName(m.from)}</span>
                        <span className="mail-subj">{m.subject || '(제목 없음)'}</span>
                      </span>
                      <span className="mail-snip">{m.snippet || '–'}</span>
                    </span>
                    <span className="mail-right">
                      <span className="mail-time mono">{fmtWhen(m.at * 1000)}</span>
                      {kindLabel && <span className="mail-kind">{kindLabel}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))
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
  { id: 'research', label: '회사·JD 리서치', needs: 'research', cwd: 'career-data' },
  { id: 'explore', label: '공고 탐색', needs: 'research', cwd: 'career-data' },
  { id: 'coverletter', label: '커버레터', needs: 'files', cwd: 'resume' },
  { id: 'package', label: '지원 패키지', needs: 'files', cwd: 'resume' },
  { id: 'submit', label: '제출 준비', needs: 'files', cwd: 'resume' },
  { id: 'mail-check', label: '메일 확인', needs: 'scan', cwd: 'career-data' },
]

const RUNNER_STALE_MS = 40 * 60 * 1000

export interface PendingReq {
  id: string
  type: string
  combo: string
  model: string
  prompt: string
  at: string
}

type AgentSession = { id: string; ms: number; run?: RunnerRun; req?: PendingReq }

function runStatusText(r: RunnerRun): string {
  if (r.status === 'running') return '실행 중'
  if (r.status === 'failed') return '실패'
  return '완료'
}

function typeLabelOf(types: RequestType[], id: string): string {
  return types.find((t) => t.id === id)?.label ?? id
}

/* 완료 run 산출물: reports/runs/*.md PAT fetch */
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
  return <div className="run-result">{output}</div>
}

function SessionDetail({ token, session, types }: { token: string; session: AgentSession; types: RequestType[] }) {
  const run = session.run
  const req = session.req
  return (
    <div className="agent-detail">
      <dl className="drawer-meta">
        <div>
          <dt>유형</dt>
          <dd>{typeLabelOf(types, run?.type ?? req?.type ?? '')}</dd>
        </div>
        <div>
          <dt>경로</dt>
          <dd className="mono">{run ? (run.combo ?? '–') : req?.combo}</dd>
        </div>
        <div>
          <dt>모델</dt>
          <dd className="mono">{run?.model ?? req?.model}</dd>
        </div>
        {run?.started && (
          <div>
            <dt>시작</dt>
            <dd className="mono">{fmtHistoryAt(run.started)}</dd>
          </div>
        )}
        {run?.ended && (
          <div>
            <dt>종료</dt>
            <dd className="mono">{fmtHistoryAt(run.ended)}</dd>
          </div>
        )}
      </dl>

      <section className="agent-block">
        <h3>프롬프트</h3>
        <p className="agent-prompt">{run?.prompt ?? req?.prompt}</p>
      </section>

      {run?.events_tail && run.events_tail.length > 0 && (
        <section className="agent-block">
          <h3>진행</h3>
          <div className="ev-tail mono">
            {run.events_tail.map((ev, i) => (
              <p key={i}>
                <span className="ev-at">{ev.at}</span> <span className="ev-type">{ev.type}</span> {ev.text}
              </p>
            ))}
          </div>
        </section>
      )}

      {req && <p className="plain-note">대기 중 · 러너 주기 60초</p>}
      {run?.status === 'running' && (
        <p className="plain-note">실행 중{run.started ? ` · 시작 ${hhmm(run.started)}` : ''}</p>
      )}
      {run?.status === 'failed' && <p className="plain-note err">{run.error || '실패 사유 없음'}</p>}
      {run?.status === 'done' && (
        <section className="agent-block">
          <h3>결과</h3>
          <RunOutput token={token} run={run} />
        </section>
      )}
    </div>
  )
}

function AgentComposer({
  token,
  user,
  state,
  types,
  onSubmitted,
}: {
  token: string
  user: string
  state: RunnerState | null
  types: RequestType[]
  onSubmitted: (p: PendingReq) => void
}) {
  const combos = useMemo(() => state?.combos ?? [], [state])
  const [typeId, setTypeId] = useState(types[0]?.id ?? 'research')
  useEffect(() => {
    if (!types.some((t) => t.id === typeId)) setTypeId(types[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types])

  const needs = types.find((t) => t.id === typeId)?.needs
  /* needs=files 면 파일 능력 콤보만 노출 (능력 경계 — 정직 표면) */
  const eligible = useMemo(
    () => combos.filter((c) => needs !== 'files' || c.capabilities.includes('files')),
    [combos, needs],
  )
  const [comboId, setComboId] = useState('')
  const combo = eligible.find((c) => c.id === comboId)
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  /* 적격 콤보 변동 시: localStorage 선호 콤보 → 첫 ready 콤보 순 */
  useEffect(() => {
    if (!eligible.some((c) => c.id === comboId && c.ready)) {
      const stored = localStorage.getItem(COMBO_KEY)
      const pick =
        (stored && eligible.find((c) => c.id === stored && c.ready)) || eligible.find((c) => c.ready)
      setComboId(pick?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible])

  /* 콤보 변경 시: localStorage 선호 모델 → 기본 모델 순 */
  useEffect(() => {
    const stored = localStorage.getItem(MODEL_KEY)
    const m =
      (stored && combo?.models.find((x) => x.id === stored)) ||
      combo?.models.find((x) => x.default) ||
      combo?.models[0]
    setModelId(m?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comboId])

  /* 선택한 콤보·모델 영속 — 메일 '에이전트 초안'이 참조 */
  useEffect(() => {
    if (comboId) localStorage.setItem(COMBO_KEY, comboId)
  }, [comboId])
  useEffect(() => {
    if (modelId) localStorage.setItem(MODEL_KEY, modelId)
  }, [modelId])

  const notReady = eligible.filter((c) => !c.ready)

  const submit = async () => {
    if (!prompt.trim() || !combo || !combo.ready) return
    setBusy(true)
    setNote(null)
    try {
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
      const id = `REQ-${ts}`
      const label = typeLabelOf(types, typeId)
      const body = reqFileBody({ id, typeId, label, combo: combo.id, model: modelId, user, prompt: prompt.trim() })
      await createFile(token, `requests/${id}.md`, body, `request: ${label} (board:${user})`)
      const pendingReq: PendingReq = {
        id,
        type: typeId,
        combo: combo.id,
        model: modelId,
        prompt: prompt.trim(),
        at: new Date().toISOString(),
      }
      setPrompt('')
      onSubmitted(pendingReq)
    } catch (e) {
      setNote(e instanceof Error ? e.message : '요청 실패')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="req-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label>
        유형
        <select name="type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        실행 경로
        <select name="combo" value={comboId} onChange={(e) => setComboId(e.target.value)} disabled={eligible.length === 0}>
          {eligible.length === 0 && <option value="">사용 가능한 경로 없음</option>}
          {eligible.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.ready}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {notReady.map((c) => (
        <p key={c.id} className="plain-note combo-note">
          {c.label} — {c.reason ?? '사용 불가'}
          {c.action ? ` · ${c.action}` : ''}
        </p>
      ))}
      <label>
        모델
        <select name="model" value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!combo}>
          {!combo && <option value="">–</option>}
          {combo?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        프롬프트
        <textarea
          name="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder="요청 내용…"
        />
      </label>
      <div className="req-submit-row">
        <button type="submit" className="compose-submit req-submit" disabled={busy || !prompt.trim() || !combo}>
          {busy ? '등록 중…' : '요청 등록'}
        </button>
        {note && <span className="plain-note">{note}</span>}
      </div>
    </form>
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

  const sessions = useMemo<AgentSession[]>(() => {
    /* 러너가 집행을 시작하면 같은 프롬프트의 대기 항목은 run 으로 흡수 */
    const visiblePending = pending.filter((p) => !runs.some((r) => r.prompt === p.prompt))
    return [
      ...visiblePending.map((p) => ({ id: p.id, ms: new Date(p.at).getTime(), req: p })),
      ...runs.map((r) => ({ id: r.id, ms: runStartMs(r), run: r })),
    ].sort((a, b) => b.ms - a.ms)
  }, [pending, runs])

  const [selRaw, setSel] = useState<string | null>(null)
  const sel = selRaw ?? sessions[0]?.id ?? 'new'
  const selected = sessions.find((s) => s.id === sel)

  /* 알림 → run 세션 선택 */
  useEffect(() => {
    if (!focus) return
    setSel(focus.runId)
    onFocusDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  const aliveAt = state?.runner_alive_at ? new Date(state.runner_alive_at).getTime() : null
  const runnerStale = aliveAt !== null && Date.now() - aliveAt > RUNNER_STALE_MS

  return (
    <section className="agent" aria-label="에이전트">
      <nav className="agent-rail" aria-label="세션">
        <button type="button" className={`sess-new mono${sel === 'new' ? ' sel' : ''}`} onClick={() => setSel('new')}>
          + 새 요청
        </button>
        {sessions.map((s) => {
          const statusText = s.run ? runStatusText(s.run) : '대기'
          const title = `${typeLabelOf(types, s.run?.type ?? s.req?.type ?? '')} · ${s.run?.prompt ?? s.req?.prompt ?? ''}`
          return (
            <button
              key={s.id}
              type="button"
              className={`sess-row${sel === s.id ? ' sel' : ''}`}
              onClick={() => setSel(s.id)}
            >
              <span className="sess-title">{title}</span>
              <span className="sess-sub mono">
                {fmtWhen(s.ms)} · {statusText}
              </span>
            </button>
          )
        })}
        {sessions.length === 0 && runnerEntry !== undefined && <p className="plain-note sess-empty">없음</p>}
      </nav>

      <div className="agent-body">
        {runnerEntry === undefined && <p className="plain-note">불러오는 중…</p>}
        {runnerEntry !== undefined && !state && <p className="plain-note">러너 상태 없음 · Mac에서 launchd 확인</p>}
        {runnerStale && state && (
          <p className="plain-note">러너 마지막 응답 {fmtHistoryAt(state.runner_alive_at)} · Mac에서 launchd 확인</p>
        )}
        {sel === 'new' || !selected ? (
          <AgentComposer
            token={token}
            user={user}
            state={state}
            types={types}
            onSubmitted={(p) => {
              onPendingAdd(p)
              setSel(p.id)
            }}
          />
        ) : (
          <SessionDetail token={token} session={selected} types={types} />
        )}
      </div>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════ */

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set())
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuUp, setMenuUp] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const [view, setView] = useState<View>('board')
  const [notifOpen, setNotifOpen] = useState(false)
  const [mailFocus, setMailFocus] = useState<{ subject: string; ts: number } | undefined>(undefined)
  const [agentFocus, setAgentFocus] = useState<{ runId: string; ts: number } | undefined>(undefined)
  const [pendingReqs, setPendingReqs] = useState<PendingReq[]>([])

  const boardEntry = useEntry<BoardData>('applications')
  const notifEntry = useEntry<NotifFile>('notifications')
  const inboxEntry = useEntry<InboxData>('inbox')
  const outboxEntry = useEntry<OutboxData>('outbox')
  const runnerEntry = useEntry<RunnerState>('runner-state')

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
    if (token) void login(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 백그라운드 재검증: 활성 뷰 관련 파일만 60s, ETag 조건부 (304 면 자리 유지) */
  const hasBoard = board !== null
  useEffect(() => {
    if (!token || !hasBoard) return
    const VIEW_KEYS: Record<View, StoreKey[]> = {
      board: ['applications', 'notifications'],
      mail: ['inbox', 'outbox', 'notifications', 'runner-state'],
      agent: ['runner-state', 'notifications'],
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

  /* 알림 행 = 대상 객체의 입구 (Linear 원칙) */
  const navigateFromNotif = useCallback(
    (n: Notification) => {
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
    [apps],
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
    return { groups: [...byWave.entries()].sort((x, y) => y[0].localeCompare(x[0])), visibleCount: visible.length }
  }, [apps, statusFilter, query])

  const openApp = openId ? apps.find((a) => a.id === openId) : null
  const filtered = statusFilter.size > 0 || query.trim().length > 0

  const openRowMenu = (id: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuUp(window.innerHeight - rect.bottom < 320)
    setMenuFor(menuFor === id ? null : id)
  }

  if (!token) {
    return loading ? (
      <main className="gate">
        <p>불러오는 중…</p>
      </main>
    ) : (
      <TokenGate onSubmit={(t) => void login(t)} error={gateError} />
    )
  }
  if (!board) {
    return (
      <main className="gate">
        <p>불러오는 중…</p>
      </main>
    )
  }

  const unreadCount = notifItems.filter((n) => !n.handled).length

  const notifSection = notifOpen && (
    <NotifSection items={notifItems} onRead={readNotifs} onNavigate={navigateFromNotif} />
  )

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
            className="topbar-action"
            aria-expanded={notifOpen}
            aria-controls="panel-notif"
            onClick={() => setNotifOpen((v) => !v)}
          >
            알림{unreadCount > 0 ? ` ${unreadCount}` : ''}
          </button>
          <span className="sep">·</span>
          <span>{user}</span>
          <span className="sep">·</span>
          <span>updated {board.updated}</span>
          <span className="sep">·</span>
          <button
            type="button"
            className="linkish"
            onClick={() => {
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

      {view === 'mail' ? (
        <>
          {notifSection}
          <MailView
            token={token}
            user={user}
            inboxEntry={inboxEntry}
            outboxEntry={outboxEntry}
            runner={runnerEntry?.data ?? null}
            focus={mailFocus}
            onFocusDone={() => setMailFocus(undefined)}
            onQueued={() => void revalidate(token, 'outbox').catch(() => {})}
          />
        </>
      ) : view === 'agent' ? (
        <>
          {notifSection}
          <AgentView
            token={token}
            user={user}
            runnerEntry={runnerEntry}
            pending={pendingReqs}
            onPendingAdd={(p) => setPendingReqs((cur) => [...cur, p])}
            focus={agentFocus}
            onFocusDone={() => setAgentFocus(undefined)}
          />
        </>
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

          {notifSection}

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
            {groups.groups.map(([wave, rows]) => (
              <section key={wave} className="wave-group" role="rowgroup">
                <h2 className="wave-head mono" aria-label={`${wave} 차수 ${rows.length}건`}>
                  {wave}
                  <span className="wave-count">{rows.length}건</span>
                </h2>
                {rows.map((a, i) => (
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
                      {String(i + 1).padStart(2, '0')}
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
    </main>
  )
}
