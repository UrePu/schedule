-- =============================================================================
-- M_Schedule · 11. 공개 컬럼 권한 재설계 + 반복 가능시간(패턴/예외)
-- =============================================================================
-- 두 가지 작업이 들어 있다.
--   A. **보안 결함 수정** — 공개 테이블에 나중에 추가된 민감 컬럼이 anon 에게 새고 있었다.
--   B. **반복 가능시간** — CLAUDE.md §1.4 의 핵심 화면(가능시간 겹쳐보기)을 위한 데이터 모델.
-- =============================================================================


-- #############################################################################
-- A. 공개 컬럼 권한 재설계
-- #############################################################################
--
-- ── 무엇이 잘못됐나 ──────────────────────────────────────────────────────────
-- 08 마이그레이션이 `grant select on table public.run_signups to anon` 로 **테이블 전체**를
-- 허용했다. **RLS 는 행만 거르고 컬럼은 거르지 못한다.** 그래서 10 마이그레이션이 나중에
-- `share_bp` 를 추가하자, 공개 파티의 분배 비율("우레푸 67% / 라이언 33%")이 비로그인에게
-- 그대로 노출됐다. 분배 비율은 친구들 사이의 **돈 약정**이다.
--
-- ── 왜 컬럼 단위 GRANT 를 골랐나 (뷰 분리가 아니라) ──────────────────────────
-- 결정적인 이유는 **기본값이 안전하기 때문**이다.
--   `grant select (a, b, c)` 는 나중에 추가되는 컬럼을 **자동으로 포함하지 않는다.**
--   즉 이 결함의 재발 자체가 구조적으로 막힌다 — 새 컬럼은 명시적으로 허용해야만 열린다.
--   (테이블 단위 grant 는 정반대로, 새 컬럼이 자동으로 열린다. 그게 이번 사고의 원인이다.)
-- 부수 효과: anon 의 `select *` 는 이제 실패한다. 이는 의도된 것이다 —
--   비로그인 열람의 정식 경로는 공개 뷰(v_public_party_runs 등)이며,
--   테이블 직접 접근은 뷰가 필요로 하는 컬럼만 열어 둔다.
--
-- ── note 컬럼 판단 ──────────────────────────────────────────────────────────
--   `run_signups.note`  → **비공개.** 개인이 자기 참여에 붙인 자유 텍스트다.
--                          공개 시간표를 그리는 데 전혀 필요 없고("누가 간다"만 있으면 된다),
--                          자유 텍스트라 무엇이 들어갈지 통제할 수 없다.
--   `party_runs.note`   → **공개 유지.** 파티 주최자가 그 일정에 붙인 공지이며,
--                          공개 파티에서는 모집 공고의 일부다. 이미 공개 중인
--                          `parties.description` 과 같은 성격이다.
--   원칙: **개인이 자기에 대해 쓴 메모는 비공개, 운영자가 파티에 붙인 설명은 공개.**
--   → UI 는 공개 파티의 note 를 편집할 때 "이 내용은 비로그인 사용자에게도 보입니다"를 고지할 것.

-- -----------------------------------------------------------------------------
-- 11-A-1. 공개 시간표 5개 테이블 — 테이블 권한 회수 후 컬럼 단위로 재부여
-- -----------------------------------------------------------------------------

-- ── parties ──────────────────────────────────────────────────────────────────
-- 제외: owner_user_id (계정 UUID. 공개 파티 간 인물 연결고리가 된다)
revoke all on table public.parties from anon;
revoke all on table public.parties from authenticated;
grant select (
  id, name, description, visibility, share_slug, world_name,
  default_capacity, created_at, updated_at, archived_at
) on table public.parties to anon, authenticated;

-- ── party_participants ───────────────────────────────────────────────────────
-- 제외: user_id, guest_id, character_id, invited_by_user_id
--       (계정/게스트/캐릭터 UUID 와 초대 관계. 공개 시간표는 display_name 스냅샷만 있으면 된다)
revoke all on table public.party_participants from anon;
revoke all on table public.party_participants from authenticated;
grant select (
  id, party_id, display_name, role, joined_at, left_at, created_at, updated_at
) on table public.party_participants to anon, authenticated;

-- ── party_runs ───────────────────────────────────────────────────────────────
-- 제외: created_by_participant_id (작성자 식별), share_mode (분배 방식은 돈 약정의 일부)
revoke all on table public.party_runs from anon;
revoke all on table public.party_runs from authenticated;
grant select (
  id, party_id, boss_difficulty_id, scheduled_at, duration_minutes, status,
  capacity, entry_party_size, week_key, note, created_at, updated_at, cancelled_at
) on table public.party_runs to anon, authenticated;

-- ── run_signups ── ★ 이번 결함의 진원지 ──────────────────────────────────────
-- 제외: share_bp (분배 비율 = 돈 약정), note (개인 메모), character_id (캐릭터 UUID)
-- 포함: seat_no — 사람을 부르는 관리 번호일 뿐 금전 정보가 아니고,
--                 공개 시간표에서 "1번 우레푸"로 표시하는 데 쓴다 (CLAUDE.md §1.4)
revoke all on table public.run_signups from anon;
revoke all on table public.run_signups from authenticated;
grant select (
  id, run_id, participant_id, status, seat_no, created_at, updated_at
) on table public.run_signups to anon, authenticated;

-- ── availability_slots ───────────────────────────────────────────────────────
-- 이 테이블은 아래 B 파트에서 폐기된다. 그 전까지의 권한만 정리해 둔다.
revoke all on table public.availability_slots from anon;
revoke all on table public.availability_slots from authenticated;
grant select (
  id, party_id, participant_id, slot_start, week_key, created_at
) on table public.availability_slots to anon, authenticated;

-- 보스 마스터 4종은 전 컬럼이 공개 게임 정보라 테이블 단위 grant 를 유지한다.
-- (price_meso 는 아래 가드의 화이트리스트에 근거와 함께 명시한다)

-- -----------------------------------------------------------------------------
-- 11-A-2. 재발 방지 가드
-- -----------------------------------------------------------------------------
-- 이 결함은 개별 실수가 아니라 **구조적 문제**다. 앞으로도 나중 마이그레이션이 공개 테이블에
-- 민감 컬럼을 추가하면 아무 소리 없이 새어나간다.
-- → 민감 패턴 컬럼이 anon/authenticated 에 SELECT 가능하면 **마이그레이션을 실패시킨다.**
-- → 의도적으로 공개해야 하는 컬럼은 화이트리스트에 **명시적으로** 추가해야 한다.
--   "조용히 새는 것"이 아니라 "명시적으로 허용한 것"이 되게 만드는 장치다.
create or replace function public.assert_no_public_sensitive_columns()
returns void
language plpgsql
as $func$
declare
  v_bad text;
begin
  select string_agg(x.ref, ', ' order by x.ref) into v_bad
  from (
    select format('%s.%s', c.table_name, c.column_name) as ref
    from information_schema.columns c
    where c.table_schema = 'public'
      and (
             c.column_name ilike '%share%'
          or c.column_name ilike '%meso%'
          or c.column_name ilike '%\_bp'    escape '\'
          or c.column_name ilike '%secret%'
          or c.column_name ilike '%hash%'
          or c.column_name ilike '%token%'
          or c.column_name ilike '%api\_key%' escape '\'
      )
      and (
             has_column_privilege('anon',          format('public.%I', c.table_name), c.column_name, 'SELECT')
          or has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'SELECT')
      )
      and format('%s.%s', c.table_name, c.column_name) not in (
        -- ★★ 의도적 공개 화이트리스트 ★★
        -- 여기에 넣는다는 것은 "비로그인 전체에게 보여도 된다"고 판단했다는 뜻이다.
        -- 반드시 근거를 함께 남길 것.

        -- 공개(visibility='public') 파티의 짧은 URL 조각. RLS 가 공개 파티 행만 노출하므로
        -- 슬러그가 비밀인 visibility='link' 파티는 애초에 이 경로로 나오지 않는다.
        'parties.share_slug',
        'v_public_party_board.share_slug',
        'v_public_party_runs.share_slug',

        -- 결정석 시세는 게임 공개 정보이며 비로그인 등록 화면이 필요로 한다.
        -- 개인 수익이 아니라 만인이 아는 상수표다.
        'boss_crystal_prices.price_meso',
        'v_boss_catalog.crystal_price_meso'
      )
  ) x;

  if v_bad is not null then
    raise exception
      '민감 패턴 컬럼이 anon/authenticated 에 노출되었습니다: %. 의도한 공개라면 assert_no_public_sensitive_columns() 의 화이트리스트에 근거와 함께 명시하세요.',
      v_bad
      using errcode = 'insufficient_privilege';
  end if;
end;
$func$;

comment on function public.assert_no_public_sensitive_columns() is
  '공개 역할에 민감 패턴 컬럼(share/meso/_bp/secret/hash/token/api_key)이 열려 있으면 예외를 던진다. 새 마이그레이션 끝에서 반드시 호출할 것.';


-- #############################################################################
-- B. 반복 가능시간 — 패턴 + 예외 (CLAUDE.md §1.4)
-- #############################################################################
--
-- 발주자 원문: "사람들은 규칙적으로 출퇴근하니 평균 가능한 시간 / 특이사항으로 등록해두고,
--               파티원을 선택하면 왼쪽에 각자의 가능 시간이 뜨고 오른쪽에서 일정을 등록"
--
-- 두 층으로 나눈다.
--   availability_patterns   : 요일별 반복 구간. 한 번 넣으면 계속 유효하다.
--   availability_exceptions : 특정 KST 날짜 하루만 덮어쓰기(야근·여행 등).
--
-- ── availability_slots 를 어떻게 할 것인가 → **폐기한다** ────────────────────
-- 이유:
--   1. 30분 격자 이산 슬롯은 "매주 다시 찍는" 모델이다. §1.4 가 명시적으로 거부한 UX다
--      ("Never make users re-enter a normal week").
--   2. 패턴+예외가 같은 정보를 더 적은 입력으로, 더 정밀하게(분 단위) 표현한다.
--   3. 무엇보다 **한 사람의 가용시간에 진실이 둘이면 안 된다.** 어정쩡하게 공존시키면
--      나중에 어느 쪽이 맞는지 아무도 모르게 된다.
-- 게스트 대응: 패턴/예외도 party_participants 와 **같은 널러블 FK 방식**으로
--   `user_id` / `guest_id` 중 하나를 갖는다. 초대 링크로 들어온 사람도 가용시간을 넣을 수 있고,
--   정식 가입 시 승계된다. (게스트가 시간을 못 넣으면 초대 기능의 가치가 반토막 난다)
-- 파티별 가용시간이 사라지는 것 아닌가? → §1.4 가 원하는 것은 **사람 단위 생활 패턴**이다.
--   파티별 의사는 `run_signups`(참여 의사)가 이미 담당한다. 역할이 겹치지 않는다.

drop view if exists public.v_availability_overlay cascade;
drop table if exists public.availability_slots cascade;

-- -----------------------------------------------------------------------------
-- 11-B-1. KST 달력 헬퍼 (전부 IMMUTABLE — 타임존 함수를 쓰지 않는다)
-- -----------------------------------------------------------------------------
create or replace function public.kst_date(ts timestamptz)
returns date
language sql
immutable
strict
parallel safe
as $func$
  select date '1970-01-01'
       + floor((extract(epoch from (ts - to_timestamp(0))) + 32400) / 86400)::int;
$func$;

comment on function public.kst_date(timestamptz) is
  '시각이 속한 KST 달력 날짜. day_key() 의 date 판이며 값이 항상 일치한다.';

-- KST 벽시계 (날짜, 분) → 절대 시각.
-- minutes 가 1440 을 넘으면 자연스럽게 다음 날로 넘어간다(자정 넘김 구간 표현의 핵심).
create or replace function public.kst_moment(d date, minutes integer)
returns timestamptz
language sql
immutable
strict
parallel safe
as $func$
  select to_timestamp(
    (((d - date '1970-01-01')::bigint * 86400) - 32400 + (minutes::bigint * 60))::double precision
  );
$func$;

comment on function public.kst_moment(date, integer) is
  'KST 벽시계 (날짜 + 분) 를 절대 시각으로. minutes > 1440 이면 다음 날로 넘어간다.';

-- -----------------------------------------------------------------------------
-- 11-B-3. availability_patterns — 요일별 반복 가능시간
-- -----------------------------------------------------------------------------
-- ★ 소유 주체는 **캐릭터가 아니라 사람**이다. 사람의 생활 패턴이지 캐릭터의 일정이 아니다.
--
-- ★ 자정 넘김(22:00~02:00) 표현:
--   구간을 쪼개지 않고 `end_minute` 가 1440 을 넘도록 허용한다. 22:00~02:00 = 1320~1560.
--   두 행으로 쪼개면 사용자의 의도("밤 10시부터 새벽 2시까지")가 데이터에서 사라지고,
--   화면에 되돌려 보여줄 때 다시 합쳐야 한다. 한 행이 곧 한 의도다.
--   해석기가 kst_moment(날짜, 1560) 을 계산하면 자동으로 다음 날 02:00 이 된다.
create table if not exists public.availability_patterns (
  id           uuid primary key default gen_random_uuid(),

  -- party_participants 와 동일한 널러블 FK 방식. 게스트도 가용시간을 가질 수 있다.
  user_id      uuid references public.app_users(id) on delete cascade,
  guest_id     uuid references public.guest_profiles(id) on delete cascade,

  -- ISO 요일: 1=월 … 7=일. extract(isodow) 와 값이 그대로 맞는다.
  weekday      smallint not null check (weekday between 1 and 7),

  -- KST 벽시계 분. 0 = 00:00, 1439 = 23:59.
  start_minute integer not null check (start_minute between 0 and 1439),
  -- 1440 = 자정, 1560 = 다음 날 02:00. 최대 2880(다음 날 24:00).
  end_minute   integer not null check (end_minute between 1 and 2880),

  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint availability_patterns_one_owner check (num_nonnulls(user_id, guest_id) = 1),
  constraint availability_patterns_range check (end_minute > start_minute),
  -- 한 구간이 24시간을 넘을 수는 없다.
  constraint availability_patterns_max_span check (end_minute - start_minute <= 1440)
);

comment on table public.availability_patterns is
  '요일별 반복 가능시간. 소유 주체는 캐릭터가 아니라 사람(계정 또는 게스트)이다. 한 요일에 구간 여러 개 허용.';
comment on column public.availability_patterns.weekday is
  'ISO 요일 1=월 … 7=일. extract(isodow from date) 와 값이 일치한다.';
comment on column public.availability_patterns.end_minute is
  '1440 초과 = 자정 넘김. 22:00~02:00 은 1320~1560 한 행으로 표현한다(쪼개지 않는다).';

create index if not exists availability_patterns_user_idx
  on public.availability_patterns (user_id, weekday) where user_id is not null;
create index if not exists availability_patterns_guest_idx
  on public.availability_patterns (guest_id, weekday) where guest_id is not null;

drop trigger if exists availability_patterns_set_updated_at on public.availability_patterns;
create trigger availability_patterns_set_updated_at
  before update on public.availability_patterns
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 11-B-4. availability_exceptions — **뺄셈 전용**
-- -----------------------------------------------------------------------------
-- 발주자 원문: "특이사항은 그냥 단순하게 기본적으로 잡힌 시간대를 제외하고
--               '아 이때 안 돼요' 표시하는 거임. 이유는 없어도 됨"
--
-- ★ **실효 가능시간 = 패턴 − 예외.** 그게 전부다.
--   * 예외는 **빼기만 한다.** "그날은 이 시간만 가능" 같은 대체(replacement) 변형은 **없다.**
--   * **패턴에 없는 시간을 추가하는 기능은 의도적으로 넣지 않았다.**
--     그럴 일이 생기면 패턴 자체를 넓히면 된다. (나중에 "왜 없지?" 하고 다시 논의하지 말 것)
--   * 하루 통째 제외 = `(0, 1440)` 전 구간 제외. 별도 종류(kind)를 두지 않는다 —
--     표현이 하나뿐이어야 "같은 뜻인데 저장 형태가 둘"인 상황이 안 생긴다.
--   * 한 날짜에 **구간 여러 개** 허용(오후에 잠깐 + 밤에 또). 겹쳐도 무해하다(뺄셈이라 멱등).
create table if not exists public.availability_exceptions (
  id             uuid primary key default gen_random_uuid(),

  user_id        uuid references public.app_users(id) on delete cascade,
  guest_id       uuid references public.guest_profiles(id) on delete cascade,

  -- KST 달력 날짜. 순간(instant)이 아니라 업무 날짜이므로 date 가 정확한 타입이다.
  -- public.kst_date(timestamptz) 가 같은 값을 만들어 준다.
  exception_date date not null,

  -- 제외할 구간. 하루 통째 제외는 (0, 1440).
  -- 패턴과 같은 규칙으로 1440 초과를 허용해 자정 넘김 제외도 한 행으로 쓸 수 있다.
  start_minute   integer not null check (start_minute between 0 and 1439),
  end_minute     integer not null check (end_minute between 1 and 2880),

  -- **선택 사항이다.** 발주자가 "이유는 없어도 됨"이라고 명시했다.
  -- UI 는 이 값을 절대 필수 입력으로 요구하지 않는다.
  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint availability_exceptions_one_owner check (num_nonnulls(user_id, guest_id) = 1),
  constraint availability_exceptions_range check (end_minute > start_minute),
  constraint availability_exceptions_max_span check (end_minute - start_minute <= 1440)
);

comment on table public.availability_exceptions is
  '특정 KST 날짜에서 **빼낼** 시간 구간. 실효 가능시간 = 패턴 − 예외. 대체·추가 기능은 의도적으로 없다.';
comment on column public.availability_exceptions.exception_date is
  'KST 달력 날짜. 순간이 아니라 업무 날짜라 date 가 정확하다. kst_date(timestamptz) 와 같은 값.';
comment on column public.availability_exceptions.start_minute is
  '제외 시작(KST 분). 하루 통째 제외는 (0, 1440) 으로 쓴다.';
comment on column public.availability_exceptions.note is
  '선택 사항. 발주자가 "이유는 없어도 됨"이라고 명시했으므로 UI 는 필수 입력으로 요구하지 않는다.';

create index if not exists availability_exceptions_user_idx
  on public.availability_exceptions (user_id, exception_date) where user_id is not null;
create index if not exists availability_exceptions_guest_idx
  on public.availability_exceptions (guest_id, exception_date) where guest_id is not null;

drop trigger if exists availability_exceptions_set_updated_at on public.availability_exceptions;
create trigger availability_exceptions_set_updated_at
  before update on public.availability_exceptions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 11-B-5. 해석기 — 패턴에 예외를 얹은 실효 가용시간
-- -----------------------------------------------------------------------------
-- **웹과 카톡 봇이 반드시 같은 답을 내야 하므로 DB 에 단일 구현으로 둔다.**
-- distribute_meso 와 같은 이유다 — 앱에 두면 뷰가 호출할 수 없고, 화면·봇·집계가 갈라진다.
--
-- person_id 는 `user_id` 이거나 `guest_id` 다. uuid 는 전역 유일하므로 한 배열로 받아
-- 양쪽을 매칭하고, 결과에는 coalesce 한 값을 돌려준다.
-- **실효 가능시간 = 패턴 − 예외.** 뺄셈 하나뿐이라 로직이 짧다.
--
-- 구간 뺄셈은 손으로 쪼개지 않고 **multirange**(PG14+)에 맡긴다.
--   range_agg(패턴구간) - range_agg(예외구간)
-- 이렇게 하면 겹침 병합·부분 제외·양끝 제외·완전 제외가 전부 한 연산으로 처리되고,
-- **자정 넘김 구간도 절대 시각 위에서 계산되므로 특별 취급이 필요 없다.**
-- (패턴 구간을 손으로 자르는 코드를 쓰면 자정 넘김에서 반드시 실수가 난다)
create or replace function public.resolve_availability(
  p_person_ids uuid[],
  p_from       timestamptz,
  p_to         timestamptz
)
returns table (
  person_id uuid,
  starts_at timestamptz,
  ends_at   timestamptz
)
language sql
stable
parallel safe
as $func$
  with bounds as (
    -- 전날의 자정 넘김 구간(22:00~02:00)이 오늘 범위로 넘어올 수 있으므로 하루 앞에서 시작한다.
    select public.kst_date(p_from) - 1 as d0,
           public.kst_date(p_to)       as d1
  ),
  days as (
    select (b.d0 + g)::date as kst_date
    from bounds b, generate_series(0, (b.d1 - b.d0)) as g
  ),
  -- 패턴이 만드는 가능 구간 (사람별로 합집합)
  pattern_ranges as (
    select coalesce(p.user_id, p.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(d.kst_date, p.start_minute),
             public.kst_moment(d.kst_date, p.end_minute),
             '[)'
           )) as available
    from days d
    join public.availability_patterns p
      on p.weekday = extract(isodow from d.kst_date)::smallint
    where p.user_id = any(p_person_ids) or p.guest_id = any(p_person_ids)
    group by 1
  ),
  -- 예외가 빼앗는 구간 (사람별로 합집합)
  exception_ranges as (
    select coalesce(e.user_id, e.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(e.exception_date, e.start_minute),
             public.kst_moment(e.exception_date, e.end_minute),
             '[)'
           )) as blocked
    from public.availability_exceptions e, bounds b
    where (e.user_id = any(p_person_ids) or e.guest_id = any(p_person_ids))
      and e.exception_date between b.d0 and b.d1
    group by 1
  ),
  effective as (
    select pr.person_id,
           unnest(pr.available - coalesce(er.blocked, '{}'::tstzmultirange)) as r
    from pattern_ranges pr
    left join exception_ranges er on er.person_id = pr.person_id
  )
  select e.person_id,
         greatest(lower(e.r), p_from) as starts_at,
         least(upper(e.r), p_to)      as ends_at
  from effective e
  where lower(e.r) < p_to
    and upper(e.r) > p_from;
$func$;

comment on function public.resolve_availability(uuid[], timestamptz, timestamptz) is
  '실효 가능시간 = 패턴 − 예외. multirange 뺄셈으로 계산하므로 자정 넘김도 특별 취급이 필요 없다. 웹·봇이 공유하는 유일한 구현.';

-- -----------------------------------------------------------------------------
-- 11-B-6. 겹침 질의 — 왼쪽 패널을 그리는 쿼리 (앱의 1순위 가치)
-- -----------------------------------------------------------------------------
-- N명을 주면 **k명 이상 가능한 시간창**을 돌려준다.
-- 6인 파티가 다 모이지 않아도 4명이면 가는 경우가 흔하므로 k 를 파라미터로 받는다.
-- p_min_count = 사람 수 → "전원 가능한 창".
--
-- 알고리즘: 모든 구간 경계로 시간축을 잘라(sweep line) 구간별 인원을 센 뒤,
--           조건을 만족하는 인접 구간을 하나의 창으로 병합한다.
-- 한 사람이 겹치는 구간을 여러 개 등록해도 `count(distinct person_id)` 라 중복 계산되지 않는다.
create or replace function public.availability_overlap(
  p_person_ids uuid[],
  p_from       timestamptz,
  p_to         timestamptz,
  p_min_count  integer default 1
)
returns table (
  window_start    timestamptz,
  window_end      timestamptz,
  available_count integer,
  person_ids      uuid[]
)
language sql
stable
parallel safe
as $func$
  with iv as (
    select r.person_id, r.starts_at, r.ends_at
    from public.resolve_availability(p_person_ids, p_from, p_to) r
    where r.ends_at > r.starts_at
  ),
  pts as (
    select starts_at as t from iv
    union
    select ends_at   as t from iv
  ),
  seg as (
    select t as seg_start, lead(t) over (order by t) as seg_end
    from pts
  ),
  counted as (
    select s.seg_start,
           s.seg_end,
           count(distinct i.person_id)::integer as cnt
    from seg s
    join iv i
      on i.starts_at <= s.seg_start and i.ends_at >= s.seg_end
    where s.seg_end is not null
      and s.seg_end > s.seg_start
    group by s.seg_start, s.seg_end
  ),
  qualified as (
    select * from counted where cnt >= greatest(coalesce(p_min_count, 1), 1)
  ),
  flagged as (
    -- 윈도우 함수는 중첩할 수 없으므로 lag 를 먼저 뽑아 둔다.
    select q.*, lag(q.seg_end) over (order by q.seg_start) as prev_end
    from qualified q
  ),
  grouped as (
    select f.*,
           sum(case when f.prev_end = f.seg_start then 0 else 1 end)
             over (order by f.seg_start) as grp
    from flagged f
  ),
  merged as (
    select min(seg_start) as window_start,
           max(seg_end)   as window_end,
           min(cnt)       as available_count
    from grouped
    group by grp
  )
  select m.window_start,
         m.window_end,
         m.available_count,
         (
           -- 창 전체를 커버하는 사람들만 (병합 구간에서 정확한 교집합)
           select array_agg(distinct i.person_id order by i.person_id)
           from iv i
           where i.starts_at <= m.window_start
             and i.ends_at   >= m.window_end
         ) as person_ids
  from merged m
  order by m.window_start;
$func$;

comment on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer) is
  'N명 중 k명 이상 가능한 시간창. 핵심 화면(§1.4) 왼쪽 패널의 원천. 한 사람의 중복 구간은 distinct 로 흡수된다.';

-- -----------------------------------------------------------------------------
-- 11-B-7. 열람 범위 — "전부 공유"의 실제 경계
-- -----------------------------------------------------------------------------
-- 가용시간은 생활 패턴이다. 몇 시에 집에 있는지가 드러나므로 **아무나 보면 안 된다.**
-- 공개 범위 = **본인 / 수락된 친구 / 같은 파티 구성원**. 그 밖에는 비공개다.
--
-- 인증 모델 (c)(서버 전용 쓰기, anon 전면 차단) 하에서는 RLS 로 이 규칙을 표현할 수 없다
-- (`auth.uid()` 가 없다). 그래서 규칙을 **SQL 함수 하나로 못박고** Route Handler 가 호출한다.
-- TS 에 흩어 놓으면 화면·봇·집계가 서로 다른 범위를 쓰게 된다.
create or replace function public.can_view_availability(
  p_viewer_user_id uuid,
  p_person_id      uuid
)
returns boolean
language sql
stable
parallel safe
as $func$
  select p_viewer_user_id is not null
     and p_person_id is not null
     and (
       -- 본인
       p_viewer_user_id = p_person_id
       -- 수락된 친구
       or exists (
         select 1 from public.friendships f
         where f.status = 'accepted'
           and (
                (f.requester_user_id = p_viewer_user_id and f.addressee_user_id = p_person_id)
             or (f.addressee_user_id = p_viewer_user_id and f.requester_user_id = p_person_id)
           )
       )
       -- 같은 파티 구성원 (상대가 게스트여도 성립한다)
       or exists (
         select 1
         from public.party_participants me
         join public.party_participants other on other.party_id = me.party_id
         where me.user_id = p_viewer_user_id
           and me.left_at is null
           and other.left_at is null
           and coalesce(other.user_id, other.guest_id) = p_person_id
       )
     );
$func$;

comment on function public.can_view_availability(uuid, uuid) is
  '가용시간 열람 권한: 본인 / 수락된 친구 / 같은 파티 구성원. Route Handler 가 서빙 전에 호출한다.';

-- -----------------------------------------------------------------------------
-- 11-B-8. 게스트 승계 시 가용시간 이관
-- -----------------------------------------------------------------------------
-- availability_slots 가 사라졌고 패턴/예외가 새로 생겼으므로 승계 함수를 갱신한다.
create or replace function public.claim_guest_profile(
  p_guest_id uuid,
  p_user_id  uuid
)
returns table (moved_participants integer, merged_participants integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_guest        public.guest_profiles%rowtype;
  v_display_name text;
  v_moved        integer := 0;
  v_merged       integer := 0;
  r              record;
begin
  select * into v_guest
    from public.guest_profiles
   where id = p_guest_id
     for update;

  if not found then
    raise exception '승계 대상 게스트(%)를 찾을 수 없습니다.', p_guest_id
      using errcode = 'no_data_found';
  end if;

  if v_guest.claimed_by_user_id is not null and v_guest.claimed_by_user_id <> p_user_id then
    raise exception '게스트(%)는 이미 다른 계정에 승계되었습니다.', p_guest_id
      using errcode = 'unique_violation';
  end if;

  select display_name into v_display_name
    from public.app_users
   where id = p_user_id and deleted_at is null;

  if not found then
    raise exception '승계 대상 사용자(%)를 찾을 수 없습니다.', p_user_id
      using errcode = 'no_data_found';
  end if;

  for r in
    select gp.id as guest_participant_id,
           up.id as user_participant_id
      from public.party_participants gp
      join public.party_participants up
        on up.party_id = gp.party_id
       and up.user_id = p_user_id
     where gp.guest_id = p_guest_id
  loop
    -- 분배 비율 보존: 같은 런에 양쪽 행이 있으면 게스트 몫을 본인 행에 합산한다.
    -- 한 사람은 자리 하나이므로 본인 seat_no 를 유지하고 게스트 번호는 빈 번호가 된다.
    update public.run_signups t
       set share_bp = t.share_bp + s.share_bp
      from public.run_signups s
     where s.participant_id = r.guest_participant_id
       and t.participant_id = r.user_participant_id
       and t.run_id = s.run_id;

    update public.run_signups s
       set participant_id = r.user_participant_id
     where s.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.run_signups t
          where t.participant_id = r.user_participant_id
            and t.run_id = s.run_id
       );
    delete from public.run_signups
     where participant_id = r.guest_participant_id;

    update public.run_drop_shares t
       set share_bp = t.share_bp + s.share_bp
      from public.run_drop_shares s
     where s.participant_id = r.guest_participant_id
       and t.participant_id = r.user_participant_id
       and t.drop_id = s.drop_id;

    update public.run_drop_shares s
       set participant_id = r.user_participant_id
     where s.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.run_drop_shares t
          where t.participant_id = r.user_participant_id
            and t.drop_id = s.drop_id
       );
    delete from public.run_drop_shares
     where participant_id = r.guest_participant_id;

    update public.run_drops
       set solo_participant_id = r.user_participant_id
     where solo_participant_id = r.guest_participant_id;
    update public.run_drops
       set recorded_by_participant_id = r.user_participant_id
     where recorded_by_participant_id = r.guest_participant_id;

    update public.party_runs
       set created_by_participant_id = r.user_participant_id
     where created_by_participant_id = r.guest_participant_id;

    delete from public.party_participants where id = r.guest_participant_id;
    v_merged := v_merged + 1;
  end loop;

  update public.party_participants
     set user_id      = p_user_id,
         guest_id     = null,
         display_name = v_display_name
   where guest_id = p_guest_id;
  get diagnostics v_moved = row_count;

  -- ★ 가용시간 패턴/예외를 계정으로 이관한다. 게스트로 넣어 둔 생활 패턴이 사라지면 안 된다.
  update public.availability_patterns
     set user_id = p_user_id, guest_id = null
   where guest_id = p_guest_id;

  update public.availability_exceptions
     set user_id = p_user_id, guest_id = null
   where guest_id = p_guest_id;

  update public.guest_profiles
     set claimed_by_user_id = p_user_id,
         claimed_at         = coalesce(claimed_at, now()),
         claim_token_hash   = null,
         last_seen_at       = now()
   where id = p_guest_id;

  insert into public.guest_claims (
    guest_id, user_id, moved_participant_count, merged_participant_count
  ) values (
    p_guest_id, p_user_id, v_moved, v_merged
  );

  return query select v_moved, v_merged;
end;
$func$;

-- -----------------------------------------------------------------------------
-- 11-B-9. RLS — 신규 테이블
-- -----------------------------------------------------------------------------
-- 생활 패턴은 개인정보다. anon/authenticated 전면 차단하고 서버가 can_view_availability()
-- 로 범위를 검증한 뒤 service role 로 서빙한다.
do $$
declare
  t text;
  private_tables text[] := array['availability_patterns', 'availability_exceptions'];
begin
  foreach t in array private_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    execute format('drop policy if exists %I on public.%I', t || '_no_public_access', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to anon, authenticated using (false) with check (false)$p$,
      t || '_no_public_access', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to service_role using (true) with check (true)$p$,
      t || '_service_role_all', t
    );
  end loop;
end
$$;

-- 해석기/겹침/열람권한 함수는 남의 생활 패턴을 읽으므로 서버 전용이다.
revoke all on function public.resolve_availability(uuid[], timestamptz, timestamptz) from public;
revoke all on function public.resolve_availability(uuid[], timestamptz, timestamptz) from anon;
revoke all on function public.resolve_availability(uuid[], timestamptz, timestamptz) from authenticated;
grant execute on function public.resolve_availability(uuid[], timestamptz, timestamptz) to service_role;

revoke all on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer) from public;
revoke all on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer) from anon;
revoke all on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer) from authenticated;
grant execute on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer) to service_role;

revoke all on function public.can_view_availability(uuid, uuid) from public;
revoke all on function public.can_view_availability(uuid, uuid) from anon;
revoke all on function public.can_view_availability(uuid, uuid) from authenticated;
grant execute on function public.can_view_availability(uuid, uuid) to service_role;

-- claim_guest_profile 을 재정의했으므로 기본 PUBLIC 실행권을 다시 회수한다.
revoke all on function public.claim_guest_profile(uuid, uuid) from public;
revoke all on function public.claim_guest_profile(uuid, uuid) from anon;
revoke all on function public.claim_guest_profile(uuid, uuid) from authenticated;
grant execute on function public.claim_guest_profile(uuid, uuid) to service_role;


-- #############################################################################
-- 자기검증
-- #############################################################################
do $$
declare
  v_missing text;
  v_rls_off text;
  v_cnt     integer;
begin
  -- (1) 민감 컬럼 노출 가드 — 이 마이그레이션의 존재 이유
  perform public.assert_no_public_sensitive_columns();

  -- (2) share_bp 가 실제로 막혔는지 직접 확인
  if has_column_privilege('anon', 'public.run_signups', 'share_bp', 'SELECT') then
    raise exception 'run_signups.share_bp 가 여전히 anon 에게 노출되어 있습니다.';
  end if;
  if has_column_privilege('anon', 'public.run_signups', 'note', 'SELECT') then
    raise exception 'run_signups.note 가 여전히 anon 에게 노출되어 있습니다.';
  end if;
  -- 공개되어야 하는 컬럼은 계속 열려 있어야 한다(공개 뷰가 이 컬럼들을 읽는다).
  if not has_column_privilege('anon', 'public.run_signups', 'status', 'SELECT')
     or not has_column_privilege('anon', 'public.run_signups', 'seat_no', 'SELECT') then
    raise exception '공개 시간표에 필요한 run_signups 컬럼이 잠겼습니다.';
  end if;

  -- (3) RLS / 정책 누락
  select string_agg(c.relname, ', ' order by c.relname) into v_rls_off
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_rls_off is not null then
    raise exception 'RLS 가 비활성화된 테이블이 있습니다: %', v_rls_off;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if v_missing is not null then
    raise exception 'RLS 정책이 없는 테이블이 있습니다: %', v_missing;
  end if;

  -- (4) 공개 역할에 쓰기 권한이 남아 있으면 실패
  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;

  -- (5) 자정 넘김 구간이 실제로 다음 날로 넘어가는가
  if public.kst_moment(date '2026-08-17', 1560) <> timestamptz '2026-08-18 02:00:00+09' then
    raise exception '자정 넘김 계산 오류: %', public.kst_moment(date '2026-08-17', 1560);
  end if;

  -- (6) kst_date 가 day_key 와 값이 일치하는가
  if public.kst_date(timestamptz '2026-08-17 23:59:59+09')::text <> public.day_key(timestamptz '2026-08-17 23:59:59+09')
     or public.kst_date(timestamptz '2026-08-18 00:00:00+09')::text <> public.day_key(timestamptz '2026-08-18 00:00:00+09') then
    raise exception 'kst_date 와 day_key 가 불일치합니다.';
  end if;

  -- (7) 폐기된 테이블이 실제로 사라졌는가
  select count(*) into v_cnt from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'availability_slots';
  if v_cnt <> 0 then
    raise exception 'availability_slots 가 아직 남아 있습니다.';
  end if;
end
$$;
