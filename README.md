# Career Board

지원 현황 대시보드. 데이터는 비공개 저장소 [`career-data`](https://github.com/mangowhoiscloud/career-data)의
`data/applications.json` 단일 진실원에서 읽고, 상태 변경은 GitHub Contents API 커밋으로 기록한다.
이 공개 저장소에는 어떤 지원 데이터도 포함되지 않는다.

## 접근 모델

| 주체 | 읽기/쓰기 경로 | 인증 |
|---|---|---|
| 사람 | 보드 UI (GitHub Pages) | fine-grained PAT (career-data, Contents RW) — localStorage 보관 |
| 에이전트 | `career-data` 저장소 git 직접 커밋 | gh CLI / deploy key |

모든 변경은 git 커밋이므로 감사 이력은 git history 그 자체다. 보드는 별도 로그를 만들지 않는다.

커밋 메시지 규약: `status: {회사} {포지션} {from}→{to} (board:{user} | agent:{name})`

## 개발

```bash
npm install
npm run dev    # local
npm run build  # tsc + vite build → dist/
```

`main` push 시 GitHub Actions가 Pages로 배포한다.

디자인 규칙은 [DESIGN.md](./DESIGN.md) — 작업 전 필독.
상태 어휘(8종)와 career-ops 매핑은 DESIGN.md §8.
