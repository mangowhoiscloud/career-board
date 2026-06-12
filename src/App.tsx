import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotifications, markNotificationsHandled, type Notification, commitBoard, createFile, DATA_REPO_URL, fetchBoard, fetchDocBlobUrl, whoami } from './api'
import {
  cachedProviders, checkDaemonHealth, fetchProviders, getDaemonToken, setDaemonToken,
  mailList, mailMessage, mailScan, mailSend, notifList, notifRead,
  runCreate, runDetail, runsList, runStop,
  type MailListItem, type MailListResult, type MailMessage, type ProvidersPayload, type RequestType, type RunDetail, type RunSummary,
} from './opsd'
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

/* 시각 표기: 오늘이면 HH:MM, 아니면 MM-DD */
function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function mmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
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

function authAbbr(auth: string): string {
  return auth === 'subscription' ? 'sub' : auth === 'api_key' ? 'key' : auth
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
   알림 — 메트릭 아래 고정 원장 섹션. 시각 · 사실 한 줄 · 출처.
   액션은 모두 읽음 하나. 파생 액션 없음 (알림은 피드일 뿐).
   ════════════════════════════════════════════════════════════════ */

function notifSource(source: string): string {
  return source === 'gmail' || source === 'naver' ? 'mail' : source
}

function NotifSection({
  items,
  onReadAll,
}: {
  items: Notification[] | null
  onReadAll: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const unread = items?.filter((n) => !n.handled).length ?? 0
  return (
    <section id="panel-notif" className="panel" aria-label="알림">
      <div className="panel-head">
        <span className="panel-title">알림</span>
        {items && items.length > 0 && (
          <span className={`panel-count${unread > 0 ? ' alert' : ''}`}>
            {unread > 0 ? `${unread} 미읽음` : `${items.length}`}
          </span>
        )}
        <span className="panel-rule" aria-hidden="true" />
        {unread > 0 && (
          <button
            type="button"
            className="panel-action"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setErr(null)
              onReadAll()
                .catch((e) => setErr(e instanceof Error ? e.message : '읽음 처리 실패'))
                .finally(() => setBusy(false))
            }}
          >
            {busy ? '처리 중…' : '모두 읽음'}
          </button>
        )}
      </div>
      {err && <p className="panel-empty">{err}</p>}
      {items === null ? (
        <p className="panel-empty">불러오는 중…</p>
      ) : items.length === 0 ? (
        <p className="panel-empty">없음</p>
      ) : (
        <div className="panel-rows" role="list">
          {items.slice(0, 20).map((n) => (
            <div key={n.id} role="listitem" className={`panel-row notif-row${n.handled ? ' handled' : ''}`}>
              <span className="p-time mono">{n.at.slice(5, 16).replace('T', ' ')}</span>
              <span className="n-fact">
                {n.company ? `${n.company} · ` : ''}
                {n.subject}
                {n.statusChange ? ` · ${n.statusChange}` : ''}
              </span>
              <span className="n-src mono">{notifSource(n.source)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════
   설정 — 로컬 데몬 토큰 (PAT 게이트와 동일 UX, 입력 필드 1개)
   ════════════════════════════════════════════════════════════════ */

function SettingsSection({
  daemon,
  dToken,
  onSave,
}: {
  daemon: 'checking' | 'live' | 'offline'
  dToken: string | null
  onSave: (t: string) => void
}) {
  const [value, setValue] = useState(dToken ?? '')
  return (
    <section className="panel" aria-label="설정">
      <div className="panel-head">
        <span className="panel-title">설정</span>
        <span className="panel-count">
          {daemon === 'live' ? '데몬 연결됨 · 127.0.0.1:8787' : daemon === 'offline' ? '데몬 오프라인' : '확인 중…'}
        </span>
        <span className="panel-rule" aria-hidden="true" />
      </div>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSave(value.trim())
        }}
      >
        <input
          type="password"
          name="daemonToken"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="로컬 데몬 토큰 (~/.config/career-ops/daemon.json)"
          aria-label="로컬 데몬 토큰"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={!value.trim()}>
          저장
        </button>
      </form>
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════
   메일함 — opsd 경유 Gmail+Naver 통합. 큐 모드에서는 알림 요약만.
   ════════════════════════════════════════════════════════════════ */

type MailDrawerState =
  | { kind: 'message'; account: string; id: string }
  | { kind: 'compose'; prefill?: { account: string; to: string; subject: string; in_reply_to?: string; thread_id?: string } }

function MailComposeForm({
  dToken,
  prefill,
  onSent,
}: {
  dToken: string
  prefill?: { account: string; to: string; subject: string; in_reply_to?: string; thread_id?: string }
  onSent: () => void
}) {
  const [account, setAccount] = useState(prefill?.account ?? 'gmail')
  const [to, setTo] = useState(prefill?.to ?? '')
  const [subject, setSubject] = useState(prefill?.subject ?? '')
  const [body, setBody] = useState('')
  const [phase, setPhase] = useState<'idle' | 'armed' | 'sending' | 'sent'>('idle')
  const [sentAt, setSentAt] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const armTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(armTimer.current), [])

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
    setPhase('sending')
    try {
      await mailSend(dToken, {
        account,
        to: to.trim(),
        subject: subject.trim(),
        body,
        ...(prefill?.in_reply_to ? { in_reply_to: prefill.in_reply_to } : {}),
        ...(prefill?.thread_id ? { thread_id: prefill.thread_id } : {}),
      })
      setSentAt(new Date().toTimeString().slice(0, 5))
      setPhase('sent')
      onSent()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '발송 실패')
      setPhase('idle')
    }
  }

  return (
    <div className="compose-form">
      <label>
        보내는 계정
        <select name="account" value={account} onChange={(e) => setAccount(e.target.value)} disabled={phase === 'sent'}>
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
          disabled={phase === 'sent'}
        />
      </label>
      <label>
        제목
        <input type="text" name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={phase === 'sent'} />
      </label>
      <label>
        본문
        <textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} disabled={phase === 'sent'} />
      </label>
      {phase === 'sent' ? (
        <p className="plain-note">발송됨 · {sentAt}</p>
      ) : (
        <button type="button" className="compose-submit" disabled={!ready || phase === 'sending'} onClick={() => void onSendClick()}>
          {phase === 'armed' ? '발송 확정' : phase === 'sending' ? '발송 중…' : '발송'}
        </button>
      )}
      {err && <p className="plain-note err">발송 실패: {err}</p>}
    </div>
  )
}

function MailDrawer({
  dToken,
  state,
  onClose,
  onReply,
  onSent,
}: {
  dToken: string
  state: MailDrawerState
  onClose: () => void
  onReply: (m: MailMessage) => void
  onSent: () => void
}) {
  const ref = useDialog(onClose)
  const [msg, setMsg] = useState<MailMessage | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (state.kind !== 'message') return
    setMsg(null)
    setErr(null)
    mailMessage(dToken, state.account, state.id)
      .then(setMsg)
      .catch((e) => setErr(e instanceof Error ? e.message : '메일 로드 실패'))
  }, [dToken, state])

  const isCompose = state.kind === 'compose'
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer drawer-mail"
        role="dialog"
        aria-modal="true"
        aria-label={isCompose ? '메일 작성' : '메일 전문'}
        ref={ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <div>
            <h2>{isCompose ? (state.prefill?.in_reply_to ? '답장' : '새 메일') : msg?.subject ?? '메일'}</h2>
            {!isCompose && msg && <p className="drawer-role">{msg.from}</p>}
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기 (Esc)">
            esc
          </button>
        </header>

        {isCompose ? (
          <MailComposeForm dToken={dToken} prefill={state.prefill} onSent={onSent} />
        ) : err ? (
          <p className="plain-note err">{err}</p>
        ) : !msg ? (
          <p className="plain-note">불러오는 중…</p>
        ) : (
          <>
            <dl className="drawer-meta">
              <div>
                <dt>보낸이</dt>
                <dd>{msg.from}</dd>
              </div>
              <div>
                <dt>받는이</dt>
                <dd>{msg.to || '–'}</dd>
              </div>
              <div>
                <dt>시각</dt>
                <dd className="mono">{new Date(msg.at * 1000).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}</dd>
              </div>
              <div>
                <dt>계정</dt>
                <dd className="mono">{msg.account}</dd>
              </div>
            </dl>
            {msg.html ? (
              <iframe className="mail-frame" sandbox="" srcDoc={msg.html} title="메일 본문" />
            ) : (
              <div className="mail-text">{msg.text || '(본문 없음)'}</div>
            )}
            <div className="drawer-actions">
              <button type="button" className="text-action" onClick={() => onReply(msg)}>
                답장
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  )
}

function MailView({
  live,
  dToken,
  queueNotifs,
}: {
  live: boolean
  dToken: string | null
  queueNotifs: Notification[] | null
}) {
  const [list, setList] = useState<MailListResult | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [drawer, setDrawer] = useState<MailDrawerState | null>(null)
  const enabled = live && !!dToken

  const load = useCallback(async () => {
    if (!dToken) return
    try {
      setList(await mailList(dToken, 25))
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : '메일 목록 로드 실패')
    }
  }, [dToken])

  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])

  if (!enabled) {
    const mailNotifs = (queueNotifs ?? []).filter((n) => notifSource(n.source) === 'mail')
    return (
      <section className="mailbox" aria-label="메일함">
        <p className="plain-note">
          {live ? '데몬 토큰 없음 · 설정에서 입력' : '로컬 데몬 오프라인 · 메일은 데스크톱에서'}
        </p>
        {mailNotifs.length > 0 && (
          <div className="panel-rows" role="list">
            {mailNotifs.slice(0, 20).map((n) => (
              <div key={n.id} role="listitem" className={`panel-row notif-row${n.handled ? ' handled' : ''}`}>
                <span className="p-time mono">{n.at.slice(5, 16).replace('T', ' ')}</span>
                <span className="n-fact">
                  {n.company ? `${n.company} · ` : ''}
                  {n.subject}
                </span>
                <span className="n-src mono">{notifSource(n.source)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="mailbox" aria-label="메일함">
      <div className="mail-actions mono">
        <button type="button" className="text-action" onClick={() => setDrawer({ kind: 'compose' })}>
          새 메일
        </button>
        <span className="sep">·</span>
        <button
          type="button"
          className="text-action"
          disabled={scanning}
          onClick={() => {
            if (!dToken) return
            setScanning(true)
            setScanNote(null)
            mailScan(dToken)
              .then((r) => {
                setScanNote(`스캔 완료 · 신규 ${r.new_notifications}`)
                void load()
              })
              .catch((e) => setScanNote(e instanceof Error ? e.message : '스캔 실패'))
              .finally(() => setScanning(false))
          }}
        >
          {scanning ? '스캔 중…' : '스캔'}
        </button>
        {scanNote && <span className="mail-note">{scanNote}</span>}
      </div>

      {loadErr && <p className="plain-note err">{loadErr}</p>}
      {list?.errors.gmail && <p className="plain-note">gmail: {list.errors.gmail}</p>}
      {list?.errors.naver && <p className="plain-note">naver: {list.errors.naver}</p>}

      {list === null && !loadErr ? (
        <p className="plain-note">불러오는 중…</p>
      ) : list && list.messages.length === 0 ? (
        <p className="plain-note">없음</p>
      ) : (
        <div className="mail-list" role="list">
          {list?.messages.map((m: MailListItem) => (
            <button
              key={`${m.account}-${m.id}`}
              type="button"
              role="listitem"
              className={`mail-row${m.unread ? ' unread' : ''}`}
              onClick={() => setDrawer({ kind: 'message', account: m.account, id: m.id })}
            >
              <span className="mail-acct mono" aria-label={m.account}>
                {m.account === 'gmail' ? 'G' : 'N'}
              </span>
              <span className="mail-main">
                <span className="mail-top">
                  <span className="mail-from">{fromName(m.from)}</span>
                  <span className="mail-subj">{m.subject || '(제목 없음)'}</span>
                </span>
                <span className="mail-snip">{m.snippet || '–'}</span>
              </span>
              <span className="mail-time mono">{fmtWhen(m.at * 1000)}</span>
            </button>
          ))}
        </div>
      )}

      {drawer && dToken && (
        <MailDrawer
          dToken={dToken}
          state={drawer}
          onClose={() => setDrawer(null)}
          onSent={() => void load()}
          onReply={(m) =>
            setDrawer({
              kind: 'compose',
              prefill: {
                account: m.account,
                to: fromAddr(m.from),
                subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`,
                in_reply_to: m.message_id,
                ...(m.thread_id ? { thread_id: m.thread_id } : {}),
              },
            })
          }
        />
      )}
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════
   요청 — 컴포저(유형·실행 경로·모델·프롬프트) + 최근 runs 원장
   라이브 = POST /runs 즉시 실행, 큐 모드 = requests/ PAT 커밋(runner 블록 포함)
   ════════════════════════════════════════════════════════════════ */

const FALLBACK_TYPES: RequestType[] = [
  { id: 'research', label: '회사·JD 리서치', needs: 'research', cwd: 'career-data' },
  { id: 'explore', label: '공고 탐색', needs: 'research', cwd: 'career-data' },
  { id: 'coverletter', label: '커버레터', needs: 'files', cwd: 'resume' },
  { id: 'package', label: '지원 패키지', needs: 'files', cwd: 'resume' },
  { id: 'submit', label: '제출 준비', needs: 'files', cwd: 'resume' },
  { id: 'mail-check', label: '메일 확인', needs: 'scan', cwd: 'career-data' },
]

function runStatusText(r: RunSummary, now: number): string {
  if (r.status === 'running') return `실행 중 ${mmss(now - runStartMs(r))}`
  if (r.status === 'failed') return '실패'
  return '완료'
}

function RunDrawer({
  dToken,
  id,
  onClose,
  onChanged,
}: {
  dToken: string
  id: string
  onClose: () => void
  onChanged: () => void
}) {
  const ref = useDialog(onClose)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)

  const load = useCallback(() => {
    runDetail(dToken, id)
      .then(setDetail)
      .catch((e) => setErr(e instanceof Error ? e.message : 'run 로드 실패'))
  }, [dToken, id])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (detail?.status !== 'running') return
    const t = window.setInterval(load, 3000)
    return () => window.clearInterval(t)
  }, [detail?.status, load])

  const statusLine = detail
    ? detail.status === 'running'
      ? '실행 중'
      : detail.status === 'failed'
        ? `실패${typeof detail.exit === 'number' ? ` · exit ${detail.exit}` : ''}`
        : '완료'
    : ''

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`run ${id}`}
        ref={ref as React.RefObject<HTMLElement>}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <div>
            <h2 className="mono">{id}</h2>
            {detail && <p className="drawer-role">{statusLine}</p>}
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기 (Esc)">
            esc
          </button>
        </header>

        {err ? (
          <p className="plain-note err">{err}</p>
        ) : !detail ? (
          <p className="plain-note">불러오는 중…</p>
        ) : (
          <>
            <dl className="drawer-meta">
              <div>
                <dt>유형</dt>
                <dd>{detail.spec.type}</dd>
              </div>
              <div>
                <dt>경로</dt>
                <dd className="mono">
                  {detail.spec.provider}/{authAbbr(detail.spec.auth)} · {detail.spec.model}
                </dd>
              </div>
              {detail.started && (
                <div>
                  <dt>시작</dt>
                  <dd className="mono">{fmtHistoryAt(detail.started)}</dd>
                </div>
              )}
              {detail.ended && (
                <div>
                  <dt>종료</dt>
                  <dd className="mono">{fmtHistoryAt(detail.ended)}</dd>
                </div>
              )}
            </dl>

            <section className="drawer-notes">
              <h3>프롬프트</h3>
              <p>{detail.spec.prompt}</p>
            </section>

            <section className="drawer-history">
              <h3>이벤트</h3>
              {detail.events_tail.length === 0 ? (
                <p className="mono">없음</p>
              ) : (
                detail.events_tail.map((ev, i) => (
                  <p key={i} className="mono run-ev">
                    {ev.at} {ev.type} · {ev.text}
                  </p>
                ))
              )}
            </section>

            {detail.result && (
              <section className="drawer-notes">
                <h3>결과</h3>
                <div className="run-result">{detail.result}</div>
              </section>
            )}

            {detail.status === 'running' && (
              <div className="drawer-actions">
                <button
                  type="button"
                  className="text-action"
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true)
                    runStop(dToken, id)
                      .then(() => {
                        load()
                        onChanged()
                      })
                      .catch((e) => setErr(e instanceof Error ? e.message : '중단 실패'))
                      .finally(() => setStopping(false))
                  }}
                >
                  {stopping ? '중단 중…' : '중단'}
                </button>
              </div>
            )}
          </>
        )}
      </aside>
    </>
  )
}

function RequestSection({
  live,
  dToken,
  providers,
  user,
  patToken,
}: {
  live: boolean
  dToken: string | null
  providers: ProvidersPayload | null
  user: string
  patToken: string
}) {
  const catalog = providers ?? cachedProviders()
  const types = catalog?.request_types?.length ? catalog.request_types : FALLBACK_TYPES
  const combos = catalog?.combos ?? []

  const [typeId, setTypeId] = useState(types[0]?.id ?? 'research')
  const needs = types.find((t) => t.id === typeId)?.needs
  const eligible = useMemo(
    () => combos.filter((c) => needs !== 'files' || c.capabilities.includes('files')),
    [combos, needs],
  )
  const [comboId, setComboId] = useState<string>(() => eligible.find((c) => c.ready)?.id ?? '')
  const combo = eligible.find((c) => c.id === comboId)
  const [modelId, setModelId] = useState<string>(
    () => combo?.models.find((m) => m.default)?.id ?? combo?.models[0]?.id ?? '',
  )
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /* 유형 변경으로 현재 콤보가 부적격해지면 첫 ready 콤보로 */
  useEffect(() => {
    if (!eligible.some((c) => c.id === comboId && c.ready)) {
      setComboId(eligible.find((c) => c.ready)?.id ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible])

  /* 콤보 변경 시 기본 모델 선반영 */
  useEffect(() => {
    setModelId(combo?.models.find((m) => m.default)?.id ?? combo?.models[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comboId])

  const liveReady = live && !!dToken

  const loadRuns = useCallback(async () => {
    if (!dToken) return
    try {
      setRuns(await runsList(dToken))
    } catch {
      /* 목록 로드 실패는 다음 폴링에서 재시도 */
    }
  }, [dToken])

  useEffect(() => {
    if (liveReady) void loadRuns()
  }, [liveReady, loadRuns])

  const anyRunning = runs?.some((r) => r.status === 'running') ?? false

  /* 5s 폴링 + 경과 시계: 실행 중일 때만 */
  useEffect(() => {
    if (!liveReady || !anyRunning) return
    const poll = window.setInterval(() => void loadRuns(), 5000)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [liveReady, anyRunning, loadRuns])

  const submit = async () => {
    if (!prompt.trim()) return
    setBusy(true)
    setNote(null)
    try {
      if (liveReady && dToken && combo) {
        const id = await runCreate(dToken, {
          type: typeId,
          provider: combo.provider,
          auth: combo.auth,
          model: modelId,
          prompt: prompt.trim(),
        })
        setPrompt('')
        setNote(`실행 시작 · ${id}`)
        await loadRuns()
      } else {
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
        const label = types.find((t) => t.id === typeId)?.label ?? typeId
        const runner = combo
          ? { provider: combo.provider, auth: combo.auth, model: modelId }
          : { provider: 'anthropic', auth: 'subscription', model: null }
        const body = [
          `# REQ-${ts} · ${label}`,
          '',
          `- type: ${typeId}`,
          `- runner: ${JSON.stringify(runner)}`,
          `- requested-by: board:${user}`,
          `- requested-at: ${new Date().toISOString()}`,
          `- status: pending`,
          '',
          '## 요청',
          '',
          prompt.trim(),
          '',
          '> 처리 규약: opsd 또는 로컬 세션이 requests/ 를 확인해 처리한다. 완료 시 status: done 으로 수정하고 산출물 경로를 기재한다.',
          '',
        ].join('\n')
        await createFile(patToken, `requests/REQ-${ts}.md`, body, `request: ${label} (board:${user})`)
        setPrompt('')
        setNote(`요청 등록됨 · REQ-${ts}`)
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : '요청 실패')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="panel-req" className="panel" aria-label="요청">
      <div className="panel-head">
        <span className="panel-title">요청</span>
        <span className="panel-count">{liveReady ? '라이브 · 즉시 실행' : '큐 모드 · requests/ 커밋'}</span>
        <span className="panel-rule" aria-hidden="true" />
      </div>

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
            {eligible.length === 0 && <option value="">카탈로그 없음 · 데몬 1회 연결 필요</option>}
            {eligible.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.ready}>
                {c.label}
                {!c.ready && c.reason ? ` — ${c.reason}` : ''}
              </option>
            ))}
          </select>
        </label>
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
            rows={4}
            placeholder="요청 내용…"
          />
        </label>
        <div className="req-submit-row">
          <button type="submit" className="compose-submit req-submit" disabled={busy || !prompt.trim() || (liveReady && !combo)}>
            {busy ? '등록 중…' : liveReady ? '실행' : '요청 등록'}
          </button>
          {note && <span className="plain-note">{note}</span>}
        </div>
      </form>

      {liveReady && (
        <>
          <div className="panel-head req-runs-head">
            <span className="panel-title">실행</span>
            {runs && runs.length > 0 && <span className="panel-count">{runs.length}</span>}
            <span className="panel-rule" aria-hidden="true" />
          </div>
          {runs === null ? (
            <p className="panel-empty">불러오는 중…</p>
          ) : runs.length === 0 ? (
            <p className="panel-empty">없음</p>
          ) : (
            <div className="panel-rows" role="list">
              {runs.slice(0, 10).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="listitem"
                  className="panel-row run-row"
                  onClick={() => setOpenRun(r.id)}
                >
                  <span className="p-time mono">{fmtWhen(runStartMs(r))}</span>
                  <span className="run-type">{r.type}</span>
                  <span className="run-path mono">
                    {r.provider}/{authAbbr(r.auth)}
                  </span>
                  <span className={`run-status${r.status === 'failed' ? ' failed' : r.status === 'done' ? ' done' : ''}`}>
                    {runStatusText(r, now)}
                  </span>
                  <span className="run-prompt">{r.prompt}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {openRun && dToken && (
        <RunDrawer dToken={dToken} id={openRun} onClose={() => setOpenRun(null)} onChanged={() => void loadRuns()} />
      )}
    </section>
  )
}

/* ════════════════════════════════════════════════════════════════ */

type NotifState = { src: 'opsd' | 'gh'; items: Notification[]; sha?: string }

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

  const [view, setView] = useState<'board' | 'mail'>('board')
  const [daemon, setDaemon] = useState<'checking' | 'live' | 'offline'>('checking')
  const [dToken, setDToken] = useState<string | null>(() => getDaemonToken())
  const [providers, setProviders] = useState<ProvidersPayload | null>(null)
  const [notifs, setNotifs] = useState<NotifState | null>(null)
  const [openSection, setOpenSection] = useState<'notif' | 'req' | 'settings' | null>(null)

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

  /* 데몬 감지: /health 1.5s. 성공 시 카탈로그·알림을 데몬에서 가져온다 */
  const refreshDaemon = useCallback(async (tok: string | null) => {
    const ok = await checkDaemonHealth()
    setDaemon(ok ? 'live' : 'offline')
    if (ok && tok) {
      fetchProviders(tok)
        .then(setProviders)
        .catch(() => {})
      notifList(tok)
        .then((items) => setNotifs({ src: 'opsd', items }))
        .catch(() => {})
    }
  }, [])

  useEffect(() => {
    void refreshDaemon(dToken)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(
    async (tok: string) => {
      setLoading(true)
      try {
        const [{ data, sha }, login] = await Promise.all([fetchBoard(tok), whoami(tok)])
        setBoard(data)
        /* 큐 모드 폴백: 데몬 알림이 이미 있으면 GitHub 본은 무시 */
        void fetchNotifications(tok).then((n) => {
          if (n) setNotifs((prev) => (prev?.src === 'opsd' ? prev : { src: 'gh', items: n.items, sha: n.sha }))
        })
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
    },
    [],
  )

  useEffect(() => {
    if (token) void load(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const readAllNotifs = useCallback(async () => {
    if (!notifs) return
    if (notifs.src === 'opsd' && dToken) {
      await notifRead(dToken)
      setNotifs({ src: 'opsd', items: await notifList(dToken) })
    } else if (notifs.src === 'gh' && token && notifs.sha) {
      await markNotificationsHandled(token, notifs.items, notifs.sha)
      const n = await fetchNotifications(token)
      if (n) setNotifs({ src: 'gh', items: n.items, sha: n.sha })
    }
  }, [notifs, dToken, token])

  const saveDaemonToken = useCallback(
    (t: string) => {
      setDaemonToken(t)
      setDToken(t)
      void refreshDaemon(t)
    },
    [refreshDaemon],
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
                    history: [...(a.history ?? []), ...historyHops(a, next, `board:${user}`)],
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

  if (!token || !board) {
    return loading ? (
      <main className="gate">
        <p>불러오는 중…</p>
      </main>
    ) : (
      <TokenGate onSubmit={(t) => void load(t)} error={gateError} />
    )
  }

  const unreadCount = notifs?.items.filter((n) => !n.handled).length ?? 0
  const toggleSection = (s: 'notif' | 'req' | 'settings') => setOpenSection((cur) => (cur === s ? null : s))

  const sections = (
    <>
      {openSection === 'notif' && <NotifSection items={notifs?.items ?? null} onReadAll={readAllNotifs} />}
      {openSection === 'req' && (
        <RequestSection live={daemon === 'live'} dToken={dToken} providers={providers} user={user} patToken={token} />
      )}
      {openSection === 'settings' && <SettingsSection daemon={daemon} dToken={dToken} onSave={saveDaemonToken} />}
    </>
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
          </nav>
        </div>
        <div className="topbar-right mono">
          <button
            type="button"
            className="topbar-action"
            aria-expanded={openSection === 'notif'}
            aria-controls="panel-notif"
            onClick={() => toggleSection('notif')}
          >
            알림{unreadCount > 0 ? ` ${unreadCount}` : ''}
          </button>
          <button
            type="button"
            className="topbar-action"
            aria-expanded={openSection === 'req'}
            aria-controls="panel-req"
            onClick={() => toggleSection('req')}
          >
            요청
          </button>
          <button type="button" className="topbar-action" aria-expanded={openSection === 'settings'} onClick={() => toggleSection('settings')}>
            설정
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

      {view === 'mail' ? (
        <>
          {sections}
          <MailView live={daemon === 'live'} dToken={dToken} queueNotifs={notifs?.items ?? null} />
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

          {sections}

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
