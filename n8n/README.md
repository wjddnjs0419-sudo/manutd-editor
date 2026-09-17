# Instagram Collector Schedule

이 workflow는 `Asia/Seoul` 기준 30분마다 active Instagram 계정을 수집한 뒤,
collector가 정상 응답한 경우 같은 실행에서 Content Intelligence Edge Function을
정확히 한 번 호출합니다. collector의 HTTP 200 partial result는 그대로 다음 단계로
전달됩니다. Meta token과 Supabase secret key는 n8n에 저장하거나 workflow export에
넣지 않습니다.

## Import와 credential 연결

1. n8n에서 `workflows/instagram-collector-schedule.json`을 import합니다.
2. 두 HTTP Request node가 project `byymtttpwmllqvggnddm`의
   `/functions/v1/collect-instagram` 및 `/functions/v1/intelligence`인지 확인합니다.
3. 기존 `Instagram Collector Invoke Secret` Header Auth credential을 두 HTTP
   Request node에 연결합니다. credential의 header name은 `Authorization`이며,
   secret 값은 n8n credential store에만 입력합니다.
4. credential 값, token, key가 workflow export·문서·screenshot에 남지 않았는지
   확인합니다.

## Manual 실행과 publish

1. workflow timezone이 `Asia/Seoul`, Schedule Trigger가 30분 간격인지 확인합니다.
2. `Collect Active Instagram Accounts` node를 포함한 workflow를 manual 실행합니다.
3. collector가 HTTP 200을 반환하면 aggregate JSON을 확인하고, 일부 계정 실패가
   있어도 결과를 보존한 채 `Run Content Intelligence`가 한 번 실행되는지 확인합니다.
4. intelligence 응답은 JSON으로 보존되며, HTTP 202와 body의
   `status: "already_running"`은 정상적인 동시 실행 방지 응답입니다.
5. 검증 후 workflow를 publish합니다. 기존 Telegram/OpenAI workflow와 연결하지
   않습니다.

## Retry semantics

`Run Content Intelligence`는 120초 timeout과 continue-on-failure로 설정되어 있어
일시적인 오류가 발생해도 collector 실행 결과가 사라지지 않습니다. 한 workflow
실행에서 intelligence 자동 재시도는 하지 않으므로 collector 성공 경로의 호출 수는
항상 1회입니다. `already_running`(HTTP 202)은 재시도하지 않고 현재 실행을
종료하며, 다음 scheduled 실행 또는 사용자가 시작한 manual 실행에서 다시 시도할
수 있습니다. transport/5xx 오류도 같은 방식으로 기록한 뒤 다음 실행에서 재시도합니다.

## Export 검증

저장소 export를 갱신한 뒤에는 node 연결, endpoint, timeout, JSON/202 처리,
credential reference와 secret marker를 검사합니다.

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
```
