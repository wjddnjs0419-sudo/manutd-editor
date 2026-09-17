# Instagram Collector Schedule

이 workflow는 30분마다 Supabase `collect-instagram` Edge Function을 호출합니다. Meta token이나 Supabase secret key를 n8n에 저장하지 않으며, 기존 Telegram/OpenAI workflow와 연결하지 않습니다.

## Import와 credential 연결

1. n8n에서 `workflows/instagram-collector-schedule.json`을 import합니다.
2. HTTP Request node의 endpoint가 project `byymtttpwmllqvggnddm`의 `/functions/v1/collect-instagram`인지 확인합니다.
3. generic Header Auth credential을 `Instagram Collector Invoke Secret`이라는 이름으로 생성합니다.
4. header name은 `Authorization`, value는 `Bearer <COLLECTOR_INVOKE_SECRET>`로 설정합니다. 실제 값은 workflow export, 문서, screenshot에 남기지 않습니다.
5. `Collect Active Instagram Accounts` node에 위 credential을 연결합니다.

## 검증과 publish

1. workflow timezone이 `Asia/Seoul`인지 확인합니다.
2. HTTP Request node를 manual 실행합니다.
3. HTTP 200 aggregate JSON에서 `accounts_success + accounts_failed = accounts_requested`이고 `accounts` 길이도 같은지 확인합니다. 일부 계정 실패가 있어도 HTTP 200 결과를 그대로 보존합니다.
4. Schedule Trigger가 30분 간격인지 확인합니다.
5. workflow를 publish합니다.
6. 최대 35분 안에 첫 scheduled execution이 생성되는지 확인합니다.

저장소 export를 갱신한 뒤에는 credential binding이나 secret 값이 들어오지 않았는지 반드시 검사합니다.

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
```
