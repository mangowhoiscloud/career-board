import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commitBoard, createFile, DATA_REPO_URL, fetchBoard, fetchDocBlobUrl, whoami } from './api'
import type { Application, BoardData, Status } from './types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types'

const TOKEN_KEY = 'career-board:token'
type Toast = { kind: 'ok' | 'err'; text: string } | null

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
  const passDocs = submitted - wait - rejDocs
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
              <dd className="mono">{app.submitted}</dd>
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

function Composer({
  user,
  token,
  onClose,
  toast,
}: {
  user: string
  token: string
  onClose: () => void
  toast: (t: Toast) => void
}) {
  const [reqType, setReqType] = useState('package')
  const [reqUrl, setReqUrl] = useState('')
  const [reqNote, setReqNote] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useDialog(onClose)

  const submit = async () => {
    if (!reqUrl.trim()) return
    setBusy(true)
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
    const typeLabel: Record<string, string> = {
      package: '지원 패키지 제작 (이력서+커버레터)',
      coverletter: '커버레터·지원동기 작성',
      research: '회사·JD 리서치',
      submit: '제출 보조 (폼 입력안)',
    }
    const body = [
      `# REQ-${ts} · ${typeLabel[reqType]}`,
      '',
      `- type: ${reqType}`,
      `- url: ${reqUrl.trim()}`,
      `- requested-by: board:${user}`,
      `- requested-at: ${new Date().toISOString()}`,
      `- status: pending`,
      '',
      '## 메모',
      '',
      reqNote.trim() || '(없음)',
      '',
      '> 처리 규약: 로컬 Claude Code 세션(구독 쿼터)이 requests/ 를 확인하고 resume-production 파이프라인으로 처리한다.',
      '> 완료 시 status: done 으로 수정하고 산출물 경로를 기재한다.',
      '',
    ].join('\n')
    try {
      await createFile(token, `requests/REQ-${ts}.md`, body, `request: ${typeLabel[reqType]} (board:${user})`)
      toast({ kind: 'ok', text: `요청 등록됨 · REQ-${ts}` })
      onClose()
    } catch (e) {
      toast({ kind: 'err', text: e instanceof Error ? e.message : '요청 실패' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="에이전트 작업 요청"
        ref={ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <div>
            <h2>에이전트 작업 요청</h2>
            <p className="drawer-role">requests/ 에 커밋되어 로컬 Claude Code 세션(구독 쿼터)이 처리합니다</p>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기 (Esc)">
            esc
          </button>
        </header>
        <form
          className="compose-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <label>
            유형
            <select name="type" value={reqType} onChange={(e) => setReqType(e.target.value)}>
              <option value="package">지원 패키지 제작 (이력서+커버레터)</option>
              <option value="coverletter">커버레터·지원동기 작성</option>
              <option value="research">회사·JD 리서치</option>
              <option value="submit">제출 보조 (폼 입력안)</option>
            </select>
          </label>
          <label>
            공고 URL
            <input
              type="url"
              name="url"
              value={reqUrl}
              onChange={(e) => setReqUrl(e.target.value)}
              placeholder="https://…"
              spellCheck={false}
            />
          </label>
          <label>
            메모
            <textarea
              name="note"
              value={reqNote}
              onChange={(e) => setReqNote(e.target.value)}
              rows={4}
              placeholder="강조 축, 마감일 등…"
            />
          </label>
          <button type="submit" className="compose-submit" disabled={busy || !reqUrl.trim()}>
            {busy ? '등록 중…' : '요청 등록'}
          </button>
        </form>
      </aside>
    </>
  )
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [board, setBoard] = useState<BoardData | null>(null)
  const [sha, setSha] = useState('')
  const [user, setUser] = useState('')
  const [gateError, setGateError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set())
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuUp, setMenuUp] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [composer, setComposer] = useState(false)
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

  const load = useCallback(async (tok: string) => {
    setLoading(true)
    try {
      const [{ data, sha }, login] = await Promise.all([fetchBoard(tok), whoami(tok)])
      setBoard(data)
      setSha(sha)
      setUser(login)
      setGateError(null)
      localStorage.setItem(TOKEN_KEY, tok)
      setToken(tok)
    } catch (e) {
      setGateError(e instanceof Error ? e.message : String(e))
      localStorage.removeItem(TOKEN_KEY)
      setToken(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (token) void load(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
                history: [
                  ...(a.history ?? []),
                  { at: new Date().toISOString(), from: a.status, to: next, by: `board:${user}` },
                ],
              }
            : a,
        ),
      }
      setBoard(updated)
      setMenuFor(null)
      const message = `status: ${app.company} ${app.role} ${app.status}→${next} (board:${user})`
      try {
        let newSha: string
        try {
          newSha = await commitBoard(token, updated, prevSha, message)
        } catch {
          // 409 등: 최신 sha 재취득 후 1회 재시도 (낙관적 상태는 유지하되 서버 본문 기준 재구성)
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
                    history: [
                      ...(a.history ?? []),
                      { at: new Date().toISOString(), from: a.status, to: next, by: `board:${user}` },
                    ],
                  }
                : a,
            ),
          }
          newSha = await commitBoard(token, merged, fresh.sha, message)
          setBoard(merged)
        }
        setSha(newSha)
        showToast({
          kind: 'ok',
          text:
            next === 'submitted' && !app.submitted
              ? `${app.company} 제출 확인 · ${todayLocal()} 기록`
              : `${app.company} → ${STATUS_LABEL[next]}`,
        })
      } catch (e) {
        setBoard(prev)
        setSha(prevSha)
        showToast({ kind: 'err', text: e instanceof Error ? e.message : '커밋 실패' })
      }
    },
    [board, token, sha, user, showToast],
  )

  const apps = board?.applications ?? []

  const counts = useMemo(() => {
    const m = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>
    for (const a of apps) m[a.status] += 1
    return m
  }, [apps])

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
      if (statusFilter.size > 0 && !statusFilter.has(a.status)) return false
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

  if (!token || !board) {
    return loading ? (
      <main className="gate">
        <p>불러오는 중…</p>
      </main>
    ) : (
      <TokenGate onSubmit={(t) => void load(t)} error={gateError} />
    )
  }

  return (
    <main className="board">
      <header className="topbar">
        <h1 className="wordmark">
          mango<span className="wordmark-dot">.</span>career
        </h1>
        <div className="topbar-right mono">
          <button type="button" className="topbar-action" onClick={() => setComposer(true)}>
            에이전트 요청
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
              setToken(null)
              setBoard(null)
            }}
          >
            로그아웃
          </button>
        </div>
      </header>

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
              <span className="filter-count mono">{counts[s]}</span>
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

      {openApp && (
        <Drawer
          app={openApp}
          token={token}
          onClose={() => setOpenId(null)}
          onStatus={(s) => void changeStatus(openApp, s)}
          toast={showToast}
        />
      )}

      {composer && <Composer user={user} token={token} onClose={() => setComposer(false)} toast={showToast} />}

      {toast && (
        <button type="button" className={`toast ${toast.kind}`} role="status" aria-live="polite" onClick={() => setToast(null)}>
          {toast.text}
        </button>
      )}
    </main>
  )
}
