-- =============================================================================
-- M_Schedule · 00. 공용 함수 / 열거 타입
-- =============================================================================
-- 이 파일은 이후 모든 마이그레이션이 의존하는 기반이다.
--
-- 핵심 규칙 (CLAUDE.md §1 / §2):
--   * 모든 시각은 timestamptz(UTC 저장). 로컬 타임 컬럼은 만들지 않는다.
--   * 주간 초기화 경계는 **목요일 00:00 KST**. 일간 초기화는 **매일 00:00 KST**.
--   * KST 는 서머타임이 없는 고정 UTC+9 이므로, 오프셋(32400초)을 더한 뒤
--     절삭하는 순수 산술로 경계를 구할 수 있다. 이 성질 덕분에 아래 함수들을
--     **IMMUTABLE** 로 선언할 수 있고, 생성 컬럼(GENERATED)·인덱스·CHECK 에 쓸 수 있다.
--
-- IMMUTABLE 을 지키기 위한 주의사항 (중요):
--   * `extract(epoch from <timestamptz>)` 는 `date_part(text, timestamptz)` 이며 **STABLE** 이다.
--     → 대신 `extract(epoch from (ts - to_timestamp(0)))` 를 쓴다.
--       `timestamptz - timestamptz` 는 interval 을 만들고,
--       `date_part(text, interval)` 은 IMMUTABLE 이다.
--   * `to_timestamp(double precision)` 은 IMMUTABLE 이다 (절대 시각이므로 TimeZone 무관).
--   * `<timestamptz> AT TIME ZONE 'Asia/Seoul'`, `date::text`, `to_char(...)` 는
--     TimeZone / DateStyle / lc_numeric 설정에 의존하므로 **쓰지 않는다.**
--     연/월/일은 `date` 로 변환한 뒤 `extract` + `lpad` 로 조립한다.
--
-- 대응 TypeScript: src/lib/time/week.ts 의 getWeekStart / getNextReset /
-- getDailyReset / getWeekKey 와 **값이 정확히 일치**해야 한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0-1. 열거 타입
-- -----------------------------------------------------------------------------
-- create type 은 if not exists 를 지원하지 않으므로 DO 블록으로 감싼다(재실행 안전성).

do $$
begin
  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'party_visibility' and n.nspname = 'public') then
    -- private : 초대된 사람만 (서버 경유)
    -- link    : 링크(슬러그/초대토큰)를 아는 사람만. anon 직접 조회 불가 — 서버가 토큰 검증 후 서빙
    -- public  : 비로그인 포함 전체 공개. anon 이 RLS 로 직접 SELECT 가능
    create type public.party_visibility as enum ('private', 'link', 'public');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'party_member_role' and n.nspname = 'public') then
    create type public.party_member_role as enum ('owner', 'organizer', 'member');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'run_status' and n.nspname = 'public') then
    -- proposed  : 시각 미정 또는 조율 중
    -- confirmed : 시각 확정
    -- done      : 종료(클리어 여부와 무관)
    -- cancelled : 취소
    create type public.run_status as enum ('proposed', 'confirmed', 'done', 'cancelled');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'signup_status' and n.nspname = 'public') then
    -- going/maybe/declined = 카톡 봇의 "참가 5/6 · 미정 1" 표기와 1:1 대응
    create type public.signup_status as enum ('going', 'maybe', 'declined');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'clear_source' and n.nspname = 'public') then
    create type public.clear_source as enum ('manual', 'nexon_api', 'bot');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'run_share_mode' and n.nspname = 'public') then
    -- auto_equal : 참가자가 바뀔 때마다 균등 재계산. 게임의 1/n 지급과 결과가 정확히 같다.
    -- manual     : 사용자가 비율을 직접 지정(버스 33:67 등). 참가자 변동 시 기존 비율을 보존한다.
    create type public.run_share_mode as enum ('auto_equal', 'manual');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'drop_share_mode' and n.nspname = 'public') then
    -- party_default : 그 일정(런)의 기본 분배 비율을 그대로 따른다
    -- custom        : 이 드랍 건에만 적용되는 별도 비율 (run_drop_shares)
    -- solo          : 특정 1인이 전부 가져간다 (먹은 사람이 갖는 경우)
    create type public.drop_share_mode as enum ('party_default', 'custom', 'solo');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'boss_cycle' and n.nspname = 'public') then
    -- 초기화 주기. daily=매일 00:00 KST, weekly=목 00:00 KST, monthly=매월 1일 00:00 KST.
    -- ⚠️ 보스의 cycle 은 불변이 아니다. 2026-06-18 패치로 하드 힐라 / 카오스 핑크빈 /
    --    노멀 시그너스가 주간 → 일간으로 원복되었다. 그래서 클리어 기록은 그 시점 cycle 을
    --    스냅샷으로 함께 남긴다(boss_clears.cycle).
    create type public.boss_cycle as enum ('daily', 'weekly', 'monthly');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'boss_difficulty_tier' and n.nspname = 'public') then
    -- 우리가 통제하는 난이도 값. 넥슨 API 의 자유 문자열은 boss_difficulties.nexon_difficulty
    -- 에 원문을 두고 이 enum 으로 매핑한다.
    create type public.boss_difficulty_tier as enum ('easy', 'normal', 'chaos', 'hard', 'extreme');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'boss_generation' and n.nspname = 'public') then
    -- 파티 인원 상한이 세대별로 갈린다: classic 6인 / modern 3인 (익스트림 스우만 2인은 엔트리 예외).
    -- event = 챌린저스 월드 전용 등 수익 계산에서 격리해야 하는 보스.
    create type public.boss_generation as enum ('classic', 'modern', 'event');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'chore_scope' and n.nspname = 'public') then
    create type public.chore_scope as enum ('daily', 'weekly');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'friendship_status' and n.nspname = 'public') then
    create type public.friendship_status as enum ('pending', 'accepted', 'blocked');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'bot_channel_status' and n.nspname = 'public') then
    create type public.bot_channel_status as enum ('active', 'degraded', 'paused');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'bot_outbox_state' and n.nspname = 'public') then
    create type public.bot_outbox_state as enum ('pending', 'delivering', 'sent', 'failed', 'expired');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'bot_link_code_kind' and n.nspname = 'public') then
    -- channel_pair : 방 최초 페어링 코드 (research-KAKAO-BOT §3.2)
    -- member_link  : 개인 계정 연결 코드 `!연결 <코드>` (research-KAKAO-BOT §2.9)
    create type public.bot_link_code_kind as enum ('channel_pair', 'member_link');
  end if;

  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'account_status' and n.nspname = 'public') then
    create type public.account_status as enum ('active', 'suspended', 'deleted');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 0-2. KST 주/일 경계 함수 (전부 IMMUTABLE)
-- -----------------------------------------------------------------------------

-- 주어진 시각이 속한 주의 시작 = 직전(또는 같은) 목요일 00:00 KST.
-- epoch day 0 (1970-01-01) 이 목요일이라는 성질을 이용한다.
create or replace function public.week_start(ts timestamptz)
returns timestamptz
language sql
immutable
strict
parallel safe
as $func$
  select to_timestamp(
    (
      floor((extract(epoch from (ts - to_timestamp(0))) + 32400) / 604800) * 604800
      - 32400
    )::double precision
  );
$func$;

comment on function public.week_start(timestamptz) is
  'KST 목요일 00:00 기준 주 시작 시각. src/lib/time/week.ts getWeekStart 와 동일.';

-- 다음 주간 초기화 시각 = 다음 목요일 00:00 KST.
-- (timestamptz + interval 은 STABLE 이므로 쓰지 않고 epoch 산술로 계산한다.)
create or replace function public.next_week_reset(ts timestamptz)
returns timestamptz
language sql
immutable
strict
parallel safe
as $func$
  select to_timestamp(
    (
      floor((extract(epoch from (ts - to_timestamp(0))) + 32400) / 604800) * 604800
      + 604800 - 32400
    )::double precision
  );
$func$;

comment on function public.next_week_reset(timestamptz) is
  '다음 주간 초기화(목 00:00 KST) 시각. src/lib/time/week.ts getNextReset 와 동일.';

-- 일간 초기화 경계 = 직전(또는 같은) 00:00 KST.
create or replace function public.day_start(ts timestamptz)
returns timestamptz
language sql
immutable
strict
parallel safe
as $func$
  select to_timestamp(
    (
      floor((extract(epoch from (ts - to_timestamp(0))) + 32400) / 86400) * 86400
      - 32400
    )::double precision
  );
$func$;

comment on function public.day_start(timestamptz) is
  '일간 초기화(00:00 KST) 경계. src/lib/time/week.ts getDailyReset 와 동일.';

-- 주차 키. 예) '2026-W33'
--
-- 알고리즘 (src/lib/time/week.ts getWeekKey 와 동일):
--   1. 주 시작(목요일 00:00 KST)의 KST 달력 날짜를 구한다.
--   2. 그 목요일이 속한 연도를 연(year)으로 삼는다.  ← ISO-8601 주차 연도와 동일한 규칙
--   3. 그 목요일의 dayOfYear 를 7 로 나눠 올림한 값이 주차다.
--      (연중 n번째 목요일의 doy 는 항상 firstThuDoy + 7(n-1) 이므로
--       ceil(doy/7) = n 이 되고, 이는 ISO 주차와 정확히 일치한다.)
create or replace function public.week_key(ts timestamptz)
returns text
language sql
immutable
strict
parallel safe
as $func$
  select extract(year from s.week_start_date)::int::text
      || '-W'
      || lpad(ceil(extract(doy from s.week_start_date) / 7.0)::int::text, 2, '0')
  from (
    select date '1970-01-01'
         + (floor((extract(epoch from (ts - to_timestamp(0))) + 32400) / 604800) * 7)::int
           as week_start_date
  ) s;
$func$;

comment on function public.week_key(timestamptz) is
  '주차 키(예: 2026-W33). 목 00:00 KST 경계, ISO 주차와 값 일치. src/lib/time/week.ts getWeekKey 와 동일해야 한다.';

-- 일자 키. 예) '2026-08-17' (KST 달력 기준)
-- date::text / to_char 는 DateStyle·lc_numeric 에 의존하므로 쓰지 않고 직접 조립한다.
create or replace function public.day_key(ts timestamptz)
returns text
language sql
immutable
strict
parallel safe
as $func$
  select lpad(extract(year  from s.d)::int::text, 4, '0') || '-'
      || lpad(extract(month from s.d)::int::text, 2, '0') || '-'
      || lpad(extract(day   from s.d)::int::text, 2, '0')
  from (
    select date '1970-01-01'
         + floor((extract(epoch from (ts - to_timestamp(0))) + 32400) / 86400)::int as d
  ) s;
$func$;

comment on function public.day_key(timestamptz) is
  'KST 달력 일자 키(예: 2026-08-17). 일간 숙제/호출량 집계 버킷.';

-- -----------------------------------------------------------------------------
-- 0-3. 자기검증 — 주 경계가 어긋나면 마이그레이션 자체를 실패시킨다
-- -----------------------------------------------------------------------------
-- 2026-08-20(목) 00:00 KST 가 주 경계다.
--   수 23:59:59 KST → 2026-W33
--   목 00:00:00 KST → 2026-W34
do $$
begin
  if public.week_key(timestamptz '2026-08-19 23:59:59+09') <> '2026-W33' then
    raise exception 'week_key 경계 오류: 수요일 23:59:59 KST 가 2026-W33 이 아님 (실제 %)',
      public.week_key(timestamptz '2026-08-19 23:59:59+09');
  end if;

  if public.week_key(timestamptz '2026-08-20 00:00:00+09') <> '2026-W34' then
    raise exception 'week_key 경계 오류: 목요일 00:00:00 KST 가 2026-W34 가 아님 (실제 %)',
      public.week_key(timestamptz '2026-08-20 00:00:00+09');
  end if;

  -- 같은 순간을 다른 오프셋으로 표현해도 같은 키여야 한다 (timestamptz 는 절대 시각).
  if public.week_key(timestamptz '2026-08-19 15:00:00+00') <> '2026-W34' then
    raise exception 'week_key 오류: UTC 표기 환산 실패 (실제 %)',
      public.week_key(timestamptz '2026-08-19 15:00:00+00');
  end if;

  -- 연말 경계: 2026-12-31(목) 은 2026-W53, 2027-01-07(목) 은 2027-W01.
  if public.week_key(timestamptz '2027-01-01 12:00:00+09') <> '2026-W53' then
    raise exception 'week_key 오류: 2027-01-01 이 2026-W53 이 아님 (실제 %)',
      public.week_key(timestamptz '2027-01-01 12:00:00+09');
  end if;

  if public.week_key(timestamptz '2027-01-07 00:00:00+09') <> '2027-W01' then
    raise exception 'week_key 오류: 2027-01-07 이 2027-W01 이 아님 (실제 %)',
      public.week_key(timestamptz '2027-01-07 00:00:00+09');
  end if;

  if public.week_start(timestamptz '2026-08-19 23:59:59+09') <> timestamptz '2026-08-13 00:00:00+09' then
    raise exception 'week_start 오류: 기대 2026-08-13T00:00+09, 실제 %',
      public.week_start(timestamptz '2026-08-19 23:59:59+09');
  end if;

  if public.next_week_reset(timestamptz '2026-08-19 23:59:59+09') <> timestamptz '2026-08-20 00:00:00+09' then
    raise exception 'next_week_reset 오류: 기대 2026-08-20T00:00+09, 실제 %',
      public.next_week_reset(timestamptz '2026-08-19 23:59:59+09');
  end if;

  if public.day_key(timestamptz '2026-08-17 23:59:59+09') <> '2026-08-17'
     or public.day_key(timestamptz '2026-08-18 00:00:00+09') <> '2026-08-18' then
    raise exception 'day_key 경계 오류';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 0-4. 공용 트리거 함수 / 세션 헬퍼
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $func$
begin
  new.updated_at := now();
  return new;
end;
$func$;

comment on function public.set_updated_at() is
  'updated_at 자동 갱신용 BEFORE UPDATE 트리거 함수.';

-- 현재 요청의 앱 사용자 ID.
--
-- 이 프로젝트는 Supabase Auth 세션을 쓰지 않는다(넥슨 API 키 해시로 식별).
-- 따라서 기본 인증 모델은 "모든 쓰기는 Route Handler + service role, RLS 는
-- anon/authenticated 전면 차단"(DB-SCHEMA.md 난제 1 (c))이며, 이 함수는
--   * 서버가 `select set_config('app.user_id', <uuid>, true)` 로 심어둔 값을 읽고,
--   * 나중에 커스텀 JWT/익명 로그인 모델로 옮길 때 이 함수 하나만 고쳐 쓰도록
-- 준비된 확장 지점이다. 값이 없으면 null 을 돌려주고, null 이면 어떤 정책도 통과하지 않는다.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
parallel safe
as $func$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$func$;

comment on function public.current_app_user_id() is
  '현재 세션에 바인딩된 앱 사용자 UUID. 미설정이면 null. 인증 모델 교체 시 이 함수만 바꾼다.';
