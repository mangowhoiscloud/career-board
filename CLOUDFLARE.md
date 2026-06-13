# Cloudflare Pages 배포 (B6 — 보드 프론트)

현 GitHub Pages 배포는 그대로 두고, Cloudflare Pages에 **별도 배포**한다. 차이는 빌드 env뿐:
`VITE_API_BASE`가 있으면 보드는 control-plane(OIDC 세션 + Bearer + CORS)을 쓰고, 없으면
기존 GitHub PAT 경로(GitHub Pages)로 동작한다 (`src/backend.ts`의 듀얼 스위치).

프록시 불필요: 보드는 Bearer + CORS로 `career-control-plane.fly.dev`를 **직접** 호출한다
(쿠키+프록시 단일오리진이 아니라 토큰 기반). 그래서 Cloudflare는 **정적 호스팅만** 한다.

## 연결 (운영자, 1회)
1. Cloudflare 대시보드 → Workers & Pages → **Create → Pages → Connect to Git** → `mangowhoiscloud/career` 선택.
2. 빌드 설정:
   - Framework preset: **None** (Vite)
   - **Build command: `npm run build:cf`**  ← control-plane 모드(VITE_API_BASE·VITE_BASE=/ 가 스크립트에
     박혀 있음). 기본 `npm run build`로 하면 GitHub PAT 모드로 빌드되니 반드시 `build:cf`.
   - Build output directory: `dist`
3. (별도 env 불필요 — `build:cf`가 VITE_API_BASE/VITE_BASE를 주입. CF UI에 env 안 넣어도 됨.)
4. Save & Deploy → `career.<subdomain>.workers.dev`(Worker) 또는 `*.pages.dev`.
5. SPA 라우팅: `wrangler.jsonc`의 `assets.not_found_handling: single-page-application`이 네이티브
   처리(새로고침/딥링크 → index.html). `_redirects`는 쓰지 않는다(Workers Assets에서 `/* /index.html
   200`은 무한루프로 거부됨 — code 100324).

## 배포 후 — control-plane 쪽 2가지
1. **CORS 허용 오리진 추가**: 새 pages.dev 오리진을 `ALLOWED_ORIGINS`에 추가.
   `fly secrets set ALLOWED_ORIGINS="https://mangowhoiscloud.github.io,https://<프로젝트>.pages.dev" -a career-control-plane`
2. **OAuth redirect URI 추가**(보드가 직접 콜백받지 않고 control-plane이 받으므로 변경 없음 —
   콜백은 `career-control-plane.fly.dev/auth/google/callback` 유지. 단 `BOARD_URL`을 새 pages.dev로
   바꾸면 로그인 후 그 보드로 복귀): `fly secrets set BOARD_URL="https://<프로젝트>.pages.dev/" -a career-control-plane`

## 데이터 전제
보드가 control-plane에서 읽는 상태(applications·mail·notifications·runner-state)는 **DB(bus_kv)에
있어야** 보인다. 최초 1회 섀도 이주 필요: `control-plane/migrate.py`(tenant 'op')로 git→DB 적재.
러너의 이벤트도 컷오버(POST /events) 전까지는 git이 SSOT이므로, 완전 전환 전에는 GitHub Pages
보드를 주 운영으로 유지하고 Cloudflare 보드는 검증용으로 병행한다.

## mango.career (나중에, 유료)
`.career` 도메인 구매 후 Cloudflare Pages 프로젝트에 **커스텀 도메인 추가**(apex 네이티브 지원).
그 다음 `ALLOWED_ORIGINS`·`BOARD_URL`에 `https://mango.career` 추가하면 전환 완료. 재빌드 불필요.
