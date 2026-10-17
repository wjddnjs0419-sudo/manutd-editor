# gnews-decoder PoC 평가 보고서

실행일: 2026-10-12 (Asia/Seoul)
판정: **CONDITIONAL**

## 요약

실제 네트워크에서 최신 Google News 관측 30건을 읽어 검증했다. `gnews-decoder==0.1.1`은 30건 모두 Google News가 아닌 HTTPS 원본 도메인으로 변환했다. 같은 30건에 과거 저장소의 `google_news_resolution.ts`를 실행한 비교군도 30건 모두 변환했다. 이 표본에서는 성공률 개선은 없고, 배치 방식이 Google 요청 수를 90건에서 61건으로 줄였으며 전체 처리시간은 23.36초에서 8.63초로 줄었다.

단, 두 비교는 **로컬 실행 환경에서 같은 표본으로 지금 실행한 비교**다. 운영 Edge Function의 과거 결과는 별도 기준으로 1,206건 중 변환 0건, 본문 추출 0건이며, 이전 진단에는 Supabase 실행 환경에서 Google 요청 429가 기록되어 있다. 로컬 성공을 운영 성공으로 간주할 수 없다. 또한 URL 30건 변환 성공과 본문 추출 성공은 다르다. 원문 페이지 10건 중 HTTP 접근은 9건, 현재 추출 방식으로 본문을 추출한 건 3건이었다.

따라서 운영 통합 가능성은 있지만, 실제 Supabase/GitHub Actions 실행 환경에서 429·동작 안정성을 별도 검증해야 한다. 이 PoC는 코드·설정·데이터베이스를 운영 적용하지 않았다.

## 실행 환경과 재현

- Python 3.14.4, `gnews-decoder==0.1.1`, `requests==2.34.2`; 패키지는 `/tmp/manutd-gnews-decoder-poc/venv` 격리 환경에 설치했다.
- 공식 PyPI API 문서에 명시된 `decode()`와 `decode_many()`를 확인했고 `decode_many()`를 사용했다. 호출 인자는 동시성 2, 요청 제한시간 8초로 설정했다. `decode_many()`는 결과를 입력 URL과 원문 URL의 매핑으로 반환한다. 패키지 API 및 구현은 [PyPI 0.1.1 문서](https://pypi.org/project/gnews-decoder/0.1.1/), [공식 저장소의 공개 구현](https://github.com/mohamidi74/gnews-decoder/blob/main/src/gnews_decoder/_rpc.py)에서 확인했다.
- 30개 입력은 Supabase 프로젝트 `byymtttpwmllqvggnddm`의 `app_private.discovery_observations`에서 `provider_id = google-news`인 행을 **SELECT만** 해 최신순·URL 중복 제거로 선정했다. BBC, ESPN, Yahoo Sports 등 여러 매체를 포함했다. 원본 제목과 URL은 재현 fixture에 저장되어 있다.
- Google의 동일 호스트 기사 URL 리다이렉트는 최대 1회만 수동 처리했다. 동시 요청은 2개 이하로 제한했고, 429이면 남은 Google 요청을 중단한다. 429 재시도는 하지 않았다. 원문 페이지 확인은 HTTPS만 허용하고, DNS에서 사설/특수 IP를 차단한 뒤 확인된 공인 IP로 연결했다. 원문 리다이렉트는 최대 3회이며 매 단계 목적지를 다시 검사했다.
- 아래의 Google URL/제목은 읽기 전용 DB에서 가져온 공개 기사 메타데이터다. API 키와 DB 비밀번호를 fixture, 결과 또는 로그에 기록하지 않았다.

재현 명령:

```sh
python3 -m venv /tmp/manutd-gnews-decoder-poc/venv
/tmp/manutd-gnews-decoder-poc/venv/bin/pip install -r scripts/requirements-gnews-decoder-poc.txt
PYTHONDONTWRITEBYTECODE=1 /tmp/manutd-gnews-decoder-poc/venv/bin/python -m unittest scripts/test_gnews_decoder_poc.py -v
PYTHONDONTWRITEBYTECODE=1 /tmp/manutd-gnews-decoder-poc/venv/bin/python scripts/gnews_decoder_poc.py --input scripts/fixtures/gnews-decoder-input.json --output /tmp/gnews-decoder-poc-results.json --body-limit 10
```

테스트 스크립트는 실제 응답 상태와 요청 시간을 결과 JSON에 남긴다. 아래 수치는 이 환경에서 실제 실행해 얻은 결과다. 오프라인 단위 테스트 12건도 실행해 모두 통과했다.

## URL 복원 방식과 실시간 비교

현재 체크아웃에는 `supabase/functions/trend-discovery/google_news_resolution.ts`와 `docs/google-news-publisher-extraction.md`가 없다. 비교에는 저장소 Git 이력의 커밋 `648e3d4f26bb9fc5867fe97e67e940e1bec687d8`에 존재하는 resolver 소스를 임시 디렉터리에 추출해 사용했다. 저장소 파일이나 배포 코드는 수정하지 않았다.

기존 resolver는 기사별로 `/articles/<id>` 페이지를 가져와 `data-n-a-sg`, `data-n-a-ts` 서명 값을 읽고 기사별 `Fbv4je` RPC POST를 보낸다. 패키지는 입력받은 RSS article URL을 먼저 읽고 `decode_many()`에서 개별 서명 GET 뒤 여러 기사를 한 RPC POST로 묶는다. 두 구현 모두 같은 비공식 서명 기반 `Fbv4je` 내부 API와 `/batchexecute` 경로를 사용한다. 패키지에는 기본 consent cookie가 있고 기존 resolver에는 같은 기본값이 없었다. 이 차이가 성공률 차이를 만들었다고 입증한 것은 아니다. [패키지 구현](https://github.com/mohamidi74/gnews-decoder/blob/main/src/gnews_decoder/_rpc.py)

기존 구현은 리다이렉트가 예상한 호스트/경로를 벗어나거나 Google이 서명 속성명·RPC 응답 envelope를 바꾸면 후보를 거부하거나 원문 URL을 얻지 못할 수 있다. 기사마다 POST하는 구조라 같은 수의 URL을 처리할 때 Google RPC 호출이 배치형보다 많다. 새 패키지도 같은 Google 내부 서명·RPC 계약을 파싱하므로 해당 형식 변경에는 취약하며, 배치만으로 429 위험이 사라지지는 않는다.

기존 운영 0/1,206의 원인을 모두 parser/RPC 구현 문제로 단정할 수는 없다. 기존 진단에는 배포 함수가 URL 본문 요청 단계에서 Google 429를 받아 RPC까지 진행하지 못한 사례가 있고, 이전 버전에는 리다이렉트 호스트 검증 문제도 기록돼 있다. 로컬 진단은 별도 네트워크 경로에서 성공한 기록이 있다. 자세한 과거 관측은 [기존 진단 기록](diagnostics/2026-10-11-google-news-resolution.md)에 있다. 따라서 이 PoC의 동일 표본 로컬 비교는 resolver 구현 효율을 비교하지만, production 0%의 원인을 분리해 입증하지는 않는다.

| 지표 | 기존 방식 (30건 실시간) | gnews-decoder (30건 실시간) |
| --- | ---: | ---: |
| 테스트 기사 수 | 30 | 30 |
| URL 변환 성공 건수 | 30 | 30 |
| URL 변환 성공률 | 100.0% | 100.0% |
| 평균 처리 시간 | 778.67 ms/건 | 287.61 ms/건 |
| 주요 실패 원인 | 이 표본에서는 없음 | 이 표본에서는 없음 |
| Google 요청 수 | 90 | 61 |
| 총 처리 시간 | 23.36초 | 8.63초 |
| 429 응답 | 없음 | 없음 |

평균 처리 시간은 각 실행 전체 벽시계 시간 ÷ 30이다. 기존 resolver는 기사별 순차 실행이고, 패키지는 동시성 2의 배치 실행이므로 이 값은 패키지의 개별 URL 지연시간을 뜻하지 않는다. 이번 패키지 요청은 Google GET 60건(30건 각각 최초 302 및 같은 호스트 후속 GET), batched RPC POST 1건이었다. 기존 resolver는 GET 60건과 RPC POST 30건을 보냈다. 이는 이 표본과 한 번의 배치 설정에서 관측한 값이며, 패키지나 Google이 보장하는 고정 요청 수는 아니다.

운영 DB의 0/1,206 결과는 위 동일 표본의 실시간 대조군이 아니다. 별도 읽기 전용 집계에서 현재 `google-news` 행 1,206건 중 원문 URL 전환 0건, 본문 추출 0건을 확인했다. 기존 운영 성공률은 0%지만, 이 PoC의 로컬 비교기 성공률은 양쪽 모두 100%다.

## 기사별 URL 변환 결과 (30건)

`Google 요청 시간 합`은 해당 URL의 최초 요청과 안전한 동일 호스트 후속 요청의 HTTP 시간 합이다. 배치 큐에서 기다린 시간과 RPC 시간은 포함하지 않는다. 전체 배치 벽시계 시간은 위 비교 표를 기준으로 한다. 이 30건은 서로 다른 Google URL이다.

| # | 기사 제목 | 원래 Google News URL | URL 변환 성공 | 변환된 언론사/원본 URL | 최종 도메인 | Google 요청 시간 합 (ms) | 실패 원인 |
| ---: | --- | --- | --- | --- | ---: | --- |
|  1 | Manchester United eye Brazilian talent as Euro outfit set huge €80m asking price - Yahoo Sports | [원본](<https://news.google.com/rss/articles/CBMikAFBVV95cUxPdzFELVZtMVRFQVdCWGRYclI2VFlnNlpXWDc4YS1EVmppcm9CcVBGRTR0RXM4OU8yT3VMLXlJZXBKejVGZUxUUEk1Q0FuSHNNaGwwbzRXQ1lQMmNoM18ySGlrU3NJeWZ4blFwbXU3X0NIRENlMWNvQXlBeEtFUW82VGRUa0V2OEc1bWUzc0FsQ20?oc=5>) | 성공 | [https://sports.yahoo.com/articles/manchester-united-eye-brazilian-talent-065000769.html](<https://sports.yahoo.com/articles/manchester-united-eye-brazilian-talent-065000769.html>) | sports.yahoo.com | 820.22 | —  |
|  2 | Transfer news LIVE: Bayern release Harry Kane contract statement as Milan want Endrick - Transfermarkt | [원본](<https://news.google.com/rss/articles/CBMi0AFBVV95cUxPTUt1WVdaTEhCaEVWaHlHNFRBckgwVnpmSFJoaXVoZlNTT014VXVZMXNfWXVzWVJFR0pKQlRnVGJRd25qX1VQZjd5Qzc4eWViQzI2end6amYwekpISkFBSUxicWVudDdYNm5aM1ppV3dKNnV4LTdNUXZNZ041dzdzTkJUMk1jMEdTMHlNZnNRV09aYWVUc29nQUhKaDVvelVjRFVLOEFyb25UQzBDR3VRb2tKa25HR1VFSmJRZENRcG9mYnM0d3kwZ3QzTTVnUC1o?oc=5>) | 성공 | [https://www.transfermarkt.com/transfer-news-live-liverpool-amp-man-utd-eye-mane-as-olise-to-be-offered-release-clause-/view/news/445145](<https://www.transfermarkt.com/transfer-news-live-liverpool-amp-man-utd-eye-mane-as-olise-to-be-offered-release-clause-/view/news/445145>) | www.transfermarkt.com | 759.45 | —  |
|  3 | Transfer news LIVE: Bayern release Harry Kane contract statement as Milan want Endrick - Transfermarkt | [원본](<https://news.google.com/rss/articles/CBMizAFBVV95cUxOUUpWRG5uWnFlOG5vNHNEOUtPZzdKUXdQTjZ2b05vMjlXZWpPU3JkYU5tb1dIZE14WFR3bUZkM28wVC1ZTWo2Z3p5MUlidHFtUVNFeWd2S0tMNmlHZk13SXE1XzY4TGJCR0tVelpOR1dxdkxLYk5sNTUxdmV5WkJnWENwUXphSnhJMGhzZ2lGd1l4Q3c2ODFmSlNUS0tqZ3FBelJZaXFxT0M1LV9qYTR6UFl4bDhhbmV1RGwyaVp5SkJnQkhuRWtCallJQW4?oc=5>) | 성공 | [https://www.transfermarkt.com/transfer-news-live-bayern-release-harry-kane-contract-statement-as-milan-want-endrick/view/news/445145](<https://www.transfermarkt.com/transfer-news-live-bayern-release-harry-kane-contract-statement-as-milan-want-endrick/view/news/445145>) | www.transfermarkt.com | 705.89 | —  |
|  4 | Newcastle United injury update on Sunday sees added positive news ahead of Coventry City - Yahoo Sports | [원본](<https://news.google.com/rss/articles/CBMijAFBVV95cUxQYm85WFp2SHVnZnlYMDdzdkx3bU5OcHRPMFBqZHFkeWdvWHplUzg1OGgtV2ZhWHdsdENZWW1VcXlRbm1QalhYTTloLVoxLU9GdmxlUlR5azBLdnZKYnh3cjh2b1VrelZfdG5PXzUzYlpnUExucFViSUkzWlRISVl3akwxTlR4MUpuLXhiRg?oc=5>) | 성공 | [https://sports.yahoo.com/articles/newcastle-united-injury-sunday-sees-062728051.html](<https://sports.yahoo.com/articles/newcastle-united-injury-sunday-sees-062728051.html>) | sports.yahoo.com | 699.54 | —  |
|  5 | Arsene Wenger urged to stand against Gianni Infantino for FIFA presidency - Paper Talk \| Football News - Sky Sports | [원본](<https://news.google.com/rss/articles/CBMi4gFBVV95cUxQcDI5YVI1dlF2RWEycklaYWRLcnkwQlR2dS1zQ0JTN2ZLM3JtZnp2amN3YzM5ZzFMVlpyc3lEWlBGQ0RLdzkteUpEVHVyWHo2dU1MdnZiNS1YYVNTMVV1WlFhY19UQnFscmdtS20wNEhuQ2g2Mk16ZVk5Yld3UkItRldJU3UtUjRVSHdBZ0VMMjhQNWpDTnpHNFF6T21reUluX3piaHM4V1BtS0FKLXIzakpOVWh3OEdRNFhyLWZrVXhHUlRlR1o0UkM3eEhxX0pVY3hUOGEzYmRSSXdRcm5VRGdR?oc=5>) | 성공 | [https://www.skysports.com/football/transfer-paper-talk/13597627/arsene-wenger-urged-to-stand-against-gianni-infantino-for-fifa-presidency-paper-talk](<https://www.skysports.com/football/transfer-paper-talk/13597627/arsene-wenger-urged-to-stand-against-gianni-infantino-for-fifa-presidency-paper-talk>) | www.skysports.com | 708.83 | —  |
|  6 | Man Utd Transfer Journalists Tier List 2026: Who to Trust - The False 9 | [원본](<https://news.google.com/rss/articles/CBMifkFVX3lxTE1HMjVnZ1ZQN21sbFpiMDk4Y0stTWR4NV95bk41OWFEZV9FUnR5d3ZjRzZqLUNzTVNWQldDRWdXN0hBVnpqTDlaT2tiRE1UMTdJVENPQWc2cHVSUDVneV9LTTNhc2VfY01oYkl6ZGpIQi01aUNabzl5R1hDdEtxdw?oc=5>) | 성공 | [https://thefalse9.com/2026/10/man-utd-transfer-journalists-tier-list.html](<https://thefalse9.com/2026/10/man-utd-transfer-journalists-tier-list.html>) | thefalse9.com | 717.43 | —  |
|  7 | Man Utd dealt major Benjamin Sesko injury blow as Michael Carrick admits return date for £65m striker is 'not clear' - Goal.com | [원본](<https://news.google.com/rss/articles/CBMimwFBVV95cUxQcDBIbXJOeW9OVDE3Wk13UHhZY2hZMGhrUzhjU1NWRUszQndWSDdTSDh3c0h3dl96R1hscUI3Mno4OXVqU3h2S3lLSHhwdU5yRjJFOURfbkRMZGM3ZzdtdzBBZWMtWk56YmYyZGxlZ0FEcV91SFF0bjJzRUt3TXJJQ3pMbXVpRURqNXNWanNpckFmYVI5ZW1walA5NA?oc=5>) | 성공 | [https://www.goal.com/en/lists/man-utd-benjamin-sesko-injury-michael-carrick/bltc7df89decd2be5d2](<https://www.goal.com/en/lists/man-utd-benjamin-sesko-injury-michael-carrick/bltc7df89decd2be5d2>) | www.goal.com | 626.69 | —  |
|  8 | Worst in 40 years! Manchester United script unwanted record after draw against 10-man Tottenham Hotspur - The Times of India | [원본](<https://news.google.com/rss/articles/CBMinAJBVV95cUxOc01wcWhwVDdmRHVKVTY4RmRjRFNRdkgxRmMycDlteXBpVGdqTmJEUzFXVUIyVXNIWk03cHhmd2pZemNJQ2JfcmZIYlNxWGJxMWdjYVhFTDJVc25neEgxTldXSUsyb29GR2VtdXB6VkgwMXAtTTBlX3NRRVVycnYxWjllcERhRUIwbXdjb1EzeGdzN3hYYmVOMG9Dcm5XZTRnOG1JOUpnSXVGLU9SVjFuTUhfcnhWbWVzZzRpYUh1cjJXQUFKN1VJeVlUUktqRU5ycmNSU2RXSG9BTmZKRnpZU29IVG9nOUJPNnVPbGVrdjV4WEJkRHVSUEZpMDJKbk1NYmE1X0JLWXdNZ01iUDd1NDFKT291V0VVUnRKcg?oc=5>) | 성공 | [https://timesofindia.indiatimes.com/sports/football/top-stories/worst-in-40-years-manchester-united-script-unwanted-record-after-draw-against-10-man-tottenham-hotspur/articleshow/134864014.cms](<https://timesofindia.indiatimes.com/sports/football/top-stories/worst-in-40-years-manchester-united-script-unwanted-record-after-draw-against-10-man-tottenham-hotspur/articleshow/134864014.cms>) | timesofindia.indiatimes.com | 685.05 | —  |
|  9 | Ten-man Tottenham rescue late draw at Man United. Did Spurs deserve more? - The New York Times | [원본](<https://news.google.com/rss/articles/CBMikAFBVV95cUxOSFZrWnh4OXJJWVl5aHZFXzd0bjBvTURfcHRuRXRtUnVZczNJNm51MEJtQ2M5Y0czWXBPUmFEQW92VDFORGJYVUU5MXU4MDFpdjZPQ2l1ZmpJN0V3XzllZTdCeGlxRWVlNUF6LU05eTZTRzA5bXk2Y1liVEdaVWN4Skk3amoyZVBuREt5YlE3Z04?oc=5>) | 성공 | [https://www.nytimes.com/athletic/7667943/2026/10/10/manc-utd-tottenham-result-analysis/](<https://www.nytimes.com/athletic/7667943/2026/10/10/manc-utd-tottenham-result-analysis/>) | www.nytimes.com | 413.74 | —  |
|  10 | Transfer Rumors: La Liga Giants Want Fernandes; Man Utd Plot Endrick Move - Sports Illustrated | [원본](<https://news.google.com/rss/articles/CBMiuwFBVV95cUxPSE5KbTZMMFRJTHFkeHNQcWtqUDRIejhDcnlGNVVtekRESGVGSTBRN09sQk03THprdnpvOVpjX09YdUNqcWp5cm93Y2NQR25FVUZDcHZzbC1JOE4zZU00NkxZTjcwUnZyZ2pkV3NVaHNWNVFiNmRfMUEyaEUtNnYyUUJ2TDQtY1VwcGp3N3BPYzdEVDJUQmtqc2lacFpjQV9IZ2cyMEEwYUhsZURPSHhvQXJ3QU8xYTQzNnRz?oc=5>) | 성공 | [https://www.si.com/soccer/transfer-rumors-la-liga-giants-want-fernandes-man-utd-plot-endrick-move/app/?utm_source=forza](<https://www.si.com/soccer/transfer-rumors-la-liga-giants-want-fernandes-man-utd-plot-endrick-move/app/?utm_source=forza>) | www.si.com | 655.47 | —  |
|  11 | Transfer Rumors: La Liga Giants Want Fernandes; Man Utd Plot Endrick Move - Sports Illustrated | [원본](<https://news.google.com/rss/articles/CBMingFBVV95cUxOYi01N1hKVzN0a2dncTY2TUt4dW8yX1d2WTJFeUdWQUdHUDI1ZHBMZ29hajFSalpYbWNCQkhhb3pDTExTanVtdnJQODlEVXJTRlNxUmRFQ1dKTm02ZUdWN0tfRWV1LWdicjhROUZCRXkxUEFsYXBjd2lfTmhqcTU5OTJvS1FBaS1FVzFUZkt5OHJjeG9FaUgyVDdCazIyUQ?oc=5>) | 성공 | [https://www.si.com/soccer/transfer-rumors-la-liga-giants-want-fernandes-man-utd-plot-endrick-move](<https://www.si.com/soccer/transfer-rumors-la-liga-giants-want-fernandes-man-utd-plot-endrick-move>) | www.si.com | 645.62 | —  |
|  12 | Betway announced as Official Principal Partner - Manchester United | [원본](<https://news.google.com/rss/articles/CBMikAFBVV95cUxQVGs1QjhOc1k0ejZiR01rSFpjUEVTT2FTRkE2R3lMU1A5aUNRbTFMWkgtUXBUbVItalJfOWV0VnZ6aUZvaHF0bHRhWlNkcDY4VnEwd2xoOFU2N1dUc2d0a3FRMjdNMFBwdnVBdU1hR3g2dlRVZ3RLazBBeDhFZlNfR3E0UDJBV3AxN283UGF5MkY?oc=5>) | 성공 | [https://www.manutd.com/en/news/betway-announced-as-united-official-training-kit-partner](<https://www.manutd.com/en/news/betway-announced-as-united-official-training-kit-partner>) | www.manutd.com | 641.33 | —  |
|  13 | Mikel Arteta, Michael Carrick and the time and zeal managers need to drag a club back to the top - The New York Times | [원본](<https://news.google.com/rss/articles/CBMijwFBVV95cUxPLUItSkVTaGRmZGlWb1A3ZGRPRWRjY1FPWXphbzNRdmJDaVN4VGE0ZjBhTFM1MUxSclBRSHA0VlBCZkhWWFVOZTltcm5aWGJNS3hxWVhwbEE1S2hwcmRjUmFla2c2aTlibEZ4TWR1Z25mXzRtdU9YbXVqWmVzRHh3alB1Z0pxM0dDN1BwbmNsUQ?oc=5>) | 성공 | [https://www.nytimes.com/athletic/7666168/2026/10/09/arteta-carrick-arsenal-man-united/](<https://www.nytimes.com/athletic/7666168/2026/10/09/arteta-carrick-arsenal-man-united/>) | www.nytimes.com | 623.59 | —  |
|  14 | The Stats Show De Zerbi Deserves Credit for Spurs’ Old Trafford Fightback - The False 9 | [원본](<https://news.google.com/rss/articles/CBMihgFBVV95cUxNcDhyVUhDSVBvLTNIRk1jRFh3YUJCa1FUaWxEbGVuZmVmWm1acDBRZHlZUlhsb2llaTZSTjVfWTZicWpLVm92LUcydi1tdm1yeVBDb0xLaEVRbVVLOGMxTDB3VVdzczdpbTJZMEVjcG5BY0RMVnN5MlBaUDRjVzFYQi1LZDdmQQ?oc=5>) | 성공 | [https://thefalse9.com/2026/10/ten-man-tottenham-rescued-point-old-trafford.html](<https://thefalse9.com/2026/10/ten-man-tottenham-rescued-point-old-trafford.html>) | thefalse9.com | 515.28 | —  |
|  15 | Manchester United and Spurs come back to reality as City saga offers brief distraction \| John Brewin - The Guardian | [원본](<https://news.google.com/rss/articles/CBMixAFBVV95cUxQa2tPQzB0ZTlDTF9IdjlDa20yN0FWQm90UWFsa25uYWppNW5xVXFYY3FQUUxpNVNTVkdxX2JIUEJobmtLLUhyOXNVQjVyU2xtTlRPWWxzQjViX0tuR1FNZHREcUlyTHRtaC1lYjBwTVNqVFJET0dqQ05rWUJzVlNhdDUzVHUwdFotQ2p0NzNnem92N0JCMDNCZ1RDcWhnSlNnQVkwM0xsZkp3Wk9RaGhGU3pMb2huSm1uNWkzV3lwallvSVZD?oc=5>) | 성공 | [https://www.theguardian.com/football/2026/oct/10/draw-brings-no-respite-for-manchester-united-and-tottenham-as-crises-continue](<https://www.theguardian.com/football/2026/oct/10/draw-brings-no-respite-for-manchester-united-and-tottenham-as-crises-continue>) | www.theguardian.com | 655.58 | —  |
|  16 | “That wasn’t us”: Bryan Mbeumo admitted that Man United were simply not at the races vs Spurs - Yahoo Sports | [원본](<https://news.google.com/rss/articles/CBMie0FVX3lxTE5xc3RaOVAzMkJmcmpWX0NVUktVaXBuekc4dTg2MjhNMG9mWWcyNW9nX3hFYmdtWXlza19XX0wzOFRRcXdZUFZqaGxCYXdfMGxmNFctdVkyV1JOX25Sb0ZxS0tUZ2JZUWJmR3RHaEV2Ukh6SDRFd0lCR2p5UQ?oc=5>) | 성공 | [https://sports.yahoo.com/articles/wasn-t-us-bryan-mbeumo-214500643.html](<https://sports.yahoo.com/articles/wasn-t-us-bryan-mbeumo-214500643.html>) | sports.yahoo.com | 395.07 | —  |
|  17 | Man United 1-1 Tottenham: Five Things We Learned - The False 9 | [원본](<https://news.google.com/rss/articles/CBMiigFBVV95cUxPLTR4TFpkS182QU5PdDlBdGFtRWYwVXhuc2pyWUJweDRwal9LeDRka1FBNDVMZEUwdThoZzN3R3BPZEhhYUoybEZzM0lfVm5ael9TblhVNE5RZElZSUFWWmRLaVp1dTByQmx2ckwyZXkxYnNoaWsteFZSQ3dQdDJiOGs0bjNfOElDTkE?oc=5>) | 성공 | [https://thefalse9.com/2026/10/man-united-1-1-tottenham-five-things-we-learned.html](<https://thefalse9.com/2026/10/man-united-1-1-tottenham-five-things-we-learned.html>) | thefalse9.com | 400.22 | —  |
|  18 | Tottenham make Roberto De Zerbi sack call after Man Utd draw - TEAMtalk | [원본](<https://news.google.com/rss/articles/CBMirwFBVV95cUxPUXVKSUI3SGpiVVJIM3Bscm5qVG81WFNfQktEcVplSXEzc0Q5Qk04eXdTWXk4am1DamNLS2ZtaXdpdWx4a3Vyd0dtVnVWNnRvYzN2dDMzcVFsWnBqc3FYbUo3R3Zod2J4ekstS1dWYjFaaEljQlZKYVRFakQwVUphTFMzRkdIVU91V2g3bnlrU2hBVDBEWTJ3NUdEc0FQN3FvMUVBVHVnS205ajRIZEtN?oc=5>) | 성공 | [https://www.teamtalk.com/tottenham-hotspur/roberto-de-zerbi-tottenham-sack-decision-reached-after-man-utd-draw](<https://www.teamtalk.com/tottenham-hotspur/roberto-de-zerbi-tottenham-sack-decision-reached-after-man-utd-draw>) | www.teamtalk.com | 548.07 | —  |
|  19 | 'I kissed Rodrigo and said thanks' - De Zerbi 'liked' Spurs red card - Yahoo Sports | [원본](<https://news.google.com/rss/articles/CBMiiAFBVV95cUxNV3FNNnltT1BSS0pDdjctOXB6ZzZ4ZXhHcDhiV3FaX1JhdFdLNVVlSks5dTRDcmppSFZ5bS0zZVVPRUY4bThXS29VZ1NRYjF0bENXdWpZeXY1cTI0WGRyS0dxM2FCWWNJYlk5ZFUxTF91TVM3MmlTRTlQTkhKc0lXT1dIZ1pWREhz?oc=5>) | 성공 | [https://sports.yahoo.com/articles/kissed-rodrigo-said-thanks-zerbi-205917053.html](<https://sports.yahoo.com/articles/kissed-rodrigo-said-thanks-zerbi-205917053.html>) | sports.yahoo.com | 389.79 | —  |
|  20 | Carrick sack unavoidable as Spurs make Man United crumble against 10 again - Football365 | [원본](<https://news.google.com/rss/articles/CBMimAFBVV95cUxNb2YxLW5rc1NKWjl6X1lSLUdjSmRSZVhFOHRkV2Ewa0xGWndySHNzYlk1amptOFFEaE9oUTRqYi1GZ3p2enlDbkRhUkNjREJ2Mms5ellvYVlCSDZMdGpCLWstWFVIRWtwREFweXRmNmFiaWZVQVNYRFF0aWR5UnNSWl9oQ05qOF9PeENqV3VUdFVJeVZVRnNhbw?oc=5>) | 성공 | [https://www.football365.com/news/16-conclusions-manchester-united-spurs-carrick-sack-de-zerbi](<https://www.football365.com/news/16-conclusions-manchester-united-spurs-carrick-sack-de-zerbi>) | www.football365.com | 382.38 | —  |
|  21 | Man Utd 1-1 Spurs highlights - Sky Sports | [원본](<https://news.google.com/rss/articles/CBMi8AFBVV95cUxQem1ZN3BLdEVwT0p0ZFpjM2tHbGoyOU8yVGZOTWNqaG1yaERyRDlnMnlnbVVvdDc3VllQZVN4ckw0M05kR08xazN6bXRJekJ4SEVROThGUG9HNXU0UEFhdzJacDB6a0JVSm9DWnU2VTQxZDFibWFtUTdUV01JWnpMMjJVUTZCaTlmS0JkczduTjVrS0FFNVVpbUs4dkw3dFRBSFRHOFFqZW5GMjk1WGNNcXhycnNsSFRpMTA0SGNJeHRBelpFSzhEWUdlUUkzTEhETGhtdHlmMkp2S3kxcVRVcnBfSk51bU1xOXI2SVBvRUM?oc=5>) | 성공 | [https://www.skysports.com/football/live-blog/13592689/man-utd-vs-tottenham-live-premier-league-score-updates-news-prediction-lineups-and-how-to-watch-or-stream](<https://www.skysports.com/football/live-blog/13592689/man-utd-vs-tottenham-live-premier-league-score-updates-news-prediction-lineups-and-how-to-watch-or-stream>) | www.skysports.com | 394.95 | —  |
|  22 | Boos, anguish & fading belief -'worrying day' for under-pressure Carrick - Yahoo Sports | [원본](<https://news.google.com/rss/articles/CBMijAFBVV95cUxPNzRrRXhnMlpFQkFOakMxbHduUktnN2hFM3hjVWs3RDFHX0pRNFVmOElyYk9KZTU3bU5VQTBfOU4zU3J3R2ZVY2F0QzFreUVza2ViMnNDU1Y4WEs4MGQ3STVNa1dwZExWb3g5MVlLMFE3eDBWOGdNR0hLY2FQclE4SjE3aUJWQnY4T2cxWQ?oc=5>) | 성공 | [https://sports.yahoo.com/articles/boos-anguish-fading-belief-worrying-205452774.html](<https://sports.yahoo.com/articles/boos-anguish-fading-belief-worrying-205452774.html>) | sports.yahoo.com | 435.29 | —  |
|  23 | Manchester United: Another failure to beat 10 men increases pressure on boss Carrick - BBC | [원본](<https://news.google.com/rss/articles/CBMiaEFVX3lxTE42bVdPaFFtYjVLdEUzRVZXb0VqZnVfNlpyRU9Ebjc0UUh4TVRBTWZ1c21mSEF4NUtibzRYZlhsTE9YdGdyZDh6b2dRZW56WnZvdlIyTURXMnJlcWNodjEtWkc3bGtKblFT?oc=5>) | 성공 | [https://www.bbc.com/sport/football/articles/c62e9g09e781o](<https://www.bbc.com/sport/football/articles/c62e9g09e781o>) | www.bbc.com | 381.65 | —  |
|  24 | Man Utd on high alert as Bayern Munich set asking price for Alphonso Davies - Goal.com | [원본](<https://news.google.com/rss/articles/CBMitAFBVV95cUxPdHdpMlFmVzF0dGJ0TEZHUzEtWjVRa3h6Y1VFak4zLTRKZHUwc3oyZTROcWk1YTR1S055cDBMeUZwOW5TY3kwblJCUXl5M2F6b0lXeEVSYU16a2owei14MHR1Q19pVm1RWUV0SzBWMVM2NDVwWDB6V1JJZWppYlc1djNlQ3NySU9TbVNkNkRpaFdoSEpibXdvd3hlb0l0M2VoTmN0RlFBMGJ2OGVLNFIwUDBKS0g?oc=5>) | 성공 | [https://www.goal.com/en/lists/alphonso-davies-transfer-man-utd-arsenal-liverpool-bayern-munich/blt82a731d54f50066b](<https://www.goal.com/en/lists/alphonso-davies-transfer-man-utd-arsenal-liverpool-bayern-munich/blt82a731d54f50066b>) | www.goal.com | 448.26 | —  |
|  25 | Man Utd transfer news, rumours and gossip: Live updates and latest on deals, signings, loans and contracts - Sky Sports | [원본](<https://news.google.com/rss/articles/CBMi7AFBVV95cUxNVGxETjVqU2RwQ2J1N2o5MHliQkNSM2lLejh6TGN1UjIyTnZ3R3YyZVlQM0NBZ3dVOXF0Wk5yWHpvRl9zcmpmU2plOXRZeEhULTJuZGo3TDg2ai1SaUZObl9Md2IzUWUzNVU4LXhRWEhoeHhRZDFYb0x5T2F5dGFqZlZRWEhGZE5NTjNLdEpUSFV6bFJFM3BaQnZYU3p5OEJsMTJHS0xNbGlwbzZWM3o5a2FlUEZ1ZEtjaUIzdWxUaEdzNlcyNGMtTGE3N0FnN1pCZnk2TjBoZ1dnQUxyWUhLb0VFYWF0VC1VMDJiZQ?oc=5>) | 성공 | [https://www.skysports.com/football/live-blog/13025492/man-utd-transfer-news-rumours-and-gossip-live-updates-and-latest-on-deals-signings-loans-and-contracts](<https://www.skysports.com/football/live-blog/13025492/man-utd-transfer-news-rumours-and-gossip-live-updates-and-latest-on-deals-signings-loans-and-contracts>) | www.skysports.com | 396.30 | —  |
|  26 | Michael Carrick 'hurt' by boos as Man United fall to worst start in 40 years - ESPN | [원본](<https://news.google.com/rss/articles/CBMiuwFBVV95cUxNbWt5Wjk4MEh0WDd1VXFQSFVuM01PeTI5RkE4Zkc3aF9XWDB4aVRqeXNwOUpKN3Q4c2U1VkVnX2hvNFFJVHNPNjF5WTFoOTZhRl91RmNwbUZUTGxJcnc0TFZLX3Vvcm9tRWVZRFR1MUtPN1d4RkI2YjBuOENJZUhFLWtKZUx2X01laFlBYUd1OUpXSXE4em5pNnBSeGU2dTFyYkZYblV1c1RjN1Nkc2swZUtnSThheUlEQVVz?oc=5>) | 성공 | [https://www.espn.com/soccer/story/_/id/50149326/man-united-tottenham-dominic-solanke-bryan-mbeumo-premier-league-result](<https://www.espn.com/soccer/story/_/id/50149326/man-united-tottenham-dominic-solanke-bryan-mbeumo-premier-league-result>) | www.espn.com | 401.46 | —  |
|  27 | Man United 1-1 Spurs Player Ratings: Martinez 3/10 - The False 9 | [원본](<https://news.google.com/rss/articles/CBMihgFBVV95cUxNNTZJaVB4RjdYU2NpV3ViTTdxZ0xKSnY0cHpxb3o5WlgxRTdxVkQyenNoX3lidV9OZ3ZYT0R2bzJ2dUwwNTVRZWpnaGs0MDlaRVdmUmJUejBOZjE3TlNrZlZQVTlRMGVSX1pXWmJIeGNRc0lWV3h3VVVBM3hxQlE0NjFWNEtBZw?oc=5>) | 성공 | [https://thefalse9.com/2026/10/man-united-1-1-spurs-player-ratings-martinez.html](<https://thefalse9.com/2026/10/man-united-1-1-spurs-player-ratings-martinez.html>) | thefalse9.com | 373.95 | —  |
|  28 | "WE PLAYED A GREAT GAME!" PRESS CONFERENCE Roberto De Zerbi: Manchester United 1-1 Tottenham Hotspur - YouTube | [원본](<https://news.google.com/rss/articles/CBMiXEFVX3lxTE05Y3RycW1Xa0phaG03aWgxalJKTjNhRVBoQUFjUi1TakhyME5nM3lWTEJ2WDhaZEJ2QnFoNzQxVy1fUWQ2TXh6Y2NvbXU3S0RBYUVmMDZuSWhzMnJh?oc=5>) | 성공 | [https://youtu.be/8Iy_06Nf4mw?is=YDhBYXredU2CirQs](<https://youtu.be/8Iy_06Nf4mw?is=YDhBYXredU2CirQs>) | youtu.be | 392.37 | —  |
|  29 | Carrick ‘massively disappointed’ after United drop points against 10-man Spurs - The Guardian | [원본](<https://news.google.com/rss/articles/CBMirgFBVV95cUxOeDkzTnNGSi11TEZwMWY0dEJBc0FjT1ZiVEphUEVBVnNiTFlwSHczdWJzeDNWVUZuVEZNaFdfWXlxbFVFSkdobkR0cDRTdHlhUHE2NXktNWtNQldaWlB1VnNWdTJlTDBZdWdyNnVmbjlVLTRBWVpiZjlMcW1qUmtyckM1aFlIVld1MDhOclJfT0huM3NBNjJxYk1nY2NaZTNnTXcwaDFncXF5NEJLTUE?oc=5>) | 성공 | [https://www.theguardian.com/football/2026/oct/10/michael-carrick-manchester-united-tottenham-roberto-de-zerbi](<https://www.theguardian.com/football/2026/oct/10/michael-carrick-manchester-united-tottenham-roberto-de-zerbi>) | www.theguardian.com | 740.62 | —  |
|  30 | Man United 1-1 Spurs (11 Oct, 2026) Team Stats - ESPN Singapore | [원본](<https://news.google.com/rss/articles/CBMib0FVX3lxTE1lWjhIREZrUFhXYk9XTEstLWtDWlZzYjRqbHNua0V2WWNlYlFJVTV3czd3MkZJTE5LUWtkdzBYVDk5Q3F6eTB1Y0ZmM3VNZTE0dERxTWVtakJpd0NUeTFkTXBzQ2h2eG5CRzBQMWc3TQ?oc=5>) | 성공 | [https://www.espn.com.sg/football/team-stats/_/gameId/401878773](<https://www.espn.com.sg/football/team-stats/_/gameId/401878773>) | www.espn.com.sg | 693.31 | —  |

전 항목이 Google News가 아닌 HTTPS 주소로 변환됐고, 이 30개 요청에서는 429가 없었다. 그중 29건은 뉴스/스포츠 매체 도메인이고 1건은 Google News의 `YouTube` 출처에 해당하는 원본 동영상 페이지(`youtu.be`)다. 이를 출처 원문 URL로 포함하면 30/30이고, 뉴스 매체의 기사 페이지만 요구한다면 29/30 (96.7%)이다. 그래서 URL 확보 성공과 기사 본문 추출 성공을 별도로 기록했다.

## 원문 페이지 및 본문 추출 (10건)

본문 확인은 변환 성공 30건 중 최대 10건만 수행했다. `article_enrichment.ts`의 노이즈 제외·문단 길이·excerpt 기준을 독립 Python harness에 반영했다. TypeScript 함수를 직접 실행한 테스트는 아니며, 응답 크기는 같은 200 KB 한도로 제한했다. HTTP 200이더라도 크기 제한으로 응답을 다 읽지 못해 추출기에 전달하지 않은 경우는 본문 추출 성공으로 세지 않았다.

| # | 기사 | 원문 도메인 | HTTP 접근 | 본문 추출 상태 | 상태/HTTP | 소요 시간 (ms) |
| ---: | --- | --- | --- | --- | --- | ---: |
| 1 | Manchester United eye Brazilian talent as Euro outfit set huge €80m asking price - Yahoo Sports | [sports.yahoo.com](<https://sports.yahoo.com/articles/manchester-united-eye-brazilian-talent-065000769.html>) | 성공 | 실패 | BODY_TOO_LARGE / 200 | 1050.70 |
| 2 | Transfer news LIVE: Bayern release Harry Kane contract statement as Milan want Endrick - Transfermarkt | [www.transfermarkt.com](<https://www.transfermarkt.com/transfer-news-live-liverpool-amp-man-utd-eye-mane-as-olise-to-be-offered-release-clause-/view/news/445145>) | 성공 | 성공 | ARTICLE_BODY_EXTRACTED / 200 | 863.98 |
| 3 | Transfer news LIVE: Bayern release Harry Kane contract statement as Milan want Endrick - Transfermarkt | [www.transfermarkt.com](<https://www.transfermarkt.com/transfer-news-live-bayern-release-harry-kane-contract-statement-as-milan-want-endrick/view/news/445145>) | 성공 | 성공 | ARTICLE_BODY_EXTRACTED / 200 | 773.97 |
| 4 | Newcastle United injury update on Sunday sees added positive news ahead of Coventry City - Yahoo Sports | [sports.yahoo.com](<https://sports.yahoo.com/articles/newcastle-united-injury-sunday-sees-062728051.html>) | 성공 | 실패 | BODY_TOO_LARGE / 200 | 965.60 |
| 5 | Arsene Wenger urged to stand against Gianni Infantino for FIFA presidency - Paper Talk \| Football News - Sky Sports | [www.skysports.com](<https://www.skysports.com/football/transfer-paper-talk/13597627/arsene-wenger-urged-to-stand-against-gianni-infantino-for-fifa-presidency-paper-talk>) | 성공 | 실패 | BODY_TOO_LARGE / 200 | 1759.59 |
| 6 | Man Utd Transfer Journalists Tier List 2026: Who to Trust - The False 9 | [thefalse9.com](<https://thefalse9.com/2026/10/man-utd-transfer-journalists-tier-list.html>) | 성공 | 성공 | ARTICLE_BODY_EXTRACTED / 200 | 1928.19 |
| 7 | Man Utd dealt major Benjamin Sesko injury blow as Michael Carrick admits return date for £65m striker is 'not clear' - Goal.com | [www.goal.com](<https://www.goal.com/en/lists/man-utd-benjamin-sesko-injury-michael-carrick/bltc7df89decd2be5d2>) | 성공 | 실패 | BODY_TOO_LARGE / 200 | 552.43 |
| 8 | Worst in 40 years! Manchester United script unwanted record after draw against 10-man Tottenham Hotspur - The Times of India | [timesofindia.indiatimes.com](<https://timesofindia.indiatimes.com/sports/football/top-stories/worst-in-40-years-manchester-united-script-unwanted-record-after-draw-against-10-man-tottenham-hotspur/articleshow/134864014.cms>) | 성공 | 실패 | BODY_TOO_LARGE / 200 | 124.83 |
| 9 | Ten-man Tottenham rescue late draw at Man United. Did Spurs deserve more? - The New York Times | [www.nytimes.com](<https://www.nytimes.com/athletic/7667943/2026/10/10/manc-utd-tottenham-result-analysis/>) | 실패 | 실패 | ACCESS_RESTRICTED_OR_PAYWALL / 403 | 200.81 |
| 10 | Transfer Rumors: La Liga Giants Want Fernandes; Man Utd Plot Endrick Move - Sports Illustrated | [www.si.com](<https://www.si.com/soccer/transfer-rumors-la-liga-giants-want-fernandes-man-utd-plot-endrick-move/app/?utm_source=forza>) | 성공 | 실패 | BODY_TOO_LARGE / 200 | 516.27 |

- 요약: URL 변환 10/10, 원문 페이지 HTTP 접근 9/10 (90%), 본문 발췌 3/10 (30%).
- `BODY_TOO_LARGE` 6건은 원문 HTTP가 200이었지만 200 KB 안전 한도를 넘어 HTML 본문 추출을 중단했다. 이는 추출 성공이 아니다.
- `ACCESS_RESTRICTED_OR_PAYWALL` 1건은 HTTP 403이었다. 접근 제한이나 유료 벽을 우회하지 않았다.
- 성공적으로 추출한 본문 예시는 테스트 결과 JSON에 남겼다. 나머지 20건은 URL만 검사했고 원문 페이지 요청은 하지 않았다.

## 기존 코드와의 관계

- `google_news_provider.ts`는 RSS 항목을 발견하고 Google News RSS URL을 canonical URL로 보존한다. 수집 자체가 publisher URL 변환을 수행하는 구조는 아니다.
- 현 `article_enrichment.ts`는 안전한 HTTPS 주소를 가져오며 리다이렉트는 거부하고, 200 KB·8초 제한으로 문단 기반 excerpt를 만든다. 따라서 URL 변환만 성공해도 본문 추출을 보장하지 않는다. 이 PoC의 페이지 접근 정책은 검증을 위해 공인 주소로만 수동 리다이렉트를 제한적으로 따랐고, 운영 코드를 바꾸지 않았다.
- `orchestrator.ts`는 발견과 enrichment를 별도 동시성 제한으로 수행한다. 실패 시 URL 변환 단계와 본문 추출 단계를 분리해 상태를 기록하는 것이 적합하다.
- 이번 체크아웃의 `provider_router.ts`에는 현재 Google News provider 경로가 있지만, PoC는 이를 호출하거나 provider 설정을 바꾸지 않았다.

## ManUtd Editor 적용 가능성

### Supabase Edge Function 직접 사용

Python 패키지를 현재 Supabase Edge Function에 직접 가져다 쓸 수 없다. Supabase Edge Functions는 TypeScript와 Deno 런타임을 사용하며 공식 가이드의 기본 실행 경로도 TypeScript/Deno다. [Supabase Edge Functions](https://supabase.com/docs/guides/functions), [공식 quickstart](https://supabase.com/docs/guides/functions/quickstart). Python 패키지를 재작성해 Deno 함수로 포팅하는 것은 별도 구현이며, 이 PoC에서는 하지 않았다.

### Python GitHub Actions M9 통합

Python 실행이 가능한 별도 Actions 작업은 패키지 사용 위치로는 더 자연스럽다. 다만 저장소 기본 브랜치의 [M9 workflow](https://github.com/wjddnjs0419-sudo/manutd-editor/blob/main/.github/workflows/m9-private-preview.yml)는 수동 실행하는 private card-news preview/render 작업이며, 기사 발견 파이프라인은 아니다. 따라서 이 workflow에 바로 넣기보다는 discovery와 분리된 검증/해결 작업으로 설계해야 한다. 별도 작업이 후보 Google URL을 읽고 변환 결과를 준비한 뒤, 결과 검토/명시적 연결을 거쳐 기존 수집 단계가 쓰도록 하는 방식이 맞다. 자동 배포나 운영 연결은 이번 PoC에서 수행하지 않았다.

### 안전한 데이터 흐름 및 캐시

- 검색/수집 단계는 원래 Google News URL을 원본 필드에 보존한다. 별도 resolver는 미처리 URL만 읽고 결과를 `resolved`, `unresolved`, `rate_limited` 등으로 분리한다.
- 변환 결과는 HTTPS, 공개 주소, 허용 가능한 미디어 도메인인지 검증한다. 실패 시 원래 Google URL만 보존하고 변환 URL 필드는 비워 두며, 이 URL을 본문 추출 단계로 넘기지 않는다.
- 정확히 동일한 입력 URL에 대해 캐시 키를 두고 성공 결과는 재사용한다. 실패/429는 짧은 만료시간과 cooldown을 둬 다음 작업에서 재시도 폭주를 막는다. PoC에서는 DB 캐시나 테이블 변경을 만들지 않았다.
- 배치 실행은 unique URL만 포함하고 최대 동시성 2를 유지한다. 429 발생 시 남은 배치 호출을 중단하며 무한 재시도하지 않는다.

### 요청량과 운영 리스크

이번 30건 실행에서는 변환에 Google 요청 61건(60 GET + 1 POST)이 들었다. 원문 본문 검증 10건에는 publisher 페이지 요청이 추가됐다. 단순 추정식은 `2 × U + B` Google 요청이며, `U`는 변환할 고유 URL 수, `B`는 `decode_many()` 호출 배치 수다. 표본에서 각 URL은 GET 두 번이었고 한 배치 POST가 한 번이었다. locale redirect가 없는 URL은 GET이 하나 줄 수 있고, 재시도·redirect·여러 배치가 있으면 더 늘 수 있다. 본문 추출 요청은 URL 변환과 별도이며 검증 대상으로 선택한 수만큼 추가된다.

핵심 위험은 공개된 안정 API가 아니라 Google 내부 동작에 의존한다는 점이다. Fbv4je RPC 이름·요청 envelope, 서명 속성명, consent cookie, batchexecute 응답 구조가 바뀌면 URL 변환 전체가 실패하거나 결과가 `None`이 될 수 있다. 동시성 2와 no-retry 정책은 폭주를 줄이지만 Google의 429를 없애지는 않는다. 실제 운영 진단에서 확인된 429와 이번 로컬 무429 결과 간 차이는 배포 환경에서 별도 검증해야 한다. 패키지 버전을 고정하고 실패율·429·도메인 검증 실패를 계측하며, 매핑 실패를 원본 URL로 조용히 대체해 본문 추출 성공으로 오인하지 않아야 한다.

## 결론

**질문: “gnews-decoder를 사용하면 맨유 에디터가 Google News에서 수집한 기사의 실제 원문 URL을 자동으로 확보할 수 있는가?”**

이 로컬 PoC에서는 출처 URL 확보가 **가능했다**: 30/30 (100%)이 Google News가 아닌 HTTPS 원본 주소였고, 뉴스 매체의 기사 페이지만 기준으로 하면 YouTube 동영상 주소 1건을 제외해 29/30 (96.7%)이다. 같은 조건에서 과거 resolver도 30/30이어서 성공률 개선은 확인되지 않았고, gnews-decoder는 배치 요청 수와 이 테스트의 전체 처리시간을 줄였다. 하지만 현재 운영 DB의 변환 기록은 0/1,206이고 운영 함수 진단에는 429가 있으며, 원문 페이지 본문 추출도 3/10에 그쳤다. 내부 Google API 의존성도 두 방식에 공통으로 남는다.

### 최종 판단: CONDITIONAL

작은 실시간 표본에서 자동 원문 URL 변환은 성공했고 배치 효율도 확인했지만, 운영 환경에서의 안정성은 아직 입증되지 않았다. 다음 검증은 운영 데이터 쓰기 없이 실제 배포 예정 런타임의 네트워크 경로에서 30건 이상을 제한 속도로 실행하고, 429·변환·본문 추출을 별도 집계하는 환경 시험이다. 그 결과가 재현된 후 운영 통합을 검토할 수 있다.

## 변경 및 미변경 범위

- 추가: `scripts/gnews_decoder_poc.py`, `scripts/test_gnews_decoder_poc.py`, `scripts/requirements-gnews-decoder-poc.txt`, `scripts/fixtures/gnews-decoder-input.json`, 이 보고서.
- 오프라인 테스트: 12건 모두 통과.
- 실행하지 않음: production Supabase 쓰기, Google News 운영 설정 변경, Cron/스케줄러 변경, 자동 배포, M8/M9 workflow 수정.
- legacy 실시간 비교는 커밋 `648e3d4f26bb9fc5867fe97e67e940e1bec687d8`의 resolver 파일을 임시 실행했다. 현재 체크아웃에 없는 문서 `docs/google-news-publisher-extraction.md`는 검토 불가 상태로 남겼으며, 현재/과거 구현 분석은 해당 resolver 소스와 기존 진단 기록을 근거로 했다.
