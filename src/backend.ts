/* 백엔드 전환 (B6) — VITE_API_BASE 설정 시 control-plane(OIDC 세션 + Bearer + CORS),
   미설정 시 기존 GitHub PAT 경로. 듀얼: 현 GitHub Pages 보드는 무손상, Cloudflare 배포는
   API_BASE 를 주입해 control-plane 을 쓴다. 데이터 스위치를 이 모듈에 중앙화한다.

   인증: 같은 오리진이면 httpOnly 쿠키(서버가 처리), 교차 오리진(보드↔fly.dev)은 Bearer.
   로그인 콜백이 URL #code= 로 일회 핸드오프 코드를 주고, exchangeCodeFromUrl 이 세션 토큰으로
   교환해 저장 → 이후 모든 요청에 Bearer. */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || ''
export const httpMode = !!API_BASE
export const TOKEN_KEY = 'career-board:token'

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export async function cpReadState<T>(token: string, path: string): Promise<{ data: T; sha: string } | null> {
  const res = await fetch(`${API_BASE}/api/state/${encodeURI(path)}`, { headers: authHeaders(token) })
  if (res.status === 404) return null
  if (res.status === 401) throw new Error('세션이 만료되었습니다 (401)')
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`)
  const json = await res.json()
  return { data: json.data as T, sha: '' } // DbBus 는 sha 낙관잠금 없음(마지막 쓰기 우선)
}

export async function cpWriteState(token: string, path: string, data: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}/api/state/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) throw new Error(`저장 실패 (${res.status})`)
}

export async function cpMe(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/me`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error('세션 무효 (재로그인 필요)')
  const json = await res.json()
  return (json.email as string) || 'unknown'
}

/* OAuth 콜백 복귀: URL #code= → /auth/exchange → 세션 토큰 저장. 반환 토큰 또는 null.
   교환 후 해시를 즉시 제거(토큰·코드를 히스토리에 안 남김). */
export async function exchangeCodeFromUrl(): Promise<string | null> {
  const m = window.location.hash.match(/[#&]code=([^&]+)/)
  if (!m) return null
  const code = decodeURIComponent(m[1])
  history.replaceState(null, '', window.location.pathname + window.location.search)
  try {
    const res = await fetch(`${API_BASE}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) return null
    const json = await res.json()
    const tok = json.token as string
    localStorage.setItem(TOKEN_KEY, tok)
    return tok
  } catch {
    return null
  }
}

export function loginRedirect(): void {
  window.location.href = `${API_BASE}/auth/google/start`
}

export async function cpLogout(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: authHeaders(token) })
  } catch {
    /* 서버 폐기 실패해도 클라이언트는 토큰을 지운다 */
  }
}
