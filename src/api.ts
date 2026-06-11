import type { BoardData } from './types'

const OWNER = 'mangowhoiscloud'
const REPO = 'career-data'
const PATH = 'data/applications.json'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`

export const DATA_REPO_URL = `https://github.com/${OWNER}/${REPO}`

function b64decodeUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

export interface Fetched {
  data: BoardData
  sha: string
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export async function fetchBoard(token: string): Promise<Fetched> {
  const res = await fetch(API, { headers: headers(token) })
  if (res.status === 401) throw new Error('토큰이 유효하지 않습니다 (401)')
  if (res.status === 404) throw new Error('데이터 저장소 접근 불가 (404) — 토큰 권한을 확인하세요')
  if (!res.ok) throw new Error(`데이터 로드 실패 (${res.status})`)
  const json = await res.json()
  return { data: JSON.parse(b64decodeUtf8(json.content)) as BoardData, sha: json.sha }
}

export async function commitBoard(
  token: string,
  data: BoardData,
  sha: string,
  message: string,
): Promise<string> {
  const body = {
    message,
    content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'),
    sha,
  }
  const res = await fetch(API, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) throw new Error('충돌: 다른 곳에서 먼저 수정됨 — 새로고침 후 재시도')
  if (!res.ok) throw new Error(`커밋 실패 (${res.status})`)
  const json = await res.json()
  return json.content.sha as string
}

export async function fetchDocBlobUrl(token: string, path: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`, {
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`문서 로드 실패 (${res.status})`)
  const json = await res.json()
  const bin = atob((json.content as string).replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const mime = path.endsWith('.html')
    ? 'text/html'
    : path.endsWith('.pdf')
      ? 'application/pdf'
      : 'text/plain;charset=utf-8'
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export async function whoami(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', { headers: headers(token) })
  if (!res.ok) return 'unknown'
  const json = await res.json()
  return json.login as string
}
