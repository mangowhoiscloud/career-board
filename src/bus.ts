/* bus — transport facade (선행 못 ①, SPEC-saas-a §4).
 * 보드의 모든 SSOT 접근을 read·write·list·createFile 4메서드 뒤로 모은다.
 * 현재 구현 GitBus = GitHub Contents API(api.ts 위임). A형 전환 시 HttpBus(API_BASE)로
 * 이 파일만 교체 — App.tsx·컴포넌트는 Bus 인터페이스만 보므로 무수정. 거동 변화 0. */
import {
  fetchJsonFile,
  putJsonFile,
  fetchTextFile,
  updateTextFile,
  createFile,
  fetchDocBlobUrl,
} from './api'

export interface Bus {
  readJson<T>(token: string, path: string): Promise<{ data: T; sha: string } | null>
  writeJson(token: string, path: string, data: unknown, sha: string | null, msg: string): Promise<void>
  readText(token: string, path: string): Promise<string>
  updateText(token: string, path: string, transform: (t: string) => string, msg: string): Promise<void>
  create(token: string, path: string, content: string, msg: string): Promise<void>
  blobUrl(token: string, path: string): Promise<string>
}

/* GitHub Contents API 구현 — api.ts 함수를 그대로 위임 (의미 보존). */
export const GitBus: Bus = {
  readJson: fetchJsonFile,
  writeJson: putJsonFile,
  readText: fetchTextFile,
  updateText: updateTextFile,
  create: createFile,
  blobUrl: fetchDocBlobUrl,
}

/* 단일 진입점 — A 전환 시 여기만 HttpBus로 교체. */
export const bus: Bus = GitBus
