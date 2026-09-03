-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · `!환산` 이 긁어 온 **환산 스탯 캐시**
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-09-03): `!환산 <닉네임>` 이 링크 한 줄만 던지지 말고 **스탯 요약**까지
-- 같이 돌려주게 한다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 이 값들은 어디서 오는가 — 넥슨이 아니다
-- ───────────────────────────────────────────────────────────────────────────────
-- 환산 주스탯은 **넥슨 API 에 없는 계산값**이다(§1.1 "NOT available"). 남의 사이트
-- (maplescouter.com)가 계산해서 자기 화면에 그리는 값이고, 우리는 그 **페이지를 헤드리스
-- 브라우저로 열어** 페이지 스스로가 받는 응답을 엿들어 읽는다
-- (`features/bot/server/scouter.ts`).
--
-- ⚠️ 그쪽 내부 API 를 **직접 부르지 않는다.** `api.maplescouter.com` 은 `viewer-key`
--    헤더를 요구하고, 그걸 흉내내는 것은 접근 제어 우회다. 우리는 사람이 브라우저로 여는
--    것과 똑같이 **공개 페이지를 열기만** 한다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★★ 표가 필요한 이유는 **비용이 크롬 한 통이기 때문**이다 ★★
-- ───────────────────────────────────────────────────────────────────────────────
-- 넥슨 캐시(`character_looks`)의 비용 단위는 "API 2콜"이었다. 여기는 다르다 —
-- **조회 한 번에 크롬 프로세스가 하나 뜬다.** 실측(2026-09-03, 로컬):
--
--   브라우저 기동            405ms
--   조회 1건(페이지 열기~응답) 0.9 ~ 2.0초
--
-- 서버리스에서 이건 함수 실행시간이자 메모리다. 방에서 같은 닉네임을 두 번 치는 것만으로
-- 크롬이 두 번 뜨면 안 된다. 그래서 **양성 30분 · 음성 24시간** 캐시를 둔다.
--
-- ⚠️ **TTL 판정은 SQL 이 아니라 읽는 쪽(`scouter.ts`)이 한다.** 이 표는 값과 시각만
--    보관하고 "신선한가"는 코드가 정한다 — `character_looks` 와 같은 결이며, TTL 을
--    바꾸려고 마이그레이션을 다시 쓰게 만들지 않기 위해서다.
--
-- 왜 30분인가: 환산 스탯은 사람이 **장비를 갈아입어야** 변한다. 방에서 자랑하려고 두세
-- 번 연달아 치는 것이 전형적인 사용 패턴이라, 그 연타를 막는 데는 30분이면 충분하고 그
-- 이상 길게 잡으면 "방금 스펙업했는데 옛날 값" 이 된다.
-- 왜 음성은 24시간인가: 없는 닉네임의 대부분은 **오타**다. 오타 한 줄 때문에 크롬이 하루에
-- 수십 번 뜨는 것을 막는 것이 이 칸의 존재 이유다. 하루면 닉네임 변경권을 쓴 사람도
-- 다음 날엔 다시 잡힌다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 읽기가 왜 **공개가 아닌가** — `character_looks` 와 갈리는 지점
-- ───────────────────────────────────────────────────────────────────────────────
-- `character_looks` 는 비로그인 열람자가 보는 **공개 시간표에 그려지는 얼굴**이라 읽기를
-- 열었다. 이 표는 다르다:
--   ① 웹 화면 중 이 표를 그리는 곳이 **하나도 없다.** 유일한 소비자는 카톡 봇이고, 봇은
--      `service_role` 로 붙는다(`lib/supabase/admin-db.ts`).
--   ② 담긴 값이 **우리가 만든 것도 넥슨이 준 것도 아니다.** 남의 사이트가 계산한 값을
--      우리가 받아 적어 둔 것이라, 우리 API 표면으로 다시 퍼뜨릴 이유가 없다.
--   ③ `missing_at` 은 순수한 운영값이다.
-- 필요한 최소 권한만 준다는 원칙대로 **읽기·쓰기 모두 service_role 전용**이다. 나중에 웹
-- 화면이 이 값을 그리게 되면 그때 컬럼 단위 GRANT 로 필요한 칸만 연다.
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. 표
-- #############################################################################

create table if not exists public.scouter_stat_cache (
  /*
    ★ 기본키는 **사람이 방에 친 닉네임 원문**이다. 조회 주소가
      `?name=<닉네임>` 하나로 결정되므로 이름 하나가 곧 조회 단위다.
    ★ 길이 2~12자는 `handleScouter` 의 검증 정규식(`^[0-9A-Za-z가-힣]{2,12}$`)과 같은
      값이다. 거기서 걸러지는 것이 여기 들어올 일은 없지만, **표가 스스로 지키게** 둔다.
    ★ `btrim` 못박기는 `character_looks` 와 같은 이유다 — 앞뒤 공백이 붙은 채 들어오면
      같은 사람이 두 행이 되고 그중 하나는 영영 못 찾는 행이 된다.
      (호출부는 공백을 **전부** 제거하지만, 그 사실에 기대지 않는다.)
  */
  name                     text primary key
                           check (name = btrim(name))
                           check (length(name) between 2 and 12),

  /*
    아래 값들은 전부 **maplescouter 가 그 페이지에서 계산해 내려준 것**이다. 우리가
    검산하지 않으며, 넥슨 원본과 어긋나도 그쪽 화면과 같은 값을 보여 주는 것이 맞다 —
    사람이 `!환산` 을 치는 이유는 그 사이트의 숫자를 알고 싶어서다.
  */
  character_class          text,
  character_level          int,
  world_name               text,

  /** 환산 주스탯(380). 원본 `calculatedData.boss380_stat`. */
  boss_stat                int,
  /** 헥사 환산 주스탯(380). 원본 `calculatedData.boss380_hexaStat`. */
  hexa_stat                int,

  /*
    어센틱 심볼 레벨 목록. 원본은 `userApiData.symbol.authentic_symbol_1..N` 인데
    **N 이 캐릭터마다 다르다**(그랜드는 아예 없는 캐릭터가 있다 — 실측: 메검메).
    그래서 칸을 6개 박지 않고 **배열 한 칸**으로 둔다. 칸을 박아 두면 지역이 하나
    추가되는 패치마다 마이그레이션을 써야 한다.
    ★ 레벨 0(미착용)은 담지 않는다 — 화면에 `0` 을 늘어놓는 것은 정보가 아니다.
      거르는 책임은 쓰는 쪽(`scouter.ts`)이 지고, 표는 받은 대로 보관한다.
  */
  authentic_symbols        int[],
  grand_authentic_symbols  int[],
  /** 어센틱포스 합계. 원본 `userApiData.info.authenticForce`. */
  authentic_force          int,

  /** 마지막으로 스탯을 **받아 온** 시각. 양성 캐시(30분)의 기준. */
  fetched_at               timestamptz,
  /*
    마지막으로 **"그 닉네임으로는 못 찾았다"** 를 받은 시각. 음성 캐시(24시간)의 기준.
    판별 근거는 그쪽 응답의 **HTTP 상태**다(실측 2026-09-03): 있는 닉네임 **201**,
    없는 닉네임 **400**.

    ⚠️ **타임아웃 · 브라우저 기동 실패 · 네트워크 오류는 절대 이 칸에 적지 않는다.**
       그것들은 "그런 닉네임이 없다"가 아니라 "지금 우리가 못 가져왔다"이고, 여기 박으면
       멀쩡한 닉네임이 24시간 내내 "못 찾았어요" 가 된다. 두 상태를 코드에서도
       `"missing"` / `"unavailable"` 로 갈라 두었고, 절대 합치지 않는다.
  */
  missing_at               timestamptz,

  created_at               timestamptz not null default now(),

  /*
    ★ **아무것도 모르는 행은 남기지 않는다**(`character_looks` 와 같은 제약, 같은 이유).
      둘 다 null 인 행은 캐시 적중으로 볼지 미조회로 볼지 정할 수 없어서, 그 닉네임은
      매번 크롬을 띄우면서도 계속 캐시에 있는 것처럼 보인다.
  */
  constraint scouter_stat_cache_knows_something
    check (num_nonnulls(fetched_at, missing_at) >= 1)
);

comment on table public.scouter_stat_cache is
  '카톡 봇 !환산 이 maplescouter.com 페이지를 헤드리스 브라우저로 열어 받아 둔 환산 스탯 캐시. '
  '조회 한 건에 크롬 프로세스가 하나 뜨므로(실측 0.9~2.0초) 캐시가 이 표의 존재 이유 전부다. '
  '양성 30분 · 음성(missing_at) 24시간이며 TTL 판정은 읽는 쪽(features/bot/server/scouter.ts)이 한다. '
  '봇 전용이라 읽기·쓰기 모두 service_role 전용 — 이 값을 그리는 웹 화면이 하나도 없다.';

comment on column public.scouter_stat_cache.name is
  '기본키. 방에서 친 닉네임 원문(공백 제거·btrim, 2~12자). 조회 주소가 이름 하나로 결정된다.';
comment on column public.scouter_stat_cache.character_class is 'maplescouter calculatedData.class.';
comment on column public.scouter_stat_cache.character_level is 'maplescouter userApiData.info.character_level.';
comment on column public.scouter_stat_cache.world_name is 'maplescouter userApiData.info.world_name.';
comment on column public.scouter_stat_cache.boss_stat is
  '환산 주스탯(380). calculatedData.boss380_stat. 넥슨 API 에는 없는 계산값이다.';
comment on column public.scouter_stat_cache.hexa_stat is
  '헥사 환산 주스탯(380). calculatedData.boss380_hexaStat.';
comment on column public.scouter_stat_cache.authentic_symbols is
  '어센틱 심볼 레벨 목록. 원본 키 개수가 캐릭터마다 달라 칸이 아니라 배열이다. 레벨 0(미착용)은 담지 않는다.';
comment on column public.scouter_stat_cache.grand_authentic_symbols is
  '그랜드 어센틱 심볼 레벨 목록. 없는 캐릭터가 흔하며 그때는 빈 배열이다(오류가 아니다).';
comment on column public.scouter_stat_cache.authentic_force is
  '어센틱포스 합계. userApiData.info.authenticForce.';
comment on column public.scouter_stat_cache.fetched_at is
  '마지막으로 스탯을 받아 온 시각. 양성 캐시 TTL(30분)의 기준.';
comment on column public.scouter_stat_cache.missing_at is
  '마지막으로 "그 닉네임 없음"(그쪽 응답 HTTP 400)을 받은 시각. 음성 캐시(24시간)의 기준. '
  '타임아웃·기동 실패·네트워크 오류는 여기 적지 않는다 — 그것은 "못 찾았다"가 아니라 "못 가져왔다"다.';
comment on column public.scouter_stat_cache.created_at is '행이 처음 생긴 시각.';

/*
  "오래된 것부터" 훑는 조회는 아직 없다. 그래도 인덱스를 두는 이유는 **정리(purge)** 다 —
  이 표는 방에서 오간 닉네임이 그대로 쌓이는 곳이라, 언젠가 `fetched_at < now() - 30일`
  같은 청소가 필요해진다. 그때 순차 스캔을 하게 두지 않는다.
  `missing_at` 은 부분 인덱스다 — 대부분의 행은 찾힌 행이라 이 칸이 null 이고, 그 null 을
  인덱스에 담아 봐야 크기만 커진다(`character_looks` 와 같은 판단).
*/
create index if not exists scouter_stat_cache_fetched_at_idx
  on public.scouter_stat_cache (fetched_at);
create index if not exists scouter_stat_cache_missing_at_idx
  on public.scouter_stat_cache (missing_at)
  where missing_at is not null;


-- #############################################################################
-- 2. RLS — 읽기·쓰기 모두 service_role 전용
-- #############################################################################
--
-- 머리말의 근거를 그대로 집행한다. `character_looks` 가 읽기를 연 것은 **비로그인 공개
-- 시간표가 그 값을 그리기 때문**이고, 여기에는 그런 화면이 없다. 소비자가 봇 하나뿐인
-- 표를 anon 에게 열어 두는 것은 얻는 것 없이 표면만 넓히는 일이다.

alter table public.scouter_stat_cache enable row level security;

/*
  ★ 컬럼 단위 GRANT 규약(마이그레이션 11-A)을 따르되, **공개 컬럼이 0개**이므로 grant 문
    자체가 없다. 나중에 화면이 생겨 여는 날에도 테이블 단위 grant 를 쓰지 말고 필요한
    칸만 나열할 것 — 테이블 단위 grant 가 나중에 붙는 컬럼을 자동으로 열어 주는 것이
    `share_bp` 유출의 원인이었다(§0.3).
*/
revoke all on table public.scouter_stat_cache from anon;
revoke all on table public.scouter_stat_cache from authenticated;
grant all on table public.scouter_stat_cache to service_role;

/*
  RLS 는 켜져 있고 anon/authenticated 용 permissive 정책이 하나도 없으므로 그쪽에서는
  이미 아무 행도 보이지 않는다. 그래도 **거부를 명시적으로 적는다** — 정책이 없는 표와
  "일부러 막은 표" 는 다음 사람 눈에 구별되어야 하고, `character_looks` 도 같은 형식이다.
*/
drop policy if exists scouter_stat_cache_no_public_select on public.scouter_stat_cache;
create policy scouter_stat_cache_no_public_select on public.scouter_stat_cache
  as permissive for select to anon, authenticated
  using (false);

drop policy if exists scouter_stat_cache_no_public_insert on public.scouter_stat_cache;
create policy scouter_stat_cache_no_public_insert on public.scouter_stat_cache
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists scouter_stat_cache_no_public_update on public.scouter_stat_cache;
create policy scouter_stat_cache_no_public_update on public.scouter_stat_cache
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists scouter_stat_cache_no_public_delete on public.scouter_stat_cache;
create policy scouter_stat_cache_no_public_delete on public.scouter_stat_cache
  as permissive for delete to anon, authenticated using (false);

drop policy if exists scouter_stat_cache_service_role_all on public.scouter_stat_cache;
create policy scouter_stat_cache_service_role_all on public.scouter_stat_cache
  as permissive for all to service_role using (true) with check (true);


-- #############################################################################
-- 3. 자기검증
-- #############################################################################

do $$
declare
  v_rls boolean;
begin
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.scouter_stat_cache'::regclass;
  if v_rls is not true then
    raise exception 'scouter_stat_cache 에 RLS 가 켜져 있지 않습니다.';
  end if;

  -- 이 표는 읽기까지 막혀 있어야 한다. 한 칸이라도 열려 있으면 설계가 어긋난 것이다.
  if has_table_privilege('anon', 'public.scouter_stat_cache', 'SELECT')
     or has_table_privilege('authenticated', 'public.scouter_stat_cache', 'SELECT')
  then
    raise exception 'scouter_stat_cache 에 공개 읽기 권한이 남아 있습니다.';
  end if;

  if has_table_privilege('anon', 'public.scouter_stat_cache', 'INSERT')
     or has_table_privilege('authenticated', 'public.scouter_stat_cache', 'INSERT')
     or has_table_privilege('anon', 'public.scouter_stat_cache', 'UPDATE')
     or has_table_privilege('authenticated', 'public.scouter_stat_cache', 'UPDATE')
     or has_table_privilege('anon', 'public.scouter_stat_cache', 'DELETE')
     or has_table_privilege('authenticated', 'public.scouter_stat_cache', 'DELETE')
  then
    raise exception 'scouter_stat_cache 에 공개 쓰기 권한이 남아 있습니다.';
  end if;

  raise notice 'scouter_stat_cache 생성 완료 — 읽기·쓰기 모두 service_role 전용';
end $$;

select public.assert_no_public_sensitive_columns();
