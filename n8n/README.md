# Instagram Collector Schedule

이 workflow는 `Asia/Seoul` 기준 30분마다 다음 invoke-only chain을 실행합니다.

```text
Schedule → collect-instagram → intelligence → sync-notion-intelligence
```

Collector와 Intelligence가 성공한 경우에만 다음 단계로 진행하며, Notion sync만
실패를 workflow 전체에 전파하지 않습니다. Meta token과 Supabase secret key는
n8n에 저장하거나 workflow export에 넣지 않습니다.

## Import와 credential 연결

1. n8n에서 `workflows/instagram-collector-schedule.json`을 import합니다.
2. 세 HTTP Request node가 project `byymtttpwmllqvggnddm`의
   `/functions/v1/collect-instagram`, `/functions/v1/intelligence`,
   `/functions/v1/sync-notion-intelligence`인지 확인합니다.
3. 기존 `Instagram Collector Invoke Secret` Header Auth credential을 세 HTTP
   Request node에 연결합니다. credential의 header name은 `Authorization`이며,
   secret 값은 n8n credential store에만 입력합니다.
4. credential 값, token, key가 workflow export·문서·screenshot에 남지 않았는지
   확인합니다.

## Manual 실행과 publish

1. workflow timezone이 `Asia/Seoul`, Schedule Trigger가 30분 간격인지 확인합니다.
2. `Collect Active Instagram Accounts` node를 포함한 workflow를 manual 실행합니다.
3. collector가 HTTP 200을 반환하면 aggregate JSON을 확인하고, 일부 계정 실패가
   있어도 결과를 보존한 채 `Run Content Intelligence`가 한 번 실행되는지 확인합니다.
4. intelligence가 성공하면 `Sync Daily Intelligence to Notion`이 한 번 실행됩니다.
   Intelligence HTTP 202와 body의
   `status: "already_running"`은 정상적인 동시 실행 방지 응답입니다.
5. Notion sync 응답은 JSON으로 보존하며, 개별 후보 실패는 `failed` count로 확인합니다.
6. 검증 후 workflow를 publish합니다. 기존 Telegram/OpenAI workflow와 연결하지
   않습니다.

## Retry semantics

`Run Content Intelligence`는 120초 timeout을 사용하고 실패 시 Notion sync로
진행하지 않습니다. `already_running`(HTTP 202)은 JSON으로 보존하며 다음 scheduled
실행에서 다시 시도할 수 있습니다. `Sync Daily Intelligence to Notion`은 120초
timeout, `continueOnFail`, `neverError`를 사용해 Notion 장애가 앞 단계 성공 결과를
무효화하지 않습니다. Notion API 자체의 429/5xx/timeout retry는 Edge Function
client가 bounded retry로 처리합니다.

## Export 검증

저장소 export를 갱신한 뒤에는 node 연결, endpoint, timeout, JSON/202 처리,
credential reference와 secret marker를 검사합니다.

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
```
