---
name: board-design
description: Career Board UI 작업 규칙. 보드 UI를 만들거나 수정할 때 반드시 먼저 읽는다. "보드 디자인", "UI 수정", "컴포넌트 추가" 트리거.
---

# Board Design — 제작 스킬

## 읽기 순서
1. `DESIGN.md` (토큰·상태색·Do/Don't의 SSOT)
2. 본 스킬의 anti-slop 체크리스트
3. 구현 후 `vercel-web-interface-guidelines.md` (동봉 원문, 180줄)로 셀프 리뷰

## 레퍼런스 계보 (왜 이 모양인가)
- **Linear**: 행 기반 리스트, 상태는 컬러 도트+텍스트, 박스·필 최소화. 밀도가 곧 신뢰.
- **GitHub Primer dark**: 본 보드의 팔레트 출처 (#0E1116 계열, 헤어라인 #262D37).
- **Vercel dashboard**: 통계는 카드가 아니라 인라인 숫자열. 모노스페이스 수치.

## Anti-slop 체크리스트 (박스병 차단)
- [ ] 박스 안에 박스 금지. 시각 위계는 **헤어라인·간격·타이포 무게**로만 만든다.
- [ ] 통계 카드(border+padding 사각형 나열) 금지 → 인라인 메트릭 행.
- [ ] 상태 표현은 도트(8px) + 텍스트. 필 배경은 상호작용 대상(메뉴 트리거)에만 14% 알파.
- [ ] border-radius 8px 초과 금지. 그림자는 floating layer(드로어·메뉴)에만 1개.
- [ ] 색은 상태 8종 + accent 1종 외 의미 부여 금지. 장식 그라데이션·이모지·일러스트 금지.
- [ ] 행 hover는 배경 1단계만. 스케일·리프트 애니메이션 금지.
- [ ] 수치는 `tabular-nums` 모노스페이스. 날짜·카운트 전부.
- [ ] 빈 상태·로딩은 한 줄 텍스트 ("불러오는 중…"). 스켈레톤 shimmer 금지.

## 상호작용 규약
- 행 클릭 = 상세 드로어 (문서·이력·메타). 외부 링크는 드로어 안에서만.
- 문서 열람: contents API fetch → Blob URL → 새 탭. 토큰이 URL에 노출되지 않게 한다.
- 모든 mutation은 낙관적 업데이트 + 실패 롤백 + 토스트. 커밋 메시지 규약은 README.
- 키보드: 행 Enter로 드로어, Esc로 닫기, 칩 메뉴 Esc 닫기. `:focus-visible` 링 필수.

## 검증 루프
1. `npm run build` 통과
2. playwright로 토큰 주입 스크린샷 (`scripts/shot.mjs`) → 육안 확인
3. vercel 가이드라인 셀프 리뷰: a11y(aria-label·키보드)·focus·typography(…, tabular-nums)·empty state
