import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commitBoard, DATA_REPO_URL, fetchBoard, whoami } from './api'
import type { Application, BoardData, Status } from './types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types'

const TOKEN_KEY = 'career-board:token'

type Toast = { kind: 'ok' | 'err'; text: string } | null

function StatusChip({ status, onClick }: { status: Status; onClick?: () => void }) {
  const c = STATUS_COLOR[status]
  return (
    <button
      type="button"
      className="chip"
      style={{ color: c, background: c + '24', borderColor: c + '59' }}
      onClick={onClick}
      aria-label={`상태: ${STATUS_LABEL[status]}${onClick ? ', 변경하려면 선택' : ''}`}
    >
      {STATUS_LABEL[status]}
    </button>
  )
}

function StatusMenu({
  current,
  onPick,
  onClose,
}: {
  current: Status
  onPick: (s: Status) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
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
          style={{ color: STATUS_COLOR[s] }}
          onClick={() => onPick(s)}
        >
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  )
}

function TokenGate({ onSubmit, error }: { onSubmit: (t: string) => void; error: string | null }) {
  const [value, setValue] = useState('')
  return (
    <main className="gate">
      <h1>Career Board</h1>
      <p className="gate-sub">
        지원 현황 데이터는 비공개 저장소에 있습니다. fine-grained PAT(career-data 저장소,
        Contents read/write)로 인증하세요. 토큰은 이 브라우저의 localStorage에만 저장됩니다.
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
          autoFocus
        />
        <button type="submit">접속</button>
      </form>
      {error && <p className="gate-error">{error}</p>}
      <p className="gate-hint">
        에이전트는 보드를 거치지 않고 <a href={DATA_REPO_URL}>career-data</a> 저장소의{' '}
        <code>data/applications.json</code>을 git으로 직접 커밋합니다.
      </p>
    </main>
  )
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [board, setBoard] = useState<BoardData | null>(null)
  const [sha, setSha] = useState<string>('')
  const [user, setUser] = useState<string>('')
  const [gateError, setGateError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(new Set())
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const showToast = useCallback((t: Toast) => {
    setToast(t)
    if (t) window.setTimeout(() => setToast(null), 4000)
  }, [])

  const load = useCallback(
    async (tok: string) => {
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
    },
    [],
  )

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
    const submitted = apps.length - by('ready')
    const responded = inProgress + by('offer') + by('rejected')
    return {
      total: apps.length,
      ready: by('ready'),
      waiting: by('submitted'),
      inProgress,
      offer: by('offer'),
      rejected: by('rejected'),
      responseRate: submitted ? Math.round((responded / submitted) * 100) : 0,
    }
  }, [apps])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return apps.filter((a) => {
      if (statusFilter.size > 0 && !statusFilter.has(a.status)) return false
      if (q && !`${a.company} ${a.role} ${a.notes ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [apps, statusFilter, query])

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
        <div className="topbar-right">
          <span className="user">{user}</span>
          <span className="updated mono">updated {board.updated}</span>
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

      <section className="stats" aria-label="요약 통계">
        {[
          ['전체', stats.total],
          ['준비', stats.ready],
          ['응답 대기', stats.waiting],
          ['진행 중', stats.inProgress],
          ['탈락', stats.rejected],
          ['응답률', `${stats.responseRate}%`],
        ].map(([label, value]) => (
          <div className="stat" key={label as string}>
            <span className="stat-value mono">{value}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </section>

      <section className="filters" aria-label="필터">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip filter-chip ${statusFilter.has(s) ? 'active' : ''}`}
            style={
              statusFilter.has(s)
                ? { color: STATUS_COLOR[s], background: STATUS_COLOR[s] + '24', borderColor: STATUS_COLOR[s] }
                : { color: STATUS_COLOR[s] }
            }
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
            {STATUS_LABEL[s]}
          </button>
        ))}
        <input
          type="search"
          className="search"
          placeholder="회사·포지션 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="검색"
        />
      </section>

      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>회사</th>
            <th>포지션</th>
            <th>연차</th>
            <th>제출일</th>
            <th>상태</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((a, i) => (
            <tr key={a.id}>
              <td className="num mono">{i + 1}</td>
              <td className="company">
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer">
                    {a.company}
                  </a>
                ) : (
                  a.company
                )}
                <span className="wave mono">{a.wave}</span>
              </td>
              <td>{a.role}</td>
              <td className="years">{a.yearsReq ?? ''}</td>
              <td className="mono date">{a.submitted ?? ''}</td>
              <td className="status-cell">
                <StatusChip status={a.status} onClick={() => setMenuFor(menuFor === a.id ? null : a.id)} />
                {menuFor === a.id && (
                  <StatusMenu
                    current={a.status}
                    onPick={(s) => void changeStatus(a, s)}
                    onClose={() => setMenuFor(null)}
                  />
                )}
              </td>
              <td className="notes">{a.notes ?? ''}</td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                조건에 맞는 항목 없음
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.text}
        </div>
      )}
    </main>
  )
}
