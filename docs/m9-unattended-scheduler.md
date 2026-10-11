# M9 자동 Telegram 리뷰 — 실제 실행 조건

현재 `main`의 M9는 **workflow_dispatch 수동 실행**만 있다. 이 브랜치는 별도의 자동 실행 워크플로를 추가한다.

## 자동 실행 설계

- `.github/workflows/m9-auto-preview.yml`: 매시간 UTC 22분에 GitHub Actions가 실행됨. `workflow_dispatch`는 문제 해결용 옵션일 뿐 자동 실행에 필수 아님. GitHub 예약 작업은 지연될 수 있으며 정확한 시각 보장은 안 됨.
- `scripts/m9_auto_preview.py`: Supabase `creative_briefs` 중 `status=READY`, 최근 24시간에 생성된 초안만 자동 조회. **사용자의 brief_id 입력 없음**.
- `app_private.m9_preview_jobs` + 서비스 전용 RPC로 이미 발송·진행된 초안 버전을 건너뛰어 **중복 Telegram 전송 방지**.
- 기존 코드로 실제 기사 사진 → 이미지 품질 검사 → Pretendard 1080×1350 COVER/BODY + 고정 CTA → 비공개 Storage → 소유자의 비공개 Telegram 채팅으로 완성본 전송.
- 회당 최대 2개 성공, 4회 시도, 사진 수집과 렌더링 중 한 개가 실패하면 다른 초안으로 이동. 불확실한 Telegram 발송은 `SEND_UNCERTAIN` 상태로 유지하고 자동 재발송하지 않음.
- 자동화는 **Telegram 비공개 검토용**이며 Instagram 공개 게시는 하지 않음. 언론사 사진의 공개 재사용 가능 여부는 별도 확인 필요.

## 현재 운영 데이터의 실제 차단 요인 (2026-10-12)

운영 Supabase를 직접 조회한 결과:
- 누적 `content_candidates` **1,945건**, 최근 48시간 **307건**.
- `first_mover_flag=true` 또는 `must_cover_flag=true` 후보 **0건**.
- `content_candidates.reliability_score` 최댓값 **0**.
- `app_private.creative_generation_jobs`의 최신 작업 갱신 **2026-10-02**; `creative_briefs` 최신 생성 **2026-10-02**.
- **근본 원인:** 기존 `creative-generation`은 `first_mover_flag` 혹은 `must_cover_flag`가 true인 후보만 AUTO_PRIORITY 생성 대상으로 보고, `listPriorityCandidateIds()`도 그 후보만 조회. 기존 자동 작업이 실행되더라도 eligible 후보 0건이면 초안을 만들지 않음.
- 실제 `app_private.story_claims` 중 VERIFIED 629건이 있지만 이 검증 결과가 후보 점수·선정에 제대로 연결되는지 별도 추적이 필요. **신뢰도 0인 후보를 무조건 통과시키거나 팩트 검증을 생략해 해결하지 말 것.**

따라서 이 PR의 자동 스케줄을 켜더라도, 상위 뉴스 자동 선별/초안 생성이 복구되지 않으면 **새 Telegram 카드뉴스가 도착하지 않는 게 정상**이다.

## 테스트

- Python 단위/모의 통합: **44 passed**
- Deno M9 테스트: **32 passed**
- GitHub Actions 스케줄 YAML 및 Secret 참조 파싱 통과.
- **실제 GitHub Actions 예약 실행 및 Telegram 발송은 아직 검증하지 않았음.**
- Secret 값은 커넥터에서 조회할 수 없음.

## 배포 전 순서

1. M8.6~M9 사이 후보의 신뢰도 점수 및 `first_mover_flag / must_cover_flag` 미설정 원인을 확인하고 안전하게 복구.
2. 자동 M9 PR 검토 후 병합하면 GitHub Actions schedule이 활성화됨(시간당 최대 두 건의 비공개 Telegram 자동 리뷰 전송). 이미 등록된 Repository secrets 4개만 사용.
3. 실제 새 READY 초안 1건을 기준으로 예약 실행 → Storage/Telegram 수신 확인.
4. 이미지 후보 실패 건은 별도 리뷰 경로 및 경고를 고도화.

코드는 현재 검토용 브랜치에만 존재하며 자동 예약 실행은 아직 활성화하지 않았다.
