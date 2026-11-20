# 휴대폰 열람 (모바일 화면)

## 1. 목적

업무 공유 시간 같은 때, 같은 Wi-Fi 에 있는 휴대폰 브라우저로 LinkWork 의 오늘 대시보드·할 일·메모를 본다.
Mac 앱의 메인 프로세스가 작은 HTTP 서버를 띄우고, 휴대폰은 설정 > 모바일의 QR 을 스캔해 접속한다.
별도 앱 설치나 클라우드 동기화는 없다. **기본값은 꺼짐**이다.

휴대폰에서 할 수 있는 쓰기는 두 가지뿐이다.

- 할 일 완료 / 되돌리기
- 메모 작성

## 2. 구조

```
 데스크톱 렌더러(메인 창)                  메인 프로세스                       휴대폰 브라우저
 ─────────────────────                  ─────────────────                  ──────────────
 MobileTodayPublisher                   mobile HTTP 서버 (0.0.0.0:8946)
  오늘 스토어들 → buildTodayDashboard      ├ 마지막 오늘 스냅샷(메모리)  ◀──── GET /api/today
  → 스냅샷              ──publishToday─▶│                                  │
                     ◀──mobile:publishRequested─┤ (/api/today 를 읽을 때)          │
                                          ├ todos·memos 를 DB 에서 직접 ◀──── GET/POST /api/todos·memos
 dataSync(ai:dataChanged) ◀───────────────┘ (휴대폰 쓰기 뒤 알림)
```

- **오늘 대시보드는 렌더러가 조립한다.** 조립 코드(`components/today/todayModel.ts` 의 `buildTodayDashboard`)가 렌더러에만 있어서다. 데스크톱 렌더러가 조립 결과(스냅샷)를 IPC 로 메인에 올리고, 메인은 마지막 스냅샷을 해석하지 않고 그대로 휴대폰에 돌려준다(객체인지·`date` 형식(YYYY-MM-DD)·직렬화 크기 1MB 이하만 검사).
- **할 일·메모는 메인이 DB 에서 직접 읽고 쓴다.** 쓰기는 같은 기능의 IPC(`todo:complete`·`todo:restore`·`memo:create`)와 같은 부수효과(이력·활동 로그)를 남기고, 끝나면 `ai:dataChanged`(`{ entity: 'todo' | 'memo' }`)를 보내 데스크톱 화면을 갱신한다(`stores/dataSync.ts`).
- 데스크톱 앱이 실행 중이어야 한다. 앱이 꺼져 있거나 Mac 이 잠자기 상태면 서버도 없다.

### 2.1 스냅샷 발행 (`components/mobile/`)

`MobileTodayPublisher` 는 화면을 그리지 않는 컴포넌트로 `App.tsx` 의 메인 창 분기에 1번 마운트한다(트레이 패널 창에는 없다).
켜짐 상태는 `stores/mobileStore.ts` 를 설정 섹션과 함께 쓴다. 설정에서 켜고 끄면 발행기가 즉시 시작·정지한다.

| 항목 | 규칙 |
|---|---|
| 입력 | 오늘 화면(`TodayView`)과 같다(`readTodayInputs`) — `useTodayStore`(events·eventsError·loading·lastSyncedAt), `useTodoStore`(activeTodos·completedTodos), `useJiraBoardStore`(snapshot·errorCode·loading·error), `useReleaseNoteStore`(allNotes), `useAssistantStore`(today → calendarConnected) |
| 스냅샷 | `{ v: 1, publishedAt, date, heading, dashboard, loading }` (`mobile/contract.ts` 의 `MobileTodaySnapshot`). `dashboard` 는 오늘 화면과 같은 규칙 문구(headline·signals·hiddenSignals)의 완전한 `TodayDashboard` 이고, 계약 밖 선택 필드 `facts` 는 크기를 줄이려고 뺀다 |
| 발행 시점 | (a) 켜진 직후 1회 (b) 입력 스토어가 바뀌면 500ms(`PUBLISH_DEBOUNCE_MS`) 디바운스 뒤, 직렬화(발행 시각 제외)가 직전과 다를 때만 (c) 60초마다 내용과 무관하게(일정의 timing·"n분 뒤"가 시간에 따라 바뀐다) (d) 메인의 `mobile:publishRequested` 를 받았을 때 |
| 재발행 요청 | 오늘 화면이 열려 있지 않아도 최신이 되도록 `useTodayStore.load()`(캐시 허용, refresh 아님 — 할 일 목록도 함께 다시 읽는다)를 먼저 하고 발행한다. 마지막 불러오기에서 30초 안이거나 이미 불러오는 중이면 불러오기를 생략하고 현재 상태만 발행한다. 메인은 `/api/today` 마다 요청하되 5초에 1번으로 줄인다 |
| 첫 로드 | 오늘 스토어가 한 번도 불러오지 않았으면(`lastSyncedAt === null`) 시작 때 한 번 불러오고, 그동안은 `loading: true` 로 발행한다 |
| 자정 넘김 | 발행한 `date` 가 바뀌면 오늘 범위의 일정을 다시 불러온다. 끝나면 스토어 변경으로 다시 발행된다 |
| 문구 | headline·신호 문구는 오늘 화면과 같은 규칙 문구다. LLM 으로 다듬지 않는다 |
| 정지 | 꺼지거나 메인 창이 언마운트되면 타이머·스토어 구독·`onPublishRequested` 구독을 모두 해제한다 |

## 3. 화면과 쓰기 범위

모바일 화면은 `src/renderer/mobile.html` + `src/renderer/src/mobile/` 로, 데스크톱 렌더러와 같은 빌드에서 별도 진입점으로 나온다(`out/renderer/mobile.html`, `out/renderer/assets/*`).

| 화면 | 읽기 | 쓰기 |
|---|---|---|
| 오늘 | `GET /api/today` 의 스냅샷(헤드라인·신호·다음 배포·Jira·할 일·일정) | 없음 |
| 할 일 | `GET /api/todos?completed=0` / `=1` | 완료(`POST /api/todos/:id/complete`), 되돌리기(`.../restore`) |
| 메모 | `GET /api/memos`(보관하지 않은 메모 전부 + 카테고리) | 작성(`POST /api/memos`) |

`401` 을 받으면 화면은 "Mac 의 LinkWork 설정 → 모바일에서 QR 을 다시 스캔하세요." 를 보인다(`EXPIRED_TEXT`).

## 4. 보안 모델

| 항목 | 내용 |
|---|---|
| 기본 꺼짐 | 사용자가 설정 > 모바일에서 켜야 서버가 뜬다. 켜짐 여부는 `app_settings.mobile_server_enabled` 에 저장하고 앱을 다시 켜면 복원한다 |
| 페어링 토큰 | 32바이트 난수(base64url). `app_settings.mobile_server_token` 에 safeStorage 암호문으로 저장한다. safeStorage 를 쓸 수 없으면 평문으로 저장하지 않고 메모리에만 둔다(앱을 다시 켜면 새 토큰이라 다시 스캔). 설정의 "QR 다시 만들기" 로 재발급하면 이전 토큰과 쿠키는 모두 무효가 되어, 이미 연결한 휴대폰은 다시 스캔해야 한다 |
| 쿠키 | `GET /pair?t=<token>` 이 토큰을 확인한 뒤 `lw_mobile` 쿠키를 설정하고 `/` 로 302 보낸다. 쿠키 값은 토큰 원문이 아니라 토큰에서 유도한 HMAC-SHA256 값이다. `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`(30일). **슬라이딩 갱신**: 인증된 `GET /` 응답마다 같은 속성으로 쿠키를 다시 내리므로, 30일 안에 한 번이라도 화면을 열면 만료가 연장된다. API 응답과 인증 실패 응답에는 쿠키를 내리지 않는다. 토큰을 재발급하면 옛 쿠키는 갱신과 무관하게 401 이다 |
| 자산 허용 목록 | `/assets/*` 는 `mobile.html` 이 참조하는 파일 그래프만 서빙한다. html 의 `./assets/…` 참조에서 시작해 js 의 상대 import(정적·동적, `"./x.js"`·`"assets/x.js"` 꼴)와 css 의 `url()` 을 재귀로 따라간다. 그 밖의 자산(데스크톱 번들 `index-*.js` 등)은 404 다. `mobile.html` 의 mtime·size 가 바뀌면 다시 계산하고, 계산이 실패하면 `mobile.html` 이 직접 참조하는 파일만 허용한다. 실제 빌드에서 허용되는 것은 `mobile-*.js`, `globals-*.js`, `globals-*.css`, `mobile-*.css` 다 |
| 인증 범위 | `/pair` 를 뺀 모든 경로(`/`, `/assets/*`, `/api/*`)가 쿠키를 요구한다. 없거나 틀리면 401 이고 경로 존재 여부도 드러내지 않는다 |
| Host 검사 | Host 헤더가 `<이 Mac 의 IPv4(LAN·Tailscale) | localhost | 127.0.0.1>:<port>` 가 아니면 403 (DNS rebinding 방어). Tailscale MagicDNS 이름(`<기기>.<tailnet>.ts.net`)은 허용하지 않는다 |
| POST 조건 | `X-LinkWork-Mobile: 1` 헤더, `Content-Type: application/json`, Origin 이 있으면 같은 출처. 본문 64KB 상한. 다른 출처의 폼·스크립트가 흉내 내기 어렵게 하려는 조건이다 |
| 속도 제한 | 같은 원격 주소에서 1분 안에 인증 실패가 10회에 이르면 그다음 요청부터 429. 예외로 차단 중에도 **올바른 토큰의 `/pair`** 는 302 로 통과하고 그 주소의 실패 기록을 지운다(다시 스캔하면 풀린다). 틀린 토큰의 `/pair` 는 차단 중에도 실패로 세고 429 를 돌려준다(토큰 대입 방어) |
| 입력 검증 | 메모 본문은 trim 후 1~20000자, 카테고리는 존재해야 한다. 할 일 id 가 없으면 404 |
| 상태 재조회 | 설정 > 모바일이 보이는 동안 창 focus 때와 10초마다 `mobile:getStatus` 를 다시 읽는다(처리 중이면 생략). Wi-Fi 가 바뀌어 IP 가 달라지면 QR·주소가 따라 바뀐다 |
| 화면 노출 | 설정 화면은 접속 주소의 토큰 부분을 가려서(`t=••••••`) 보이고, [주소 복사] 만 전체 주소를 클립보드에 넣는다. QR 은 이미지로만 보인다 |
| 백업 제외 | `mobile_server_token`·`mobile_server_enabled` 는 기기 종속이라 백업에서 뺀다([DATA_BACKUP.md](DATA_BACKUP.md) §1). 복원해도 이 기기의 값을 유지하므로 복원으로 서버가 저절로 켜지지 않는다. 새 PC 에서는 다시 켜고 QR 을 새로 스캔한다 |
| HTTP 평문 한계 | 서버는 HTTP 만 한다. **같은 네트워크 주소**로 접속하면 구간이 암호화되지 않아 같은 네트워크의 다른 기기가 트래픽(쿠키 포함)을 엿볼 수 있으므로 집·사무실처럼 믿을 수 있는 Wi-Fi 에서만 켠다. 공용 Wi-Fi 에서는 켜지 않는다. **Tailscale 주소**로 접속하면 기기 사이 구간이 Tailscale(WireGuard)로 암호화된다(§7) |

## 5. 계약

계약 타입은 렌더러 `src/renderer/src/mobile/contract.ts` 에 있다(HTTP 응답·요청 본문 포함). 실패 본문 `{ error: string }` 은 타입 없이 `api.ts` 의 `errorMessageOf` 가 해석한다. 메인 `src/main/services/mobile/types.ts` 는 메인이 다루는 것(`MobileTodaySnapshot`·`MobileServerStatus`·`MobileAddress`·`MobileTailscaleState`)을 같은 모양으로 따로 정의하고 포트 후보·설정 키를 둔다. 두 파일의 공통 타입은 한쪽을 바꾸면 다른 쪽도 바꾼다.

### 5.1 HTTP API

모두 쿠키 인증이 필요하고 JSON 을 주고받는다. `/api/*` 의 실패는 `{ error: string }` 과 4xx/5xx 다.

**gzip**: 요청의 `Accept-Encoding` 에 gzip 이 있고(`q=0` 제외) 본문이 1KB 이상이면 `mobile.html`, `/assets` 의 js·css(그 밖에 html·json·svg·map·txt), JSON API 응답을 gzip 으로 보낸다. 압축 대상 응답에는 실제 압축 여부와 관계없이 `Vary: Accept-Encoding` 을 붙인다. 정적 파일의 압축본은 경로+mtime+size 키로 메모리에 캐시한다(최대 64개).

| 메서드·경로 | 응답 | 비고 |
|---|---|---|
| `GET /pair?t=<token>` | 302 `/` + `Set-Cookie` | 쿠키 없이 받는 유일한 경로. 토큰이 틀리면 401 HTML |
| `GET /` | `mobile.html` | 빌드되지 않았으면 503 |
| `GET /assets/*` | 정적 파일 | 자산 허용 목록(§4) 밖이면 404. 경로 탈출(`..`, 인코딩된 슬래시 등)은 거부 |
| `GET /api/today` | `{ snapshot: MobileTodaySnapshot \| null }` | 데스크톱에 재발행도 요청한다(5초에 1번) |
| `GET /api/todos?completed=0\|1` | `{ todos: Todo[] }` | |
| `POST /api/todos/:id/complete` | `{ success: true }` | 이력·활동 로그·`ai:dataChanged`(todo) |
| `POST /api/todos/:id/restore` | `{ success: true }` | 같음 |
| `GET /api/memos` | `{ memos: Memo[], categories: MemoCategory[] }` | 보관하지 않은 메모 전부 |
| `POST /api/memos` | `{ id: number }` | 본문 `{ content, category_id?, is_important? }`. 활동 로그·`ai:dataChanged`(memo) |

### 5.2 IPC

| 채널 | 방향 | 인자 → 반환 |
|---|---|---|
| `mobile:getStatus` | 렌더러 → 메인 | `() → MobileServerStatus` |
| `mobile:setEnabled` | 렌더러 → 메인 | `(enabled: boolean) → MobileServerStatus`. 켜기 실패(포트 모두 사용 중 등)는 `error` 에 담는다 |
| `mobile:regenerateToken` | 렌더러 → 메인 | `() → MobileServerStatus` |
| `mobile:publishToday` | 렌더러 → 메인 | `(snapshot: MobileTodaySnapshot) → { success, error? }` |
| `mobile:publishRequested` | 메인 → 렌더러(이벤트) | 인자 없음. preload 의 `onPublishRequested(cb)` 가 구독 해제 함수를 돌려준다 |

`MobileServerStatus` 는 `{ enabled, running, port, pairUrl, qrDataUrl, error, addresses, tailscale }` 다.

- `addresses: MobileAddress[]` — 휴대폰이 열 수 있는 주소 전부. 주소마다 `{ kind: 'lan' | 'tailscale', iface, ip, pairUrl, qrDataUrl }` 이고 순서는 lan(en0 우선) → tailscale 이다. 서버가 꺼져 있으면 빈 배열(분류·제외 규칙은 §7.1).
- `pairUrl`·`qrDataUrl` — `addresses[0]` 과 같다. 주소가 없으면 null.
- `tailscale: 'connected' | 'installed' | 'not_installed'` — §7 참고.

설정 화면은 옛 응답(`addresses` 가 없음)도 `pairUrl`·`qrDataUrl` 로 같은 네트워크 주소 1개를 만들어 그린다.
렌더러 타입은 `src/renderer/src/types/index.ts` 의 `MobileAPI` 와 `env.d.ts` 의 `window.api.mobile` 이다.

## 6. 포트

`0.0.0.0` 에 바인드한다. 포트 후보는 `MOBILE_PORT_CANDIDATES`(8946 → 8955)이고 앞에서부터 차례로 시도한다. 모두 사용 중이면 켜기 실패로 `error` 를 돌려준다.
포트가 바뀌면 QR 도 바뀌므로 다시 스캔해야 한다. (8945 는 Google OAuth 콜백이 쓴다.)

## 7. 제약

- **Mac 잠자기 / 앱 꺼짐**: 서버가 없으므로 접속되지 않는다.
- **macOS 방화벽**: 처음 켤 때 "들어오는 연결 허용" 을 물으면 허용해야 한다.
- **회사 Wi-Fi 격리**: 기기 간 통신(client isolation)을 막는 네트워크에서는 접속되지 않을 수 있다.
- **주소 없음**: Wi-Fi·유선·Tailscale IPv4 가 하나도 없으면 `addresses` 가 비고 `pairUrl`·`qrDataUrl` 은 null, `error` 에 "Wi-Fi·Tailscale 등 휴대폰이 닿을 주소를 찾지 못했습니다." 가 들어간다. 설정 화면은 그 문구와 "Wi-Fi 주소를 찾지 못했어요" 를 보인다. IP 가 바뀌면 QR 도 바뀐다(설정 화면은 10초마다 다시 읽는다).
- **iOS "홈 화면에 추가" (실기기 미확인)**: 홈 화면 아이콘으로 연 웹앱은 Safari 와 쿠키 저장소가 분리될 수 있다. 그러면 페어링 쿠키가 없어 401 "QR 을 다시 스캔하세요" 안내가 뜰 수 있다. 설정 화면의 사용 안내는 이 경우 Safari 책갈피를 쓰라고 안내한다.
- **오늘 데이터의 신선도**: 오늘 대시보드는 데스크톱 렌더러가 올린 스냅샷이라, 데스크톱 메인 창이 살아 있어야 갱신된다. 헤드라인·신호 문구는 발행 시점의 규칙 문구다.

## 7.1 Tailscale 로 밖에서 접속

같은 Wi-Fi 가 아닐 때(다른 Wi-Fi, LTE) 휴대폰에서 보려면 Mac 과 휴대폰 모두에 [Tailscale](https://tailscale.com/download) 을 설치하고 같은 계정으로 로그인한다. LinkWork 는 Tailscale 을 설정하거나 실행하지 않고, 이미 연결된 Tailscale 주소를 감지해 QR 을 하나 더 보여 줄 뿐이다.

**동작 원리**

1. 메인이 네트워크 인터페이스의 IPv4 를 훑어 `100.64.0.0/10`(Tailscale 이 쓰는 CGNAT 대역 — 첫 옥텟 100, 둘째 옥텟 64~127) 주소를 인터페이스 이름과 관계없이 `tailscale` 로, 그 밖은 `lan` 으로 분류한다(`100.63.x`·`100.128.x` 는 lan). 순서는 lan(en0 먼저) → tailscale 이다. 서버는 `0.0.0.0` 에 바인드돼 있어 그 주소로도 바로 받는다.
   - QR 목록에서 빼는 주소: internal 주소, IPv6, 링크 로컬 `169.254/16`, 가상 브리지·호스트 전용 인터페이스(`bridge*`, `vmnet*`, `vnic*`, `vboxnet*`, `docker*`, `veth*`, `awdl*`, `llw*`, `anpi*`, `ap<숫자>`, `gif*`, `stf*`), 터널 인터페이스(`utun*`, `tun*`, `tap*`, `ipsec*`, `ppp*`)의 비-Tailscale 주소(회사 VPN 등). Host 허용 목록은 이와 별개로 internal 아닌 IPv4 전체 + `localhost` + `127.0.0.1` 이다.
2. 상태 `tailscale` 은 외부 프로세스(`tailscale status`)를 실행하지 않고 판정한다 — Tailscale 주소가 있으면 `connected`, 설치 흔적(`/Applications/Tailscale.app`, `/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale`)만 있으면 `installed`, 둘 다 없으면 `not_installed`. 이 값은 서버가 꺼져 있어도 계산한다.
3. 주소마다 페어링 URL 과 QR 을 만든다. QR 은 메인이 pairUrl(토큰·IP·포트)을 키로 캐시하므로(최대 32개) 설정 화면이 10초마다 상태를 읽어도 다시 만들지 않는다. 토큰을 재발급하거나 포트가 바뀌면 새로 만든다. 설정 > 모바일은 주소가 2개 이상이면 "같은 네트워크" / "어디서나 (Tailscale)" 선택을 보인다. 같은 종류가 2개 이상이면(유선+Wi-Fi 등) `Wi-Fi·유선 (en0 · 192.168.0.5)` 처럼 인터페이스·IP 로 구분한다. 고른 주소가 재조회로 사라지면 첫 주소로 돌아간다.

**설정 절차** (설정 화면의 Tailscale 안내와 같다)

| 상태 | 화면 안내 |
|---|---|
| `not_installed` | ① Mac 에 Tailscale 설치·로그인(tailscale.com/download 링크 — 외부 브라우저로 열린다) ② 휴대폰에도 Tailscale 앱 설치 후 같은 계정으로 로그인 ③ 두 기기에서 Tailscale 을 켠 뒤 "어디서나" QR 이 나타나면 스캔 |
| `installed` | Tailscale 이 꺼져 있다. Mac 메뉴 막대의 Tailscale 에서 연결하면 "어디서나" QR 이 나타난다 |
| `connected` | "어디서나" QR 을 고를 수 있다. 휴대폰에서도 Tailscale 이 켜져 있어야 열린다 |

**쿠키는 주소마다 따로다.** 쿠키는 출처(`http://<ip>:<port>`)에 묶이므로, 같은 네트워크 QR 로 연결한 휴대폰도 Tailscale 주소로 열려면 "어디서나" QR 로 한 번 더 스캔해야 한다. 토큰은 하나라서 "QR 다시 만들기" 는 모든 주소의 연결을 함께 끊는다.

**보안 조건은 같다.** Tailscale 주소로 들어온 요청에도 Host 검사·쿠키·속도 제한이 똑같이 적용된다. Host 는 이 Mac 의 100.x 주소만 허용한다.

**MagicDNS 이름은 지원하지 않는다.** Host 검사가 IP 만 허용하므로 `<기기>.<tailnet>.ts.net` 이나 짧은 기기 이름으로 열면 403 이다. QR 의 IP 주소로 연다.

**외부 서비스 의존.** 기기 찾기·연결 조율(키 교환, NAT 통과)은 Tailscale 의 조율 서버가 한다. 데이터는 기기 사이에 직접(직접 연결이 안 되면 Tailscale 의 중계 서버 DERP 를 거쳐) WireGuard 로 암호화돼 오가므로, Tailscale 이 내용을 볼 수는 없다. 다만 Tailscale 계정과 서비스가 동작해야 접속된다. 휴대폰이 Tailscale 에 연결돼 있지 않으면 "어디서나" 주소는 열리지 않는다.

## 8. 파일 위치

| 파일 | 역할 |
|---|---|
| `src/main/services/mobile/server.ts` | HTTP 서버(라우팅·인증·POST 조건·속도 제한). electron 을 import 하지 않는다 |
| `src/main/services/mobile/auth.ts` | 토큰 생성·쿠키 유도·Host 검사·실패 제한 |
| `src/main/services/mobile/network.ts` | 주소 목록(lan·tailscale 분류, en0 우선)·Tailscale 상태 감지·Host 허용 목록 |
| `src/main/services/mobile/status.ts` | `MobileServerStatus` 조립 |
| `src/main/services/mobile/qr.ts` | 페어링 URL 의 QR(SVG data URL) |
| `src/main/services/mobile/static.ts` | `mobile.html`·`assets/*` 정적 파일 해석(경로 탈출 거부·자산 허용 목록) |
| `src/main/services/mobile/snapshot.ts` | 마지막 오늘 스냅샷 보관·검사 |
| `src/main/services/mobile/controller.ts` | 서버 수명(앱 시작 때 켜짐이면 시작, 종료 때 정지)·상태·스냅샷 보관·재발행 요청. IPC 는 `src/main/ipc/mobile.ipc.ts` |
| `src/main/services/mobile/settings.ts` | 켜짐 여부·토큰(safeStorage) 저장 |
| `src/main/services/mobile/types.ts` | 메인 쪽 계약 타입·포트 후보·설정 키 |
| `src/preload/index.ts` | `window.api.mobile` |
| `src/renderer/src/mobile/contract.ts` | 렌더러 쪽 계약 타입(데스크톱·모바일 공용) |
| `src/renderer/src/mobile/` , `src/renderer/mobile.html` | 모바일 화면 |
| `src/renderer/src/components/mobile/` | 데스크톱의 스냅샷 발행기(`MobileTodayPublisher.tsx`, `mobilePublish.ts`) |
| `src/renderer/src/stores/mobileStore.ts` | 서버 상태 스토어(설정 섹션·발행기 공용) |
| `src/renderer/src/components/settings/sections/MobileSection.tsx` | 설정 > 모바일 |
