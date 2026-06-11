import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commitBoard, DATA_REPO_URL, fetchBoard, fetchDocBlobUrl, whoami } from './api'
import type { Application, BoardData, Status } from './types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types'

const TOKEN_KEY = 'career-board:token'
type Toast = { kind: 'ok' | 'err'; text: string } | null

/* ── 상태 표시: 도트 + 텍스트 ── */
function StatusDot({ status, asButton, onClick }: { status: Status; asButton?: boolean; onClick?: () => void }) {
  const c = STATUS_COLOR[status]
  const inner = (
    <>
      <span className="dot" style={{ background: c }} aria-hidden="true" />
      {STATUS_LABEL[status]}
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

function StatusMenu({ current, onPick, onClose }: { current: Status; onPick: (s: Status) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])
  return (
    <div className="status-menu" ref={ref} role="menu">
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

/* ── 퍼널 분포 바 ── */
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

/* ── 상세 드로어 ── */
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
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

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
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${app.company} 상세`}>
        <header className="drawer-head">
          <div>
            <h2>{app.company}</h2>
            <p className="drawer-role">{app.role}</p>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기">
            ✕
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
                  JD 열기 ↗
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
                <span className="doc-open mono">{opening === d.path ? '여는 중…' : '열기 ↗'}</span>
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
                {h.at.slice(0, 16).replace('T', ' ')} · {h.from ? `${STATUS_LABEL[h.from]} → ` : ''}
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
      <h1>Career Board</h1>
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
      {error && <p className="gate-error" aria-live="polite">{error}</p>}
      <p className="gate-hint">
        에이전트는 보드를 거치지 않고 <a href={DATA_REPO_URL}>career-data</a>의{' '}
        <code>data/applications.json</code>을 git으로 직접 커밋합니다.
      </p>
    </main>
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
  const [openId, setOpenId] = useState<string | null>(null)

  const showToast = useCallback((t: Toast) => {
    setToast(t)
    if (t) window.setTimeout(() => setToast(null), 4000)
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
      const updated: BoardData = {
        ...board,
        updated: new Date().toISOString().slice(0, 10),
        applications: board.applications.map((a) =>
          a.id === app.id
            ? {
                ...a,
                status: next,
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
      try {
        const newSha = await commitBoard(
          token,
          updated,
          prevSha,
          `status: ${app.company} ${app.role} ${app.status}→${next} (board:${user})`,
        )
        setSha(newSha)
        showToast({ kind: 'ok', text: `${app.company} → ${STATUS_LABEL[next]}` })
      } catch (e) {
        setBoard(prev)
        setSha(prevSha)
        showToast({ kind: 'err', text: e instanceof Error ? e.message : '커밋 실패' })
      }
    },
    [board, token, sha, user, showToast],
  )

  const apps = board?.applications ?? []

  const stats = useMemo(() => {
    const by = (s: Status) => apps.filter((a) => a.status === s).length
    const inProgress = by('screening') + by('assignment') + by('interview')
    const submittedTotal = apps.length - by('ready')
    const responded = inProgress + by('offer') + by('rejected')
    return {
      total: apps.length,
      ready: by('ready'),
      waiting: by('submitted'),
      inProgress,
      rejected: by('rejected'),
      rate: submittedTotal ? Math.round((responded / submittedTotal) * 100) : 0,
    }
  }, [apps])

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
    return [...byWave.entries()].sort((x, y) => y[0].localeCompare(x[0]))
  }, [apps, statusFilter, query])

  const openApp = openId ? apps.find((a) => a.id === openId) : null

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
        <h1>Career Board</h1>
        <div className="topbar-right mono">
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

      <FunnelBar apps={apps} />

      <section className="metrics" aria-label="요약">
        <span>
          <strong className="mono">{stats.total}</strong> 전체
        </span>
        <span>
          <strong className="mono">{stats.ready}</strong> 준비
        </span>
        <span>
          <strong className="mono">{stats.waiting}</strong> 응답 대기
        </span>
        <span>
          <strong className="mono">{stats.inProgress}</strong> 진행 중
        </span>
        <span>
          <strong className="mono">{stats.rejected}</strong> 탈락
        </span>
        <span>
          <strong className="mono">{stats.rate}%</strong> 응답률
        </span>
      </section>

      <section className="filters" aria-label="필터">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={`filter ${statusFilter.has(s) ? 'active' : ''}`}
            aria-pressed={statusFilter.has(s)}
            onClick={() =>
              setStatusFilter((prev) => {
                const next = new Set(prev)
                next.has(s) ? next.delete(s) : next.add(s)
                return next
              })
            }
          >
            <span className="dot" style={{ background: STATUS_COLOR[s] }} aria-hidden="true" />
            {STATUS_LABEL[s]}
          </button>
        ))}
        <input
          type="search"
          className="search"
          placeholder="회사·포지션 검색…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="검색"
          spellCheck={false}
        />
      </section>

      <div className="list" role="table" aria-label="지원 목록">
        {groups.map(([wave, rows]) => (
          <section key={wave} className="wave-group">
            <h2 className="wave-head mono">
              {wave} <span className="wave-count">{rows.length}</span>
            </h2>
            {rows.map((a) => (
              <div
                key={a.id}
                role="row"
                tabIndex={0}
                className="row"
                onClick={() => setOpenId(a.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setOpenId(a.id)
                }}
              >
                <div className="cell-main">
                  <span className="company">{a.company}</span>
                  <span className="role">{a.role}</span>
                </div>
                <span className="cell-years">{a.yearsReq ?? ''}</span>
                <span className="cell-date mono">{a.submitted ?? ''}</span>
                <span className="cell-docs mono">{a.docs?.length ? `${a.docs.length} docs` : ''}</span>
                <span className="cell-status" onClick={(e) => e.stopPropagation()}>
                  <StatusDot status={a.status} asButton onClick={() => setMenuFor(menuFor === a.id ? null : a.id)} />
                  {menuFor === a.id && (
                    <StatusMenu
                      current={a.status}
                      onPick={(s) => void changeStatus(a, s)}
                      onClose={() => setMenuFor(null)}
                    />
                  )}
                </span>
                <span className="cell-notes">{a.notes ?? ''}</span>
              </div>
            ))}
          </section>
        ))}
        {groups.length === 0 && <p className="empty">조건에 맞는 항목 없음</p>}
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

      {toast && (
        <div className={`toast ${toast.kind}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
    </main>
  )
}
