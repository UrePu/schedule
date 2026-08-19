# 캐싱 전략 — 구현 사실 기록

작성 2026-08-18. 근거 규약은 `CLAUDE.md` §2.4 이고, **이 문서는 규약을 복사하지 않는다.**
여기 적는 것은 *실제로 어떻게 구현했는가* 다: 무엇을 prefetch 하고 무엇을 하지 않는지,
각 쿼리가 어느 티어인지, `router.refresh()` 를 어디에 남기고 어디서 뺐는지,
요청 범위 QueryClient 를 **어떤 구조로** 강제했는지.

---

## 0. 무엇이 문제였나 (한 문단)

발주자 보고: *"tanstackquery 제대로 적용 된건지 모르겠는데 invalidatequerykey 가 제대로
안된거같음."* 조사 결과 **무효화 호출은 멀쩡했다.** 진짜 원인은 네 화면이 전부 서버
컴포넌트에서 DB 를 읽어 **행을 props 로 내려보내고 있었다**는 것이다. `invalidateQueries()`
는 props 에 닿을 수 없으므로, 클리어를 체크해도 계획을 꺼도 서버 렌더분은 새로고침
전까지 낡은 값 그대로였다. 저장소 전체의 `initialData` 사용은 11건뿐이었고 — 즉 **서버
props 와 클라이언트 쿼리가 같은 데이터를 두 벌로 들고 서로 몰랐다.**

발주자 결정: *"2안으로 해야지 서버로 받는건 좋다이거야. 근데 캐싱전략은 제대로
확립해야지?"* → **서버에서 읽는 것은 유지하고, 그 결과를 넣는 자리만 바꿨다.**

---

## 1. 서버 prefetch → dehydrate → HydrationBoundary

```
서버 컴포넌트(page.tsx)
  └ dehydrateQueries(async (qc) => { qc.setQueryData(화면이 쓰는 그 키, await repo(...)) })
       └ 요청마다 새 QueryClient → dehydrate() → 직렬화 스냅샷
클라이언트
  └ <HydrationBoundary state={…}> → useQuery(같은 키) 가 첫 렌더부터 값을 갖는다
```

핵심은 **키가 같다는 것**이다. 서버는 워크스페이스가 실제로 쓰는 캐시 키 그대로 심고,
클라이언트는 평범한 `useQuery` 만 쓴다. 그래서

- 뮤테이션은 `invalidateQueries` **만으로** 서버가 채운 값을 갈아엎을 수 있고,
- "지금 보고 있는 조합이 서버가 계산한 그 조합인가"를 판정하던 파생 플래그
  (`isInitialParty` · `isInitialRoster` · `initialScope`)가 **통째로 사라졌다.**
  키가 다르면 애초에 맞지 않으므로 판정이 틀릴 자리가 구조적으로 없다.

### 첫 페인트는 스켈레톤으로 퇴행하지 않는다

`HydrationBoundary` 는 `useMemo` 안에서 `hydrate()` 를 부른다
(`@tanstack/react-query/build/modern/HydrationBoundary.js`). 즉 **렌더 중에** 캐시가 채워지므로
SSR 패스에서도 `useQuery` 가 데이터를 갖는다. 서버 렌더 HTML 에 값이 그대로 들어 있음을
실측으로 확인했다(§6-3).

### `initialData` 를 안 쓰는 이유

`initialData` 는 `initialDataUpdatedAt` 을 함께 주지 않으면 그 값이 캐시에서 **영원히
신선한 것**으로 취급된다. 기존 코드 11곳이 전부 그 상태였다. 하이드레이션은 `dataUpdatedAt`
을 스냅샷과 함께 실어 오므로 그 함정이 없다. **현재 저장소에 `initialData` 사용은 0건이다**
(주석에서 설명용으로만 언급된다).

---

## 2. Rule 2 — 요청 범위 QueryClient 를 **구조로** 강제한 방법

서버 QueryClient 가 모듈 레벨에 있으면 한 사람의 파티·수익이 다음 방문자에게 나간다.
규율이 아니라 구조로 막았다. `src/lib/query/server-cache.ts`:

1. **QueryClient 를 export 하지 않는다.** 이 모듈의 유일한 export 는
   `dehydrateQueries(prefetch)` 함수 하나이고, 인스턴스는 그 함수의 **지역 변수**로만
   존재한다. 함수 밖으로 나가는 것은 평범한 직렬화 스냅샷(`DehydratedState`)뿐이라,
   호출부가 클라이언트를 붙들어 둘 방법 자체가 없다.
2. **`import "server-only"`** — 이 모듈이 클라이언트 번들에 끌려 들어가면 빌드가 깨진다.
3. 클라이언트 쪽(`app/providers.tsx`)도 대칭이다. `new QueryClient` 는 `useState` 초기화
   함수 안에 있어 **컴포넌트 인스턴스에 매인다** — 모듈 싱글턴이 아니다.

**검증 (§6-6):** `grep -rn "new QueryClient" src` 의 결과는 두 곳뿐이고 **둘 다 함수
본문 안**이다. 모듈 최상단에 하나라도 있으면 그것이 곧 그 버그다.

---

## 3. 무엇을 prefetch 하고 무엇을 하지 않는가

### 하는 것 — **우리 DB 읽기만**

| 화면 | 심는 키 | 서버 함수 |
|---|---|---|
| `/` (로그인) | `db.dashboard.summary(weekKey)` | `fetchDashboardData` |
| `/` (로그인) | `db.bossPlans.checklist()` | ↑ 같은 호출의 `checklist` 를 나눠 심는다 |
| `/` (로그인) | `db.auth.session()` | `loadSessionUser`(이미 읽은 값) |
| `/boss-plans` | `db.bossPlans.checklist()` | `fetchWeeklyChecklist` |
| `/boss-plans` | `db.party.mine(weekKey)` | `fetchMyParties` |
| `/boss-plans` | `db.bosses.catalog()` | `fetchBossCatalog` |
| `/boss-plans` | `db.bossPlans.character(선택된 캐릭터)` | `fetchCharacterPlanBundle` |
| `/income` | `db.income.detail(weekKey)` | `fetchWeeklyIncomeDetail` |
| `/schedule` | `db.party.list()` | `fetchParties` |
| `/schedule` | `db.party.members(첫 파티)` | `fetchPartyMembers` |
| `/schedule` | `db.party.bosses(첫 파티)` | `fetchPartyBosses` |
| `/schedule` | `db.runs.list(첫 파티, weekKey)` | `fetchPartyRuns` |
| `/schedule` | `db.availability.resolve/overlap/exceptions` | `fetchAvailability*` |
| `/schedule` | `db.availability.myPatterns()` (로그인 시) | `fetchMyAvailabilityPatterns` |
| `/schedule` | `db.bosses.catalog()` | `fetchBossCatalog` |
| `/schedule` | `db.characters.forRuns()` (로그인 시) | `fetchMyRunCharacters` |

`/` 의 대시보드는 `fetchDashboardData()` **한 번**으로 두 키를 채운다. 체크리스트는 그
응답에 이미 들어 있으므로 다시 읽지 않으면서도, 동기화 버튼이 체크리스트만 따로
무효화·재조회할 수 있다.

### ⚠️ 하지 않는 것

- **넥슨 API 는 서버 prefetch 에서 한 번도 부르지 않는다.** 넥슨 호출은 캐릭터당 1콜이고
  개발 키는 하루 1,000콜이라(§1.1), 페이지 진입마다 도는 prefetch 에 얹으면 화면을 여는
  것만으로 예산이 녹는다. 넥슨은 **사용자 조작(동기화 버튼)과 자동 동기화 훅**에서만 나간다.
  이번 작업으로 넥슨 호출 지점은 **한 곳도 늘지 않았다.**
- **편집기를 열어야만 켜지는 조회** — `db.people.pool()`(파티 편집 다이얼로그),
  특이사항 편집 구간(오늘부터 8주), `db.characters.list()`(캐릭터 선택 모달),
  `db.party.members(...)`(계획 화면의 일정 모달). 화면에 쓰이지 않는 요청을 미리 하는 것은
  그냥 DB 부하다.
- **`/schedule` 에서 사람이 0명일 때의 가용시간 3종** — 워크스페이스가 `enabled: false` 로
  끄므로 켜지지 않을 키에 값을 심으면 캐시에 죽은 항목만 남는다. 조건을 화면과 똑같이 맞췄다.
- **로그아웃 상태의 세션·수익·계획** — 세션이 없으면 그 prefetch 자체를 건너뛴다.
  실패를 삼키지 않는다(§5).

---

## 4. staleTime 티어 (Rule 4)

값은 `src/lib/query-keys.ts` 의 `STALE_TIME` **한 곳**에만 있다. `app/providers.tsx` 의
전역 기본값도 `STALE_TIME.db` 를 그대로 참조한다 — 60000 을 다시 적으면 갈라질 두 번째
출처가 생긴다.

| 티어 | staleTime | 헬퍼 | 근거 |
|---|---|---|---|
| `session` | 30초 | `sessionQueryOptions` | 계정 상태가 화면 전체를 가른다. 틀린 값의 대가가 가장 크다. |
| `db` | 60초 | `dbQueryOptions` | 우리 DB 의 가변 데이터. 신선도는 **뮤테이션 후 무효화**가 진다. |
| `bossMaster` | 6시간 | `bossMasterQueryOptions` | 게임 패치 때만 바뀐다. 이동마다 다시 받는 것은 순수한 낭비. |
| `nexon` | **≥ 15분** | `nexonQueryOptions` | 상류가 ~15분 지연(§1.1). 더 자주 물으면 같은 값 + 쿼터 소모. |

**넥슨 하한은 낮추지 않았고, 낮출 수도 없다.** `nexonQueryOptions()` 는 15분 미만을 주면
개발에서 던지고 프로덕션에서 하한으로 올린다(기존 구현 그대로). `db` 계열 헬퍼도 대칭으로
**네임스페이스를 검사한다** — 넥슨 키에 60초를 붙이면 즉시 던진다.

### 쿼리별 배치 (전 28건)

**session (2)**
- `db.auth.session()` — `useSessionQuery`
- `db.auth.credentials()` — `useCredentialsQuery`

**bossMaster (2)**
- `db.bosses.catalog()` — `ScheduleWorkspace.bossQuery`, `BossPlanWorkspace.bossQuery`

**nexon (2)**
- `nexon.characterList(credentialId)` — `useNexonCharacterListQuery`
- `nexon.characterPortrait(ocid)` — `useNexonCharacterPortraitQuery`

**db (22)**
- `db.auth.quota()` — 넥슨이 아니라 **우리 장부**를 읽는다(넥슨엔 잔여량 헤더가 없다)
- `db.dashboard.summary(weekKey)` — `Dashboard`
- `db.income.detail(weekKey)` — `IncomeWorkspace`
- `db.bossPlans.checklist()` — `WeeklyChecklist`, `BossPlanWorkspace`
- `db.bossPlans.character(id)` — `BossPlanWorkspace`, `ScheduleWorkspace`(등록 폼의 계획 목록)
- `db.party.list()` / `db.party.mine(weekKey)` / `db.party.members(id)` ×2 / `db.party.bosses(id)`
- `db.people.pool()`
- `db.availability.resolve / overlap / exceptions ×2 / myPatterns`
- `db.runs.list(partyId, weekKey)`
- `db.characters.forRuns()` / `db.characters.list()`

**검증 (§6-7):** 정규식 스캔 결과 `useQuery({ … })` 28건이 **전부** 네 헬퍼 중 하나를
스프레드한다. 매직 넘버 staleTime 은 애플리케이션 코드에 0건이다.

---

## 5. 키는 전부 `src/lib/query-keys.ts` (Rule 5)

옮긴 것:

- `authQueryKeys`(features/auth/data/auth-queries.ts) → `queryKeys.db.auth.*`
- `characterQueryKeys`(features/characters/data/character-queries.ts) → `queryKeys.db.characters.*`

둘 다 **별칭으로만 남겼다**(`export const authQueryKeys = queryKeys.db.auth;`). 호출부를
전부 바꾸는 대신 정의를 하나로 만든 것이라, 값이 갈라질 여지가 없다.

고친 배열 리터럴 2건:
- `auth-queries.ts:242` · `auth-queries.ts:313` 의 `["db","characters"]`
  → `queryKeys.db.characters.root()`.
  기존 주석은 "순환 import 회피"를 이유로 들었는데, 키가 `@/lib/query-keys` 로 모인 지금은
  그 순환이 없다(이 파일은 features 를 거치지 않고 팩토리를 직접 부른다).

새로 만든 키:
- `db.dashboard.root() / summary(weekKey)` — `GET /api/dashboard`
- `db.party.mine(weekKey)` — `GET /api/schedule/parties/mine`
- `db.characters.list()` — 기존 `characterQueryKeys.list()` 를 옮긴 것

**검증 (§6-1):** `grep -rn "queryKey: \[" src` → **0건.**

> 참고: 컨덕터 메모의 *"schedule-workspace.tsx 에 queryKey 정의가 25개"* 는 `queryKey:`
> **occurrence** 25건이었고, 실제로는 25건 모두 이미 팩토리 호출이었다. 배열 리터럴은
> `auth-queries.ts` 두 곳뿐이었다. 그럼에도 그 파일이 문제였던 것은 사실이다 — 다만
> 원인은 키가 아니라 **`initialData` 9개와 `isInitialParty`/`isInitialRoster` 판정**이었고,
> 그쪽은 이번에 통째로 사라졌다.

---

## 6. 새로 만든 것 / 지운 것

### 새 Route Handler 2개 (클라이언트 재조회 경로)

캐시가 화면을 소유하려면 **클라이언트가 다시 받아 올 경로**가 있어야 한다. 서버 repo 는
service_role 이라 브라우저가 직접 부를 수 없다.

- `GET /api/dashboard?weekKey=` → `DashboardData` (수익 · 파티 · 체크리스트 · 12칸). 401 게이트.
- `GET /api/schedule/parties/mine?weekKey=` → 내가 속한 파티만. 401 게이트.
  `GET /api/schedule/parties`(볼 수 있는 것 = 남의 공개 파티 포함)와 **의도적으로 다르다.**

### 서버가 세던 숫자를 화면 쪽으로 옮긴 것

서버 렌더에 박힌 집계는 뮤테이션을 따라오지 않는다. 세 곳을 옮겼다.

- `/boss-plans` 헤더 `추적 캐릭터 N명` → `BossPlanWorkspace` 안에서 **목록과 같은 배열**로 센다.
- `/schedule` 헤더 `파티 N개` → 제거. 바로 아래 `PartyBar` 가 쿼리에서 온 같은 목록으로
  이미 개수를 그린다(두 자리에 두면 언젠가 서로 다른 말을 한다).
- 대시보드 제목의 본캐 닉네임 → `useSessionUser()` 로. 키를 추가해 본캐가 바뀌면
  mutation 이 세션 캐시를 갱신하고 제목이 곧바로 따라온다.

### props 에서 제거한 데이터

| 컴포넌트 | 없앤 props |
|---|---|
| `Dashboard` | `user`, `data: DashboardData` |
| `WeeklyChecklist` | `initial: CharacterChecklist[]` |
| `IncomeWorkspace` | `initial: WeeklyIncomeDetail` |
| `BossPlanWorkspace` | `characters`, `parties` |
| `ScheduleWorkspace` | `initial`(12개 필드 전부) |

**props 로 남긴 것**과 그 이유: `now`(서버 기준 시각 — 하이드레이션 불일치 방지),
`range`/`weekKey`(주 경계 계산 결과이자 캐시 키의 일부), `viewerPersonId`(열람자 신원 —
여러 쿼리의 `enabled` 를 가른다), `initialCharacterId`(`?characterId=` 로 온 **선택 상태**).
넷 다 **뮤테이션이 바꿀 수 있는 데이터가 아니다.**

---

## 7. `router.refresh()` — 남긴 자리와 뺀 자리

작업 전 5건 → 3건 → **최종 1건** (2026-08-19 갱신).

### ⚠️ 2026-08-19 정정 — 인증 전환은 `router.refresh()` 를 쓰지 않는다

발주자가 **로그인했는데 랜딩이 그대로**인 화면을 보고했다(계정 카드에는 `로그인됨 · 더저`).
서버는 결백했다 — 유효한 세션 쿠키로 `GET /` 하면 대시보드가 정확히 나온다.

원인은 클라이언트 쪽이고 두 가지가 겹쳐 있었다.
1. `router.refresh()` 는 `startTransition` 안에서 서스펜드하므로 **커밋 전까지 옛 UI 가 남는다.**
   "부르면 반드시 바뀐다"는 호출이 아니다.
2. 같은 날 성능 작업으로 올린 `staleTimes.dynamic: 30` 이 **세션이 화면 *모양*을 가르는**
   라우트의 RSC 페이로드를 30초간 들고 있었다. 캐시 태그 단위는 URL 이지 세션이 아니라,
   남는 것이 "조금 낡은 숫자"가 아니라 **로그인 전/후의 다른 화면**이다.
   로그아웃 후 30초가 특히 나쁘다 — 남의 PC 라면 그건 버그가 아니다.
   → `dynamic: 0` 으로 되돌렸다(`next.config.ts` 주석에 이력 기재).

**인증 상태가 바뀌는 자리는 문서를 다시 적재한다**(`window.location.replace("/")`).
로그인·로그아웃은 자주 일어나는 동작이 아니라 문서 로드 한 번을 치를 값어치가 있고,
재적재는 라우터 캐시·BFCache·로그인 전 쿼리 캐시를 **전부** 버린다. SPA 시도를 하지 않으므로
"트랜지션이 안 커밋되면 옛 화면이 남는" 경우의 수가 구조적으로 0이다.
`assign` 이 아니라 `replace` 인 이유 — 뒤로가기가 로그인 전 랜딩으로 돌아가면 안 된다.
사용자가 랜딩을 보는 시간: **1.5초 → 0**(감시 타이머 삭제).

⚠️ 추적 캐릭터 0명 경로는 모달이 **저장 요청이 나가는 중에 닫히므로**, 닫힘 신호로 재적재하면
그 POST 가 끊겨 방금 고른 명단이 사라진다. `CharacterPickerTrigger.onFinished`(요청 settled 후
또는 그냥 닫음)에서만 전환한다.

### 남김 (페이지 **형태**가 서버에 달려 있고, 재적재가 과한 자리)

| 위치 | 이유 |
|---|---|
| `features/invites/components/invite-claim-panel.tsx` | 승계 후 `/invite/[token]` 의 서버 렌더가 세션·초대 상태를 다시 판정한다. **`onSuccess` 가 아니라 `onSettled`** — 실패해도 서버 판정을 다시 받아야 한다. |

### 문서 재적재로 바꿈

| 위치 | 방식 |
|---|---|
| `features/auth/components/home-auth-section.tsx` | 로그인 성공 → `window.location.replace("/")` |
| `features/auth/components/logout-button.tsx` | 로그아웃 → `window.location.replace("/")` |
| `features/invites/components/invite-claim-panel.tsx:73` | 승계 후 `/invite/[token]` 의 서버 렌더가 세션·초대 상태를 다시 판정한다. |

### 뺌 (숫자 갱신용이었다 — Rule 3 위반)

| 위치 | 대신 무엇이 하는가 |
|---|---|
| `features/auth/components/credential-manager.tsx` 키 **추가** 성공 | `useAddCredentialMutation` 이 세션·키 목록을 직접 심고 `db.characters` · `db.bossPlans` · `db.dashboard` 를 무효화한다. |
| `features/auth/components/credential-manager.tsx` 키 **삭제** 성공 | `useDeleteCredentialMutation` 이 같은 대상을 무효화한다. |

둘 다 **로그인 상태가 그대로**라 페이지 형태가 바뀌지 않는다. 기존 주석의 근거
(*"대시보드는 서버 컴포넌트라 쿼리 캐시 밖"*)가 이번 작업으로 사실이 아니게 됐다.
`useRouter` import 도 함께 제거했다.

---

## 8. 무효화 누락 — 찾아서 채운 목록

뮤테이션 전수를 훑어 "이 변경이 실제로 그 화면을 덮는가"를 확인했다. 채운 것:

| 뮤테이션 | 빠져 있던 무효화 | 증상 |
|---|---|---|
| `CharacterPickerTrigger.save` (추적 캐릭터 저장) | `db.characters.forRuns()` · `db.bossPlans` · `db.dashboard` | **가장 컸다.** 저장 응답이 갱신하는 것은 모달 자신의 목록뿐인데, 추적 명단은 대시보드 12칸의 **분모**이자 체크리스트·계획 화면의 캐릭터 칩이자 등록 폼의 캐릭터 목록이다. 캐릭터를 추가해도 홈의 분모가 옛 숫자였다. |
| `WeeklyChecklist.sync` (수동 동기화) | `db.income` · `db.dashboard` | 동기화는 인게임 `complete_flag` 를 읽어 **클리어를 기록**한다(`clearRecordedCount`). 체크리스트만 갱신되고 바로 위 수익 카드는 옛 금액을 말했다. |
| `useSchedulerAutoSync` (자동 동기화) | `db.income` · `db.dashboard` | 위와 같은 대상. 한쪽 경로에만 적으면 자동으로 돈 날에만 숫자가 어긋난다. |
| `BossPlanWorkspace.applyBundle` (계획 켜기/끄기/인원수) | `db.dashboard` | 수익 카드와 12칸 분모가 같은 원장에서 나온다. |
| `BossPlanWorkspace.sync` | `db.income` · `db.dashboard` | 위와 같은 이유. |
| `IncomeWorkspace.applyDetail` (클리어 체크·인원 수정) | `db.dashboard` · `db.bossPlans` | 기존 주석은 *"대시보드는 서버 컴포넌트라 다음 진입에서 다시 읽힌다"* 였는데, 그 말인즉 **뒤로 가기로 돌아가면 낡은 값**이라는 뜻이었다. |
| `PlanRunDialog.createRun` (계획 화면에서 일정 등록) | `db.dashboard` | 대시보드 파티 카드가 파티마다 **이번 주 일정 건수**를 싣는다. |
| `ScheduleWorkspace.createRun` | `db.party.mine(weekKey)` · `db.dashboard` | 같은 집계. `party.root()` 를 통째로 날리지 않고 `party.mine` 만 짚었다 — 과잉 무효화는 구성원·보스 목록까지 불필요하게 다시 받게 한다. |
| `ScheduleWorkspace.saveParty` / `saveRoster` | `db.dashboard` | 파티가 늘거나 구성원 수가 바뀌면 대시보드 파티 카드가 바뀐다. |
| `useLoginMutation` | `db.root()` | 로그인 전 캐시는 **다른 사람의 답**이다(비로그인 공개 파티 목록 등). 남아 있으면 로그인 직후 화면이 잠깐 "파티 없음"을 말한다. 넥슨은 건드리지 않는다(쿼터). |
| `useLogoutMutation` | `removeQueries(db.root())` | 예전에는 세션·키·넥슨만 지우고 파티·수익·계획은 메모리에 남겼다. 캐시가 화면을 소유하는 지금은 **다음 사람이 앞사람의 숫자를 볼 수 있다.** 지우는 순서도 고쳤다 — 먼저 지우고, 그 다음에 "비로그인"을 심는다(반대로 하면 방금 심은 세션까지 지워져 화면이 로딩으로 되돌아간다). |
| `useAddCredentialMutation` / `useDeleteCredentialMutation` | `db.dashboard` | `router.refresh()` 를 없앤 자리를 메운다. |

**빠뜨리지 않은 것으로 확인된 것**: `saveMyCharacter`(party.members + runs.root — 대시보드에
영향 없음), `savePatterns`/`addException`/`removeException`(availability.root 하나로 3종 커버),
`signup`(runs.list), `GuestInviteDialog.invite`(토큰 발급만 — 화면 데이터를 바꾸지 않는다),
`InviteClaimPanel.claim`(`db.root()` 전체).

---

## 9. 검증 결과

| # | 항목 | 결과 |
|---|---|---|
| 1 | `pnpm typecheck` | **exit 0** |
| 2 | `pnpm lint` | **exit 0** |
| 3 | `pnpm build` | **성공** (42 라우트, `/api/dashboard` · `/api/schedule/parties/mine` 포함) |
| 4 | 비로그인 4화면 | `PORT=3187 pnpm start` (로그에 `✓ Ready`, 바인드 오류 없음) → `/` **200** · `/schedule` **200** · `/boss-plans` **200** · `/income` **200** |
| 5 | 무효화 회귀 | 아래 §9-1 |
| 6 | Rule 2 (요청 범위) | `grep -rn "new QueryClient" src` → 2건, **둘 다 함수 본문 안**(`providers.tsx` 의 `useState` 팩토리 · `server-cache.ts` 의 `dehydrateQueries`). 모듈 레벨 인스턴스 0건, export 되는 인스턴스 0건. |
| 7 | 키 팩토리 | `grep -rn "queryKey: \[" src` → **0건** |

추가로 확인한 것:
- `grep -rn "initialData" src` → 실제 사용 **0건**(주석 언급뿐).
- `useQuery({…})` 28건 전부가 티어 헬퍼를 스프레드한다(정규식 스캔).
- 새 엔드포인트가 실제로 라우팅된다: 비로그인 `GET /api/dashboard` → **401**,
  `GET /api/schedule/parties/mine` → **401**(404 가 아니다 = `[partyId]` 와 충돌하지 않는다).
- `/schedule` 서버 HTML 에 dehydrate 스냅샷이 실린다: `queryHash` 2건(비로그인이므로
  `party.list` + `bosses.catalog` 둘뿐 — 나머지는 위 §3 규칙대로 건너뛴 것), 그리고
  `bossDifficultyId` 54건 = **보스 카탈로그가 첫 HTML 에 이미 들어 있다**(스켈레톤 아님).

### 9-1. 무효화 회귀 테스트 — 방법과 결과

로그인 세션이 필요한 조작을 브라우저 없이 클릭할 수 없으므로, **루프의 두 반쪽을 각각
증명**했다. 둘이 붙으면 "뮤테이션 → 무효화 → 화면 갱신"이 닫힌다.

**(a) 화면이 props 가 아니라 쿼리에서 읽는다** — 정적 확인
`initialData` 0건, 네 워크스페이스의 데이터 props 0개(§6), 모든 표시 값이 `useQuery` 결과에서
나온다. 즉 무효화가 닿을 수 있는 자리에 데이터가 있다.

**(b) 무효화 키가 그 쿼리 키를 실제로 덮는다** — 실행 확인
`invalidateQueries({queryKey})` 는 내부적으로 `matchQuery()` → `partialMatchKey(query.queryKey,
queryKey)` 로 접두사 일치를 판정한다. 그 **실제 함수**(`@tanstack/query-core` 5.101.4)를
불러오고, **실제 키 팩토리**(`src/lib/query-keys.ts`)로 만든 키 쌍을 넣어 27건을 검사했다.

실행: Node 24 네이티브 타입 스트리핑 + `@/` 별칭 resolve 훅 (스크래치패드의 일회성
스크립트 — 저장소에 파일을 남기지 않았고 새 의존성도 없다).

결과: **27건 중 실패 0건.** 요구된 두 경로를 포함한다.

- **경로 A — 보스 계획 끄기** (`/boss-plans`)
  - `db.bossPlans.character(id)` → 계획 목록 ✅ (응답 번들을 `setQueryData` 로 직접 얹는다)
  - `db.dashboard` → `db.dashboard.summary(weekKey)` (12칸 분모) ✅
  - `db.bossPlans.checklist` → 체크리스트 ✅
  - `db.income` → `db.income.detail(weekKey)` (수익 원장) ✅
- **경로 B — 파티 구성원 변경** (`/schedule`)
  - `db.party.members(id)` → 구성원 목록 ✅
  - `db.party` → `db.party.list()` (자동 제목이 바뀐다) ✅ / `db.party.bosses(id)` ✅
  - `db.availability` → `resolve` ✅ / `overlap` ✅ / `exceptions` ✅ (셋을 한 접두사로 덮는다)
  - `db.runs` → `db.runs.list(partyId, weekKey)` (참가자 이름이 실려 나간다) ✅
  - `db.dashboard` → 파티 카드의 `N명` ✅
- 그 밖에 일정 등록 · 클리어 체크 · 추적 캐릭터 변경 · 키 추가/삭제 · 패턴 저장 경로 ✅

**반대 방향도 검사했다**(덮으면 안 되는 것, 3건 전부 PASS):
- `db` 무효화가 `nexon.characterList` / `nexon.characterPortrait` 를 건드리지 않는다
  → 쿼터가 걸린 응답이 살아남는다.
- `db.party` 무효화가 `db.income.detail` 까지 날리지 않는다 → 과잉 무효화 방지.

**남는 한계(솔직하게):** 실제 브라우저에서 버튼을 눌러 픽셀이 바뀌는 것까지는 확인하지
못했다. 위 두 반쪽은 그 사이의 **모든 프로그램적 연결**을 덮지만, 렌더 단계의 실수(예:
쿼리 결과를 화면에 안 꽂은 경우)는 잡지 못한다. 그 부분은 typecheck + 기존 화면 코드가
그대로라는 사실에 기댄다.

---

## 10. 남은 이슈 · 가정

1. **`/income` 헤더의 본캐 닉네임은 여전히 서버 렌더 값**이다(`user.mainCharacterName`).
   그 화면에는 계정을 바꾸는 조작이 없어 세션 안에서 낡을 수 없다고 판단했다. 대시보드
   쪽은 세션 쿼리로 옮겼다.
2. **`/boss-plans` 진입 시 DB 읽기가 하나 늘었다**(선택된 캐릭터의 계획 번들). 예전에는
   그 자리가 첫 페인트 스켈레톤이었다. 넥슨 호출은 늘지 않았다.
3. **`db.dashboard` 는 화면 하나 = 쿼리 하나**로 묶었다. 수익 합계 · 12칸 분모 · 파티 건수가
   같은 원장에서 한 번에 나온 값이라 조각으로 나누면 화면이 잠깐 서로 어긋난 숫자를 말한다.
   대신 그중 하나만 바뀌어도 전부 다시 받는다 — 우리 DB 조회 한 번이므로 감수한다.
4. **`GET /api/dashboard` 는 401 을 준다**(체크리스트 경로의 "200 + 빈 배열"과 다르다).
   이 쿼리는 대시보드가 렌더될 때만 마운트되므로 에러 UI 가 번쩍일 자리가 없고,
   `/api/income` 과 같은 경계를 지키는 편이 일관적이라고 봤다.
5. **DB 마이그레이션은 없다.** 스키마 변경 없이 끝나는 작업이었다.
