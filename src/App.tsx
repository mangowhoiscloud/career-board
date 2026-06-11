import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commitBoard, createFile, DATA_REPO_URL, fetchBoard, fetchDocBlobUrl, whoami } from './api'
import type { Application, BoardData, Status } from './types'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from './types'

const TOKEN_KEY = 'career-board:token'

function channelLabel(url?: string, channel?: string): string {
  if (channel) return channel
  if (!url) return ''
  try {
    const h = new URL(url).hostname
    if (h.includes('ashbyhq')) return 'ashby'
    if (h.includes('greenhouse')) return 'greenhouse'
    if (h.includes('lever')) return 'lever'
    if (h.includes('wanted')) return 'wanted'
    if (h.includes('greetinghr')) return 'greeting'
    return h.replace(/^www\./, '').split('.').slice(0, 2).join('.')
  } catch {
    return ''
  }
}
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
      <h1 className="wordmark">career<span className="wordmark-dot">.</span>board</h1>
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
  const [composer, setComposer] = useState(false)
  const [reqType, setReqType] = useState('package')
  const [reqUrl, setReqUrl] = useState('')
  const [reqNote, setReqNote] = useState('')
  const [reqBusy, setReqBusy] = useState(false)

  const showToast = useCallback((t: Toast) => {
    setToast(t)
    if (t) window.setTimeout(() => setToast(null), 4000)
  }, [])

  const submitRequest = useCallback(async () => {
    if (!token || !reqUrl.trim()) return
    setReqBusy(true)
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
    const typeLabel: Record<string, string> = {
      package: '지원 패키지 제작 (이력서+커버레터)',
      coverletter: '커버레터/지원동기 작성',
      research: '회사·JD 리서치',
      submit: '제출 보조 (폼 입력안 작성)',
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
      showToast({ kind: 'ok', text: `요청 등록됨 · REQ-${ts}` })
      setComposer(false)
      setReqUrl('')
      setReqNote('')
    } catch (e) {
      showToast({ kind: 'err', text: e instanceof Error ? e.message : '요청 실패' })
    } finally {
      setReqBusy(false)
    }
  }, [token, reqType, reqUrl, reqNote, user, showToast])


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
                submitted:
                  next === 'submitted' && !a.submitted
                    ? new Date().toISOString().slice(0, 10)
                    : a.submitted,
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
        showToast({
          kind: 'ok',
          text:
            next === 'submitted' && !app.submitted
              ? `${app.company} 제출 확인 · ${new Date().toISOString().slice(0, 10)} 기록`
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

  const stats = useMemo(() => {
    const by = (s: Status) => apps.filter((a) => a.status === s).length
    const inProgress = by('screening') + by('assignment') + by('interview')
    const rejected = by('rejected-docs') + by('rejected-assignment') + by('rejected-interview')
    const submittedTotal = apps.length - by('ready')
    const responded = inProgress + by('offer') + rejected
    return {
      total: apps.length,
      ready: by('ready'),
      waiting: by('submitted'),
      inProgress,
      rejected,
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
        <h1 className="wordmark">career<span className="wordmark-dot">.</span>board</h1>
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

      {composer && (
        <>
          <div className="drawer-backdrop" onClick={() => setComposer(false)} aria-hidden="true" />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="에이전트 작업 요청">
            <header className="drawer-head">
              <div>
                <h2>에이전트 작업 요청</h2>
                <p className="drawer-role">requests/ 에 커밋되어 로컬 Claude Code 세션(구독 쿼터)이 처리합니다</p>
              </div>
              <button type="button" className="drawer-close" onClick={() => setComposer(false)} aria-label="닫기">
                ✕
              </button>
            </header>
            <div className="compose-form">
              <label>
                유형
                <select value={reqType} onChange={(e) => setReqType(e.target.value)}>
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
                  value={reqUrl}
                  onChange={(e) => setReqUrl(e.target.value)}
                  placeholder="https://…"
                  spellCheck={false}
                />
              </label>
              <label>
                메모
                <textarea value={reqNote} onChange={(e) => setReqNote(e.target.value)} rows={4} placeholder="강조 축, 마감일 등…" />
              </label>
              <button type="button" className="compose-submit" disabled={reqBusy || !reqUrl.trim()} onClick={() => void submitRequest()}>
                {reqBusy ? '등록 중…' : '요청 등록'}
              </button>
            </div>
          </aside>
        </>
      )}

      <div className="list" role="table" aria-label="지원 목록">
        <div className="row head" role="row" aria-hidden="true">
          <span>회사 · 포지션</span>
          <span>연차</span>
          <span>공고</span>
          <span className="ta-r">제출일</span>
          <span className="ta-r">문서</span>
          <span>상태</span>
          <span>메모</span>
        </div>
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
                className={`row ${a.status.startsWith('rejected') || a.status === 'hold' ? 'dim' : ''}`}
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
                <span className="cell-channel">
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {channelLabel(a.url, a.channel)}
                    </a>
                  ) : (
                    channelLabel(a.url, a.channel)
                  )}
                </span>
                <span className="cell-date mono">{a.submitted ?? ''}</span>
                <span className="cell-docs mono ta-r">{a.docs?.length ?? ''}</span>
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
