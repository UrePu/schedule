-- M_Schedule — 전체 스키마 (마이그레이션 20개 병합)
-- 생성: 2026-08-17 20:23 · Supabase SQL Editor 에 붙여넣어 실행.
-- 원본은 supabase/migrations/*.sql. 이 파일은 편의용 사본이며 여기를 고치지 마세요.

-- ============================================================
-- 20260817090000_core_functions_and_enums.sql
-- ============================================================
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

-- ============================================================
-- 20260817090100_core_identity.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 01. 코어 신원 (사용자 / 자격증명 / 캐릭터)
-- =============================================================================
-- 설계 원칙:
--   * 공개 가능한 프로필 정보와 **절대 노출되면 안 되는 자격증명을 테이블 단위로 분리**한다.
--     app_users            → 표시용. 그래도 anon 직접 접근은 막는다(공개 시간표는 참가자
--                            스냅샷 이름으로 렌더링하므로 이 테이블을 읽을 필요가 없다).
--     user_credentials     → 넥슨 API 키 SHA-256 해시 / 암호화 원문. anon 전면 차단.
--     user_nexon_accounts  → account_id 보조 식별자. anon 전면 차단.
--   * 넥슨 API 키 **원문은 저장하지 않는다**(CLAUDE.md §2.1).
--     서버 대리호출/봇 알림에 동의한 사용자만 암호화본을 별도 컬럼에 보관한다.
--   * ocid 는 변경될 수 있다(스펙 명시) → **PK 로 쓰지 않는다.** 자체 UUID PK + 갱신 가능한
--     유니크 컬럼으로 둔다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app_users — 앱 사용자(계정)
-- -----------------------------------------------------------------------------
create table if not exists public.app_users (
  id                  uuid primary key default gen_random_uuid(),

  -- 표시용 이름. 초대 링크로 들어온 임시 참가자가 승계될 때 이 값으로 승격된다.
  display_name        text        not null check (length(btrim(display_name)) between 1 and 40),

  -- 대표 캐릭터 이름(표시용 스냅샷). 정규 참조는 characters.is_main 을 쓴다.
  main_character_name text,
  main_world_name     text,

  avatar_url          text,
  status              public.account_status not null default 'active',

  -- 향후 인증 모델 교체(커스텀 JWT / 익명 로그인)를 위한 확장 지점.
  -- 현재 모델(service role 전용 쓰기)에서는 항상 null 이다.
  -- auth.users 로의 FK 는 의도적으로 걸지 않는다 — 스키마 이식성과 로컬 검증 가능성을 위해서다.
  auth_user_id        uuid unique,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_login_at       timestamptz,
  deleted_at          timestamptz
);

comment on table public.app_users is
  '앱 사용자. 넥슨 API 키 해시로 식별되며 자격증명은 user_credentials 에 분리 보관한다.';
comment on column public.app_users.auth_user_id is
  '향후 Supabase Auth 연동 시 auth.users.id 를 담을 자리. 현행 모델에서는 미사용(null).';

create index if not exists app_users_active_idx
  on public.app_users (created_at desc)
  where deleted_at is null;

drop trigger if exists app_users_set_updated_at on public.app_users;
create trigger app_users_set_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- user_credentials — 넥슨 API 키 자격증명 (기밀)
-- -----------------------------------------------------------------------------
-- 키를 재발급하면 SHA-256 해시가 바뀐다. 기존 계정을 잃지 않도록 **행을 추가**하는
-- 구조로 만든다(1:N). 옛 해시는 invalidated_at 을 채워 비활성화한다.
create table if not exists public.user_credentials (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.app_users(id) on delete cascade,

  -- SHA-256 hex 64자. **원문 키는 어떤 경우에도 저장하지 않는다.**
  api_key_hash        text not null unique
                        check (api_key_hash ~ '^[0-9a-f]{64}$'),

  -- 서버 대리호출/봇 알림에 명시 동의한 사용자만 채워진다(CLAUDE.md §2.1).
  -- 애플리케이션 레벨 암호화(AEAD) 결과를 담는다. 평문 금지.
  encrypted_api_key   bytea,
  encryption_key_id   text,
  allow_server_side_use boolean not null default false,
  consent_at          timestamptz,

  label               text,
  last_validated_at   timestamptz,
  invalidated_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 서버 대리호출을 허용했다면 암호화된 키와 동의 시각이 반드시 있어야 한다.
  constraint user_credentials_server_use_requires_key check (
    allow_server_side_use = false
    or (encrypted_api_key is not null and encryption_key_id is not null and consent_at is not null)
  )
);

comment on table public.user_credentials is
  '넥슨 API 키 자격증명. 해시로만 식별하며, 서버 대리호출 동의자에 한해 암호화 원문을 보관한다. anon/authenticated 전면 차단.';

create index if not exists user_credentials_user_idx
  on public.user_credentials (user_id)
  where invalidated_at is null;

drop trigger if exists user_credentials_set_updated_at on public.user_credentials;
create trigger user_credentials_set_updated_at
  before update on public.user_credentials
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- user_nexon_accounts — 넥슨 계정 보조 식별자 (기밀)
-- -----------------------------------------------------------------------------
-- character/list 응답의 account_list[].account_id. 키 재발급으로 해시가 바뀌었을 때
-- 계정을 복구하는 경로다(research-NEXON-API "인증 모델에 미치는 영향").
create table if not exists public.user_nexon_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.app_users(id) on delete cascade,
  nexon_account_id text not null unique,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);

comment on table public.user_nexon_accounts is
  '넥슨 account_id 보조 식별자. API 키 재발급 시 계정 복구 경로. anon/authenticated 전면 차단.';

create index if not exists user_nexon_accounts_user_idx
  on public.user_nexon_accounts (user_id);

-- -----------------------------------------------------------------------------
-- characters — 사용자 소유 캐릭터
-- -----------------------------------------------------------------------------
create table if not exists public.characters (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.app_users(id) on delete cascade,

  -- ocid 는 "게임 콘텐츠 변경으로 변경될 수 있음"이 스펙에 명시되어 있다.
  -- 따라서 PK 가 아니라 **갱신 가능한 유니크 컬럼**이다. 미해석 상태를 위해 nullable.
  ocid              text,
  ocid_refreshed_at timestamptz,

  character_name    text not null check (length(btrim(character_name)) between 1 and 30),
  world_name        text,
  character_class   text,
  character_level   integer check (character_level between 1 and 500),
  guild_name        text,
  image_url         text,

  is_main           boolean not null default false,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint characters_user_name_world_uniq unique (user_id, character_name, world_name)
);

comment on table public.characters is
  '사용자 계정에 속한 메이플 캐릭터. ocid 는 변경 가능하므로 PK 가 아니라 갱신 가능 유니크 컬럼이다.';
comment on column public.characters.ocid is
  '넥슨 ocid. 스펙상 변경될 수 있으므로 PK 로 쓰지 않는다. 부분 유니크 인덱스로 중복만 막는다.';

-- ocid 는 값이 있을 때만 전역 유일해야 한다.
create unique index if not exists characters_ocid_uniq
  on public.characters (ocid)
  where ocid is not null;

-- 사용자당 대표 캐릭터는 하나.
create unique index if not exists characters_one_main_per_user
  on public.characters (user_id)
  where is_main;

create index if not exists characters_user_idx
  on public.characters (user_id);

drop trigger if exists characters_set_updated_at on public.characters;
create trigger characters_set_updated_at
  before update on public.characters
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- nexon_api_quota_usage — 넥슨 API 호출량 집계 (기밀)
-- -----------------------------------------------------------------------------
-- 개발 단계 키는 1,000건/일, 5건/초 제한이다(research-NEXON-API §제약사항 1).
-- 프록시가 예산을 넘기지 않도록 자격증명 × KST 일자 단위로 누적한다.
create table if not exists public.nexon_api_quota_usage (
  id            uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.user_credentials(id) on delete cascade,

  -- KST 일자 키. 넥슨의 일 허용량 리셋 기준이 KST 이므로 day_key 를 그대로 쓴다.
  day_key       text not null check (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),

  call_count    integer not null default 0 check (call_count >= 0),
  error_count   integer not null default 0 check (error_count >= 0),
  throttled_count integer not null default 0 check (throttled_count >= 0),
  last_called_at  timestamptz,
  updated_at    timestamptz not null default now(),

  constraint nexon_api_quota_usage_uniq unique (credential_id, day_key)
);

comment on table public.nexon_api_quota_usage is
  '넥슨 오픈 API 호출량 일별 집계(KST). 개발 단계 키 1,000건/일 예산 통제용. anon/authenticated 전면 차단.';

drop trigger if exists nexon_api_quota_usage_set_updated_at on public.nexon_api_quota_usage;
create trigger nexon_api_quota_usage_set_updated_at
  before update on public.nexon_api_quota_usage
  for each row execute function public.set_updated_at();

-- ============================================================
-- 20260817090200_boss_master.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 02. 보스 마스터 / 별칭 / 결정석 가격
-- =============================================================================
-- ⚠️ **이 파일은 구조만 만든다. 시드 데이터는 넣지 않는다.**
--    보스 78개 엔트리와 결정석 가격은 Claude/research-BOSS-DATA.md 에 정리되어 있으며,
--    시드 투입은 별도 작업 단위다. 추측값을 넣으면 수익이 조용히 틀어진다.
--
-- 2단 구조:
--   bosses            = 보스 본체("스우", "자쿰"). research 문서의 `baseName` 에 대응.
--   boss_difficulties = 난이도별 실제 도전 단위("하드 스우"). research 문서의 한 행 = 여기 한 행.
--                       결정석 가격·파티 상한·입장 레벨·주기가 전부 이 단위에 붙는다.
--
-- 왜 2단인가:
--   * `cycle` 이 난이도마다 다르다. 이지/노멀 자쿰은 daily 인데 카오스 자쿰은 weekly 다.
--   * `max_party` 도 난이도마다 다르다. 하드 스우는 6인인데 **익스트림 스우는 2인**이다.
--   * 봇이 `스우` 처럼 난이도 없는 별칭을 받으면 후보가 여러 개임을 알아야 되물을 수 있다.
--
-- PK 를 uuid 가 아니라 **영문 slug(text)** 로 잡은 이유:
--   research-BOSS-DATA.md 가 `id` 를 "DB에 저장되는 키. 한 번 정하면 바꾸지 말 것"으로
--   못박았고, 우리가 직접 통제하는 값이라 변할 위험이 없다. 클리어 원장에 'lotus_hard' 가
--   그대로 보이는 편이 디버깅·시드·감사 모두에 유리하다.
--   (넥슨 ocid 를 PK 로 쓰지 않는 것과는 성격이 정반대다. ocid 는 넥슨이 바꿀 수 있는 값이다.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bosses — 보스 본체
-- -----------------------------------------------------------------------------
create table if not exists public.bosses (
  -- 우리가 정한 안정적 slug. 예: 'lotus', 'zakum'. **변경 금지.**
  id                 text primary key check (id ~ '^[a-z0-9][a-z0-9_]{0,49}$'),

  korean_name        text not null unique,

  -- 파티 상한이 세대별로 갈린다(classic 6 / modern 3). 개별 상한은 엔트리의 max_party 가 정답이고,
  -- 이 컬럼은 분류·표시·신규 보스 기본값 판단용이다.
  generation         public.boss_generation not null default 'classic',

  -- 넥슨 스케줄러 API `boss_contents[].content_name` 원문. 실호출로 수집해 채운다.
  nexon_content_name text unique,

  sort_order         integer not null default 1000,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.bosses is
  '보스 본체(난이도 무관). research-BOSS-DATA.md 의 baseName 에 대응.';
comment on column public.bosses.id is
  'DB **영구 키**. 한 번 저장되면 변경 불가. 시드 투입 전에 영문 slug 를 확정할 것.';
comment on column public.bosses.generation is
  'classic=구세대 6인 / modern=김창섭 체제 신세대 3인 / event=챌린저스 월드 등 수익 계산 격리 대상.';

create index if not exists bosses_sort_idx on public.bosses (sort_order, korean_name);

drop trigger if exists bosses_set_updated_at on public.bosses;
create trigger bosses_set_updated_at
  before update on public.bosses
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- boss_difficulties — 보스 × 난이도 (실제 도전 단위, research 문서의 한 행)
-- -----------------------------------------------------------------------------
create table if not exists public.boss_difficulties (
  -- 예: 'lotus_hard', 'lotus_extreme'. research-BOSS-DATA.md 의 `id` 와 동일. **변경 금지.**
  id               text primary key check (id ~ '^[a-z0-9][a-z0-9_]{0,59}$'),
  boss_id          text not null references public.bosses(id) on delete restrict,

  -- 난이도를 포함한 한글 표기. 예: '하드 스우'. UI·봇 응답에 그대로 쓴다.
  korean_name      text not null,
  difficulty       public.boss_difficulty_tier not null,
  cycle            public.boss_cycle not null,

  -- 파티 인원 상한. **소프트 상한이다 (CLAUDE.md §1.3 D5).**
  -- 6인 값 대부분은 보스별 1차 출처가 아니라 세대 규칙에서 유도한 값이고(개별 확인 11건뿐),
  -- 실제 파티가 이 값을 넘는데 입력이 막히면 그게 더 나쁘다.
  -- → DB 는 막지 않는다. 초과는 애플리케이션이 **경고**로 처리한다.
  -- 익스트림 스우 2 / 신세대 3 은 개별 확인되어 신뢰도가 높다.
  max_party        integer not null default 6 check (max_party between 1 and 24),

  entry_level      integer check (entry_level between 1 and 500),

  -- 라이브 서버 출시 여부. 미출시(벨로나 3종)·난이도 통합으로 사라진 항목(cygnus_easy)은
  -- **행을 지우지 않고** false 로 내려 과거 기록을 보존한다.
  released         boolean not null default false,

  -- 넥슨 API `boss_contents[].difficulty` 원문(자유 문자열). 매핑 실패 감지에 쓴다.
  nexon_difficulty text,

  sort_order       integer not null default 1000,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint boss_difficulties_boss_difficulty_uniq unique (boss_id, difficulty),
  -- boss_aliases 가 (엔트리, 보스) 정합성을 복합 FK 로 검증할 수 있게 열어둔다.
  constraint boss_difficulties_id_boss_uniq unique (id, boss_id)
);

comment on table public.boss_difficulties is
  '보스 × 난이도. 결정석 가격·파티 상한·입장 레벨·초기화 주기가 붙는 실제 도전 단위. PK 는 영문 slug.';
comment on column public.boss_difficulties.max_party is
  '파티 인원 **소프트** 상한(CLAUDE.md §1.3 D5). 대부분 세대 규칙에서 유도한 값이라 DB 로 막지 않고 앱이 경고만 한다.';
comment on column public.boss_difficulties.id is
  'DB **영구 키**. 한 번 저장되면 변경 불가 — 시드 투입 전에 영문 slug 를 확정해야 한다(예: 찬란한 흉성은 radiant_malefic_star 가 실제 영문명).';
comment on column public.boss_difficulties.cycle is
  '초기화 주기. 패치로 바뀔 수 있다(2026-06-18 하드 힐라·카오스 핑크빈·노멀 시그너스 주간→일간).';
comment on column public.boss_difficulties.released is
  '미출시/폐지 엔트리는 행을 지우지 않고 false 로 둔다. 과거 클리어 기록을 보존하기 위해서다.';

create index if not exists boss_difficulties_boss_idx
  on public.boss_difficulties (boss_id, sort_order);

-- 등록 UI/봇이 쓰는 목록: 주기별 + 출시된 것만
create index if not exists boss_difficulties_cycle_idx
  on public.boss_difficulties (cycle, sort_order)
  where released;

drop trigger if exists boss_difficulties_set_updated_at on public.boss_difficulties;
create trigger boss_difficulties_set_updated_at
  before update on public.boss_difficulties
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- boss_aliases — 별칭 → 보스(+선택적 난이도)
-- -----------------------------------------------------------------------------
-- research-KAKAO-BOT §2.10: 별칭은 **코드에 하드코딩하지 않는다.**
-- boss_difficulty_id 가 null 이면 난이도 미지정 별칭('스우')이고, 봇은 후보가 2개 이상이면
-- 되묻는다. 채워져 있으면 곧바로 특정된다('하스우').
create table if not exists public.boss_aliases (
  id                 uuid primary key default gen_random_uuid(),
  boss_id            text not null references public.bosses(id) on delete cascade,
  boss_difficulty_id text,

  alias              text not null check (length(btrim(alias)) between 1 and 40),

  -- 매칭용 정규화 문자열(소문자·공백제거 등). 정규화 규칙은 앱 로직이고 바뀔 수 있어
  -- 생성 컬럼으로 굳히지 않는다.
  normalized_alias   text not null check (normalized_alias = lower(btrim(normalized_alias))),

  source             text not null default 'manual',
  created_at         timestamptz not null default now(),

  -- 엔트리가 지정되면 그 엔트리는 반드시 이 보스의 것이어야 한다.
  constraint boss_aliases_entry_belongs_to_boss
    foreign key (boss_difficulty_id, boss_id)
    references public.boss_difficulties (id, boss_id)
    on delete cascade
);

comment on table public.boss_aliases is
  '보스 별칭 → 보스(+선택 난이도) 매핑. 카톡 봇 파서가 사용하며 코드 하드코딩을 금지한다.';
comment on column public.boss_aliases.boss_difficulty_id is
  'null 이면 난이도 미지정 별칭. 봇은 후보가 여러 개면 되묻는다(research-KAKAO-BOT §2.4).';

-- 같은 별칭 문자열이 서로 다른 대상을 가리키면 조용히 엉뚱한 보스에 등록된다.
-- 난이도까지 특정된 별칭은 전역 유일해야 하고, 난이도 미지정 별칭도 보스별로 유일해야 한다.
create unique index if not exists boss_aliases_normalized_uniq
  on public.boss_aliases (normalized_alias)
  where boss_difficulty_id is not null;

create unique index if not exists boss_aliases_normalized_group_uniq
  on public.boss_aliases (normalized_alias, boss_id)
  where boss_difficulty_id is null;

create index if not exists boss_aliases_boss_idx on public.boss_aliases (boss_id);

-- -----------------------------------------------------------------------------
-- boss_crystal_prices — 결정석 기본가 (효력기간형)
-- -----------------------------------------------------------------------------
-- 가격은 **솔로(1인) 기준 기본가**다. 실제 수령액은 입장 파티 인원으로 나눈 값이며
-- 그 계산은 boss_clears 에서 한다(R1: floor(기본가 / 파티인원)).
--
-- research-BOSS-DATA.md 의 상수표를 그대로 담되 **효력기간형**으로 둔 이유:
--   가격은 패치로만 바뀌고(R6: 시세 변동 시스템은 2024-01-04부터 중단), 실제로
--   2026-06-18 패치에서 52개 항목이 조정됐다. 이력을 남겨야 "그 시점 가격"을 재구성할 수 있다.
--
-- ⚠️ price_meso 는 **nullable** 이다. `null` 은 0 이 아니라 **미확인**이다.
--    (노멀 벨로나처럼 출처가 엇갈려 확정하지 못한 값이 실제로 존재한다)
create table if not exists public.boss_crystal_prices (
  id                 uuid primary key default gen_random_uuid(),
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete cascade,

  -- 솔로 기준 기본가(메소). 부동소수점 금지. null = 미확인.
  price_meso         bigint check (price_meso is null or price_meso >= 0),

  effective_from     timestamptz not null default now(),

  -- 가격 근거 패치. 예: '1.2.202 (2026-06-18)'
  patch_label        text,
  note               text,
  created_at         timestamptz not null default now(),

  constraint boss_crystal_prices_uniq unique (boss_difficulty_id, effective_from)
);

comment on table public.boss_crystal_prices is
  '보스별 결정석 기본가(솔로 기준, 효력기간형). null 가격은 0 이 아니라 "미확인"이다. 과거 수익은 boss_clears 스냅샷을 쓰므로 여기 값이 바뀌어도 소급되지 않는다.';
comment on column public.boss_crystal_prices.price_meso is
  '솔로 1인 입장 기준 기본가. 실수령액은 floor(price_meso / party_size) 이며 boss_clears 에 스냅샷된다.';

create index if not exists boss_crystal_prices_lookup_idx
  on public.boss_crystal_prices (boss_difficulty_id, effective_from desc);

-- 특정 시점에 유효한 기본가 1건. 클리어 스냅샷 생성에 쓴다.
-- 행이 없거나 price_meso 가 null 이면 "미확인"이며, 호출부는 이를 0 과 구분해야 한다.
create or replace function public.current_crystal_price(
  p_boss_difficulty_id text,
  p_at timestamptz default now()
)
returns table (price_id uuid, price_meso bigint)
language sql
stable
parallel safe
as $func$
  select p.id, p.price_meso
  from public.boss_crystal_prices p
  where p.boss_difficulty_id = p_boss_difficulty_id
    and p.effective_from <= p_at
  order by p.effective_from desc
  limit 1;
$func$;

comment on function public.current_crystal_price(text, timestamptz) is
  '해당 시점에 유효한 결정석 기본가. 결과가 없거나 price_meso 가 null 이면 미확인이다.';

-- -----------------------------------------------------------------------------
-- 결정석 판매 제한 상수
-- -----------------------------------------------------------------------------
-- 숫자를 뷰·트리거에 흩뿌리지 않고 한 곳에 둔다. 패치로 바뀌면 여기만 고친다.
create or replace function public.weekly_crystal_sell_limit()
returns integer language sql immutable parallel safe as $func$ select 12 $func$;

comment on function public.weekly_crystal_sell_limit() is
  '주간 결정 판매 한도(캐릭터당 주 12개). 2025-08-21 패치로 13번째 주간 보스는 입장 자체가 차단되므로 실무상 절삭은 거의 발생하지 않는다 — 집계의 방어 상한으로 쓴다.';

create or replace function public.world_crystal_sell_limit()
returns integer language sql immutable parallel safe as $func$ select 90 $func$;

comment on function public.world_crystal_sell_limit() is
  '월드당 주간 결정 판매 총량(일간+주간+월간 합산 90개). 주체가 계정 단위인지 미확인이라 강제하지 않고 모니터링 지표로만 쓴다.';

-- ============================================================
-- 20260817090300_scheduling.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 03. 스케줄링 (파티 / 참가자 / 보스 런 / 참여의사 / 가용시간)
-- =============================================================================
-- 이 앱의 1순위 가치가 여기에 있다: **여러 사람의 참여 의사를 하나의 시간표로 겹쳐 보기.**
-- 넥슨 API 에는 "몇 시에 갈지"가 전혀 없고 남의 스케줄도 못 읽으므로
-- (research-NEXON-API), 이 영역은 100% 자체 DB 다.
--
-- 두 층으로 나눈다.
--   availability_slots : 시각 확정 전 "나는 이 시간대 가능" (30분 격자). 겹쳐보기의 원천.
--   party_runs         : 시각이 정해진(또는 조율 중인) 실제 보스 런. `!일정` 이 읽는 대상.
--   run_signups        : 런별 참여 의사(going/maybe/declined). "참가 5/6 · 미정 1" 의 근거.
--
-- 임시 참가자(초대 링크로 이름만 적고 들어온 사람)와 정규 사용자는
-- **party_participants 한 테이블에 공존**한다. 자세한 근거는 Claude/DB-SCHEMA.md 난제 7.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- parties — 파티(지속되는 사람 묶음)
-- -----------------------------------------------------------------------------
create table if not exists public.parties (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references public.app_users(id) on delete cascade,

  name              text not null check (length(btrim(name)) between 1 and 60),
  description       text,

  -- private : 서버가 멤버십을 확인해야만 볼 수 있다
  -- link    : 슬러그/초대 토큰을 아는 사람만. **anon 직접 SELECT 불가** — 슬러그가 곧 비밀이므로
  --           RLS 로는 보호할 수 없고 Route Handler 가 토큰을 검증한 뒤 service role 로 읽는다
  -- public  : 비로그인 열람 대상. anon 이 RLS 로 직접 SELECT 한다
  visibility        public.party_visibility not null default 'private',

  -- 공개/링크 파티의 짧은 URL 조각. 예: /r/a7k2
  share_slug        text unique check (share_slug ~ '^[a-z0-9]{4,32}$'),

  world_name        text,
  -- 보스별 파티 상한(구세대 6 / 신세대 3 / 익스트림 스우 2)은 **소프트 상한**이므로
  -- 여기서는 넉넉한 정상성 범위만 둔다. 초과 경고는 애플리케이션 몫이다(CLAUDE.md §1.3 D5).
  default_capacity  integer not null default 6 check (default_capacity between 1 and 24),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,

  -- 공개/링크 파티는 슬러그가 반드시 있어야 URL 이 만들어진다.
  constraint parties_shared_requires_slug check (
    visibility = 'private' or share_slug is not null
  )
);

comment on table public.parties is
  '보스 파티(지속되는 사람 묶음). visibility=public 인 행만 비로그인 열람 대상이다.';
comment on column public.parties.visibility is
  'link 는 anon 이 직접 읽지 못한다 — 슬러그가 비밀이라 RLS 로 표현할 수 없기 때문. 서버가 검증 후 서빙한다.';

-- 비로그인 공개 목록 조회용.
create index if not exists parties_public_idx
  on public.parties (updated_at desc)
  where visibility = 'public' and archived_at is null;

create index if not exists parties_owner_idx
  on public.parties (owner_user_id)
  where archived_at is null;

drop trigger if exists parties_set_updated_at on public.parties;
create trigger parties_set_updated_at
  before update on public.parties
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- party_participants — 파티 참가자 (정규 사용자 + 임시 게스트 공존)
-- -----------------------------------------------------------------------------
-- user_id 와 guest_id 중 **정확히 하나**만 채워진다.
-- guest_id 는 guest_profiles(마이그레이션 05)를 가리키며, FK 는 그 파일에서 추가한다.
--
-- display_name 을 스냅샷으로 들고 있는 이유가 두 가지다.
--   1) 게스트는 app_users 행이 없다. 이름을 여기 말고 둘 곳이 없다.
--   2) 비로그인 공개 시간표가 app_users 를 **전혀 조인하지 않아도** 렌더링된다.
--      → anon 에게 app_users 접근 권한을 한 톨도 줄 필요가 없어진다(난제 2).
create table if not exists public.party_participants (
  id                uuid primary key default gen_random_uuid(),
  party_id          uuid not null references public.parties(id) on delete cascade,

  user_id           uuid references public.app_users(id) on delete cascade,
  guest_id          uuid,   -- → guest_profiles(id). FK 는 05 마이그레이션에서 추가

  -- 공개 시간표에 그대로 노출되는 이름. 사용자 표시명 변경 시 트리거로 동기화된다.
  display_name      text not null check (length(btrim(display_name)) between 1 and 40),

  role              public.party_member_role not null default 'member',
  character_id      uuid references public.characters(id) on delete set null,

  invited_by_user_id uuid references public.app_users(id) on delete set null,
  joined_at         timestamptz not null default now(),
  left_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- 널러블 FK 두 개 중 정확히 하나. num_nonnulls 는 IMMUTABLE 이라 CHECK 에 쓸 수 있다.
  constraint party_participants_exactly_one_identity
    check (num_nonnulls(user_id, guest_id) = 1),

  -- 하위 테이블이 party_id 를 비정규화해도 정합성이 깨지지 않도록 복합 유니크를 열어둔다.
  constraint party_participants_id_party_uniq unique (id, party_id)
);

comment on table public.party_participants is
  '파티 참가자. 정규 사용자(user_id)와 임시 게스트(guest_id)가 한 테이블에 공존한다. display_name 은 공개 시간표 렌더링용 스냅샷.';

-- 같은 사람이 한 파티에 두 번 들어가지 못하게 한다.
create unique index if not exists party_participants_user_uniq
  on public.party_participants (party_id, user_id)
  where user_id is not null;

create unique index if not exists party_participants_guest_uniq
  on public.party_participants (party_id, guest_id)
  where guest_id is not null;

create index if not exists party_participants_user_idx
  on public.party_participants (user_id)
  where user_id is not null and left_at is null;

create index if not exists party_participants_guest_idx
  on public.party_participants (guest_id)
  where guest_id is not null;

create index if not exists party_participants_party_idx
  on public.party_participants (party_id)
  where left_at is null;

drop trigger if exists party_participants_set_updated_at on public.party_participants;
create trigger party_participants_set_updated_at
  before update on public.party_participants
  for each row execute function public.set_updated_at();

-- 사용자가 표시명을 바꾸면 참가자 스냅샷도 따라간다.
-- (스냅샷을 쓰는 대가로 생기는 정합성 부채를 트리거로 갚는다.)
create or replace function public.sync_participant_display_name()
returns trigger
language plpgsql
as $func$
begin
  if new.display_name is distinct from old.display_name then
    update public.party_participants
       set display_name = new.display_name
     where user_id = new.id
       and display_name = old.display_name;
  end if;
  return new;
end;
$func$;

drop trigger if exists app_users_sync_participant_name on public.app_users;
create trigger app_users_sync_participant_name
  after update of display_name on public.app_users
  for each row execute function public.sync_participant_display_name();

-- -----------------------------------------------------------------------------
-- party_runs — 보스 런 (일정 항목)
-- -----------------------------------------------------------------------------
create table if not exists public.party_runs (
  id                 uuid primary key default gen_random_uuid(),
  party_id           uuid not null references public.parties(id) on delete cascade,
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete restrict,

  -- null 이면 "시각 미정". 겹쳐보기로 시간을 조율하는 중이다.
  scheduled_at       timestamptz,
  duration_minutes   integer not null default 30 check (duration_minutes between 5 and 600),

  status             public.run_status not null default 'proposed',

  -- 모집 정원(계획값). 보스의 max_party 는 **소프트 상한**이라 DB 는 막지 않는다(CLAUDE.md §1.3 D5).
  capacity           integer not null default 6 check (capacity between 1 and 24),

  -- **입장 시점 실제 파티 인원.** 결정석은 여기에 맞춰 1/n 로 나뉜다(소수점 버림).
  -- 기본값은 앱에 등록된 참가자 수이고 **사용자가 고칠 수 있어야 한다**(CLAUDE.md §1.3 D3).
  -- 클리어 기록이 이 값을 스냅샷으로 가져간다.
  entry_party_size   integer check (entry_party_size between 1 and 24),

  -- 주간 집계 버킷. 목 00:00 KST 경계. week_key() 가 IMMUTABLE 이라 생성 컬럼으로 쓸 수 있다.
  -- 시각 미정이면 생성 시각이 속한 주에 매단다. 나중에 시각이 정해지면 자동으로 옮겨간다.
  week_key           text generated always as
                       (public.week_key(coalesce(scheduled_at, created_at))) stored,

  created_by_participant_id uuid references public.party_participants(id) on delete set null,
  note               text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  cancelled_at       timestamptz,

  constraint party_runs_confirmed_needs_time check (
    status <> 'confirmed' or scheduled_at is not null
  )
);

comment on table public.party_runs is
  '보스 런(일정 항목). scheduled_at 이 null 이면 시각 미정 상태로 겹쳐보기 조율 중이다.';
comment on column public.party_runs.week_key is
  'KST 목 00:00 경계 주차 키(생성 컬럼). scheduled_at 이 없으면 created_at 기준.';

-- `!일정` / 주간 보드: 파티 × 주차 × 시간순
create index if not exists party_runs_party_week_idx
  on public.party_runs (party_id, week_key, scheduled_at);

-- 다가오는 일정(리마인더 아웃박스 적재, 상단 하이라이트)
create index if not exists party_runs_upcoming_idx
  on public.party_runs (scheduled_at)
  where status in ('proposed', 'confirmed') and cancelled_at is null;

create index if not exists party_runs_boss_idx
  on public.party_runs (boss_difficulty_id, scheduled_at);

drop trigger if exists party_runs_set_updated_at on public.party_runs;
create trigger party_runs_set_updated_at
  before update on public.party_runs
  for each row execute function public.set_updated_at();

-- ⚠️ 파티 인원 상한을 **DB 에서 강제하지 않는다** (CLAUDE.md §1.3 D5).
-- boss_difficulties.max_party 의 6인 값 대부분이 보스별 1차 출처가 아니라 세대 규칙에서
-- 유도한 값이다. 실제 파티가 그 값을 넘는데 등록이 막히면 사용자는 앱을 못 쓴다.
-- → 애플리케이션이 `boss_difficulties.max_party`(또는 v_boss_catalog)와 비교해 **경고**만 띄운다.
-- 이전 버전에 있던 강제 트리거는 제거한다(재실행 시 잔재 정리 포함).
drop trigger if exists party_runs_validate_party_size on public.party_runs;
drop function if exists public.party_runs_validate_party_size();

-- -----------------------------------------------------------------------------
-- run_signups — 런별 참여 의사
-- -----------------------------------------------------------------------------
create table if not exists public.run_signups (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.party_runs(id) on delete cascade,
  participant_id uuid not null references public.party_participants(id) on delete cascade,

  status         public.signup_status not null default 'going',
  character_id   uuid references public.characters(id) on delete set null,
  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint run_signups_uniq unique (run_id, participant_id)
);

comment on table public.run_signups is
  '보스 런별 참여 의사. going/maybe/declined 는 봇의 "참가 5/6 · 미정 1" 표기와 1:1 대응한다.';

-- 정원 카운트(참가/미정)를 인덱스만으로 끝내기 위한 커버링 인덱스.
create index if not exists run_signups_run_status_idx
  on public.run_signups (run_id, status);

create index if not exists run_signups_participant_idx
  on public.run_signups (participant_id);

drop trigger if exists run_signups_set_updated_at on public.run_signups;
create trigger run_signups_set_updated_at
  before update on public.run_signups
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- availability_slots — 가용 시간 격자 (겹쳐보기의 원천)
-- -----------------------------------------------------------------------------
-- 30분 단위 이산 슬롯. 범위(tstzrange)+GiST 대신 이산 슬롯을 쓰는 이유:
--   겹쳐보기는 결국 "각 칸에 몇 명"을 세는 일이다. 이산 슬롯이면
--   `group by slot_start` 한 번으로 끝나고 일반 B-tree 인덱스로 충분하다.
--   범위형은 겹침 계산에 구간 분할이 필요해 훨씬 비싸다.
--
-- party_id 는 party_participants 에서 비정규화한 값이며, 복합 FK 로 정합성을 강제한다.
-- (겹쳐보기 쿼리가 참가자 테이블을 조인하지 않고 바로 집계할 수 있게 하기 위함)
create table if not exists public.availability_slots (
  id             uuid primary key default gen_random_uuid(),
  party_id       uuid not null,
  participant_id uuid not null,

  slot_start     timestamptz not null,

  week_key       text generated always as (public.week_key(slot_start)) stored,

  created_at     timestamptz not null default now(),

  constraint availability_slots_uniq unique (participant_id, slot_start),

  -- 30분 격자 정렬 강제. mod(numeric, numeric) 은 IMMUTABLE 이라 CHECK 에 쓸 수 있다.
  constraint availability_slots_aligned check (
    mod(extract(epoch from (slot_start - to_timestamp(0))), 1800) = 0
  ),

  constraint availability_slots_participant_fk
    foreign key (participant_id, party_id)
    references public.party_participants (id, party_id)
    on delete cascade
);

comment on table public.availability_slots is
  '참가자별 30분 단위 가용 시간. "겹쳐보기" 시간표의 원천 데이터.';
comment on column public.availability_slots.party_id is
  'party_participants 에서 비정규화. 복합 FK 로 정합성을 강제하며, 겹쳐보기 집계가 조인 없이 끝나게 한다.';

-- 겹쳐보기 핵심 인덱스: 파티 × 주차 × 슬롯
create index if not exists availability_slots_overlay_idx
  on public.availability_slots (party_id, week_key, slot_start);

create index if not exists availability_slots_participant_idx
  on public.availability_slots (participant_id, slot_start);

-- ============================================================
-- 20260817090400_crystal_and_chores.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 04. 결정석 클리어 원장 / 넥슨 스케줄러 스냅샷 / 주간 숙제
-- =============================================================================
-- 요구사항: "보스 클리어 시 결정석은 무조건 드랍. 등록해두고 완료 처리하면
--            **그 주의 수익으로 자동 합산**."
--
-- research-BOSS-DATA.md 에서 확정된 수익 규칙 3가지를 스키마가 강제한다.
--
--  R1. **파티 인원 1/n 분할.** 마스터 표의 가격은 전부 솔로(1인) 기준이다.
--      개인수령액 = floor(기본가 / 입장 시점 파티 인원).
--      → `party_size` 를 저장하지 않으면 수익이 최대 6배 과대 계상된다. 그래서 not null 이다.
--      → 파티 상한은 보스마다 다르다(구세대 6 / 신세대 3 / **익스트림 스우 2**). 트리거가 검증한다.
--
--  R2. **주간 결정은 캐릭터당 주 12개.** 12개는 `(주간)` 결정 전용 카운터이며
--      일간·월간 결정은 포함되지 않는다.
--      2025-08-21 패치로 13번째 주간 보스는 **입장 자체가 차단**되므로 정상 플레이에서는
--      12개를 넘지 않는다. → 집계는 **단순 합계**로 하고, 상위 12개 절삭은 뷰에 남기는
--      **방어 로직**일 뿐이다. 판매 순서 추적이나 재계산 캐시 테이블은 만들지 않는다.
--
--  R3. **가격 소급 변경 금지.** 클리어 시점의 기본가·파티 인원·개인수령액을 행에 복사해 둔다.
--      가격표가 패치로 바뀌어도(2026-06-18에 실제로 52건 조정) 과거 금액은 1메소도 안 움직인다.
--
-- 그리고 `cycle` 은 불변이 아니다(2026-06-18 하드 힐라·카오스 핑크빈·노멀 시그너스가
-- 주간→일간 원복). 12개 카운터 대상이 바뀌므로 **클리어 시점 cycle 도 스냅샷**한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- boss_clears — 주차별 보스 클리어 원장 (결정석 수익의 유일한 근거)
-- -----------------------------------------------------------------------------
-- 한 행 = (사용자, 캐릭터, 보스 엔트리, 주차) 하나.
-- 등록만 하고 아직 안 깬 상태도 행으로 존재한다(effective_cleared = false).
create table if not exists public.boss_clears (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.app_users(id) on delete cascade,

  -- 12개 한도는 **캐릭터 단위**다. 캐릭터를 지정하지 않고 계정 단위로만 쓰는 사용자를 위해
  -- nullable 이며, 그 경우 null 캐릭터끼리 하나의 버킷으로 묶여 집계된다.
  character_id       uuid references public.characters(id) on delete set null,
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete restrict,

  run_id             uuid references public.party_runs(id) on delete set null,

  -- 주간 집계 버킷(목 00:00 KST). 트리거가 관리한다.
  week_key           text not null default public.week_key(now())
                       check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),

  -- ── 출처별 상태 (지우지 않고 둘 다 보존한다) ─────────────────────────────
  manual_cleared     boolean,
  manual_set_at      timestamptz,
  -- 넥슨 complete_flag 와 그 데이터의 **기준 시각**(호출 시각이 아니다. 데이터가 평균 15분 지연).
  api_cleared        boolean,
  api_observed_at    timestamptz,

  -- ── 파생 상태 (트리거가 계산) ────────────────────────────────────────────
  effective_cleared  boolean not null default false,
  has_conflict       boolean not null default false,
  cleared_at         timestamptz,

  -- ── 금액 스냅샷 (R1 + R3) ────────────────────────────────────────────────
  -- 입장 시점 실제 파티 인원. 1 = 솔로. 결정석은 정확히 이 값으로 나뉜다.
  -- 기본값은 앱에 등록된 참가자 수이고 **사용자가 고칠 수 있다**(CLAUDE.md §1.3 D3).
  -- 보스별 max_party 는 소프트 상한이라 여기서 막지 않는다. 넉넉한 정상성 범위만 둔다
  -- (0 이나 터무니없는 값으로 나누면 금액이 무의미해지므로 그것만 막는다).
  party_size         integer not null default 1 check (party_size between 1 and 24),

  -- 클리어 시점 초기화 주기 스냅샷. 주간 12개 카운터 대상 판별에 쓴다.
  cycle              public.boss_cycle,

  -- 클리어 시점 캐릭터의 월드 스냅샷. **월드당 주 90개 한도 집계용**(CLAUDE.md §1.3 D2).
  -- 캐릭터가 삭제(character_id → null)돼도 월드 집계가 살아남도록 비정규화한다.
  world_name         text,

  -- 클리어 시점 솔로 기준 기본가. **null 은 0 이 아니라 "미확인"이다.**
  base_price_meso    bigint check (base_price_meso is null or base_price_meso >= 0),

  -- 실제 개인수령액 = floor(base_price_meso / party_size). 집계는 오직 이 값만 더한다.
  crystal_share_meso bigint check (crystal_share_meso is null or crystal_share_meso >= 0),

  -- 사용자가 직접 입력한 기본가. 마스터 가격이 미확인일 때의 탈출구이며 마스터보다 우선한다.
  manual_base_price_meso bigint check (manual_base_price_meso is null or manual_base_price_meso >= 0),

  crystal_price_id   uuid references public.boss_crystal_prices(id) on delete set null,
  -- 스냅샷을 이미 찍었는지. base_price_meso 가 정당하게 null 일 수 있어 별도 컬럼이 필요하다.
  price_snapshotted_at timestamptz,

  source             public.clear_source not null default 'manual',
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 같은 주에 같은 캐릭터로 같은 보스를 두 번 기록할 수 없다.
  -- character_id 가 null 인 행끼리도 중복이면 안 되므로 NULLS NOT DISTINCT (PG15+).
  constraint boss_clears_week_uniq
    unique nulls not distinct (user_id, character_id, boss_difficulty_id, week_key),

  -- 버킷과 클리어 시각이 어긋나지 않게 강제한다. week_key() 가 IMMUTABLE 이라 CHECK 에 쓸 수 있다.
  constraint boss_clears_week_key_matches_cleared_at check (
    cleared_at is null or week_key = public.week_key(cleared_at)
  ),

  -- 클리어된 행은 반드시 스냅샷 시각과 주기를 갖는다(금액은 미확인일 수 있다).
  constraint boss_clears_cleared_needs_snapshot check (
    effective_cleared = false
    or (cleared_at is not null and price_snapshotted_at is not null and cycle is not null)
  ),

  -- 1/n 분할이 실제로 지켜졌는지 DB 가 직접 검증한다.
  -- bigint / integer 는 0 방향 절삭이고 base_price_meso >= 0 이므로 floor 와 같다.
  constraint boss_clears_share_is_floor_division check (
    crystal_share_meso is null
    or (base_price_meso is not null and crystal_share_meso = base_price_meso / party_size)
  ),

  -- 금액이 있는데 기본가가 없거나 그 반대인 상태를 막는다.
  constraint boss_clears_price_pair check (
    (base_price_meso is null) = (crystal_share_meso is null)
  )
);

comment on table public.boss_clears is
  '주차별 보스 클리어 원장. 결정석 수익의 유일한 근거이며, 클리어 시점의 기본가·파티 인원·개인수령액·주기를 스냅샷해 소급 변경을 막는다.';
comment on column public.boss_clears.party_size is
  '입장 시점 파티 인원. 결정석은 정확히 1/n 로 나뉘고 소수점은 버린다. 저장하지 않으면 수익이 최대 6배 틀어진다.';
comment on column public.boss_clears.crystal_share_meso is
  '개인수령액 = floor(base_price_meso / party_size). 주간 수익 집계는 이 값만 더한다. null = 가격 미확인.';
comment on column public.boss_clears.base_price_meso is
  '클리어 시점 솔로 기준 기본가 스냅샷. null 은 0 이 아니라 "미확인"이며 집계에서 제외되고 별도로 카운트된다.';
comment on column public.boss_clears.cycle is
  '클리어 시점 초기화 주기 스냅샷. 패치로 주기가 바뀌어도(2026-06-18 실제 발생) 과거 기록의 12개 카운터 대상 여부가 흔들리지 않는다.';
comment on column public.boss_clears.has_conflict is
  '수동 체크와 넥슨 complete_flag 가 서로 다름. 값을 덮어쓰지 않고 UI 에 배지로 노출한다.';

-- 상태 판정 · 파티 인원 검증 · 금액 스냅샷 · 주차 버킷을 한 번에 처리하는 BEFORE 트리거.
--
-- 생성 컬럼(GENERATED)을 쓰지 않은 이유: 생성 컬럼은 BEFORE 트리거보다 **나중에** 계산되므로
-- 같은 패스에서 그 값을 보고 금액을 스냅샷할 수 없다.
create or replace function public.boss_clears_apply_state()
returns trigger
language plpgsql
as $func$
declare
  v_winner    text;
  v_cycle     public.boss_cycle;
  v_price_id  uuid;
  v_base      bigint;
begin
  -- 0) 보스 엔트리의 주기를 읽어 둔다 -------------------------------------------
  --    ⚠️ max_party 는 **검증하지 않는다** (CLAUDE.md §1.3 D5: 소프트 상한).
  --       상한 초과는 애플리케이션이 경고로 처리하며 DB 는 등록을 막지 않는다.
  select bd.cycle
    into v_cycle
    from public.boss_difficulties bd
   where bd.id = new.boss_difficulty_id;

  if not found then
    raise exception '알 수 없는 보스 엔트리입니다: %', new.boss_difficulty_id
      using errcode = 'foreign_key_violation';
  end if;

  -- 0 으로 나누는 사고 방지.
  -- CHECK 제약은 BEFORE 트리거보다 **나중에** 평가되므로, 여기서 먼저 막지 않으면
  -- 아래 나눗셈에서 'division by zero' 라는 알아보기 힘든 오류가 먼저 튀어나온다.
  if new.party_size is null or new.party_size < 1 then
    raise exception '파티 인원(party_size)은 1 이상이어야 합니다 (입력: %).', new.party_size
      using errcode = 'check_violation';
  end if;

  -- 월드 스냅샷 (90개 한도 집계용). 한 번 찍히면 유지한다.
  if new.world_name is null and new.character_id is not null then
    select ch.world_name into new.world_name
      from public.characters ch
     where ch.id = new.character_id;
  end if;

  -- 1) 승자 판정 ---------------------------------------------------------------
  --    규칙: 관측 시각이 더 최신인 쪽이 이긴다. 동률이면 사람(수동)이 이긴다.
  --    넥슨 데이터는 평균 15분 지연되므로 비교 기준을 "호출 시각"이 아니라
  --    "응답이 말하는 기준 시각(api_observed_at)"으로 잡는다.
  if new.manual_cleared is null and new.api_cleared is null then
    v_winner := 'none';
  elsif new.manual_cleared is null then
    v_winner := 'api';
  elsif new.api_cleared is null then
    v_winner := 'manual';
  elsif coalesce(new.manual_set_at, '-infinity'::timestamptz)
        >= coalesce(new.api_observed_at, '-infinity'::timestamptz) then
    v_winner := 'manual';
  else
    v_winner := 'api';
  end if;

  new.effective_cleared := case v_winner
    when 'manual' then coalesce(new.manual_cleared, false)
    when 'api'    then coalesce(new.api_cleared, false)
    else false
  end;

  -- 2) 충돌 보존 ---------------------------------------------------------------
  new.has_conflict := (
    new.manual_cleared is not null
    and new.api_cleared is not null
    and new.manual_cleared is distinct from new.api_cleared
  );

  -- 3) 클리어 시각 / 금액 스냅샷 -----------------------------------------------
  if new.effective_cleared then
    if new.cleared_at is null then
      new.cleared_at := coalesce(
        case v_winner when 'manual' then new.manual_set_at else new.api_observed_at end,
        now()
      );
    end if;

    -- 이미 스냅샷을 찍었으면 절대 다시 계산하지 않는다(R3: 소급 변경 금지).
    if new.price_snapshotted_at is null then
      new.cycle := v_cycle;

      if new.manual_base_price_meso is not null then
        -- 사용자가 직접 입력한 값이 마스터보다 우선한다.
        v_base     := new.manual_base_price_meso;
        v_price_id := null;
      else
        select cp.price_id, cp.price_meso
          into v_price_id, v_base
          from public.current_crystal_price(new.boss_difficulty_id, new.cleared_at) cp;
      end if;

      new.crystal_price_id := v_price_id;
      new.base_price_meso  := v_base;

      -- 가격 미확인(v_base is null)이면 금액도 null 로 둔다. **0 으로 채우지 않는다.**
      -- 0 은 "0메소를 벌었다"는 사실 주장이지만 실제로는 "모른다"이기 때문이다.
      -- 집계 뷰는 이런 행을 합계에서 제외하고 unknown_price_count 로 따로 보고한다.
      new.crystal_share_meso := case
        when v_base is null then null
        else v_base / new.party_size   -- bigint / int = 절삭 나눗셈 = floor (음수 없음)
      end;

      new.price_snapshotted_at := now();
    end if;
  else
    -- 클리어가 취소되면 스냅샷을 비워, 다시 깼을 때 그 시점 기준으로 다시 찍히게 한다.
    new.cleared_at           := null;
    new.crystal_price_id     := null;
    new.base_price_meso      := null;
    new.crystal_share_meso   := null;
    new.price_snapshotted_at := null;
    new.cycle                := v_cycle;
  end if;

  -- 4) 주차 버킷 ---------------------------------------------------------------
  if new.cleared_at is not null then
    new.week_key := public.week_key(new.cleared_at);
  else
    new.week_key := coalesce(
      nullif(new.week_key, ''),
      public.week_key(coalesce(new.created_at, now()))
    );
  end if;

  return new;
end;
$func$;

comment on function public.boss_clears_apply_state() is
  'boss_clears 의 유효 클리어 상태·충돌 플래그·파티 인원 검증·1/n 금액 스냅샷·주차 버킷을 한 번에 확정한다.';

drop trigger if exists boss_clears_apply_state on public.boss_clears;
create trigger boss_clears_apply_state
  before insert or update on public.boss_clears
  for each row execute function public.boss_clears_apply_state();

drop trigger if exists boss_clears_set_updated_at on public.boss_clears;
create trigger boss_clears_set_updated_at
  before update on public.boss_clears
  for each row execute function public.set_updated_at();

-- 주간 수익 집계 커버링 인덱스.
-- 집계 단위가 (사용자 → 캐릭터 → 주차)이므로 선두 컬럼을 그 순서로 잡는다.
create index if not exists boss_clears_income_idx
  on public.boss_clears (user_id, week_key, character_id)
  include (crystal_share_meso, cycle)
  where effective_cleared;

-- 12개 한도는 캐릭터 단위다. 캐릭터 기준 조회 전용 인덱스.
create index if not exists boss_clears_character_week_idx
  on public.boss_clears (character_id, week_key)
  where effective_cleared and character_id is not null;

-- **월드당 주 90개 한도 집계**(CLAUDE.md §1.3 D2).
-- 일간 보스 24종 × 7일 = 주 최대 168개라 캐릭터 하나로도 90을 넘길 수 있는 실제 병목이다.
-- 차단하지는 않지만 경고하려면 (월드, 주차) 로 셀 수 있어야 한다.
create index if not exists boss_clears_world_week_idx
  on public.boss_clears (world_name, week_key)
  where effective_cleared and world_name is not null;

-- 미클리어(= 이번 주 미수령) 목록. 봇 `!결정석` 이 탄다.
create index if not exists boss_clears_pending_idx
  on public.boss_clears (user_id, week_key)
  where effective_cleared = false;

create index if not exists boss_clears_conflict_idx
  on public.boss_clears (user_id, week_key)
  where has_conflict;

create index if not exists boss_clears_run_idx
  on public.boss_clears (run_id)
  where run_id is not null;

-- -----------------------------------------------------------------------------
-- character_scheduler_snapshots — 넥슨 스케줄러 응답 미러
-- -----------------------------------------------------------------------------
-- complete_flag 는 현재 상태만 준다. 주차별 이력은 우리가 남겨야 한다.
--
-- ⚠️ 약관 제5조 ⑤ 및 "크롤링 데이터 30일 이내 갱신 의무" 때문에 30일 초과분은
--    주기적으로 파기해야 한다. 보존 정책은 배치 작업으로 강제한다.
create table if not exists public.character_scheduler_snapshots (
  id           uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id) on delete cascade,

  -- 넥슨 응답의 `date` 값(예: "2026-08-17T00:00+09:00").
  -- 오프셋이 포함된 절대 시각이므로 timestamptz 로 저장한다(로컬 타임 컬럼 아님).
  snapshot_at  timestamptz not null,
  fetched_at   timestamptz not null default now(),

  weekly_boss_clear_count       integer check (weekly_boss_clear_count >= 0),
  -- research-BOSS-DATA.md R7: 이 값은 **12**로 예상된다(캐릭터당 주간 보스 입장 12회).
  -- 실호출 검증 전까지 값 자체를 신뢰하되 12 가정을 코드에 박지는 않는다.
  weekly_boss_clear_limit_count integer check (weekly_boss_clear_limit_count >= 0),

  -- boss_contents[] / daily_contents[] / weekly_contents[] 원문.
  payload      jsonb not null default '{}'::jsonb,
  -- 응답이 비어 있으면 그날 미접속이다. **오류가 아니라 빈 상태**로 취급한다.
  is_empty     boolean not null default false,

  week_key     text generated always as (public.week_key(snapshot_at)) stored,
  day_key      text generated always as (public.day_key(snapshot_at)) stored,

  constraint character_scheduler_snapshots_uniq unique (character_id, snapshot_at)
);

comment on table public.character_scheduler_snapshots is
  '넥슨 스케줄러 API 응답 미러. complete_flag 동기화 근거이자 주차별 이력. 약관상 30일 이내 갱신/파기 대상.';
comment on column public.character_scheduler_snapshots.weekly_boss_clear_limit_count is
  '넥슨이 주는 주간 보스 입장 한도. 12 로 확정적으로 예상되며 주간 12개 결정 카운터의 상한과 일치한다.';

create index if not exists character_scheduler_snapshots_recent_idx
  on public.character_scheduler_snapshots (character_id, snapshot_at desc);

create index if not exists character_scheduler_snapshots_week_idx
  on public.character_scheduler_snapshots (character_id, week_key);

create index if not exists character_scheduler_snapshots_fetched_idx
  on public.character_scheduler_snapshots (fetched_at);

-- -----------------------------------------------------------------------------
-- chore_definitions — 일간/주간 숙제 마스터
-- -----------------------------------------------------------------------------
-- ⚠️ 시드 없음. 넥슨 daily_contents / weekly_contents 의 content_name 목록은
--    실호출로 수집해야 하는 미확인 항목이다.
create table if not exists public.chore_definitions (
  id                 uuid primary key default gen_random_uuid(),
  scope              public.chore_scope not null,

  slug               text not null unique check (slug ~ '^[a-z0-9][a-z0-9_-]{0,49}$'),
  name               text not null,
  nexon_content_name text,

  sort_order         integer not null default 1000,
  is_active          boolean not null default true,
  is_builtin         boolean not null default true,

  owner_user_id      uuid references public.app_users(id) on delete cascade,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint chore_definitions_id_scope_uniq unique (id, scope),
  constraint chore_definitions_builtin_has_no_owner check (
    is_builtin = false or owner_user_id is null
  )
);

comment on table public.chore_definitions is
  '일간/주간 숙제 마스터. 시드는 넥슨 실호출로 content_name 을 수집한 뒤 투입한다.';

create index if not exists chore_definitions_scope_idx
  on public.chore_definitions (scope, sort_order)
  where is_active;

create index if not exists chore_definitions_owner_idx
  on public.chore_definitions (owner_user_id)
  where owner_user_id is not null;

drop trigger if exists chore_definitions_set_updated_at on public.chore_definitions;
create trigger chore_definitions_set_updated_at
  before update on public.chore_definitions
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- chore_completions — 숙제 수행 기록
-- -----------------------------------------------------------------------------
-- boss_clears 와 동일한 수동/API 충돌 규칙을 적용한다(금액 개념은 없다).
create table if not exists public.chore_completions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.app_users(id) on delete cascade,
  character_id         uuid references public.characters(id) on delete set null,
  chore_definition_id  uuid not null,

  -- 정의의 scope 를 비정규화한다. 부분 유니크 인덱스를 scope 별로 나누기 위해 필요하며
  -- 복합 FK 로 정의와 어긋나지 않게 강제한다.
  scope                public.chore_scope not null,

  manual_done          boolean,
  manual_set_at        timestamptz,
  api_done             boolean,
  api_observed_at      timestamptz,

  effective_done       boolean not null default false,
  has_conflict         boolean not null default false,
  completed_at         timestamptz,

  now_count            integer check (now_count >= 0),
  max_count            integer check (max_count >= 0),

  week_key             text not null default public.week_key(now())
                         check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  day_key              text not null default public.day_key(now())
                         check (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),

  source               public.clear_source not null default 'manual',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint chore_completions_definition_fk
    foreign key (chore_definition_id, scope)
    references public.chore_definitions (id, scope)
    on delete cascade
);

comment on table public.chore_completions is
  '일간/주간 숙제 수행 기록. boss_clears 와 동일한 수동 vs 넥슨 API 충돌 규칙을 쓴다.';

create or replace function public.chore_completions_apply_state()
returns trigger
language plpgsql
as $func$
declare
  v_winner text;
begin
  if new.manual_done is null and new.api_done is null then
    v_winner := 'none';
  elsif new.manual_done is null then
    v_winner := 'api';
  elsif new.api_done is null then
    v_winner := 'manual';
  elsif coalesce(new.manual_set_at, '-infinity'::timestamptz)
        >= coalesce(new.api_observed_at, '-infinity'::timestamptz) then
    v_winner := 'manual';
  else
    v_winner := 'api';
  end if;

  new.effective_done := case v_winner
    when 'manual' then coalesce(new.manual_done, false)
    when 'api'    then coalesce(new.api_done, false)
    else false
  end;

  new.has_conflict := (
    new.manual_done is not null
    and new.api_done is not null
    and new.manual_done is distinct from new.api_done
  );

  if new.effective_done then
    if new.completed_at is null then
      new.completed_at := coalesce(
        case v_winner when 'manual' then new.manual_set_at else new.api_observed_at end,
        now()
      );
    end if;
    new.week_key := public.week_key(new.completed_at);
    new.day_key  := public.day_key(new.completed_at);
  else
    new.completed_at := null;
    new.week_key := coalesce(nullif(new.week_key, ''), public.week_key(coalesce(new.created_at, now())));
    new.day_key  := coalesce(nullif(new.day_key, ''),  public.day_key(coalesce(new.created_at, now())));
  end if;

  return new;
end;
$func$;

drop trigger if exists chore_completions_apply_state on public.chore_completions;
create trigger chore_completions_apply_state
  before insert or update on public.chore_completions
  for each row execute function public.chore_completions_apply_state();

drop trigger if exists chore_completions_set_updated_at on public.chore_completions;
create trigger chore_completions_set_updated_at
  before update on public.chore_completions
  for each row execute function public.set_updated_at();

-- 주간 숙제는 주차당 1행, 일간 숙제는 일자당 1행.
create unique index if not exists chore_completions_weekly_uniq
  on public.chore_completions (user_id, character_id, chore_definition_id, week_key)
  nulls not distinct
  where scope = 'weekly';

create unique index if not exists chore_completions_daily_uniq
  on public.chore_completions (user_id, character_id, chore_definition_id, day_key)
  nulls not distinct
  where scope = 'daily';

create index if not exists chore_completions_user_week_idx
  on public.chore_completions (user_id, week_key)
  where scope = 'weekly';

create index if not exists chore_completions_user_day_idx
  on public.chore_completions (user_id, day_key)
  where scope = 'daily';

-- ============================================================
-- 20260817090500_social_and_invites.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 05. 친구 / 초대 링크 / 임시 참가자 승계(claim)
-- =============================================================================
-- 발주자 요구사항 원문:
--   "초대는 메일이 아니라 링크. 초대 링크로 들어와 이름을 적으면 그 사람에게도
--    바로 적용되는 임시 테이블이 필요하다."
--   → 아직 넥슨 키로 가입하지 않은 사람도 **이름만으로 파티 자리를 차지하고 일정에 나타나야**
--     하며, 나중에 정식 가입하면 그 임시 레코드가 실제 계정으로 **승계(claim)** 되어야 한다.
--
-- 승계 경로:
--   invite_links(토큰) → 이름 입력 → guest_profiles + party_participants(guest_id)
--   → 정식 가입(넥슨 키) → claim_guest_profile() → party_participants 가 user_id 로 전환
--   → 그 사람의 가용시간·참여의사·런 생성 이력이 전부 계정에 따라온다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- friendships — 친구 관계
-- -----------------------------------------------------------------------------
-- 두 사용자 사이에는 방향과 무관하게 **행이 하나만** 존재한다.
-- (A→B pending 과 B→A pending 이 동시에 생기면 수락 로직이 애매해진다)
create table if not exists public.friendships (
  id                 uuid primary key default gen_random_uuid(),
  requester_user_id  uuid not null references public.app_users(id) on delete cascade,
  addressee_user_id  uuid not null references public.app_users(id) on delete cascade,

  status             public.friendship_status not null default 'pending',

  -- 차단은 방향이 있다. 누가 차단했는지 남긴다.
  blocked_by_user_id uuid references public.app_users(id) on delete cascade,

  created_at         timestamptz not null default now(),
  responded_at       timestamptz,

  constraint friendships_not_self check (requester_user_id <> addressee_user_id),
  constraint friendships_blocked_has_actor check (
    (status = 'blocked') = (blocked_by_user_id is not null)
  )
);

comment on table public.friendships is
  '친구 관계. 두 사용자 쌍당 행 하나(방향 무관)만 존재한다.';

-- least/greatest 는 uuid 에 대해 IMMUTABLE 이므로 표현식 유니크 인덱스에 쓸 수 있다.
create unique index if not exists friendships_pair_uniq
  on public.friendships (
    least(requester_user_id, addressee_user_id),
    greatest(requester_user_id, addressee_user_id)
  );

-- 친구 목록 조회는 양방향이므로 두 방향 모두 인덱스가 필요하다.
create index if not exists friendships_requester_idx
  on public.friendships (requester_user_id, status);

create index if not exists friendships_addressee_idx
  on public.friendships (addressee_user_id, status);

-- -----------------------------------------------------------------------------
-- invite_links — 파티 초대 링크 (메일 아님, 링크)
-- -----------------------------------------------------------------------------
-- 토큰 원문은 저장하지 않는다. 발급 시 1회만 노출하고 서버는 SHA-256 해시만 보관한다
-- (CLAUDE.md §2.1 의 API 키 원칙과 같은 기조).
create table if not exists public.invite_links (
  id                 uuid primary key default gen_random_uuid(),
  party_id           uuid not null references public.parties(id) on delete cascade,

  token_hash         text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  created_by_user_id uuid references public.app_users(id) on delete set null,
  role_on_join       public.party_member_role not null default 'member',

  label              text,
  max_uses           integer check (max_uses is null or max_uses > 0),
  used_count         integer not null default 0 check (used_count >= 0),

  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),

  constraint invite_links_uses_within_max check (
    max_uses is null or used_count <= max_uses
  ),
  -- 링크 자체가 비밀이므로 소유자(owner)로 승격시키는 초대는 만들지 않는다.
  constraint invite_links_no_owner_grant check (role_on_join <> 'owner')
);

comment on table public.invite_links is
  '파티 초대 링크. 토큰 원문은 저장하지 않고 SHA-256 해시만 보관한다. anon/authenticated 전면 차단.';

create index if not exists invite_links_party_idx
  on public.invite_links (party_id)
  where revoked_at is null;

-- -----------------------------------------------------------------------------
-- guest_profiles — 임시 참가자 (넥슨 키 없이 이름만으로 존재하는 사람)
-- -----------------------------------------------------------------------------
create table if not exists public.guest_profiles (
  id                    uuid primary key default gen_random_uuid(),

  display_name          text not null check (length(btrim(display_name)) between 1 and 40),

  created_via_invite_id uuid references public.invite_links(id) on delete set null,

  -- 게스트가 다른 기기에서 돌아오거나 나중에 본인임을 증명할 때 쓰는 토큰의 해시.
  -- 원문은 브라우저(쿠키/localStorage)에만 있고 서버는 해시만 안다.
  -- 승계가 끝나면 null 로 비워 재사용을 막는다.
  claim_token_hash      text unique check (claim_token_hash ~ '^[0-9a-f]{64}$'),

  claimed_by_user_id    uuid references public.app_users(id) on delete set null,
  claimed_at            timestamptz,

  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  expires_at            timestamptz,

  constraint guest_profiles_claim_pair check (
    (claimed_by_user_id is null) = (claimed_at is null)
  )
);

comment on table public.guest_profiles is
  '초대 링크로 이름만 적고 들어온 임시 참가자. 정식 가입 시 claim_guest_profile() 로 계정에 승계된다.';
comment on column public.guest_profiles.claim_token_hash is
  '게스트 재방문/승계 증명 토큰의 SHA-256 해시. 원문은 서버에 없다. 승계 완료 시 null 로 만든다.';

create index if not exists guest_profiles_unclaimed_idx
  on public.guest_profiles (created_at)
  where claimed_by_user_id is null;

create index if not exists guest_profiles_claimed_by_idx
  on public.guest_profiles (claimed_by_user_id)
  where claimed_by_user_id is not null;

-- party_participants.guest_id 의 FK 는 여기서 붙인다(순환 참조 회피).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'party_participants_guest_fk') then
    alter table public.party_participants
      add constraint party_participants_guest_fk
      foreign key (guest_id) references public.guest_profiles(id) on delete cascade;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- invite_redemptions — 초대 링크 사용 이력
-- -----------------------------------------------------------------------------
create table if not exists public.invite_redemptions (
  id             uuid primary key default gen_random_uuid(),
  invite_id      uuid not null references public.invite_links(id) on delete cascade,

  guest_id       uuid references public.guest_profiles(id) on delete set null,
  user_id        uuid references public.app_users(id) on delete set null,
  participant_id uuid references public.party_participants(id) on delete set null,

  -- 남용 추적용. 원문 IP 는 저장하지 않는다.
  ip_hash        text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  redeemed_at    timestamptz not null default now()
);

comment on table public.invite_redemptions is
  '초대 링크 사용 이력. 남용 추적과 max_uses 감사용. anon/authenticated 전면 차단.';

create index if not exists invite_redemptions_invite_idx
  on public.invite_redemptions (invite_id, redeemed_at desc);

create index if not exists invite_redemptions_guest_idx
  on public.invite_redemptions (guest_id)
  where guest_id is not null;

-- -----------------------------------------------------------------------------
-- guest_claims — 승계 감사 로그
-- -----------------------------------------------------------------------------
-- 승계는 "남의 참가 이력을 내 계정으로 가져오는" 보안 민감 동작이다. 흔적을 남긴다.
create table if not exists public.guest_claims (
  id                       uuid primary key default gen_random_uuid(),
  guest_id                 uuid not null references public.guest_profiles(id) on delete cascade,
  user_id                  uuid not null references public.app_users(id) on delete cascade,

  moved_participant_count  integer not null default 0 check (moved_participant_count >= 0),
  merged_participant_count integer not null default 0 check (merged_participant_count >= 0),

  claim_method             text not null default 'claim_token',
  claimed_at               timestamptz not null default now()
);

comment on table public.guest_claims is
  '임시 참가자 → 정식 계정 승계 감사 로그. anon/authenticated 전면 차단.';

create index if not exists guest_claims_user_idx
  on public.guest_claims (user_id, claimed_at desc);

create index if not exists guest_claims_guest_idx
  on public.guest_claims (guest_id);

-- -----------------------------------------------------------------------------
-- claim_guest_profile — 승계 실행 함수
-- -----------------------------------------------------------------------------
-- 여러 테이블을 한 트랜잭션으로 옮겨야 하고, 중간 상태가 노출되면 안 되므로
-- SECURITY DEFINER 함수로 캡슐화한다. 실행 권한은 service_role 에만 준다(마이그레이션 08).
--
-- 병합 규칙:
--   * 같은 파티에 이미 본인 참가자 행이 있으면 → 게스트 행의 가용시간/참여의사를 본인 행으로
--     옮기고(충돌은 본인 것 우선) 게스트 행을 삭제한다. (merged)
--   * 그 외 게스트 행은 그대로 user_id 로 전환한다. (moved)
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

  -- 1) 같은 파티에 본인 행이 이미 있는 경우 → 병합
  for r in
    select gp.id as guest_participant_id,
           up.id as user_participant_id
      from public.party_participants gp
      join public.party_participants up
        on up.party_id = gp.party_id
       and up.user_id = p_user_id
     where gp.guest_id = p_guest_id
  loop
    -- 가용시간: 본인 행에 같은 슬롯이 없을 때만 옮기고, 나머지는 버린다.
    update public.availability_slots a
       set participant_id = r.user_participant_id
     where a.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.availability_slots b
          where b.participant_id = r.user_participant_id
            and b.slot_start = a.slot_start
       );
    delete from public.availability_slots
     where participant_id = r.guest_participant_id;

    -- 참여 의사: 같은 런에 본인 응답이 없을 때만 옮긴다.
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

    -- 게스트가 만든 런의 작성자도 본인 행으로 넘긴다.
    update public.party_runs
       set created_by_participant_id = r.user_participant_id
     where created_by_participant_id = r.guest_participant_id;

    delete from public.party_participants where id = r.guest_participant_id;
    v_merged := v_merged + 1;
  end loop;

  -- 2) 남은 게스트 참가자 행 → 정식 사용자 행으로 전환
  --    이 시점부터 표시명은 계정 표시명을 따라간다(app_users 트리거가 동기화).
  update public.party_participants
     set user_id      = p_user_id,
         guest_id     = null,
         display_name = v_display_name
   where guest_id = p_guest_id;
  get diagnostics v_moved = row_count;

  -- 3) 게스트 프로필 승계 확정. 토큰은 폐기한다.
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

comment on function public.claim_guest_profile(uuid, uuid) is
  '임시 참가자(guest_profiles)를 정식 계정으로 승계한다. 파티 중복 시 병합하며 감사 로그를 남긴다. 실행 권한은 service_role 전용.';

-- ============================================================
-- 20260817090600_bot.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 06. 카카오톡 봇 연동
-- =============================================================================
-- 근거: Claude/research-KAKAO-BOT.md §3.7(최소 스키마), §2.9(연결 흐름),
--       §3.4(인증), §3.6(런너 비종속 금지 목록)
--
-- **런너 비종속 원칙** — 아래 금지 목록을 스키마 차원에서 지킨다.
--   ❌ 카톡 방 이름 / kakao chat_id / openlink_id 를 컬럼으로 저장하지 않는다.
--   ✅ `room` 은 **우리가 발급한 불투명 ID**다. 실제 방과의 매핑은 런너가 자기 로컬에 둔다.
--   ✅ 응답은 평문 문자열 하나(`reply`)가 1급 시민이고, 확장은 무시 가능한 선택 필드다.
--
-- 봇 트래픽은 사용자 세션이 아니라 **채널 시크릿**으로 인증된다. 즉 RLS 로 보호되는 대상이
-- 아니다 → 이 파일의 모든 테이블은 anon/authenticated 를 전면 차단하고,
-- Route Handler 가 HMAC 서명을 검증한 뒤에만 service role 로 접근한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bot_channels — 봇이 들어가 있는 방(채널)
-- -----------------------------------------------------------------------------
create table if not exists public.bot_channels (
  id                  uuid primary key default gen_random_uuid(),

  -- 우리가 발급한 불투명 채널 ID. 런너/API 가 주고받는 `room` 값.
  room                text not null unique check (room ~ '^ch_[A-Za-z0-9]{8,40}$'),

  -- 런너 종류가 아니라 "플랫폼". 텔레그램/디스코드 런너를 붙여도 스키마가 안 바뀐다.
  platform            text not null default 'kakao',

  -- 채널 시크릿은 해시로만 보관한다. 원문은 페어링 응답에서 단 1회만 노출한다.
  secret_hash         text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  secret_rotated_at   timestamptz,
  -- 회전 시 구 시크릿을 24시간 병행 검증한다(research-KAKAO-BOT §3.2).
  previous_secret_hash        text check (previous_secret_hash is null or previous_secret_hash ~ '^[0-9a-f]{64}$'),
  previous_secret_expires_at  timestamptz,

  owner_user_id       uuid references public.app_users(id) on delete set null,
  status              public.bot_channel_status not null default 'active',

  -- HMAC 서명을 쓰는 채널인지. 메신저봇R(Rhino)에서 HMAC 가능 여부가 미확인이라
  -- 서명 미사용 채널을 별도로 표시하고 아웃박스 권한을 제한한다(§3.4).
  signed              boolean not null default true,

  -- 런너가 계산한 방 지문 해시. **방 이름 원문이 아니다.**
  room_fingerprint    text check (room_fingerprint is null or room_fingerprint ~ '^[0-9a-f]{64}$'),
  -- 런너 문자열은 로그·통계 전용이며 분기 로직에 쓰지 않는다(§3.6).
  runner              text,

  signature_failure_count integer not null default 0 check (signature_failure_count >= 0),
  suspended_until     timestamptz,
  last_seen_at        timestamptz,
  last_polled_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint bot_channels_prev_secret_pair check (
    (previous_secret_hash is null) = (previous_secret_expires_at is null)
  )
);

comment on table public.bot_channels is
  '봇 채널. room 은 우리가 발급한 불투명 ID이며 카톡 방 이름/chat_id 는 저장하지 않는다. 시크릿은 해시만 보관.';
comment on column public.bot_channels.signed is
  'HMAC 서명 사용 여부. false 인 채널은 아웃박스(선제 발송) 권한을 제한한다.';

create index if not exists bot_channels_active_idx
  on public.bot_channels (last_seen_at desc)
  where status = 'active';

create index if not exists bot_channels_owner_idx
  on public.bot_channels (owner_user_id)
  where owner_user_id is not null;

drop trigger if exists bot_channels_set_updated_at on public.bot_channels;
create trigger bot_channels_set_updated_at
  before update on public.bot_channels
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- bot_channel_members — 방 발신자 ↔ 앱 계정 매핑
-- -----------------------------------------------------------------------------
-- 방에서 얻을 수 있는 발신자 정보는 닉네임뿐이고, 닉네임은 언제든 바뀌며 중복될 수 있다.
-- 따라서 **닉네임을 키로 쓰지 않는다.** `!연결 <코드>` 로 맺어진 sender_id ↔ user_id
-- 매핑만이 신원의 근거다(research-KAKAO-BOT §2.9).
create table if not exists public.bot_channel_members (
  id           uuid primary key default gen_random_uuid(),
  channel_id   uuid not null references public.bot_channels(id) on delete cascade,

  -- 런너가 고른 안정적 발신자 식별자(불투명). **서버는 이 값의 의미를 해석하지 않는다.**
  sender_id    text not null,

  user_id      uuid not null references public.app_users(id) on delete cascade,

  -- 표시용 닉네임 스냅샷. 식별에 쓰지 않는다.
  display_name text,

  linked_at    timestamptz not null default now(),
  last_seen_at timestamptz,

  constraint bot_channel_members_uniq unique (channel_id, sender_id)
);

comment on table public.bot_channel_members is
  '봇 채널 발신자 ↔ 앱 계정 매핑. sender_id 는 런너가 정한 불투명 값이며 서버는 해석하지 않는다.';
comment on column public.bot_channel_members.display_name is
  '표시용 닉네임 스냅샷. 가변이라 식별자로 쓰지 않는다.';

create index if not exists bot_channel_members_user_idx
  on public.bot_channel_members (user_id);

-- -----------------------------------------------------------------------------
-- bot_link_codes — 6자리 연결/페어링 코드
-- -----------------------------------------------------------------------------
-- channel_pair : 방 최초 페어링 (§3.2)
-- member_link  : 개인 계정 연결 `!연결 <코드>` (§2.9)
-- 코드 원문은 저장하지 않고 해시만 둔다. TTL 10분, 5회 오입력 시 폐기.
create table if not exists public.bot_link_codes (
  id              uuid primary key default gen_random_uuid(),
  kind            public.bot_link_code_kind not null,

  code_hash       text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),

  user_id         uuid references public.app_users(id) on delete cascade,
  channel_id      uuid references public.bot_channels(id) on delete cascade,

  attempt_count   integer not null default 0 check (attempt_count >= 0),
  max_attempts    integer not null default 5 check (max_attempts > 0),

  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  consumed_by_channel_id uuid references public.bot_channels(id) on delete set null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),

  -- 개인 연결 코드는 반드시 발급한 사용자가 있어야 한다.
  constraint bot_link_codes_member_needs_user check (
    kind <> 'member_link' or user_id is not null
  )
);

comment on table public.bot_link_codes is
  '봇 페어링/계정 연결용 6자리 코드. 원문은 저장하지 않고 SHA-256 해시만 보관한다. TTL 10분.';

create index if not exists bot_link_codes_user_idx
  on public.bot_link_codes (user_id, kind)
  where consumed_at is null and revoked_at is null;

create index if not exists bot_link_codes_expiry_idx
  on public.bot_link_codes (expires_at)
  where consumed_at is null;

-- -----------------------------------------------------------------------------
-- bot_outbox — 선제 알림 큐 (런너가 폴링해 가져간다)
-- -----------------------------------------------------------------------------
-- 봇 런너는 가정용 폰이거나 NAT 뒤 컨테이너라 서버가 부를 수 없다. 런너가 가져간다.
-- 중복 발송 3중 방어: (1) dedupe_key 유니크, (2) id 멱등 ack, (3) visible_after 리스.
create table if not exists public.bot_outbox (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references public.bot_channels(id) on delete cascade,

  -- 규약: {목적}:{엔티티ID}:{시점}  예) boss_remind:sch_9931:T-30
  -- 주차 표기는 반드시 KST 목 00:00 경계(week_key)를 쓴다. ISO 주차를 쓰면 수·목 알림이
  -- 두 주에 걸쳐 중복 생성된다.
  dedupe_key     text not null,

  -- 카카오톡 평문 문자열 하나. 마크다운/HTML 금지, 350자·12줄 예산.
  reply          text not null check (length(reply) between 1 and 2000),
  -- 여러 말풍선으로 나눌 때의 선택 필드. 미지원 런너는 무시해도 동작한다.
  extra          text[],

  state          public.bot_outbox_state not null default 'pending',

  -- 리스: 응답 시 now()+60s 로 밀어 두 런너가 같은 건을 집어가지 못하게 한다.
  visible_after  timestamptz not null default now(),
  -- 지난 알림은 가치가 음수다. 반드시 만료시킨다(리마인더 15분, 주간 요약 6시간).
  expires_at     timestamptz not null,

  attempts       integer not null default 0 check (attempts >= 0),
  max_attempts   integer not null default 5 check (max_attempts > 0),
  last_error     text,
  delivered_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint bot_outbox_dedupe_uniq unique (channel_id, dedupe_key)
);

comment on table public.bot_outbox is
  '봇 선제 알림 큐. 런너가 폴링해 가져가고 ack 한다. dedupe_key + 리스 + 멱등 ack 로 중복 발송을 막는다.';
comment on column public.bot_outbox.expires_at is
  '만료 시각. "30분 전 알림"이 보스 시간이 지나 도착하면 가치가 음수이므로 반드시 파기한다.';

-- 폴링 핵심 인덱스: 채널 × 가시성 × 만료
create index if not exists bot_outbox_pickup_idx
  on public.bot_outbox (channel_id, visible_after)
  where state in ('pending', 'delivering');

create index if not exists bot_outbox_expiry_idx
  on public.bot_outbox (expires_at)
  where state in ('pending', 'delivering');

drop trigger if exists bot_outbox_set_updated_at on public.bot_outbox;
create trigger bot_outbox_set_updated_at
  before update on public.bot_outbox
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- bot_command_log — 명령 감사 + 리플레이 방지
-- -----------------------------------------------------------------------------
-- ⚠️ 프라이버시(§R5): **`!` 로 시작하는 명령 원문만** 저장한다. 일반 대화는 서버에
--    도달하지도 않고 저장하지도 않는다.
create table if not exists public.bot_command_log (
  id           uuid primary key default gen_random_uuid(),
  channel_id   uuid not null references public.bot_channels(id) on delete cascade,

  -- 요청마다 유일한 UUID. 재사용되면 409(리플레이)로 거절한다.
  nonce        text not null,

  sender_id    text,
  user_id      uuid references public.app_users(id) on delete set null,

  -- 명령 원문. 반드시 '!' 로 시작해야 한다.
  command      text not null check (command like '!%'),

  result       text,
  status_code  integer,
  duration_ms  integer check (duration_ms is null or duration_ms >= 0),
  created_at   timestamptz not null default now(),

  constraint bot_command_log_nonce_uniq unique (channel_id, nonce)
);

comment on table public.bot_command_log is
  '봇 명령 감사 로그 + nonce 리플레이 방지. 명령 원문만 저장하며 일반 대화는 저장하지 않는다.';

-- nonce 캐시는 10분만 유효하므로 오래된 행을 걷어내는 배치가 이 인덱스를 쓴다.
create index if not exists bot_command_log_created_idx
  on public.bot_command_log (created_at);

create index if not exists bot_command_log_channel_idx
  on public.bot_command_log (channel_id, created_at desc);

-- ============================================================
-- 20260817090700_views.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 07. 조회용 뷰
-- =============================================================================
-- 모든 뷰는 **security_invoker = true** 다.
--   → 뷰를 통해 읽어도 기반 테이블의 RLS 가 "호출자 기준"으로 그대로 적용된다.
--   → SECURITY DEFINER 뷰(기본값)를 쓰면 RLS 를 우회해 비로그인 열람 설계가 통째로 무너진다.
--     Supabase advisor 도 이를 경고한다.
--
-- 권한(GRANT/REVOKE)은 08 마이그레이션에서 한 곳에 모아 관리한다.
-- 컬럼 목록이 바뀌면 create or replace 가 실패하므로 drop → create 로 재실행 안전성을 얻는다.
-- =============================================================================

-- 의존 순서대로 먼저 전부 내린다(뷰가 뷰를 참조하므로 순서가 중요하다).
--
-- `cascade` 인 이유: 뒤에 오는 마이그레이션(10-8)이 여기 뷰 위에 다시 뷰를 얹는다
-- (v_weekly_income → v_weekly_crystal_income). 전체 재실행 시 이 시점에는 그 파생 뷰가
-- 아직 남아 있어 cascade 없이는 drop 이 실패한다. 파생 뷰는 뒤 마이그레이션이 다시 만든다.
drop view if exists public.v_weekly_crystal_income cascade;
drop view if exists public.v_weekly_crystal_income_by_character cascade;
drop view if exists public.v_weekly_crystal_world_usage cascade;
drop view if exists public.v_weekly_crystal_pending cascade;
drop view if exists public.v_public_party_runs cascade;
drop view if exists public.v_public_party_board cascade;
drop view if exists public.v_run_participation cascade;
drop view if exists public.v_availability_overlay cascade;
drop view if exists public.v_boss_catalog cascade;

-- -----------------------------------------------------------------------------
-- v_boss_catalog — 보스 카탈로그 (research-BOSS-DATA.md 표와 같은 모양)
-- -----------------------------------------------------------------------------
-- 저장은 정규화(마스터 + 효력기간형 가격)해 두고, 읽을 때는 조사 문서와 동일한 평평한
-- 한 줄로 보여준다. 앱/봇이 보스를 고를 때 이 뷰 하나만 보면 된다.
create view public.v_boss_catalog
with (security_invoker = true) as
select
  bd.id                  as boss_difficulty_id,
  bd.korean_name,
  b.id                   as boss_id,
  b.korean_name          as boss_korean_name,
  b.generation,
  bd.difficulty,
  bd.cycle,
  -- 솔로 기준 기본가. **null 은 0 이 아니라 미확인이다.**
  p.price_meso           as crystal_price_meso,
  p.effective_from       as price_effective_from,
  p.patch_label          as price_patch_label,
  bd.max_party,
  bd.entry_level,
  bd.released,
  b.nexon_content_name,
  bd.nexon_difficulty,
  bd.sort_order
from public.boss_difficulties bd
join public.bosses b on b.id = bd.boss_id
left join lateral (
  select pr.price_meso, pr.effective_from, pr.patch_label
  from public.boss_crystal_prices pr
  where pr.boss_difficulty_id = bd.id
    and pr.effective_from <= now()
  order by pr.effective_from desc
  limit 1
) p on true;

comment on view public.v_boss_catalog is
  '보스 엔트리 + 현재 유효 결정석 기본가를 평평하게 합친 카탈로그. crystal_price_meso 가 null 이면 미확인(0 아님).';

-- 넥슨 API content_name/difficulty 를 우리 엔트리로 매핑할 때 쓰는 보조 뷰.
comment on column public.v_boss_catalog.nexon_content_name is
  '넥슨 스케줄러 API 원문 보스명. 매핑 실패 감지에 쓴다(신규 보스는 API 에 먼저 나타난다).';

-- -----------------------------------------------------------------------------
-- v_run_participation — 런별 참여 카운트
-- -----------------------------------------------------------------------------
-- 봇 `!일정` 의 "참가 5/6 · 미정 1" 을 그대로 만들어 준다.
create view public.v_run_participation
with (security_invoker = true) as
select
  r.id           as run_id,
  r.party_id,
  r.boss_difficulty_id,
  r.week_key,
  r.scheduled_at,
  r.status,
  r.capacity,
  count(s.id) filter (where s.status = 'going')    as going_count,
  count(s.id) filter (where s.status = 'maybe')    as maybe_count,
  count(s.id) filter (where s.status = 'declined') as declined_count,
  (count(s.id) filter (where s.status = 'going')) >= r.capacity as is_full
from public.party_runs r
left join public.run_signups s on s.run_id = r.id
group by r.id;

comment on view public.v_run_participation is
  '보스 런별 참여/미정/거절 카운트. 봇 `!일정` 의 "참가 5/6 · 미정 1" 표기 근거.';

-- -----------------------------------------------------------------------------
-- v_public_party_board — 비로그인 공개 파티 목록
-- -----------------------------------------------------------------------------
create view public.v_public_party_board
with (security_invoker = true) as
select
  p.id,
  p.name,
  p.description,
  p.share_slug,
  p.world_name,
  p.default_capacity,
  p.created_at,
  p.updated_at,
  count(pp.id) filter (where pp.left_at is null) as member_count
from public.parties p
left join public.party_participants pp on pp.party_id = p.id
where p.visibility = 'public'
  and p.archived_at is null
group by p.id;

comment on view public.v_public_party_board is
  '비로그인 열람용 공개 파티 목록. 기밀 컬럼을 가진 테이블을 전혀 참조하지 않는다.';

-- -----------------------------------------------------------------------------
-- v_public_party_runs — 비로그인 공개 시간표
-- -----------------------------------------------------------------------------
-- 참가자 이름은 party_participants.display_name 스냅샷에서 온다.
-- **app_users 를 조인하지 않는다** → anon 에게 계정 테이블 권한을 한 톨도 줄 필요가 없다.
create view public.v_public_party_runs
with (security_invoker = true) as
select
  r.id            as run_id,
  p.id            as party_id,
  p.name          as party_name,
  p.share_slug,
  b.korean_name   as boss_korean_name,
  bd.id           as boss_difficulty_id,
  bd.korean_name  as boss_display_name,
  bd.difficulty,
  bd.cycle,
  bd.max_party,
  r.scheduled_at,
  r.duration_minutes,
  r.status,
  r.capacity,
  r.entry_party_size,
  r.week_key,
  count(s.id) filter (where s.status = 'going') as going_count,
  count(s.id) filter (where s.status = 'maybe') as maybe_count
from public.parties p
join public.party_runs r         on r.party_id = p.id
join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
join public.bosses b             on b.id = bd.boss_id
left join public.run_signups s   on s.run_id = r.id
where p.visibility = 'public'
  and p.archived_at is null
  and r.cancelled_at is null
group by r.id, p.id, b.korean_name, bd.id;

comment on view public.v_public_party_runs is
  '비로그인 열람용 공개 시간표. app_users 를 조인하지 않아 계정 정보가 구조적으로 샐 수 없다.';

-- -----------------------------------------------------------------------------
-- v_availability_overlay — 겹쳐보기 집계 (이 앱의 1순위 가치)
-- -----------------------------------------------------------------------------
create view public.v_availability_overlay
with (security_invoker = true) as
select
  a.party_id,
  a.week_key,
  a.slot_start,
  count(*)                                            as available_count,
  array_agg(pp.display_name order by pp.display_name) as available_names
from public.availability_slots a
join public.party_participants pp on pp.id = a.participant_id
where pp.left_at is null
group by a.party_id, a.week_key, a.slot_start;

comment on view public.v_availability_overlay is
  '파티 × 주차 × 30분 슬롯별 가용 인원 집계. "여러 사람의 참여 의사를 하나의 시간표로 겹쳐 보기"의 결과물.';

-- -----------------------------------------------------------------------------
-- v_weekly_crystal_income_by_character — 캐릭터 × 주차 결정석 수익 (1차 집계)
-- -----------------------------------------------------------------------------
-- **집계 단위가 캐릭터인 이유**: 주간 결정 판매 한도 12개가 캐릭터 단위이기 때문이다.
-- 한 사용자가 캐릭터를 여러 개 굴리면 각 캐릭터가 독립적으로 12개를 갖는다.
--
-- 계산 규칙:
--   * 금액은 **클리어 시점 스냅샷(crystal_share_meso)만** 더한다.
--     가격 마스터를 조인하지 않으므로 시세가 패치로 바뀌어도 과거 수익이 소급 변경되지 않는다.
--   * 주간(weekly) 결정만 12개 한도에 걸린다. 일간·월간은 이 카운터와 무관하게 전액 합산된다.
--   * 12개 절삭은 **방어 로직**이다. 2025-08-21 패치로 13번째 주간 보스는 입장 자체가 막히므로
--     정상 데이터라면 절삭이 일어나지 않는다. 수동 입력 실수나 과거 데이터 이관으로 12개를
--     넘겼을 때 값이 터무니없어지는 것만 막는다.
--   * 가격 미확인(crystal_share_meso is null) 행은 합계에서 빠지고 unknown_price_count 로
--     따로 보고된다. 0 으로 채우면 "0메소를 벌었다"는 거짓 주장이 되기 때문이다.
create view public.v_weekly_crystal_income_by_character
with (security_invoker = true) as
with ranked as (
  select
    c.user_id,
    c.character_id,
    c.week_key,
    c.cycle,
    c.crystal_share_meso,
    case
      when c.cycle = 'weekly' then
        row_number() over (
          partition by c.user_id, c.character_id, c.week_key
          order by c.crystal_share_meso desc nulls last, c.id
        )
    end as weekly_rank
  from public.boss_clears c
  where c.effective_cleared
)
select
  user_id,
  character_id,
  week_key,
  count(*)                                                as clear_count,
  count(*) filter (where cycle = 'weekly')                as weekly_clear_count,
  count(*) filter (where cycle = 'daily')                 as daily_clear_count,
  count(*) filter (where cycle = 'monthly')               as monthly_clear_count,
  count(*) filter (where crystal_share_meso is null)      as unknown_price_count,
  count(*) filter (
    where cycle = 'weekly' and weekly_rank > public.weekly_crystal_sell_limit()
  )                                                       as weekly_over_limit_count,
  public.weekly_crystal_sell_limit()                      as weekly_sell_limit,
  coalesce(sum(crystal_share_meso) filter (
    where cycle <> 'weekly' or weekly_rank <= public.weekly_crystal_sell_limit()
  ), 0)::bigint                                           as income_meso
from ranked
group by user_id, character_id, week_key;

comment on view public.v_weekly_crystal_income_by_character is
  '캐릭터 × 주차 결정석 수익(1차 집계). 주간 결정 12개 한도가 캐릭터 단위이므로 여기가 기준 단위다. 절삭은 방어 로직.';

-- -----------------------------------------------------------------------------
-- v_weekly_crystal_income — 사용자 × 주차 결정석 수익 (2차 집계)
-- -----------------------------------------------------------------------------
-- "내 이번 주 총수익" = 그 사용자의 캐릭터별 수익을 다시 더한 값.
create view public.v_weekly_crystal_income
with (security_invoker = true) as
select
  user_id,
  week_key,
  sum(income_meso)::bigint    as income_meso,
  sum(clear_count)            as clear_count,
  sum(weekly_clear_count)     as weekly_clear_count,
  sum(daily_clear_count)      as daily_clear_count,
  sum(monthly_clear_count)    as monthly_clear_count,
  sum(unknown_price_count)    as unknown_price_count,
  sum(weekly_over_limit_count) as weekly_over_limit_count,
  count(*)                    as character_count
from public.v_weekly_crystal_income_by_character
group by user_id, week_key;

comment on view public.v_weekly_crystal_income is
  '사용자 × 주차 결정석 총수익(2차 집계). 캐릭터별 집계를 다시 합산한 값이다.';

-- -----------------------------------------------------------------------------
-- v_weekly_crystal_world_usage — 월드 × 주차 결정 사용량 (모니터링 전용)
-- -----------------------------------------------------------------------------
-- 월드당 주 90개(일간+주간+월간 합산)는 **실제 병목**이다(CLAUDE.md §1.3 D2):
-- 일간 보스 24종 × 7일 = 주 최대 168개라 캐릭터 하나만으로도 90을 넘긴다.
-- 그러나 "월드당"의 주체(계정 단위인지)가 1차 출처로 확정되지 않았으므로
-- **차단하지 않고, 표시 수익을 깎지도 않고, 경고용 수치만 제공한다.**
--
-- boss_clears.world_name 스냅샷을 쓰므로 캐릭터가 삭제돼도 집계가 살아남고
-- boss_clears_world_week_idx (world_name, week_key) 를 그대로 탄다.
create view public.v_weekly_crystal_world_usage
with (security_invoker = true) as
select
  c.user_id,
  c.world_name,
  c.week_key,
  count(*)                                                   as crystal_count,
  count(*) filter (where c.cycle = 'daily')                  as daily_crystal_count,
  count(*) filter (where c.cycle = 'weekly')                 as weekly_crystal_count,
  count(*) filter (where c.cycle = 'monthly')                as monthly_crystal_count,
  public.world_crystal_sell_limit()                          as world_sell_limit,
  greatest(public.world_crystal_sell_limit() - count(*), 0)  as remaining_slots,
  (count(*) > public.world_crystal_sell_limit())             as over_limit
from public.boss_clears c
where c.effective_cleared
  and c.world_name is not null
group by c.user_id, c.world_name, c.week_key;

comment on view public.v_weekly_crystal_world_usage is
  '월드 × 주차 결정 개수와 90개 한도 대비 잔여/초과 여부. **경고용이며 강제하지 않는다**(CLAUDE.md §1.3 D2).';

-- -----------------------------------------------------------------------------
-- v_weekly_crystal_pending — 이번 주 미수령 결정석 (봇 `!결정석`)
-- -----------------------------------------------------------------------------
create view public.v_weekly_crystal_pending
with (security_invoker = true) as
select
  c.id            as clear_id,
  c.user_id,
  c.character_id,
  c.week_key,
  c.boss_difficulty_id,
  bd.korean_name  as boss_display_name,
  bd.cycle,
  bd.max_party,
  c.run_id,
  r.scheduled_at,
  c.has_conflict
from public.boss_clears c
join public.boss_difficulties bd on bd.id = c.boss_difficulty_id
left join public.party_runs r    on r.id = c.run_id
where c.effective_cleared = false;

comment on view public.v_weekly_crystal_pending is
  '이번 주 등록했지만 아직 클리어하지 않은 보스. 봇 `!결정석` 의 "미수령" 목록.';

-- ============================================================
-- 20260817090800_rls_policies.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 08. RLS 활성화 및 정책 (보안의 실질적 방어선)
-- =============================================================================
-- 채택한 인증 모델: **(c) 모든 쓰기를 Next.js Route Handler + service role 로만 수행하고,
-- RLS 는 anon/authenticated 를 전면 차단한다.** (근거는 Claude/DB-SCHEMA.md 난제 1)
--
-- 이 모델에서 RLS 는 장식이 아니라 **유일한 방어선**이다. 이유:
--   * 브라우저는 `sb_publishable_...` 키(= anon 역할)를 들고 있고, 이 키는 설계상 공개다.
--     즉 누구든 PostgREST 로 직접 쿼리를 날릴 수 있다.
--   * 우리는 Supabase Auth 세션을 쓰지 않으므로 `auth.uid()` 가 항상 null 이다.
--     따라서 "본인 행만" 류의 정책은 성립하지 않는다.
--   * 그래서 anon/authenticated 에게는 **공개 시간표 SELECT 이외의 모든 것을 거부**하고,
--     나머지는 서명·세션을 검증한 Route Handler 가 service role 로만 수행한다.
--
-- 이중 방어:
--   1) RLS 정책 — 모든 테이블에 명시적으로 작성한다(정책 없는 테이블 = 실패).
--   2) GRANT/REVOKE — Supabase 는 public 스키마 신규 테이블에 anon/authenticated 권한을
--      기본으로 부여한다. RLS 가 실수로 꺼져도 새지 않도록 권한 자체를 회수한다.
--
-- ⚠️ service_role 은 BYPASSRLS 속성을 가지므로 아래 service_role 정책은 실제로는 평가되지
--    않는다. 그래도 명시적으로 남긴다 — 의도를 스키마에 기록하고, 향후 bypassrls 가
--    제거되더라도 동작이 유지되게 하기 위해서다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 8-1. 비공개 테이블 (19개) — anon/authenticated 전면 차단
-- -----------------------------------------------------------------------------
-- 반복 정의는 실수가 나기 쉬우므로 테이블 목록을 한 곳에 두고 동일 정책을 적용한다.
-- 어떤 테이블이 여기 속하는지가 이 파일에서 가장 중요한 정보다.
do $$
declare
  t text;
  private_tables text[] := array[
    -- 신원 · 자격증명 (API 키 해시, 암호화 키, 넥슨 account_id)
    'app_users',
    'user_credentials',
    'user_nexon_accounts',
    'characters',
    'nexon_api_quota_usage',
    -- 결정석 원장 · 넥슨 미러 · 숙제 (개인 활동 기록)
    'boss_clears',
    'character_scheduler_snapshots',
    'chore_definitions',
    'chore_completions',
    -- 소셜 · 초대 (초대 토큰 해시, 게스트 승계 토큰 해시)
    'friendships',
    'invite_links',
    'guest_profiles',
    'invite_redemptions',
    'guest_claims',
    -- 봇 (채널 시크릿 해시, 발신자 식별자, 명령 로그)
    'bot_channels',
    'bot_channel_members',
    'bot_link_codes',
    'bot_outbox',
    'bot_command_log'
  ];
begin
  foreach t in array private_tables loop
    execute format('alter table public.%I enable row level security', t);

    -- 권한 자체를 회수한다(RLS 가 꺼지는 사고에 대한 2차 방어).
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    -- 명시적 전면 거부. "정책이 없어서 막힌다"가 아니라 "막으라고 썼다"로 남긴다.
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

-- -----------------------------------------------------------------------------
-- 8-2. 공개 마스터 데이터 (4개) — 누구나 읽기, 아무도 쓰기 불가
-- -----------------------------------------------------------------------------
-- 보스 이름·난이도·별칭·결정석 시세는 게임 공개 정보이며 비로그인 화면이 필요로 한다.
-- 기밀 컬럼이 하나도 없으므로 전량 공개해도 안전하다.
do $$
declare
  t text;
  public_master_tables text[] := array[
    'bosses',
    'boss_difficulties',
    'boss_aliases',
    'boss_crystal_prices'
  ];
begin
  foreach t in array public_master_tables loop
    execute format('alter table public.%I enable row level security', t);

    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to anon', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    execute format('drop policy if exists %I on public.%I', t || '_public_select', t);
    execute format(
      $p$create policy %I on public.%I as permissive for select
         to anon, authenticated using (true)$p$,
      t || '_public_select', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_no_public_insert', t);
    execute format(
      $p$create policy %I on public.%I as permissive for insert
         to anon, authenticated with check (false)$p$,
      t || '_no_public_insert', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_no_public_update', t);
    execute format(
      $p$create policy %I on public.%I as permissive for update
         to anon, authenticated using (false) with check (false)$p$,
      t || '_no_public_update', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_no_public_delete', t);
    execute format(
      $p$create policy %I on public.%I as permissive for delete
         to anon, authenticated using (false)$p$,
      t || '_no_public_delete', t
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

-- -----------------------------------------------------------------------------
-- 8-3. 공개 시간표 (5개) — 조건부 읽기. 조건이 테이블마다 다르므로 개별 작성한다.
-- -----------------------------------------------------------------------------
-- 공개 범위는 오직 `parties.visibility = 'public'` 한 곳에서 결정된다.
-- visibility = 'link' 는 슬러그가 곧 비밀이라 RLS 로 표현할 수 없다 →
-- anon 은 읽지 못하고, Route Handler 가 토큰을 검증한 뒤 service role 로 서빙한다.

-- ── parties ──────────────────────────────────────────────────────────────────
alter table public.parties enable row level security;
revoke all on table public.parties from anon;
revoke all on table public.parties from authenticated;
grant select on table public.parties to anon;
grant select on table public.parties to authenticated;
grant all on table public.parties to service_role;

drop policy if exists parties_public_select on public.parties;
create policy parties_public_select on public.parties
  as permissive for select to anon, authenticated
  using (visibility = 'public' and archived_at is null);

drop policy if exists parties_no_public_insert on public.parties;
create policy parties_no_public_insert on public.parties
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists parties_no_public_update on public.parties;
create policy parties_no_public_update on public.parties
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists parties_no_public_delete on public.parties;
create policy parties_no_public_delete on public.parties
  as permissive for delete to anon, authenticated using (false);

drop policy if exists parties_service_role_all on public.parties;
create policy parties_service_role_all on public.parties
  as permissive for all to service_role using (true) with check (true);

-- ── party_participants ───────────────────────────────────────────────────────
-- 공개 파티의 참가자만 노출된다. 노출되는 이름은 display_name 스냅샷이며
-- 이 테이블에는 기밀 컬럼이 없다(계정 정보는 app_users/user_credentials 에 있고 전면 차단).
alter table public.party_participants enable row level security;
revoke all on table public.party_participants from anon;
revoke all on table public.party_participants from authenticated;
grant select on table public.party_participants to anon;
grant select on table public.party_participants to authenticated;
grant all on table public.party_participants to service_role;

drop policy if exists party_participants_public_select on public.party_participants;
create policy party_participants_public_select on public.party_participants
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = party_participants.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists party_participants_no_public_insert on public.party_participants;
create policy party_participants_no_public_insert on public.party_participants
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_participants_no_public_update on public.party_participants;
create policy party_participants_no_public_update on public.party_participants
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_participants_no_public_delete on public.party_participants;
create policy party_participants_no_public_delete on public.party_participants
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_participants_service_role_all on public.party_participants;
create policy party_participants_service_role_all on public.party_participants
  as permissive for all to service_role using (true) with check (true);

-- ── party_runs ───────────────────────────────────────────────────────────────
alter table public.party_runs enable row level security;
revoke all on table public.party_runs from anon;
revoke all on table public.party_runs from authenticated;
grant select on table public.party_runs to anon;
grant select on table public.party_runs to authenticated;
grant all on table public.party_runs to service_role;

drop policy if exists party_runs_public_select on public.party_runs;
create policy party_runs_public_select on public.party_runs
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = party_runs.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists party_runs_no_public_insert on public.party_runs;
create policy party_runs_no_public_insert on public.party_runs
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_runs_no_public_update on public.party_runs;
create policy party_runs_no_public_update on public.party_runs
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_runs_no_public_delete on public.party_runs;
create policy party_runs_no_public_delete on public.party_runs
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_runs_service_role_all on public.party_runs;
create policy party_runs_service_role_all on public.party_runs
  as permissive for all to service_role using (true) with check (true);

-- ── run_signups ──────────────────────────────────────────────────────────────
alter table public.run_signups enable row level security;
revoke all on table public.run_signups from anon;
revoke all on table public.run_signups from authenticated;
grant select on table public.run_signups to anon;
grant select on table public.run_signups to authenticated;
grant all on table public.run_signups to service_role;

drop policy if exists run_signups_public_select on public.run_signups;
create policy run_signups_public_select on public.run_signups
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1
      from public.party_runs r
      join public.parties p on p.id = r.party_id
      where r.id = run_signups.run_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists run_signups_no_public_insert on public.run_signups;
create policy run_signups_no_public_insert on public.run_signups
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists run_signups_no_public_update on public.run_signups;
create policy run_signups_no_public_update on public.run_signups
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists run_signups_no_public_delete on public.run_signups;
create policy run_signups_no_public_delete on public.run_signups
  as permissive for delete to anon, authenticated using (false);

drop policy if exists run_signups_service_role_all on public.run_signups;
create policy run_signups_service_role_all on public.run_signups
  as permissive for all to service_role using (true) with check (true);

-- ── availability_slots ───────────────────────────────────────────────────────
-- party_id 가 비정규화되어 있어 정책이 parties 만 보면 된다(추가 조인 없음).
alter table public.availability_slots enable row level security;
revoke all on table public.availability_slots from anon;
revoke all on table public.availability_slots from authenticated;
grant select on table public.availability_slots to anon;
grant select on table public.availability_slots to authenticated;
grant all on table public.availability_slots to service_role;

drop policy if exists availability_slots_public_select on public.availability_slots;
create policy availability_slots_public_select on public.availability_slots
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = availability_slots.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists availability_slots_no_public_insert on public.availability_slots;
create policy availability_slots_no_public_insert on public.availability_slots
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists availability_slots_no_public_update on public.availability_slots;
create policy availability_slots_no_public_update on public.availability_slots
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists availability_slots_no_public_delete on public.availability_slots;
create policy availability_slots_no_public_delete on public.availability_slots
  as permissive for delete to anon, authenticated using (false);

drop policy if exists availability_slots_service_role_all on public.availability_slots;
create policy availability_slots_service_role_all on public.availability_slots
  as permissive for all to service_role using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 8-4. 뷰 권한
-- -----------------------------------------------------------------------------
-- 뷰는 security_invoker = true 이므로 기반 테이블 RLS 가 그대로 적용된다.
-- 그래도 "읽을 수 있는 뷰"를 권한 수준에서도 명시적으로 좁힌다.
do $$
declare
  v text;
  public_views text[] := array[
    -- 보스 카탈로그는 게임 공개 정보이며 비로그인 등록 화면이 필요로 한다.
    'v_boss_catalog',
    'v_public_party_board',
    'v_public_party_runs',
    'v_run_participation',
    'v_availability_overlay'
  ];
  private_views text[] := array[
    -- 개인 수익·활동 기록. anon 은 기반 테이블도 못 읽지만 권한도 함께 회수한다.
    'v_weekly_crystal_income',
    'v_weekly_crystal_income_by_character',
    'v_weekly_crystal_world_usage',
    'v_weekly_crystal_pending'
  ];
begin
  foreach v in array public_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant select on table public.%I to anon', v);
    execute format('grant select on table public.%I to authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;

  foreach v in array private_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 8-5. 함수 실행 권한
-- -----------------------------------------------------------------------------
-- ⚠️ 가장 위험한 항목. claim_guest_profile 은 SECURITY DEFINER 이고,
--    PostgreSQL 은 함수 EXECUTE 를 기본으로 PUBLIC 에 부여한다.
--    회수하지 않으면 anon 이 PostgREST RPC 로 남의 게스트 레코드를 자기 계정에 승계할 수 있다.
revoke all on function public.claim_guest_profile(uuid, uuid) from public;
revoke all on function public.claim_guest_profile(uuid, uuid) from anon;
revoke all on function public.claim_guest_profile(uuid, uuid) from authenticated;
grant execute on function public.claim_guest_profile(uuid, uuid) to service_role;

-- 시세 조회는 공개 정보를 읽을 뿐이고 SECURITY INVOKER 이므로 그대로 둔다.
-- 시간 함수(week_key 등)는 순수 산술이라 노출되어도 무해하다.

-- -----------------------------------------------------------------------------
-- 8-6. 자기검증 — 정책 없는 테이블이 하나라도 있으면 마이그레이션을 실패시킨다
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  -- (1) RLS 가 꺼진 public 스키마 테이블
  select string_agg(c.relname, ', ' order by c.relname)
    into v_rls_off
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if v_rls_off is not null then
    raise exception 'RLS 가 비활성화된 테이블이 있습니다: %', v_rls_off;
  end if;

  -- (2) 정책이 하나도 없는 테이블
  select string_agg(c.relname, ', ' order by c.relname)
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if v_missing is not null then
    raise exception 'RLS 정책이 없는 테이블이 있습니다: %', v_missing;
  end if;

  -- (3) anon 이 쓰기 권한을 가진 테이블이 남아 있으면 실패
  select string_agg(distinct table_name, ', ')
    into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');

  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;

-- ============================================================
-- 20260817091000_payout_shares_and_drops.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 10. 수익 분배(share) + 기타 드랍 수익
-- =============================================================================
-- 발주자 추가 요구사항:
--   "파티 인원수 제한은 넣는 대신에 분배 조절을 넣어줘. 100% 기준으로 33 : 67 이런식으로?"
--   "결정석도 있고 그 외에 드랍도 있음. 그런 것도 분배할 수 있게"
--
-- ── 게임 규칙과 우리 모델의 구분 (가장 중요) ─────────────────────────────────
--   * **게임 규칙**: 결정석은 입장 인원으로 1/n 균등 지급된다. 우리가 바꿀 수 없다.
--     파티 전체가 받는 총액(pot) = party_size × floor(base_price / party_size)
--   * **우리 모델**: 그 pot 을 파티원끼리 어떻게 **재분배**했는지 기록한다(버스 33:67 등).
--     게임 밖에서 벌어지는 메소 거래이므로 API 로는 절대 알 수 없고 전적으로 우리 데이터다.
--   → 즉 pot 은 게임이 정하고, 그 안의 배분은 사람이 정한다. 이 파일이 후자를 담당한다.
--
-- ⚠️ 기존 `check (crystal_share_meso = base_price_meso / party_size)` 는 **더 이상 불변식이
--    아니다.** 균등 분배는 이제 불변식이 아니라 *기본값*이다. 이 파일에서 완화한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 10-1. distribute_meso — 잔여 메소 배분 규칙 (단일 진실 공급원)
-- -----------------------------------------------------------------------------
-- **최대잉여법(largest remainder).**
--   1) 각자 floor(total × weight / Σweight) 를 먼저 받는다.
--   2) 남은 메소(total - Σfloor)를 **나머지가 큰 순서**로 1메소씩 나눠 준다.
--   3) 동률이면 weight 큰 순 → key(uuid) 오름차순. **완전 결정론적**이다.
-- 결과 합계는 항상 total 과 **정확히 일치**한다. 1메소도 새지 않는다.
--
-- **왜 DB 함수인가** (애플리케이션이 아니라):
--   * 웹 UI, 카톡 봇(`!결정석`), 주간 집계 뷰가 **모두 같은 값**을 내야 한다.
--     TS 에 두면 뷰가 그 로직을 호출할 수 없어 집계와 화면이 갈라진다.
--   * 순수 정수 산술이라 IMMUTABLE 로 선언할 수 있고 뷰에서 자유롭게 쓸 수 있다.
--   * 봇 응답은 3초 예산인데, 서버가 재계산하지 않고 뷰를 그대로 읽으면 된다.
--
-- **분모가 10000 이 아니라 Σweight 인 이유** (중요):
--   균등 분배를 basis point 로 표현하면 오차가 생긴다. 1/6 = 0.16666... 인데
--   bp 로는 1667/1666 으로 근사되어 6인 파티에서 1인당 수천 메소가 어긋난다.
--   → 균등 모드는 가중치를 전부 `1` 로 넘긴다(분모 = n). 그러면 pot 이 party_size 로
--     정확히 나누어떨어져 **게임 결과와 1메소도 다르지 않다.**
--   → 사용자 지정 모드는 가중치로 share_bp 를 넘긴다(분모 = 10000). 33:67 이 정확히 표현된다.
--   하나의 알고리즘으로 두 경우를 모두 정확히 처리한다.
create or replace function public.distribute_meso(
  p_total   bigint,
  p_keys    uuid[],
  p_weights integer[]
)
returns table (key uuid, weight integer, amount bigint)
language plpgsql
immutable
parallel safe
as $func$
declare
  v_n     integer;
  v_denom bigint;
begin
  if p_total is null or p_keys is null or p_weights is null then
    return;
  end if;

  v_n := array_length(p_keys, 1);
  if v_n is null or v_n = 0 then
    return;
  end if;

  if array_length(p_weights, 1) is distinct from v_n then
    raise exception 'distribute_meso: 키 개수(%)와 가중치 개수(%)가 다릅니다.',
      v_n, array_length(p_weights, 1) using errcode = 'data_exception';
  end if;

  if p_total < 0 then
    raise exception 'distribute_meso: 총액은 음수일 수 없습니다 (%).', p_total
      using errcode = 'data_exception';
  end if;

  if exists (select 1 from unnest(p_weights) w where w is null or w < 0) then
    raise exception 'distribute_meso: 가중치는 null 이거나 음수일 수 없습니다.'
      using errcode = 'data_exception';
  end if;

  select sum(w)::bigint into v_denom from unnest(p_weights) w;
  if v_denom is null or v_denom <= 0 then
    raise exception 'distribute_meso: 가중치 합이 0 이하입니다 (%). 분배할 수 없습니다.', v_denom
      using errcode = 'data_exception';
  end if;

  return query
  with input as (
    select k.k as ikey, w.w as iweight
    from unnest(p_keys)    with ordinality as k(k, ord)
    join unnest(p_weights) with ordinality as w(w, ord) on w.ord = k.ord
  ),
  base as (
    select i.ikey,
           i.iweight,
           (p_total * i.iweight) / v_denom as amount_floor,
           (p_total * i.iweight) % v_denom as remainder
    from input i
  ),
  ranked as (
    select b.ikey,
           b.iweight,
           b.amount_floor,
           (p_total - sum(b.amount_floor) over ())::bigint as leftover,
           row_number() over (
             order by b.remainder desc, b.iweight desc, b.ikey asc
           ) as rn
    from base b
  )
  select r.ikey,
         r.iweight,
         r.amount_floor + case when r.rn <= r.leftover then 1 else 0 end
  from ranked r;
end;
$func$;

comment on function public.distribute_meso(bigint, uuid[], integer[]) is
  '최대잉여법 메소 분배. 분모는 Σweight. 합계가 총액과 정확히 일치하며 결정론적이다. 웹·봇·집계뷰가 공유하는 유일한 구현.';

-- -----------------------------------------------------------------------------
-- 10-2. 분배 비율 컬럼
-- -----------------------------------------------------------------------------
-- share 를 **run_signups** 에 둔 이유:
--   결정석 pot 은 "그 보스에 실제로 같이 들어간 사람들"이 나눈다. 파티 멤버 전체가 아니다.
--   6인 파티에서 4명만 간 런이면 그 4명 사이에서 합이 10000 이어야 한다.
--   party_participants 에 두면 참석자 부분집합에 대해 합이 10000 이 되지 않아 성립하지 않는다.
alter table public.party_runs
  add column if not exists share_mode public.run_share_mode not null default 'auto_equal';

comment on column public.party_runs.share_mode is
  'auto_equal=참가자 변동 시 균등 재계산(게임과 동일한 결과) / manual=사용자 지정 비율 보존.';

alter table public.run_signups
  add column if not exists share_bp integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'run_signups_share_bp_range') then
    alter table public.run_signups
      add constraint run_signups_share_bp_range check (share_bp between 0 and 10000);
  end if;
  -- 불참자는 분배 대상이 아니다.
  if not exists (select 1 from pg_constraint where conname = 'run_signups_non_going_has_no_share') then
    alter table public.run_signups
      add constraint run_signups_non_going_has_no_share
      check (status = 'going' or share_bp = 0);
  end if;
end
$$;

comment on column public.run_signups.share_bp is
  '수익 분배 비율(basis point, 10000 = 100%). 한 런의 going 참가자 합계는 정확히 10000. 부동소수점을 쓰지 않아 33:67 이 정확히 표현된다.';

-- 게스트 참가자도 run_signups 를 통해 share 를 가진다. participant_id 가
-- party_participants(정규 사용자 + 게스트 공존)를 가리키므로 별도 처리가 필요 없고,
-- 승계 시 participant 행이 그대로 유지되어 share 가 자동으로 따라간다(10-7 에서 병합 케이스 처리).

-- -----------------------------------------------------------------------------
-- 10-2b. 참가자 번호 seat_no — 사람이 입으로 부르는 안정적 식별자
-- -----------------------------------------------------------------------------
-- 용도: 카톡 평문에서 긴 닉네임 대신 번호로 가리킨다. `!분배 1번 33` 처럼.
--       모집 순번이나 대기열이 아니라 **자리 지정용 식별자**다.
--
-- ★ **번호는 절대 재배열하지 않는다.**
--   3번이 나갔다고 4번이 3번이 되면, 그 순간 방에서 진행 중이던 대화가 전부 어긋난다
--   ("3번한테 33 줘" 라고 말한 사람과 들은 사람이 서로 다른 사람을 가리키게 된다).
--   → 빠진 번호는 **빈 채로 둔다.** 빈 번호를 재사용하지도 않는다(신규는 항상 max+1).
--   → 그래서 번호는 연속이 아닐 수 있다. 그게 정상이다.
alter table public.run_signups
  add column if not exists seat_no smallint;

-- 기존 행 백필(이관/재실행 대비). 이미 번호가 있는 행은 건드리지 않고 그 뒤에 이어 붙인다.
update public.run_signups s
   set seat_no = x.new_seat
  from (
    select r.id,
           (coalesce(m.max_seat, 0)
            + row_number() over (partition by r.run_id order by r.created_at, r.id))::smallint as new_seat
    from public.run_signups r
    left join (
      select run_id, max(seat_no) as max_seat
      from public.run_signups
      where seat_no is not null
      group by run_id
    ) m on m.run_id = r.run_id
    where r.seat_no is null
  ) x
 where s.id = x.id and s.seat_no is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'run_signups_seat_no_positive') then
    alter table public.run_signups
      add constraint run_signups_seat_no_positive check (seat_no is null or seat_no >= 1);
  end if;

  -- 같은 런 안에서 번호는 유일하다. 경쟁 조건이 뚫려도 여기서 반드시 막힌다.
  if not exists (select 1 from pg_constraint where conname = 'run_signups_seat_uniq') then
    alter table public.run_signups
      add constraint run_signups_seat_uniq unique (run_id, seat_no);
  end if;

  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'run_signups'
           and column_name = 'seat_no' and is_nullable = 'YES'
      )
     and not exists (select 1 from public.run_signups where seat_no is null) then
    alter table public.run_signups alter column seat_no set not null;
  end if;
end
$$;

comment on column public.run_signups.seat_no is
  '런 안에서 1부터 부여되는 참가자 번호. 봇에서 `!분배 1번 33` 처럼 사람을 가리키는 데 쓴다. **탈퇴해도 재배열하지 않으며 빈 번호를 재사용하지 않는다** — 대화 중 지칭이 어긋나면 안 되기 때문.';

-- **번호 부여를 애플리케이션이 아니라 트리거에 둔 이유**:
--   참가자를 만드는 경로가 최소 셋이다 — 웹 UI, 카톡 봇 `!등록`, 초대 링크 참가.
--   앱에 두면 세 경로가 전부 같은 규칙을 구현해야 하고, 한 곳만 빠뜨려도 번호가 겹치거나 빈다.
--   DB 에 두면 구현이 하나뿐이고 어떤 경로로 들어와도 규칙이 강제된다.
--
-- **경쟁 조건 대응**:
--   `max(seat_no)+1` 은 동시 INSERT 에 취약하다(둘 다 3을 읽고 둘 다 4를 쓴다).
--   → 같은 런에 대해 **트랜잭션 범위 advisory lock** 으로 번호 부여를 직렬화한다.
--     party_runs 행을 잠그지 않으므로 일정 수정과 경합하지 않고, 커밋/롤백 시 자동 해제된다.
--   → 그래도 unique 제약을 backstop 으로 남겨 둔다. 락을 우회하는 경로(직접 INSERT 등)에서도
--     중복 번호가 저장되는 일은 없다.
create or replace function public.run_signups_assign_seat_no()
returns trigger
language plpgsql
as $func$
declare
  v_next smallint;
begin
  -- 명시적으로 지정된 번호(복원·이관)는 존중한다.
  if new.seat_no is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('run_seat:' || new.run_id::text, 0));

  select (coalesce(max(seat_no), 0) + 1)::smallint
    into v_next
    from public.run_signups
   where run_id = new.run_id;

  new.seat_no := v_next;
  return new;
end;
$func$;

drop trigger if exists run_signups_assign_seat_no on public.run_signups;
create trigger run_signups_assign_seat_no
  before insert on public.run_signups
  for each row execute function public.run_signups_assign_seat_no();

-- -----------------------------------------------------------------------------
-- 10-3. 균등 분배 기본값 + 참가자 변동 재계산 정책
-- -----------------------------------------------------------------------------
-- **정책 (문서 DB-SCHEMA.md 와 동일):**
--   auto_equal (기본)
--     - 참가자 추가/삭제/불참전환 시 **항상 균등 재계산**.
--     - floor(10000/n) 씩 주고 나머지 (10000 mod n) 을 결정론적 순서(created_at, id)로 1씩 더한다.
--       예) 3명 → 3334/3333/3333 = 10000, 7명 → 1429×6 + 1426 형태로 정확히 10000.
--   manual (사용자가 한 번이라도 비율을 조절하면 전환)
--     - **추가**: 새 참가자는 share_bp = 0 으로 들어온다. 기존 비율이 그대로 보존되고 합도 10000 유지.
--       (새로 온 사람 몫은 사람이 직접 정해야 한다 — 임의로 남의 몫을 빼앗지 않는다.)
--     - **삭제/불참**: 떠난 사람의 몫을 남은 사람들에게 **기존 비율대로 비례 재분배**한다.
--       (그러지 않으면 합이 10000 미만이 되어 pot 일부가 증발한다.)
--     - 합이 이미 정확히 10000 이면 **절대 건드리지 않는다.**
create or replace function public.rebalance_run_shares(p_run_id uuid)
returns integer
language plpgsql
as $func$
declare
  v_mode  public.run_share_mode;
  v_n     integer;
  v_total integer;
  v_rows  integer := 0;
begin
  select r.share_mode into v_mode from public.party_runs r where r.id = p_run_id;
  if not found then
    return 0;   -- 런이 이미 삭제됨(cascade). 검사할 것이 없다.
  end if;

  -- 불참자는 분배 대상에서 제외한다.
  update public.run_signups
     set share_bp = 0
   where run_id = p_run_id and status <> 'going' and share_bp <> 0;

  select count(*), coalesce(sum(share_bp), 0)
    into v_n, v_total
    from public.run_signups
   where run_id = p_run_id and status = 'going';

  if v_n = 0 then
    return 0;   -- 참가자가 없으면 합계 0 이 정상이다.
  end if;

  if v_mode = 'manual' and v_total = 10000 then
    return 0;   -- 사용자가 정한 비율이 유효하다. 손대지 않는다.
  end if;

  if v_mode = 'auto_equal' or v_total = 0 then
    -- 균등 분배. 나머지는 **번호 순(= 등록 순)** 으로 앞에서부터 1씩. 완전 결정론적이다.
    with ordered as (
      select id, row_number() over (order by seat_no) as rn
        from public.run_signups
       where run_id = p_run_id and status = 'going'
    )
    update public.run_signups s
       set share_bp = (10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end
      from ordered o
     where s.id = o.id
       and s.share_bp is distinct from
           ((10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end);
    get diagnostics v_rows = row_count;
  else
    -- manual 인데 합이 10000 이 아니다(이탈 등).
    -- 남은 사람들의 기존 비율을 유지한 채 10000 으로 재정규화한다.
    -- 잔여 bp 배분도 distribute_meso 의 최대잉여법을 그대로 쓴다(규칙 일원화).
    with recipients as (
      select id, share_bp
        from public.run_signups
       where run_id = p_run_id and status = 'going'
    ),
    agg as (
      select array_agg(id order by id) as keys,
             array_agg(share_bp order by id) as weights
      from recipients
    ),
    dist as (
      select d.key, d.amount
      from agg, public.distribute_meso(10000, agg.keys, agg.weights) d
    )
    update public.run_signups s
       set share_bp = dist.amount::integer
      from dist
     where s.id = dist.key
       and s.share_bp is distinct from dist.amount::integer;
    get diagnostics v_rows = row_count;
  end if;

  return v_rows;
end;
$func$;

comment on function public.rebalance_run_shares(uuid) is
  '런의 분배 비율을 정책에 따라 재계산한다. auto_equal=균등 재계산, manual=기존 비율 보존 후 부족분만 비례 재정규화.';

create or replace function public.run_signups_sync_shares()
returns trigger
language plpgsql
as $func$
begin
  -- rebalance 가 같은 테이블을 update 하므로 재진입을 막는다.
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.rebalance_run_shares(coalesce(new.run_id, old.run_id));
  return null;
end;
$func$;

drop trigger if exists run_signups_sync_shares on public.run_signups;
create trigger run_signups_sync_shares
  after insert or delete or update of status on public.run_signups
  for each row execute function public.run_signups_sync_shares();

-- -----------------------------------------------------------------------------
-- 10-4. 합계 10000 강제 — 지연(DEFERRED) 제약 트리거
-- -----------------------------------------------------------------------------
-- **왜 CHECK 가 아니라 제약 트리거인가**:
--   합계는 **여러 행에 걸친 불변식**이라 단일 행 CHECK 로 표현할 수 없다.
-- **왜 즉시(IMMEDIATE)가 아니라 지연(DEFERRED)인가**:
--   참가자를 한 명 추가하거나 33:67 로 조정하는 순간 합계는 **반드시 일시적으로 깨진다.**
--   즉시 검사하면 어떤 정상적인 편집도 문장 순서를 곡예하지 않는 한 통과할 수 없다.
--   → 커밋 시점에 한 번만 본다. 트랜잭션 안에서 어떻게 고치든 자유롭고,
--     끝났을 때 반드시 맞아야 한다.
-- 허용 합계는 **10000(분배 확정) 또는 0(참가자 없음)** 두 가지다.
create or replace function public.assert_run_share_total()
returns trigger
language plpgsql
as $func$
declare
  v_run   uuid;
  v_total integer;
begin
  v_run := coalesce(new.run_id, old.run_id);
  if v_run is null then
    return null;
  end if;

  -- 런 자체가 삭제된 경우(cascade)에는 검사할 대상이 없다.
  if not exists (select 1 from public.party_runs where id = v_run) then
    return null;
  end if;

  select coalesce(sum(share_bp), 0) into v_total
    from public.run_signups
   where run_id = v_run;

  if v_total not in (0, 10000) then
    raise exception
      '일정(%)의 분배 비율 합계는 10000(=100%%) 이어야 합니다. 현재 %.', v_run, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$func$;

drop trigger if exists run_signups_share_total on public.run_signups;
create constraint trigger run_signups_share_total
  after insert or update or delete on public.run_signups
  deferrable initially deferred
  for each row execute function public.assert_run_share_total();

-- 사용자가 비율을 직접 지정하는 유일한 진입점.
-- 여기를 통과하면 share_mode 가 manual 로 바뀌고, 이후 균등 재계산이 비율을 덮어쓰지 않는다.
create or replace function public.set_run_shares(
  p_run_id         uuid,
  p_participant_ids uuid[],
  p_share_bps      integer[]
)
returns integer
language plpgsql
as $func$
declare
  v_total integer;
  v_rows  integer := 0;
begin
  if array_length(p_participant_ids, 1) is distinct from array_length(p_share_bps, 1) then
    raise exception 'set_run_shares: 참가자 수와 비율 수가 다릅니다.'
      using errcode = 'data_exception';
  end if;

  select sum(b)::integer into v_total from unnest(p_share_bps) b;
  if coalesce(v_total, 0) <> 10000 then
    raise exception '분배 비율 합계는 10000(=100%%) 이어야 합니다. 입력 합계 %.', coalesce(v_total, 0)
      using errcode = 'check_violation';
  end if;

  update public.party_runs set share_mode = 'manual' where id = p_run_id;

  update public.run_signups s
     set share_bp = x.bp
    from (
      select k.k as pid, b.b as bp
      from unnest(p_participant_ids) with ordinality as k(k, ord)
      join unnest(p_share_bps)       with ordinality as b(b, ord) on b.ord = k.ord
    ) x
   where s.run_id = p_run_id
     and s.participant_id = x.pid;
  get diagnostics v_rows = row_count;

  if v_rows <> array_length(p_participant_ids, 1) then
    raise exception '이 일정에 속하지 않은 참가자가 포함되어 있습니다.'
      using errcode = 'foreign_key_violation';
  end if;

  return v_rows;
end;
$func$;

comment on function public.set_run_shares(uuid, uuid[], integer[]) is
  '런의 분배 비율을 사용자 지정으로 설정한다. 합계 10000 을 강제하고 share_mode 를 manual 로 바꾼다.';

-- -----------------------------------------------------------------------------
-- 10-5. 기타 드랍 수익
-- -----------------------------------------------------------------------------
create table if not exists public.run_drops (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.party_runs(id) on delete cascade,

  item_name     text not null check (length(btrim(item_name)) between 1 and 100),

  -- **nullable = 아직 안 팔았다.** 0 이 아니다.
  -- 벨로나 미확인 가격과 같은 기조: 모르는 값을 0 으로 채우면 "0메소를 벌었다"는 거짓이 된다.
  -- 집계는 이런 건을 합계에서 빼고 unsold_drop_count 로 따로 보고한다.
  sale_amount_meso bigint check (sale_amount_meso is null or sale_amount_meso >= 0),
  sold_at       timestamptz,

  share_mode    public.drop_share_mode not null default 'party_default',
  -- share_mode = 'solo' 일 때 전부 가져가는 사람
  solo_participant_id uuid references public.party_participants(id) on delete set null,

  recorded_by_participant_id uuid references public.party_participants(id) on delete set null,

  -- 그 런이 속한 주차를 따라간다(트리거 관리). 결정석의 "클리어 주차 귀속"과 같은 기조로,
  -- 나중에 팔더라도 **그 보스에서 나온 수익**으로 묶어 본다.
  week_key      text not null default public.week_key(now())
                  check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),

  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint run_drops_solo_needs_participant check (
    share_mode <> 'solo' or solo_participant_id is not null
  ),
  -- 판매 금액과 판매 시각은 함께 있거나 함께 없다.
  constraint run_drops_sold_pair check (
    (sale_amount_meso is null) = (sold_at is null)
  )
);

comment on table public.run_drops is
  '보스 런에서 나온 결정석 외 드랍 수익. 금액 null = 미판매이며 집계에서 제외하고 별도로 센다.';
comment on column public.run_drops.sale_amount_meso is
  'null 은 0 이 아니라 **미판매**다. 수익 합계에서 제외되고 unsold_drop_count 로 보고된다.';
comment on column public.run_drops.share_mode is
  'party_default=런 기본 비율 / custom=이 건 전용 비율(run_drop_shares) / solo=1인 독식.';

create index if not exists run_drops_run_idx on public.run_drops (run_id);
create index if not exists run_drops_week_idx on public.run_drops (week_key);
-- 미판매 목록 조회
create index if not exists run_drops_unsold_idx
  on public.run_drops (run_id) where sale_amount_meso is null;

-- 주차 동기화 + 판매 시각 자동 기록
create or replace function public.run_drops_apply_state()
returns trigger
language plpgsql
as $func$
declare
  v_week text;
begin
  select r.week_key into v_week from public.party_runs r where r.id = new.run_id;
  if v_week is not null then
    new.week_key := v_week;
  end if;

  -- 금액이 처음 채워지면 판매 시각을 기록하고, 지워지면 되돌린다.
  if new.sale_amount_meso is not null and new.sold_at is null then
    new.sold_at := now();
  elsif new.sale_amount_meso is null then
    new.sold_at := null;
  end if;

  return new;
end;
$func$;

drop trigger if exists run_drops_apply_state on public.run_drops;
create trigger run_drops_apply_state
  before insert or update on public.run_drops
  for each row execute function public.run_drops_apply_state();

drop trigger if exists run_drops_set_updated_at on public.run_drops;
create trigger run_drops_set_updated_at
  before update on public.run_drops
  for each row execute function public.set_updated_at();

-- 드랍 1건 전용 비율 (share_mode = 'custom')
create table if not exists public.run_drop_shares (
  id             uuid primary key default gen_random_uuid(),
  drop_id        uuid not null references public.run_drops(id) on delete cascade,
  participant_id uuid not null references public.party_participants(id) on delete cascade,

  share_bp       integer not null default 0 check (share_bp between 0 and 10000),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint run_drop_shares_uniq unique (drop_id, participant_id)
);

comment on table public.run_drop_shares is
  '드랍 1건에만 적용되는 분배 비율. 합계는 정확히 10000(또는 참가자 없음 0). 지연 제약 트리거로 강제.';

create index if not exists run_drop_shares_drop_idx on public.run_drop_shares (drop_id);
create index if not exists run_drop_shares_participant_idx on public.run_drop_shares (participant_id);

drop trigger if exists run_drop_shares_set_updated_at on public.run_drop_shares;
create trigger run_drop_shares_set_updated_at
  before update on public.run_drop_shares
  for each row execute function public.set_updated_at();

-- run_signups 와 동일한 이유로 지연 제약 트리거를 쓴다.
create or replace function public.assert_drop_share_total()
returns trigger
language plpgsql
as $func$
declare
  v_drop  uuid;
  v_total integer;
begin
  v_drop := coalesce(new.drop_id, old.drop_id);
  if v_drop is null then
    return null;
  end if;

  if not exists (select 1 from public.run_drops where id = v_drop) then
    return null;
  end if;

  select coalesce(sum(share_bp), 0) into v_total
    from public.run_drop_shares where drop_id = v_drop;

  if v_total not in (0, 10000) then
    raise exception
      '드랍(%)의 분배 비율 합계는 10000(=100%%) 이어야 합니다. 현재 %.', v_drop, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$func$;

drop trigger if exists run_drop_shares_total on public.run_drop_shares;
create constraint trigger run_drop_shares_total
  after insert or update or delete on public.run_drop_shares
  deferrable initially deferred
  for each row execute function public.assert_drop_share_total();

-- -----------------------------------------------------------------------------
-- 10-6. 결정석에 분배 적용
-- -----------------------------------------------------------------------------
alter table public.boss_clears
  add column if not exists pot_meso bigint,
  add column if not exists share_bp integer;

comment on column public.boss_clears.pot_meso is
  '게임이 파티 전체에 지급한 총액 = party_size × floor(base_price / party_size). **게임 규칙이며 우리가 못 바꾼다.**';
comment on column public.boss_clears.share_bp is
  '이 사용자가 pot 에서 가져간 비율(bp). 균등이면 게임과 같은 결과, 조절하면 재분배가 반영된다.';

do $$
begin
  -- 1/n 강제 제약 제거. 균등 분배는 이제 불변식이 아니라 기본값이다.
  if exists (select 1 from pg_constraint where conname = 'boss_clears_share_is_floor_division') then
    alter table public.boss_clears drop constraint boss_clears_share_is_floor_division;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'boss_clears_pot_pair') then
    alter table public.boss_clears
      add constraint boss_clears_pot_pair
      check ((base_price_meso is null) = (pot_meso is null));
  end if;

  -- 개인 수령액은 0 이상이고 pot 을 넘을 수 없다.
  -- (참가자 전체 합계 = pot 인지는 v_run_crystal_settlement 가 검증한다 — 우리 DB 에
  --  행이 없는 참가자도 pot 을 나눠 갖기 때문에 단일 행 CHECK 로는 표현할 수 없다.)
  if not exists (select 1 from pg_constraint where conname = 'boss_clears_share_within_pot') then
    alter table public.boss_clears
      add constraint boss_clears_share_within_pot
      check (
        crystal_share_meso is null
        or (pot_meso is not null and crystal_share_meso between 0 and pot_meso)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'boss_clears_share_bp_range') then
    alter table public.boss_clears
      add constraint boss_clears_share_bp_range
      check (share_bp is null or share_bp between 0 and 10000);
  end if;
end
$$;

-- 이 사용자가 그 런에서 pot 중 얼마를 가져가는지 해석한다.
create or replace function public.resolve_crystal_payout(
  p_run_id     uuid,
  p_user_id    uuid,
  p_pot        bigint,
  p_party_size integer
)
returns table (share_bp integer, amount bigint)
language plpgsql
stable
as $func$
declare
  v_mode      public.run_share_mode;
  v_pid       uuid;
  v_use_equal boolean;
  v_size      integer := greatest(coalesce(p_party_size, 1), 1);
begin
  -- 런이 없거나(솔로 기록) 그 런에 참여 등록이 없으면 게임 기본값(균등)을 쓴다.
  -- pot 은 party_size 로 정확히 나누어떨어지므로 이 값이 곧 floor(base/party_size) 다.
  if p_run_id is null then
    return query select (10000 / v_size)::integer, (p_pot / v_size)::bigint;
    return;
  end if;

  select r.share_mode into v_mode from public.party_runs r where r.id = p_run_id;
  if not found then
    return query select (10000 / v_size)::integer, (p_pot / v_size)::bigint;
    return;
  end if;

  select pp.id into v_pid
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.run_id = p_run_id
     and s.status = 'going'
     and pp.user_id = p_user_id
   limit 1;

  if v_pid is null then
    return query select (10000 / v_size)::integer, (p_pot / v_size)::bigint;
    return;
  end if;

  -- 균등 모드이거나 비율이 아직 하나도 지정되지 않았으면 단위 가중치(=정확한 1/n)를 쓴다.
  select (v_mode = 'auto_equal')
         or coalesce(sum(s.share_bp), 0) = 0
    into v_use_equal
    from public.run_signups s
   where s.run_id = p_run_id and s.status = 'going';

  return query
  with recipients as (
    select s.participant_id,
           s.share_bp,
           case when v_use_equal then 1 else s.share_bp end as weight
      from public.run_signups s
     where s.run_id = p_run_id and s.status = 'going'
  ),
  agg as (
    select array_agg(participant_id order by participant_id) as keys,
           array_agg(weight order by participant_id)         as weights
    from recipients
  ),
  dist as (
    select d.key, d.amount
    from agg, public.distribute_meso(p_pot, agg.keys, agg.weights) d
  )
  select r.share_bp, d.amount
  from recipients r
  join dist d on d.key = r.participant_id
  where r.participant_id = v_pid;
end;
$func$;

comment on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) is
  '결정석 pot 중 해당 사용자의 몫을 해석한다. 런이 없거나 미등록이면 게임 기본 균등(1/n).';

-- boss_clears 상태 트리거 교체: pot 계산 + 분배 적용
create or replace function public.boss_clears_apply_state()
returns trigger
language plpgsql
as $func$
declare
  v_winner   text;
  v_cycle    public.boss_cycle;
  v_price_id uuid;
  v_base     bigint;
  v_pot      bigint;
  v_bp       integer;
  v_amount   bigint;
begin
  -- 0) 보스 엔트리 확인 (max_party 는 소프트 상한이라 검증하지 않는다 — CLAUDE.md §1.3 D5)
  select bd.cycle into v_cycle
    from public.boss_difficulties bd
   where bd.id = new.boss_difficulty_id;

  if not found then
    raise exception '알 수 없는 보스 엔트리입니다: %', new.boss_difficulty_id
      using errcode = 'foreign_key_violation';
  end if;

  -- 0 으로 나누는 사고 방지. CHECK 는 BEFORE 트리거보다 나중에 평가되므로 여기서 먼저 막는다.
  if new.party_size is null or new.party_size < 1 then
    raise exception '파티 인원(party_size)은 1 이상이어야 합니다 (입력: %).', new.party_size
      using errcode = 'check_violation';
  end if;

  if new.world_name is null and new.character_id is not null then
    select ch.world_name into new.world_name
      from public.characters ch where ch.id = new.character_id;
  end if;

  -- 1) 승자 판정 (관측 시각이 더 최신인 쪽. 동률이면 사람이 이긴다)
  if new.manual_cleared is null and new.api_cleared is null then
    v_winner := 'none';
  elsif new.manual_cleared is null then
    v_winner := 'api';
  elsif new.api_cleared is null then
    v_winner := 'manual';
  elsif coalesce(new.manual_set_at, '-infinity'::timestamptz)
        >= coalesce(new.api_observed_at, '-infinity'::timestamptz) then
    v_winner := 'manual';
  else
    v_winner := 'api';
  end if;

  new.effective_cleared := case v_winner
    when 'manual' then coalesce(new.manual_cleared, false)
    when 'api'    then coalesce(new.api_cleared, false)
    else false
  end;

  -- 2) 충돌 보존
  new.has_conflict := (
    new.manual_cleared is not null
    and new.api_cleared is not null
    and new.manual_cleared is distinct from new.api_cleared
  );

  -- 3) 클리어 시각 / 금액 스냅샷
  if new.effective_cleared then
    if new.cleared_at is null then
      new.cleared_at := coalesce(
        case v_winner when 'manual' then new.manual_set_at else new.api_observed_at end,
        now()
      );
    end if;

    if new.price_snapshotted_at is null then
      new.cycle := v_cycle;

      if new.manual_base_price_meso is not null then
        v_base := new.manual_base_price_meso;
        v_price_id := null;
      else
        select cp.price_id, cp.price_meso
          into v_price_id, v_base
          from public.current_crystal_price(new.boss_difficulty_id, new.cleared_at) cp;
      end if;

      new.crystal_price_id := v_price_id;
      new.base_price_meso  := v_base;

      if v_base is null then
        -- 가격 미확인. 0 으로 채우지 않는다.
        new.pot_meso           := null;
        new.share_bp           := null;
        new.crystal_share_meso := null;
      else
        -- 게임 규칙: 파티 전체가 받는 총액
        v_pot := new.party_size * (v_base / new.party_size);
        new.pot_meso := v_pot;

        -- 우리 모델: 그 총액을 파티원끼리 어떻게 나눴는가
        select p.share_bp, p.amount
          into v_bp, v_amount
          from public.resolve_crystal_payout(new.run_id, new.user_id, v_pot, new.party_size) p;

        new.share_bp           := v_bp;
        new.crystal_share_meso := v_amount;
      end if;

      new.price_snapshotted_at := now();
    end if;
  else
    new.cleared_at           := null;
    new.crystal_price_id     := null;
    new.base_price_meso      := null;
    new.pot_meso             := null;
    new.share_bp             := null;
    new.crystal_share_meso   := null;
    new.price_snapshotted_at := null;
    new.cycle                := v_cycle;
  end if;

  -- 4) 주차 버킷
  if new.cleared_at is not null then
    new.week_key := public.week_key(new.cleared_at);
  else
    new.week_key := coalesce(
      nullif(new.week_key, ''),
      public.week_key(coalesce(new.created_at, now()))
    );
  end if;

  return new;
end;
$func$;

-- 비율을 나중에 바꿨을 때 이미 기록된 결정석 금액을 다시 계산한다.
-- **가격(base_price_meso)은 절대 다시 조회하지 않는다** — R3 소급 변경 금지를 지키기 위해
-- 스냅샷된 pot 을 그대로 쓰고 분배만 다시 한다.
create or replace function public.recompute_run_crystal_shares(p_run_id uuid)
returns integer
language plpgsql
as $func$
declare
  r       record;
  v_bp    integer;
  v_amt   bigint;
  v_rows  integer := 0;
begin
  for r in
    select bc.id, bc.user_id, bc.pot_meso, bc.party_size
      from public.boss_clears bc
     where bc.run_id = p_run_id
       and bc.effective_cleared
       and bc.pot_meso is not null
  loop
    select p.share_bp, p.amount
      into v_bp, v_amt
      from public.resolve_crystal_payout(p_run_id, r.user_id, r.pot_meso, r.party_size) p;

    update public.boss_clears
       set share_bp = v_bp, crystal_share_meso = v_amt
     where id = r.id
       and (share_bp is distinct from v_bp or crystal_share_meso is distinct from v_amt);

    if found then
      v_rows := v_rows + 1;
    end if;
  end loop;

  return v_rows;
end;
$func$;

comment on function public.recompute_run_crystal_shares(uuid) is
  '분배 비율 변경 후 기록된 결정석 금액을 다시 나눈다. 가격 스냅샷은 건드리지 않아 소급 변경이 일어나지 않는다.';

-- -----------------------------------------------------------------------------
-- 10-7. 게스트 승계 시 share 보존
-- -----------------------------------------------------------------------------
-- 게스트 참가자 행이 그대로 user_id 로 전환되는 경우(moved)에는 share_bp 가 자동으로 따라온다.
-- 문제는 **병합(merged)** 이다 — 같은 런에 본인 행과 게스트 행이 둘 다 있으면 하나를 지워야 하고,
-- 그냥 지우면 합계가 10000 미만이 되어 pot 일부가 증발한다.
-- → 지우기 전에 **게스트의 몫을 본인 행에 합산**한다. 합계가 정확히 보존된다.
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
    -- 가용시간: 본인 행에 같은 슬롯이 없을 때만 옮긴다.
    update public.availability_slots a
       set participant_id = r.user_participant_id
     where a.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.availability_slots b
          where b.participant_id = r.user_participant_id
            and b.slot_start = a.slot_start
       );
    delete from public.availability_slots
     where participant_id = r.guest_participant_id;

    -- ★ 분배 비율 보존: 같은 런에 양쪽 행이 있으면 게스트 몫을 본인 행에 **합산**한다.
    --   한 사람은 자리 하나이므로 본인 번호(seat_no)를 유지하고 게스트 번호는 빈 번호가 된다.
    --   빈 번호를 메우지 않는 것이 seat_no 의 규칙이다.
    update public.run_signups t
       set share_bp = t.share_bp + s.share_bp
      from public.run_signups s
     where s.participant_id = r.guest_participant_id
       and t.participant_id = r.user_participant_id
       and t.run_id = s.run_id;

    -- 본인 응답이 없는 런은 게스트 행을 그대로 옮긴다.
    -- 행 자체가 유지되므로 share_bp 와 **seat_no 가 그대로 따라간다.**
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

    -- ★ 드랍 전용 비율도 같은 규칙으로 합산 후 이관한다.
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

    -- 드랍 독식/기록자 참조도 본인 행으로 넘긴다.
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

  -- 남은 게스트 참가자 행 → 정식 사용자 행으로 전환 (share_bp 는 행에 그대로 남아 따라간다)
  update public.party_participants
     set user_id      = p_user_id,
         guest_id     = null,
         display_name = v_display_name
   where guest_id = p_guest_id;
  get diagnostics v_moved = row_count;

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

comment on function public.claim_guest_profile(uuid, uuid) is
  '임시 참가자를 정식 계정으로 승계한다. 파티 중복 시 병합하며 분배 비율(share_bp)을 합산해 합계 10000 을 보존한다.';

-- -----------------------------------------------------------------------------
-- 10-8. 정산 / 집계 뷰
-- -----------------------------------------------------------------------------
-- 의존 순서 역순으로 내린다. cascade 는 재실행 시 파생 뷰가 남아 있어도 안전하게 하기 위함이다.
drop view if exists public.v_weekly_income cascade;
drop view if exists public.v_weekly_unsold_drops cascade;
drop view if exists public.v_weekly_drop_income cascade;
drop view if exists public.v_run_drop_settlement cascade;
drop view if exists public.v_run_drop_recipients cascade;
drop view if exists public.v_run_crystal_settlement cascade;
drop view if exists public.v_run_share_weights cascade;

-- 런별 유효 가중치(균등이면 1, 사용자 지정이면 share_bp).
create view public.v_run_share_weights
with (security_invoker = true) as
select
  s.run_id,
  s.participant_id,
  s.seat_no,
  pp.user_id,
  pp.guest_id,
  pp.display_name,
  s.share_bp,
  case
    when r.share_mode = 'auto_equal' then 1
    when coalesce(sum(s.share_bp) over (partition by s.run_id), 0) = 0 then 1
    else s.share_bp
  end as weight
from public.run_signups s
join public.party_runs r          on r.id = s.run_id
join public.party_participants pp on pp.id = s.participant_id
where s.status = 'going';

comment on view public.v_run_share_weights is
  '런별 분배 가중치. 균등 모드는 1(정확한 1/n), 사용자 지정 모드는 share_bp. 게스트도 포함된다.';

-- 결정석 정산: pot 을 실제 참가자들에게 나눈 결과. **합계가 pot 과 정확히 일치**한다.
create view public.v_run_crystal_settlement
with (security_invoker = true) as
with run_pot as (
  select bc.run_id,
         max(bc.pot_meso)  as pot_meso,
         max(bc.party_size) as party_size,
         min(bc.week_key)  as week_key
  from public.boss_clears bc
  where bc.run_id is not null
    and bc.effective_cleared
    and bc.pot_meso is not null
  group by bc.run_id
),
agg as (
  select w.run_id,
         array_agg(w.participant_id order by w.participant_id) as keys,
         array_agg(w.weight order by w.participant_id)         as weights
  from public.v_run_share_weights w
  group by w.run_id
)
select
  p.run_id,
  p.week_key,
  p.pot_meso,
  p.party_size,
  d.key    as participant_id,
  w.seat_no,
  w.user_id,
  w.display_name,
  w.share_bp,
  d.amount as amount_meso
from run_pot p
join agg a on a.run_id = p.run_id
cross join lateral public.distribute_meso(p.pot_meso, a.keys, a.weights) d
join public.v_run_share_weights w
  on w.run_id = p.run_id and w.participant_id = d.key;

comment on view public.v_run_crystal_settlement is
  '결정석 pot 의 참가자별 정산 결과. 게스트 포함 전원이 대상이라 amount_meso 합계가 pot 과 정확히 일치한다.';

-- 드랍 수익 수령자 해석 (3가지 분배 방식)
create view public.v_run_drop_recipients
with (security_invoker = true) as
-- party_default : 런 기본 비율을 그대로
select d.id as drop_id, w.participant_id, w.weight
from public.run_drops d
join public.v_run_share_weights w on w.run_id = d.run_id
where d.share_mode = 'party_default'
union all
-- custom : 이 드랍 전용 비율
select d.id, s.participant_id, s.share_bp
from public.run_drops d
join public.run_drop_shares s on s.drop_id = d.id
where d.share_mode = 'custom'
  and s.share_bp > 0
union all
-- solo : 1인 독식
select d.id, d.solo_participant_id, 1
from public.run_drops d
where d.share_mode = 'solo'
  and d.solo_participant_id is not null;

comment on view public.v_run_drop_recipients is
  '드랍 건별 수령자와 가중치. party_default/custom/solo 세 방식을 하나로 해석한다.';

-- 드랍 정산. **미판매(금액 null)는 여기 나타나지 않는다.**
create view public.v_run_drop_settlement
with (security_invoker = true) as
with agg as (
  select rc.drop_id,
         array_agg(rc.participant_id order by rc.participant_id) as keys,
         array_agg(rc.weight order by rc.participant_id)         as weights
  from public.v_run_drop_recipients rc
  group by rc.drop_id
)
select
  d.id       as drop_id,
  d.run_id,
  d.week_key,
  d.item_name,
  d.share_mode,
  d.sale_amount_meso,
  x.key      as participant_id,
  pp.user_id,
  pp.display_name,
  x.amount   as amount_meso
from public.run_drops d
join agg a on a.drop_id = d.id
cross join lateral public.distribute_meso(d.sale_amount_meso, a.keys, a.weights) x
join public.party_participants pp on pp.id = x.key
where d.sale_amount_meso is not null;

comment on view public.v_run_drop_settlement is
  '드랍 건별 참가자 정산. 미판매(금액 null)는 제외되며 합계는 판매 금액과 정확히 일치한다.';

-- 주간 드랍 수익 (사용자 × 주차). 게스트 몫은 어떤 사용자에게도 귀속되지 않는다.
create view public.v_weekly_drop_income
with (security_invoker = true) as
select
  s.user_id,
  s.week_key,
  sum(s.amount_meso)::bigint  as drop_income_meso,
  count(*)                    as drop_share_count,
  count(distinct s.drop_id)   as drop_count
from public.v_run_drop_settlement s
where s.user_id is not null
group by s.user_id, s.week_key;

comment on view public.v_weekly_drop_income is
  '사용자 × 주차 기타 드랍 수익. 결정석 12개 한도와 무관한 별도 계통이다.';

-- 미판매 드랍 개수. 금액을 모르니 수익에는 못 넣지만 "아직 안 판 게 3건 있다"는 보여줘야 한다.
-- 가격 미확인 결정석을 unknown_price_count 로 따로 보고하는 것과 같은 기조다.
create view public.v_weekly_unsold_drops
with (security_invoker = true) as
select
  pp.user_id,
  d.week_key,
  count(distinct d.id) as unsold_drop_count
from public.run_drops d
join public.run_signups s         on s.run_id = d.run_id and s.status = 'going'
join public.party_participants pp on pp.id = s.participant_id
where d.sale_amount_meso is null
  and pp.user_id is not null
group by pp.user_id, d.week_key;

comment on view public.v_weekly_unsold_drops is
  '아직 팔지 않은 드랍 건수(사용자 × 주차). 금액이 없어 수익에는 못 들어가지만 별도로 보고한다.';

-- 결정석 + 드랍 통합 주간 수익
create view public.v_weekly_income
with (security_invoker = true) as
with keys as (
  select user_id, week_key from public.v_weekly_crystal_income
  union
  select user_id, week_key from public.v_weekly_drop_income
  union
  select user_id, week_key from public.v_weekly_unsold_drops
)
select
  k.user_id,
  k.week_key,
  -- 결정석 계통 (주간 12개 한도가 적용되는 쪽)
  coalesce(c.income_meso, 0)             as crystal_income_meso,
  coalesce(c.clear_count, 0)             as clear_count,
  coalesce(c.weekly_clear_count, 0)      as weekly_clear_count,
  coalesce(c.unknown_price_count, 0)     as unknown_price_count,
  coalesce(c.weekly_over_limit_count, 0) as weekly_over_limit_count,
  -- 드랍 계통 (12개 한도와 무관)
  coalesce(d.drop_income_meso, 0)        as drop_income_meso,
  coalesce(d.drop_count, 0)              as drop_count,
  coalesce(u.unsold_drop_count, 0)       as unsold_drop_count,
  -- 합계
  (coalesce(c.income_meso, 0) + coalesce(d.drop_income_meso, 0))::bigint as total_income_meso
from keys k
left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
left join public.v_weekly_drop_income    d on d.user_id = k.user_id and d.week_key = k.week_key
left join public.v_weekly_unsold_drops   u on u.user_id = k.user_id and u.week_key = k.week_key;

comment on view public.v_weekly_income is
  '주간 총수익 = 결정석 분배 몫 + 드랍 분배 몫. 두 계통을 분리해 보여준다(12개 한도는 결정석에만 적용). 미판매 드랍은 금액이 아니라 건수로 보고한다.';

-- -----------------------------------------------------------------------------
-- 10-9. RLS — 신규 테이블/뷰
-- -----------------------------------------------------------------------------
-- 드랍 수익은 개인 금전 정보다. 공개 파티라 해도 노출하지 않는다.
do $$
declare
  t text;
  private_tables text[] := array['run_drops', 'run_drop_shares'];
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

do $$
declare
  v text;
  private_views text[] := array[
    'v_run_share_weights',
    'v_run_crystal_settlement',
    'v_run_drop_recipients',
    'v_run_drop_settlement',
    'v_weekly_drop_income',
    'v_weekly_unsold_drops',
    'v_weekly_income'
  ];
begin
  foreach v in array private_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;
end
$$;

-- 분배를 바꾸는 함수는 서버만 호출한다. anon 이 RPC 로 남의 파티 분배를 바꾸면 안 된다.
revoke all on function public.set_run_shares(uuid, uuid[], integer[]) from public;
revoke all on function public.set_run_shares(uuid, uuid[], integer[]) from anon;
revoke all on function public.set_run_shares(uuid, uuid[], integer[]) from authenticated;
grant execute on function public.set_run_shares(uuid, uuid[], integer[]) to service_role;

revoke all on function public.rebalance_run_shares(uuid) from public;
revoke all on function public.rebalance_run_shares(uuid) from anon;
revoke all on function public.rebalance_run_shares(uuid) from authenticated;
grant execute on function public.rebalance_run_shares(uuid) to service_role;

revoke all on function public.recompute_run_crystal_shares(uuid) from public;
revoke all on function public.recompute_run_crystal_shares(uuid) from anon;
revoke all on function public.recompute_run_crystal_shares(uuid) from authenticated;
grant execute on function public.recompute_run_crystal_shares(uuid) to service_role;

-- claim_guest_profile 은 재정의되었으므로 권한을 다시 잠근다(재정의 시 기본 PUBLIC 실행권이 붙는다).
revoke all on function public.claim_guest_profile(uuid, uuid) from public;
revoke all on function public.claim_guest_profile(uuid, uuid) from anon;
revoke all on function public.claim_guest_profile(uuid, uuid) from authenticated;
grant execute on function public.claim_guest_profile(uuid, uuid) to service_role;

-- distribute_meso / resolve_crystal_payout 은 순수 계산이며 인자로 받은 값만 다룬다.
-- 다만 resolve_crystal_payout 은 런 구성을 읽으므로 서버 전용으로 잠근다.
revoke all on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) from public;
revoke all on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) from anon;
revoke all on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) from authenticated;
grant execute on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 10-10. 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
  v_amounts bigint[];
begin
  -- 분배 정확성: 33:67 이 1메소도 새지 않아야 한다.
  select array_agg(amount order by amount)
    into v_amounts
    from public.distribute_meso(
      1000001,
      array['00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid],
      array[3300, 6700]
    );
  if (v_amounts[1] + v_amounts[2]) <> 1000001 then
    raise exception 'distribute_meso 33:67 합계 불일치: % + % <> 1000001', v_amounts[1], v_amounts[2];
  end if;

  -- 3분할(나누어떨어지지 않음)도 합계가 정확해야 한다.
  select array_agg(amount)
    into v_amounts
    from public.distribute_meso(
      100,
      array['00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000003'::uuid],
      array[1, 1, 1]
    );
  if (v_amounts[1] + v_amounts[2] + v_amounts[3]) <> 100 then
    raise exception 'distribute_meso 3등분 합계 불일치';
  end if;

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

  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;

-- ============================================================
-- 20260817091100_column_privileges_and_availability.sql
-- ============================================================
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

-- ============================================================
-- 20260817091200_multi_nexon_accounts.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 12. 다중 넥슨 계정 지원 (본계정 + 부계정)
-- =============================================================================
-- 발주자 요구:
--   "여러 개의 다른 계정의 캐릭터도 등록을 할 수 있어야 함. API 키 + 본캐 닉네임으로 저장하되
--    다른 계정의 캐릭터도 등록할 수 있게. API 추가등록 기능"
--   "깔끔하게 본캐 닉네임 기준 API 로그인을 기준으로 하고 연결되는 추가 API 키를 넣을 수 있게.
--    만약 연결된 api 키로 입력해서 로그인한다고 해도 가능하도록"
--
-- 근본 제약(CLAUDE.md §1.1): **넥슨 API 키는 그 키를 발급한 계정의 캐릭터만 읽는다.**
-- 따라서 부계정 캐릭터를 보려면 그 계정의 키를 추가로 등록하는 수밖에 없다.
--
-- ── 이미 있던 것 (다시 만들지 않는다) ────────────────────────────────────────
--   user_credentials.user_id 에 유니크가 없어 사용자당 다중 키가 이미 가능하다. label 도 있다.
--   user_nexon_accounts 도 사용자당 다중 행이 가능하다.
--   app_users.main_character_name/main_world_name 스냅샷과 characters.is_main 도 이미 있다.
--   characters_one_main_per_user 부분 유니크 인덱스도 이미 있다(사용자당 본캐 1개).
-- ── 이 마이그레이션이 채우는 것 ──────────────────────────────────────────────
--   1) 캐릭터가 "어느 넥슨 계정에서 왔는지" 모른다 → 출처 참조 추가
--   2) 키 ↔ 넥슨 계정 연결이 없다 (account_list 는 배열이므로 M:N) → 링크 테이블
--   3) 키 무효화 시 캐릭터 상태 표현
--   4) 로그인 해석 / 키 추가 규칙을 함수로 못박기
--   5) 주 자격증명(primary credential) 개념과 본캐 연동
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 12-1. 열거 타입
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'character_sync_state' and n.nspname = 'public') then
    -- syncable     : 이 캐릭터가 속한 넥슨 계정에 유효한 키가 있어 스케줄러 API 호출이 가능하다
    -- no_valid_key : 키가 없거나 전부 무효화됨 → **읽기는 계속 되지만 동기화만 멈춘다**
    create type public.character_sync_state as enum ('syncable', 'no_valid_key');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 12-2. 키 ↔ 넥슨 계정 링크 (M:N)
-- -----------------------------------------------------------------------------
-- ⚠️ `/character/list` 의 `account_list` 는 **배열**이다. 키 하나가 복수 계정을 돌려줄 수 있다
--    (그 조건은 미확인). 반대로 키를 재발급하면 새 credential 행이 생기지만 계정은 그대로이므로
--    한 계정에 여러 credential 이 붙는다. 양방향 다중이라 **링크 테이블**이 정답이다.
create table if not exists public.credential_nexon_accounts (
  id                uuid primary key default gen_random_uuid(),
  credential_id     uuid not null references public.user_credentials(id) on delete cascade,
  nexon_account_ref uuid not null references public.user_nexon_accounts(id) on delete cascade,

  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  constraint credential_nexon_accounts_uniq unique (credential_id, nexon_account_ref)
);

comment on table public.credential_nexon_accounts is
  'API 키 ↔ 넥슨 계정 링크. /character/list 의 account_list[] 가 배열이라 M:N 이다. 검증 시점에 채운다.';

create index if not exists credential_nexon_accounts_account_idx
  on public.credential_nexon_accounts (nexon_account_ref);

-- -----------------------------------------------------------------------------
-- 12-3. 주 자격증명 (primary credential)
-- -----------------------------------------------------------------------------
-- 본캐가 속한 계정의 키가 **주 키**, 나머지는 나중에 붙인 **연결 키**다.
-- ⚠️ 주 키는 "정체성의 출처"일 뿐이며 **로그인 자격과는 무관하다.**
--    연결 키로도 똑같이 로그인된다(§12-6). "로그인하려면 주 키여야 한다"는 규칙은 없다.
alter table public.user_credentials
  add column if not exists is_primary boolean not null default false;

comment on column public.user_credentials.is_primary is
  '본캐가 속한 계정의 키. 정체성의 출처일 뿐 로그인 자격과 무관하다 — 연결 키로도 로그인된다.';

-- 사용자당 주 키는 하나 (characters.is_main 과 같은 방식)
create unique index if not exists user_credentials_one_primary_per_user
  on public.user_credentials (user_id) where is_primary;

-- -----------------------------------------------------------------------------
-- 12-4. characters 출처 참조 + 동기화 상태
-- -----------------------------------------------------------------------------
-- **credential 이 아니라 넥슨 계정을 가리키는 이유**:
--   키는 재발급되면 SHA-256 해시가 바뀌어 credential 행이 새로 생긴다. credential 을 가리키면
--   키를 재발급할 때마다 모든 캐릭터의 출처가 끊긴다.
--   반면 **넥슨 계정(account_id)은 키를 바꿔도 그대로다.** 캐릭터가 실제로 속한 것도 계정이지 키가 아니다.
-- 호출에는 키가 필요하므로 **계정 → 현재 유효 키** 경로를 v_character_sync_source 로 제공한다.
alter table public.characters
  add column if not exists nexon_account_ref uuid
    references public.user_nexon_accounts(id) on delete set null;

alter table public.characters
  add column if not exists sync_state public.character_sync_state not null default 'no_valid_key';

comment on column public.characters.nexon_account_ref is
  '이 캐릭터가 속한 넥슨 계정. 키가 아니라 계정을 가리킨다 — 키는 재발급되지만 계정은 유지되기 때문.';
comment on column public.characters.sync_state is
  'no_valid_key = 그 계정에 유효한 키가 없어 동기화 불가. **읽기는 계속 된다** — 과거 클리어·파티 이력이 걸려 있으므로 캐릭터를 지우지 않는다.';

create index if not exists characters_account_idx
  on public.characters (nexon_account_ref) where nexon_account_ref is not null;

create index if not exists characters_stale_idx
  on public.characters (user_id) where sync_state = 'no_valid_key';

-- 캐릭터의 동기화 가능 여부를 계산한다(단일 정의).
create or replace function public.character_is_syncable(
  p_user_id uuid,
  p_account_ref uuid
)
returns boolean
language sql
stable
parallel safe
as $func$
  select p_account_ref is not null
     and exists (
       select 1
       from public.credential_nexon_accounts l
       join public.user_credentials c on c.id = l.credential_id
       where l.nexon_account_ref = p_account_ref
         and c.user_id = p_user_id
         and c.invalidated_at is null
     );
$func$;

comment on function public.character_is_syncable(uuid, uuid) is
  '그 계정에 유효한(무효화되지 않은) 키가 하나라도 있는지. sync_state 의 유일한 판정 근거.';

-- 캐릭터 자신이 쓰일 때 상태를 맞춘다(순수 계산, 다른 테이블에 쓰지 않는다).
create or replace function public.characters_apply_sync_state()
returns trigger
language plpgsql
as $func$
begin
  new.sync_state := case
    when public.character_is_syncable(new.user_id, new.nexon_account_ref) then 'syncable'
    else 'no_valid_key'
  end::public.character_sync_state;
  return new;
end;
$func$;

drop trigger if exists characters_apply_sync_state on public.characters;
create trigger characters_apply_sync_state
  before insert or update of user_id, nexon_account_ref on public.characters
  for each row execute function public.characters_apply_sync_state();

-- 키가 무효화/삭제/추가되면 영향받는 캐릭터의 상태를 다시 계산한다.
-- ★ 캐릭터를 지우지 않는다. 상태만 바꾼다.
create or replace function public.refresh_character_sync_state()
returns trigger
language plpgsql
as $func$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  update public.characters ch
     set sync_state = case
           when public.character_is_syncable(ch.user_id, ch.nexon_account_ref) then 'syncable'
           else 'no_valid_key'
         end::public.character_sync_state
   where ch.sync_state is distinct from case
           when public.character_is_syncable(ch.user_id, ch.nexon_account_ref) then 'syncable'
           else 'no_valid_key'
         end::public.character_sync_state;

  return null;
end;
$func$;

drop trigger if exists user_credentials_refresh_sync on public.user_credentials;
create trigger user_credentials_refresh_sync
  after insert or delete or update of invalidated_at, user_id on public.user_credentials
  for each statement execute function public.refresh_character_sync_state();

drop trigger if exists credential_nexon_accounts_refresh_sync on public.credential_nexon_accounts;
create trigger credential_nexon_accounts_refresh_sync
  after insert or delete or update on public.credential_nexon_accounts
  for each statement execute function public.refresh_character_sync_state();

-- 캐릭터 → 호출에 써야 할 키. 스케줄러 API 프록시가 이 뷰를 읽는다.
drop view if exists public.v_character_sync_source;
create view public.v_character_sync_source
with (security_invoker = true) as
select
  ch.id            as character_id,
  ch.user_id,
  ch.character_name,
  ch.world_name,
  ch.ocid,
  ch.is_main,
  ch.sync_state,
  ch.nexon_account_ref,
  na.nexon_account_id,
  cred.id          as credential_id,
  cred.label       as credential_label,
  cred.is_primary  as credential_is_primary,
  cred.allow_server_side_use
from public.characters ch
left join public.user_nexon_accounts na on na.id = ch.nexon_account_ref
left join lateral (
  -- 그 계정에 붙은 유효한 키 중 가장 최근에 검증된 것
  select c.id, c.label, c.is_primary, c.allow_server_side_use
  from public.credential_nexon_accounts l
  join public.user_credentials c on c.id = l.credential_id
  where l.nexon_account_ref = ch.nexon_account_ref
    and c.user_id = ch.user_id
    and c.invalidated_at is null
  order by c.last_validated_at desc nulls last, c.created_at
  limit 1
) cred on true;

comment on view public.v_character_sync_source is
  '캐릭터별로 스케줄러 API 호출에 써야 할 자격증명. credential_id 가 null 이면 동기화 불가(읽기는 가능).';

-- -----------------------------------------------------------------------------
-- 12-5. 본캐 ↔ 스냅샷 ↔ 주 키 연동
-- -----------------------------------------------------------------------------
-- **트리거로 한 이유** (앱이 아니라):
--   본캐가 정해지는 경로가 여러 개다 — 최초 가입 시 자동 지정, 웹에서 변경, 부계정 키 추가 후 변경.
--   세 경로가 전부 (a) app_users 스냅샷 갱신 (b) 주 키 이동 을 정확히 해야 하는데,
--   한 곳만 빠뜨리면 **화면에 뜨는 본캐 닉네임과 실제 본캐가 갈라진다.**
--   정체성이 갈라지는 건 조용한 치명상이라 DB 에서 한 번만 구현한다. seat_no 와 같은 판단이다.
create or replace function public.characters_sync_main_identity()
returns trigger
language plpgsql
as $func$
declare
  v_cred uuid;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  if not new.is_main then
    return null;
  end if;

  -- (a) 표시 정체성 스냅샷
  update public.app_users
     set main_character_name = new.character_name,
         main_world_name     = new.world_name
   where id = new.user_id
     and (main_character_name is distinct from new.character_name
       or main_world_name     is distinct from new.world_name);

  -- (b) 주 키를 본캐가 속한 계정의 키로 옮긴다.
  select c.id into v_cred
    from public.credential_nexon_accounts l
    join public.user_credentials c on c.id = l.credential_id
   where l.nexon_account_ref = new.nexon_account_ref
     and c.user_id = new.user_id
     and c.invalidated_at is null
   order by c.last_validated_at desc nulls last, c.created_at
   limit 1;

  if v_cred is not null then
    update public.user_credentials
       set is_primary = false
     where user_id = new.user_id and is_primary and id <> v_cred;

    update public.user_credentials
       set is_primary = true
     where id = v_cred and not is_primary;
  end if;

  return null;
end;
$func$;

drop trigger if exists characters_sync_main_identity on public.characters;
create trigger characters_sync_main_identity
  after insert or update of is_main, character_name, world_name, nexon_account_ref
  on public.characters
  for each row execute function public.characters_sync_main_identity();

-- -----------------------------------------------------------------------------
-- 12-6. 로그인 해석 — **어느 키로도 같은 사람**
-- -----------------------------------------------------------------------------
-- 이것이 이번 요구의 핵심이다.
--   `api_key_hash` 가 **전역 유니크**이므로 해시 하나는 반드시 사용자 한 명으로만 해석된다.
--   주 키든 연결 키든 결과는 같은 `user_id` 이고, 표시 정체성도 같은 본캐 닉네임이다.
--   새 기기에서, 세션 없이, 한참 뒤에 부계정 키만 들고 와도 동일 계정으로 들어온다.
--   **"로그인하려면 주 키여야 한다" 같은 제약은 두지 않는다.**
create or replace function public.resolve_login_by_key_hash(p_api_key_hash text)
returns table (
  user_id             uuid,
  main_character_name text,
  main_world_name     text,
  credential_id       uuid,
  credential_label    text,
  is_primary          boolean,
  is_invalidated      boolean,
  account_status      public.account_status
)
language sql
stable
parallel safe
as $func$
  select u.id,
         u.main_character_name,
         u.main_world_name,
         c.id,
         c.label,
         c.is_primary,
         (c.invalidated_at is not null),
         u.status
  from public.user_credentials c
  join public.app_users u on u.id = c.user_id
  where c.api_key_hash = p_api_key_hash
    and u.deleted_at is null;
$func$;

comment on function public.resolve_login_by_key_hash(text) is
  '키 해시로 로그인 해석. 주 키/연결 키 구분 없이 같은 사용자와 같은 본캐 정체성을 돌려준다.';

-- 키 추가는 **이미 로그인한 상태에서만** 가능하다(그래야 "이 키를 이 사람에게 붙인다"가 성립).
-- 이미 다른 사용자에게 묶인 키는 **거부**한다 — 조용히 소유자를 바꾸면 계정 탈취가 된다.
create or replace function public.attach_nexon_credential(
  p_user_id      uuid,
  p_api_key_hash text,
  p_label        text default null,
  p_make_primary boolean default false
)
returns uuid
language plpgsql
as $func$
declare
  v_owner uuid;
  v_id    uuid;
begin
  if p_user_id is null then
    raise exception '키 추가는 로그인한 상태에서만 가능합니다.' using errcode = 'invalid_authorization_specification';
  end if;

  select user_id into v_owner
    from public.user_credentials
   where api_key_hash = p_api_key_hash;

  if found and v_owner <> p_user_id then
    -- ★ 계정 탈취 방지. 소유자를 조용히 바꾸지 않는다.
    --   두 계정을 합치려면 별도의 명시적 병합 절차가 필요하다(현재 미구현 — DB-SCHEMA.md 참조).
    raise exception '이 API 키는 이미 다른 계정에 등록되어 있습니다. 계정 병합은 별도 절차가 필요합니다.'
      using errcode = 'unique_violation';
  end if;

  if found then
    update public.user_credentials
       set label = coalesce(p_label, label),
           invalidated_at = null,
           last_validated_at = now()
     where api_key_hash = p_api_key_hash
     returning id into v_id;
  else
    insert into public.user_credentials (user_id, api_key_hash, label, last_validated_at)
    values (p_user_id, p_api_key_hash, p_label, now())
    returning id into v_id;
  end if;

  if p_make_primary then
    update public.user_credentials set is_primary = false
     where user_id = p_user_id and is_primary and id <> v_id;
    update public.user_credentials set is_primary = true
     where id = v_id and not is_primary;
  end if;

  return v_id;
end;
$func$;

comment on function public.attach_nexon_credential(uuid, text, text, boolean) is
  '로그인 상태에서 부계정 키를 추가한다. 다른 사용자에게 이미 묶인 키는 거부한다(계정 탈취 방지).';

-- -----------------------------------------------------------------------------
-- 12-7. RLS — 신규 테이블/뷰
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  private_tables text[] := array['credential_nexon_accounts'];
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

revoke all on table public.v_character_sync_source from anon;
revoke all on table public.v_character_sync_source from authenticated;
grant all on table public.v_character_sync_source to service_role;

revoke all on function public.resolve_login_by_key_hash(text) from public;
revoke all on function public.resolve_login_by_key_hash(text) from anon;
revoke all on function public.resolve_login_by_key_hash(text) from authenticated;
grant execute on function public.resolve_login_by_key_hash(text) to service_role;

revoke all on function public.attach_nexon_credential(uuid, text, text, boolean) from public;
revoke all on function public.attach_nexon_credential(uuid, text, text, boolean) from anon;
revoke all on function public.attach_nexon_credential(uuid, text, text, boolean) from authenticated;
grant execute on function public.attach_nexon_credential(uuid, text, text, boolean) to service_role;

revoke all on function public.character_is_syncable(uuid, uuid) from public;
revoke all on function public.character_is_syncable(uuid, uuid) from anon;
revoke all on function public.character_is_syncable(uuid, uuid) from authenticated;
grant execute on function public.character_is_syncable(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  -- 민감 컬럼 가드 (11-A-2). 새 컬럼에도 반드시 적용된다.
  perform public.assert_no_public_sensitive_columns();

  -- 자격증명 관련 컬럼이 공개 역할에 노출되지 않았는지 직접 재확인
  if has_column_privilege('anon', 'public.user_credentials', 'api_key_hash', 'SELECT')
     or has_column_privilege('anon', 'public.user_credentials', 'encrypted_api_key', 'SELECT')
     or has_column_privilege('anon', 'public.user_nexon_accounts', 'nexon_account_id', 'SELECT')
     or has_column_privilege('anon', 'public.credential_nexon_accounts', 'credential_id', 'SELECT') then
    raise exception '자격증명 관련 컬럼이 anon 에게 노출되어 있습니다.';
  end if;

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

  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;

-- ============================================================
-- 20260817091300_party_rooms_and_notifications.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 13. 파티 ↔ 카톡방 바인딩 + 알림 라우팅
-- =============================================================================
-- 발주자 원문:
--   "알리미를 생각하면 보스 파티의 생성자도 필요할 거 같음. 그 사람이 존재하는 카톡방
--    (카톡방에서 `!보스등록 더저` 하면 등록되고 그 사람에게 알림 가도록).
--    그럼 생성자 = 카톡 등록된 사람일 때 그 카톡방에다가
--    `19시 1파티 보스 (파티원1, 2 3 4)` 이런 식으로 알림 가게 할 것임"
--
-- ── 핵심 결정: 알림은 **사람**이 아니라 **파티에 바인딩된 방**을 따라간다 ───────
-- 발주자는 "생성자가 존재하는 카톡방"이라고 했지만, 사람 기준으로 라우팅하면
-- **한 사람이 여러 방에 있을 때 전 방에 도배된다.** 생성자는 "누가 만들었나"를 기록할 뿐이고,
-- 알림의 목적지는 그 파티가 태어난(또는 사용자가 고른) **방 하나**다. (CLAUDE.md §2.3)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 13-1. 파티 ↔ 방 바인딩
-- -----------------------------------------------------------------------------
-- **1:1 (nullable FK)** 로 둔다.
--   * 방에서 `!보스등록` 으로 만든 파티 → 그 방에 바인딩
--   * 웹에서 만든 파티 → 사용자가 자기가 연결된 방 중 하나를 고르거나, **아무 방도 아님**(푸시 없음)
--   * null 이 정상 상태다. 웹 전용 파티는 알림을 보내지 않는다.
--
-- ── 한 파티가 여러 방에 보내야 할 수도 있는가? ──────────────────────────────
-- 지금은 아니다. 같은 파티 공지가 두 방에 뜨면 참가 응답이 갈라지고, 어느 방에서 온 `!등록`인지
-- 추적해야 하는 문제가 새로 생긴다. **기본 1:1 로 확정한다.**
-- 다만 확장 비용을 0으로 만들어 둔다: 호출부는 절대 `parties.bot_channel_id` 를 직접 읽지 않고
-- **`party_notify_channel_ids(party_id)` 함수**(0..N 행 반환)를 통해서만 목적지를 얻는다.
-- 나중에 다중 방이 필요해지면 링크 테이블을 만들고 이 함수 하나만 고치면 되며,
-- 알림 적재 로직·서버 코드는 한 줄도 바뀌지 않는다.
alter table public.parties
  add column if not exists bot_channel_id uuid
    references public.bot_channels(id) on delete set null;

comment on column public.parties.bot_channel_id is
  '알림이 갈 카톡방. null = 웹 전용 파티(푸시 없음). **어느 방인지는 사적 정보라 공개 시간표에 절대 노출하지 않는다.**';

-- 방별 파티 목록 조회 (봇이 `!일정` 처리할 때)
create index if not exists parties_channel_idx
  on public.parties (bot_channel_id) where bot_channel_id is not null;

-- 목적지 해석의 유일한 진입점. 오늘은 0..1행, 나중에 다중 방이면 여기만 고친다.
create or replace function public.party_notify_channel_ids(p_party_id uuid)
returns setof uuid
language sql
stable
parallel safe
as $func$
  select p.bot_channel_id
  from public.parties p
  where p.id = p_party_id
    and p.bot_channel_id is not null;
$func$;

comment on function public.party_notify_channel_ids(uuid) is
  '파티 알림 목적지 채널 목록(현재 0..1행). 다중 방 확장 시 이 함수만 교체하면 호출부는 그대로다.';

-- -----------------------------------------------------------------------------
-- 13-2. 생성자 — 이미 있는 것으로 충분하다
-- -----------------------------------------------------------------------------
-- `parties.owner_user_id`      : **파티 생성자.** 알림 책임자이자 파티 설정의 주인.
--                                `not null references app_users` 이므로 **게스트는 파티를 만들 수 없다.**
-- `party_runs.created_by_participant_id` : 그 **일정 항목**을 만든 사람(참가자 단위, 게스트 가능).
--                                파티는 우레푸가 만들었지만 이번 주 하드 스우 런은 라이언이 잡을 수 있다.
-- 두 컬럼은 역할이 다르며 둘 다 필요하다. 새로 만들 것이 없다.
--
-- ★ 게스트는 파티를 만들 수 없다 — 이미 스키마가 강제하고 있고, 그게 옳다.
--   방에서 `!연결` 없이 `!보스등록` 을 치면 알림 대상(어느 계정에게?)과 분배 주체(누가 owner?)가
--   불명확해진다. 봇은 research-KAKAO-BOT §2.4 의 🔒 안내를 돌려주고 연결을 요구해야 한다.

-- -----------------------------------------------------------------------------
-- 13-3. 파티 번호 — 방 + 주차 범위
-- -----------------------------------------------------------------------------
-- 평문 한 줄에서 파티를 가리키려면 번호가 필요하다. `19시 **1파티** 스우 (...)`.
--
-- **범위를 (방, 주차)로 잡은 이유**: `parties` 는 여러 주에 걸쳐 지속되는 사람 묶음이라
-- 파티 테이블의 컬럼 하나로는 "이번 주 1파티"를 표현할 수 없다. 그래서 별도 테이블이다.
-- 방마다 매주 1번부터 다시 시작하므로 번호가 무한정 커지지 않고, 활동을 멈춘 파티가
-- 번호를 영구 점유하지도 않는다.
--
-- ★ seat_no 와 같은 규칙: **한 주 안에서 번호는 재배열하지 않는다.**
--   2파티가 취소돼도 3파티가 2파티가 되지 않는다. 방에서 진행 중이던 대화가 어긋나기 때문이다.
--   빈 번호는 그 주 내내 비워 둔다.
create table if not exists public.party_room_numbers (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.bot_channels(id) on delete cascade,
  week_key    text not null check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  party_id    uuid not null references public.parties(id) on delete cascade,

  party_no    smallint not null check (party_no >= 1),
  assigned_at timestamptz not null default now(),

  constraint party_room_numbers_no_uniq    unique (channel_id, week_key, party_no),
  constraint party_room_numbers_party_uniq unique (channel_id, week_key, party_id)
);

comment on table public.party_room_numbers is
  '방 × 주차 범위의 파티 번호(1파티, 2파티). 한 주 안에서 재배열하지 않으며 빈 번호를 재사용하지 않는다.';

create index if not exists party_room_numbers_party_idx
  on public.party_room_numbers (party_id, week_key);

-- 번호 부여. 이미 있으면 그대로 돌려준다(멱등).
--
-- **주 사이 안정성**: 지난주에 쓰던 번호가 이번 주에 비어 있으면 **그 번호를 다시 준다.**
-- 그래야 "1파티는 계속 1파티"라는 방 사람들의 기대가 유지된다. 비어 있지 않으면 max+1.
--
-- **경쟁 조건**: seat_no 와 같은 이유로 (방, 주차) 단위 advisory lock 으로 직렬화하고,
-- unique 제약을 backstop 으로 둔다.
create or replace function public.assign_party_number(
  p_party_id uuid,
  p_week_key text
)
returns smallint
language plpgsql
as $func$
declare
  v_channel uuid;
  v_no      smallint;
  v_prev    smallint;
begin
  select p.bot_channel_id into v_channel
    from public.parties p where p.id = p_party_id;

  -- 방에 바인딩되지 않은 파티(웹 전용)는 번호가 없다. 정상이다.
  if v_channel is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('party_no:' || v_channel::text || ':' || p_week_key, 0)
  );

  select party_no into v_no
    from public.party_room_numbers
   where channel_id = v_channel and week_key = p_week_key and party_id = p_party_id;
  if found then
    return v_no;
  end if;

  -- 지난 주차들에서 이 파티가 쓰던 가장 최근 번호
  select n.party_no into v_prev
    from public.party_room_numbers n
   where n.channel_id = v_channel
     and n.party_id = p_party_id
     and n.week_key < p_week_key
   order by n.week_key desc
   limit 1;

  if v_prev is not null and not exists (
       select 1 from public.party_room_numbers
        where channel_id = v_channel and week_key = p_week_key and party_no = v_prev
     ) then
    v_no := v_prev;
  else
    select coalesce(max(party_no), 0) + 1 into v_no
      from public.party_room_numbers
     where channel_id = v_channel and week_key = p_week_key;
  end if;

  insert into public.party_room_numbers (channel_id, week_key, party_id, party_no)
  values (v_channel, p_week_key, p_party_id, v_no);

  return v_no;
end;
$func$;

comment on function public.assign_party_number(uuid, text) is
  '방×주차 파티 번호를 멱등하게 부여한다. 지난주 번호가 비어 있으면 재사용해 "1파티는 계속 1파티"를 유지한다.';

-- 런이 생기면 그 주차의 파티 번호를 확보해 둔다(알림 문구가 바로 번호를 쓸 수 있게).
create or replace function public.party_runs_ensure_party_number()
returns trigger
language plpgsql
as $func$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.assign_party_number(new.party_id, new.week_key);
  return null;
end;
$func$;

drop trigger if exists party_runs_ensure_party_number on public.party_runs;
create trigger party_runs_ensure_party_number
  after insert or update of party_id, scheduled_at on public.party_runs
  for each row execute function public.party_runs_ensure_party_number();

-- -----------------------------------------------------------------------------
-- 13-4. 알림 문구 생성 — DB 단일 구현
-- -----------------------------------------------------------------------------
-- distribute_meso / resolve_availability 와 같은 이유로 DB 에 둔다:
-- **웹 미리보기와 봇 실제 발송이 갈라지면 안 된다.**
--
-- 카카오톡 평문 제약(research-KAKAO-BOT §1.4):
--   마크다운·HTML 금지 / **가변폭 폰트라 공백 정렬 금지** / 350자 예산 / 이모지 절제(줄당 1~2개)

-- KST 시각 표기. 같은 날이면 '19시', 다른 날이면 '8/20(목) 19시'.
create or replace function public.format_kst_when(p_at timestamptz, p_ref timestamptz)
returns text
language sql
immutable
parallel safe
as $func$
  with v as (
    select public.kst_date(p_at) as d,
           (floor((extract(epoch from (p_at - to_timestamp(0))) + 32400) / 60)::bigint % 1440) as mod
  )
  select case
           when p_ref is not null and v.d = public.kst_date(p_ref) then ''
           else extract(month from v.d)::int::text || '/'
             || extract(day   from v.d)::int::text || '('
             || (array['월','화','수','목','금','토','일'])[extract(isodow from v.d)::int] || ') '
         end
      || (v.mod / 60)::int::text || '시'
      || case when (v.mod % 60) <> 0 then (v.mod % 60)::int::text || '분' else '' end
  from v;
$func$;

comment on function public.format_kst_when(timestamptz, timestamptz) is
  'KST 시각 표기. 기준일과 같은 날이면 시각만, 다르면 날짜(요일)까지 붙인다.';

-- 알림 문구. 발주자 예시 형태: `19시 1파티 스우 (우레푸, 라이언, 어피치, 프로도)`
--   p_kind = 'plain'   → 그 줄만
--            'created' → 📌 + 그 줄
--            'remind'  → ⏰ 30분 전 + 줄바꿈 + 그 줄
create or replace function public.format_run_notice(
  p_run_id    uuid,
  p_kind      text default 'plain',
  p_now       timestamptz default now(),
  p_max_names integer default 4
)
returns text
language plpgsql
stable
as $func$
declare
  v_boss    text;
  v_sched   timestamptz;
  v_week    text;
  v_party   uuid;
  v_when    text;
  v_no      smallint;
  v_names   text[];
  v_total   integer;
  v_names_s text;
  v_line    text;
begin
  select bd.korean_name, r.scheduled_at, r.week_key, r.party_id
    into v_boss, v_sched, v_week, v_party
    from public.party_runs r
    join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
   where r.id = p_run_id;

  if not found then
    return null;
  end if;

  v_when := case
    when v_sched is null then '시간미정'
    else public.format_kst_when(v_sched, p_now)
  end;

  select n.party_no into v_no
    from public.party_room_numbers n
   where n.party_id = v_party and n.week_key = v_week;

  -- 이름은 **display_name 스냅샷**만 쓴다. 계정 UUID·닉네임 조인으로 개인정보가 새지 않게.
  select array_agg(pp.display_name order by s.seat_no), count(*)
    into v_names, v_total
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.run_id = p_run_id and s.status = 'going';

  v_total := coalesce(v_total, 0);

  if v_total = 0 then
    v_names_s := '모집중';
  elsif v_total > p_max_names then
    v_names_s := array_to_string(v_names[1:p_max_names], ', ')
              || ' …외 ' || (v_total - p_max_names)::text || '명';
  else
    v_names_s := array_to_string(v_names, ', ');
  end if;

  -- 공백 정렬 없이 단순 연결한다(가변폭 폰트에서 표는 반드시 어긋난다).
  v_line := v_when || ' '
         || case when v_no is not null then v_no::text || '파티 ' else '' end
         || v_boss
         || ' (' || v_names_s || ')';

  v_line := case p_kind
    when 'created' then '📌 ' || v_line
    when 'remind'  then '⏰ 30분 전' || chr(10) || v_line
    else v_line
  end;

  -- 350자 예산. 넘으면 잘라낸다(카톡이 '전체보기'로 접는 것을 피한다).
  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$func$;

comment on function public.format_run_notice(uuid, text, timestamptz, integer) is
  '카톡 평문 알림 문구. 발주자 예시 형태 `19시 1파티 스우 (우레푸, ...)`. 웹 미리보기와 봇 발송이 같은 값을 쓴다.';

-- -----------------------------------------------------------------------------
-- 13-5. 아웃박스 적재
-- -----------------------------------------------------------------------------
-- ── 무엇을 언제 적재하는가 ─────────────────────────────────────────────────
--   run_created : 파티(런) 생성 알림. **명령 처리가 끝난 뒤 서버가 1회 적재.**
--   run_remind  : 시작 30분 전 리마인더. **서버 스케줄러가 주기적으로 적재.**
--
-- ── 왜 트리거가 아니라 서버인가 ────────────────────────────────────────────
--   1) `bot_outbox` 는 **문자열을 얼려서** 담는 구조다. 즉 "문구를 언제 만드느냐"가 곧 내용이다.
--      생성 트리거는 참가자가 다 들어오기 전에 발화하므로 `(모집중)` 만 담긴 알림이 나간다.
--      `!보스등록` 명령은 파티·런·참가자를 함께 만들므로, 그 처리가 **끝난 뒤** 적재해야
--      발주자가 원한 `(우레푸, 라이언, 어피치, 프로도)` 형태가 나온다.
--   2) "30분 전"은 **시간 기반**이라 애초에 트리거로 표현할 수 없다. 아무 행도 바뀌지 않아도
--      시간이 흐르면 발화해야 한다. → 주기 잡이 유일한 방법이다.
--   → **DB 는 규칙(dedupe 규약·TTL·문구)을 소유하고, 서버는 타이밍만 소유한다.**
--      규칙이 DB 에 있으므로 웹·봇·스케줄러가 같은 문구와 같은 중복 방지를 공유한다.
--
-- ── dedupe_key 규약 ────────────────────────────────────────────────────────
--   `{목적}:{엔티티ID}:{시점}`
--     run_created:<run_id>
--     run_remind:<run_id>:T-30
--     weekly_summary:<week_key>        ← 주차 표기는 **반드시 week_key(KST 목 00:00 경계)**
--   ⚠️ ISO 주차를 쓰면 수·목 알림이 두 주에 걸쳐 중복 생성된다. week_key 만 쓴다.
create or replace function public.enqueue_run_notice(
  p_run_id uuid,
  p_kind   text default 'created',
  p_now    timestamptz default now()
)
returns integer
language plpgsql
as $func$
declare
  v_channel  uuid;
  v_party    uuid;
  v_sched    timestamptz;
  v_reply    text;
  v_key      text;
  v_expires  timestamptz;
  v_inserted integer := 0;
  v_hit      integer;
begin
  select r.party_id, r.scheduled_at
    into v_party, v_sched
    from public.party_runs r
   where r.id = p_run_id;

  if not found then
    return 0;
  end if;

  v_reply := public.format_run_notice(p_run_id, p_kind, p_now);
  if v_reply is null then
    return 0;
  end if;

  if p_kind = 'remind' then
    v_key := 'run_remind:' || p_run_id::text || ':T-30';
    -- 지난 알림은 가치가 음수다. 보스 시각 + 15분이면 폐기한다.
    v_expires := coalesce(v_sched, p_now) + interval '15 minutes';
  else
    v_key := 'run_created:' || p_run_id::text;
    v_expires := p_now + interval '2 hours';
  end if;

  -- 목적지는 함수를 통해서만 얻는다(다중 방 확장 시 여기 코드는 그대로).
  for v_channel in select * from public.party_notify_channel_ids(v_party) loop
    insert into public.bot_outbox (channel_id, dedupe_key, reply, expires_at, visible_after)
    values (v_channel, v_key, v_reply, v_expires, p_now)
    on conflict (channel_id, dedupe_key) do nothing;

    get diagnostics v_hit = row_count;
    v_inserted := v_inserted + v_hit;
  end loop;

  return v_inserted;   -- 0 이면 목적지가 없거나 이미 적재됨(중복)
end;
$func$;

comment on function public.enqueue_run_notice(uuid, text, timestamptz) is
  '런 알림을 아웃박스에 적재한다. dedupe_key 로 중복을 막고 TTL 을 규약대로 건다. 반환값 0 = 목적지 없음 또는 이미 적재됨.';

-- 스케줄러가 "지금 30분 전 알림을 적재해야 할 런" 목록을 얻는 곳.
-- 서버는 이 뷰를 읽고 각 행에 대해 enqueue_run_notice(run_id, 'remind') 를 호출하면 된다.
drop view if exists public.v_pending_run_reminders;
create view public.v_pending_run_reminders
with (security_invoker = true) as
select
  r.id                                   as run_id,
  r.party_id,
  p.bot_channel_id,
  r.week_key,
  r.scheduled_at,
  r.scheduled_at - interval '30 minutes' as remind_at
from public.party_runs r
join public.parties p on p.id = r.party_id
where p.bot_channel_id is not null
  and r.scheduled_at is not null
  and r.status in ('proposed', 'confirmed')
  and r.cancelled_at is null
  and not exists (
    select 1 from public.bot_outbox o
    where o.channel_id = p.bot_channel_id
      and o.dedupe_key = 'run_remind:' || r.id::text || ':T-30'
  );

comment on view public.v_pending_run_reminders is
  '30분 전 리마인더를 아직 적재하지 않은 런. 스케줄러가 remind_at <= now() < scheduled_at 조건으로 걸러 적재한다.';

-- -----------------------------------------------------------------------------
-- 13-6. `!보스등록 <보스>` 경로 점검 결과
-- -----------------------------------------------------------------------------
-- 이 명령 하나로 파티+런이 만들어지려면 필요한 것들:
--   ✅ 발신자 → bot_channel_members → app_users        (마이그레이션 06, 이미 있음)
--   ✅ 보스 별칭 해석 → boss_aliases                   (마이그레이션 02, **시드는 아직 없음**)
--   ✅ 파티 생성자                → parties.owner_user_id (게스트 불가, 이미 강제됨)
--   ✅ 방 바인딩                  → parties.bot_channel_id (이 마이그레이션)
--   ✅ 파티 번호                  → party_room_numbers     (이 마이그레이션)
--   ✅ 알림 문구·적재             → format_run_notice / enqueue_run_notice (이 마이그레이션)
--
-- 시간 미지정(`!보스등록 더저` 처럼 시각이 없을 때):
--   `party_runs.scheduled_at` 이 **nullable** 이므로 시각 없이도 런을 만들 수 있다.
--   그 경우 문구는 `시간미정 1파티 ...` 이 되고, `v_pending_run_reminders` 는
--   `scheduled_at is not null` 조건 때문에 **리마인더를 만들지 않는다**(보낼 시각이 없으므로).
--   봇은 research-KAKAO-BOT §2.4 대로 되묻는 것을 우선하고, 사용자가 생략을 고집하면
--   시각 없는 런으로 만든 뒤 나중에 `!등록 <보스> <시간>` 으로 채우게 한다.
--   → 스키마 변경 없이 성립한다.

-- -----------------------------------------------------------------------------
-- 13-7. RLS — 신규 테이블
-- -----------------------------------------------------------------------------
-- ★ 어느 카톡방인지는 **사적 정보**다. 공개 시간표로 절대 새면 안 된다.
--   `parties.bot_channel_id` 는 11 마이그레이션의 **컬럼 단위 GRANT** 덕분에
--   자동으로 제외된다(새 컬럼은 기본이 닫힘). 아래 자기검증에서 실제로 확인한다.
do $$
declare
  t text;
  private_tables text[] := array['party_room_numbers'];
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

revoke all on table public.v_pending_run_reminders from anon;
revoke all on table public.v_pending_run_reminders from authenticated;
grant all on table public.v_pending_run_reminders to service_role;

-- 알림 적재·번호 부여는 서버만 한다.
revoke all on function public.enqueue_run_notice(uuid, text, timestamptz) from public;
revoke all on function public.enqueue_run_notice(uuid, text, timestamptz) from anon;
revoke all on function public.enqueue_run_notice(uuid, text, timestamptz) from authenticated;
grant execute on function public.enqueue_run_notice(uuid, text, timestamptz) to service_role;

revoke all on function public.assign_party_number(uuid, text) from public;
revoke all on function public.assign_party_number(uuid, text) from anon;
revoke all on function public.assign_party_number(uuid, text) from authenticated;
grant execute on function public.assign_party_number(uuid, text) to service_role;

-- 문구 생성은 참가자 이름을 읽으므로 서버 전용으로 잠근다.
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer) from public;
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer) from anon;
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer) from authenticated;
grant execute on function public.format_run_notice(uuid, text, timestamptz, integer) to service_role;

revoke all on function public.party_notify_channel_ids(uuid) from public;
revoke all on function public.party_notify_channel_ids(uuid) from anon;
revoke all on function public.party_notify_channel_ids(uuid) from authenticated;
grant execute on function public.party_notify_channel_ids(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 13-8. 민감 컬럼 가드 확장 — 방/채널 참조도 잡는다
-- -----------------------------------------------------------------------------
-- `bot_channel_id` 는 기존 패턴(share/meso/_bp/secret/hash/token/api_key) 중 어디에도 걸리지 않는다.
-- 어느 방에 속하는지는 사적 정보이므로 **`%channel%` 과 `%room%` 을 패턴에 추가**한다.
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
          -- 13 추가: 어느 카톡방/채널에 속하는지는 사적 정보다.
          or c.column_name ilike '%channel%'
          or c.column_name ilike '%room%'
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

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  -- (1) 민감 컬럼 가드 (CLAUDE.md §0.3 — 새 마이그레이션 필수 호출)
  perform public.assert_no_public_sensitive_columns();

  -- (2) 방 바인딩이 공개 시간표로 새지 않는가
  if has_column_privilege('anon', 'public.parties', 'bot_channel_id', 'SELECT') then
    raise exception 'parties.bot_channel_id 가 anon 에게 노출되어 있습니다. 어느 카톡방인지는 사적 정보입니다.';
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

  -- (4) 공개 역할 쓰기 권한
  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;

  -- (5) 시각 표기 규칙
  if public.format_kst_when(timestamptz '2026-08-20 19:00+09', timestamptz '2026-08-20 12:00+09') <> '19시' then
    raise exception '같은 날 시각 표기 오류: %',
      public.format_kst_when(timestamptz '2026-08-20 19:00+09', timestamptz '2026-08-20 12:00+09');
  end if;
  if public.format_kst_when(timestamptz '2026-08-20 19:30+09', timestamptz '2026-08-17 12:00+09') <> '8/20(목) 19시30분' then
    raise exception '다른 날 시각 표기 오류: %',
      public.format_kst_when(timestamptz '2026-08-20 19:30+09', timestamptz '2026-08-17 12:00+09');
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817091400_management_numbers.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 14. 관리 번호 정리 — 파티원 번호 / 일정 번호
-- =============================================================================
-- 화면 작업에서 드러난 결함 2건을 고친다.
--
--   결함 2: `party_runs` 에 일정 번호가 없다. §1.4 는 등록한 일정이 "번호와 함께 쌓임"을 요구한다.
--   결함 3: 참가자 번호(`seat_no`)가 **런 단위**라 사람 호칭으로 못 쓴다.
--           "3번"이 런마다 달라지면 사람은 이해하지 못한다.
--
-- ── 통합 검토 결과: seat_no 를 **폐기하고 파티 단위 하나로 통일한다** ────────
-- 먼저 "두 번호를 하나로 합칠 수 있는가"를 검토했고, **합칠 수 있다.**
--   * 런 참가자는 언제나 파티 참가자의 부분집합이다. 런 단위로 1..n 을 다시 매기면
--     같은 사람이 런마다 다른 번호를 갖게 되는데, 이게 정확히 결함 3이다.
--   * `!분배 1번 33` 의 "1번"은 **사람**을 가리킨다. 분배 자체는 런 단위가 맞지만
--     (실제 들어간 사람이 나눔), 호칭은 파티 단위여야 한다.
--   * 균등 분배의 결정론적 순서, 알림 문구의 이름 나열 순서도 파티 단위 번호로 충분하다.
-- → `run_signups.seat_no` 를 **제거**하고 `party_participants.member_no` 하나만 남긴다.
--   컬럼·트리거·제약이 줄어든다.
--
-- ── 남는 세 번호는 축이 서로 다르다 (역할이 겹치지 않는다) ──────────────────
--   party_room_numbers.party_no  : 방 안의 **파티**를 가리킴    · 스코프 (방, 주차)
--   party_runs.run_no            : 파티 안의 **일정**을 가리킴  · 스코프 (파티)
--   party_participants.member_no : 파티 안의 **사람**을 가리킴  · 스코프 (파티)
-- 셋 다 §1.4 의 공통 규칙을 따른다: **재배열 금지, 빈 번호 재사용 금지, 신규는 max+1.**
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 14-1. party_participants.member_no — 파티 안에서 사람을 부르는 번호
-- -----------------------------------------------------------------------------
alter table public.party_participants
  add column if not exists member_no smallint;

-- 기존 행 백필(가입 순서). 이미 번호가 있으면 건드리지 않고 그 뒤에 이어 붙인다.
update public.party_participants pp
   set member_no = x.new_no
  from (
    select p.id,
           (coalesce(m.max_no, 0)
            + row_number() over (partition by p.party_id order by p.joined_at, p.id))::smallint as new_no
    from public.party_participants p
    left join (
      select party_id, max(member_no) as max_no
      from public.party_participants
      where member_no is not null
      group by party_id
    ) m on m.party_id = p.party_id
    where p.member_no is null
  ) x
 where pp.id = x.id and pp.member_no is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'party_participants_member_no_positive') then
    alter table public.party_participants
      add constraint party_participants_member_no_positive check (member_no is null or member_no >= 1);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'party_participants_member_no_uniq') then
    alter table public.party_participants
      add constraint party_participants_member_no_uniq unique (party_id, member_no);
  end if;

  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'party_participants'
           and column_name = 'member_no' and is_nullable = 'YES'
      )
     and not exists (select 1 from public.party_participants where member_no is null) then
    alter table public.party_participants alter column member_no set not null;
  end if;
end
$$;

comment on column public.party_participants.member_no is
  '파티 안에서 사람을 부르는 번호(1부터). 봇의 `!분배 1번 33` 이 가리키는 대상. **재배열/재사용 금지** — 대화 중 지칭이 어긋나면 안 된다.';

-- seat_no 와 같은 이유로 트리거에 둔다: 참가자를 만드는 경로가 웹·봇·초대 링크로 여럿이라
-- 앱에 두면 한 곳만 빠뜨려도 번호가 겹치거나 빈다. 경쟁 조건은 advisory lock + unique 로 막는다.
create or replace function public.party_participants_assign_member_no()
returns trigger
language plpgsql
as $func$
declare
  v_next smallint;
begin
  if new.member_no is not null then
    return new;   -- 명시 지정(복원·이관)은 존중한다
  end if;

  perform pg_advisory_xact_lock(hashtextextended('party_member:' || new.party_id::text, 0));

  select (coalesce(max(member_no), 0) + 1)::smallint
    into v_next
    from public.party_participants
   where party_id = new.party_id;

  new.member_no := v_next;
  return new;
end;
$func$;

drop trigger if exists party_participants_assign_member_no on public.party_participants;
create trigger party_participants_assign_member_no
  before insert on public.party_participants
  for each row execute function public.party_participants_assign_member_no();

-- -----------------------------------------------------------------------------
-- 14-2. party_runs.run_no — 파티 안에서 일정을 부르는 번호
-- -----------------------------------------------------------------------------
-- **스코프를 (파티)로 잡고 주차를 넣지 않은 이유**:
--   1) 번호는 관리 식별자다. 주차를 넣으면 런을 다음 주로 옮길 때 번호가 바뀌거나
--      새 주차에서 충돌한다. **일정 하나를 미뤘다고 번호가 달라지면 안 된다.**
--   2) §1.4 의 오른쪽 패널은 "이 파티에 등록된 일정 목록"이고, 번호는 그 목록의 영구 ID 다.
--   3) 방 안의 파티를 구분하는 `party_no` 가 이미 (방, 주차) 축을 담당한다.
--      같은 축을 두 번 쓰면 "이번 주 2번"이 파티인지 일정인지 모호해진다.
alter table public.party_runs
  add column if not exists run_no smallint;

update public.party_runs r
   set run_no = x.new_no
  from (
    select pr.id,
           (coalesce(m.max_no, 0)
            + row_number() over (partition by pr.party_id order by pr.created_at, pr.id))::smallint as new_no
    from public.party_runs pr
    left join (
      select party_id, max(run_no) as max_no
      from public.party_runs
      where run_no is not null
      group by party_id
    ) m on m.party_id = pr.party_id
    where pr.run_no is null
  ) x
 where r.id = x.id and r.run_no is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'party_runs_run_no_positive') then
    alter table public.party_runs
      add constraint party_runs_run_no_positive check (run_no is null or run_no >= 1);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'party_runs_run_no_uniq') then
    alter table public.party_runs
      add constraint party_runs_run_no_uniq unique (party_id, run_no);
  end if;

  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'party_runs'
           and column_name = 'run_no' and is_nullable = 'YES'
      )
     and not exists (select 1 from public.party_runs where run_no is null) then
    alter table public.party_runs alter column run_no set not null;
  end if;
end
$$;

comment on column public.party_runs.run_no is
  '파티 안에서 일정을 부르는 번호(1부터). 주차를 넣지 않아 일정을 미뤄도 번호가 변하지 않는다. **재배열/재사용 금지.**';

create or replace function public.party_runs_assign_run_no()
returns trigger
language plpgsql
as $func$
declare
  v_next smallint;
begin
  if new.run_no is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('party_run:' || new.party_id::text, 0));

  select (coalesce(max(run_no), 0) + 1)::smallint
    into v_next
    from public.party_runs
   where party_id = new.party_id;

  new.run_no := v_next;
  return new;
end;
$func$;

drop trigger if exists party_runs_assign_run_no on public.party_runs;
create trigger party_runs_assign_run_no
  before insert on public.party_runs
  for each row execute function public.party_runs_assign_run_no();

-- -----------------------------------------------------------------------------
-- 14-3. seat_no 를 쓰던 곳을 member_no 로 옮긴다
-- -----------------------------------------------------------------------------

-- (a) 분배 가중치 뷰
drop view if exists public.v_run_share_weights cascade;
create view public.v_run_share_weights
with (security_invoker = true) as
select
  s.run_id,
  s.participant_id,
  pp.member_no,
  pp.user_id,
  pp.guest_id,
  pp.display_name,
  s.share_bp,
  case
    when r.share_mode = 'auto_equal' then 1
    when coalesce(sum(s.share_bp) over (partition by s.run_id), 0) = 0 then 1
    else s.share_bp
  end as weight
from public.run_signups s
join public.party_runs r          on r.id = s.run_id
join public.party_participants pp on pp.id = s.participant_id
where s.status = 'going';

comment on view public.v_run_share_weights is
  '런별 분배 가중치. 균등 모드는 1(정확한 1/n), 사용자 지정 모드는 share_bp. 게스트도 포함된다.';

-- v_run_share_weights 를 참조하던 뷰들을 다시 만든다(cascade 로 함께 내려갔다).
drop view if exists public.v_run_crystal_settlement;
create view public.v_run_crystal_settlement
with (security_invoker = true) as
with run_pot as (
  select bc.run_id,
         max(bc.pot_meso)   as pot_meso,
         max(bc.party_size) as party_size,
         min(bc.week_key)   as week_key
  from public.boss_clears bc
  where bc.run_id is not null
    and bc.effective_cleared
    and bc.pot_meso is not null
  group by bc.run_id
),
agg as (
  select w.run_id,
         array_agg(w.participant_id order by w.participant_id) as keys,
         array_agg(w.weight order by w.participant_id)         as weights
  from public.v_run_share_weights w
  group by w.run_id
)
select
  p.run_id,
  p.week_key,
  p.pot_meso,
  p.party_size,
  d.key    as participant_id,
  w.member_no,
  w.user_id,
  w.display_name,
  w.share_bp,
  d.amount as amount_meso
from run_pot p
join agg a on a.run_id = p.run_id
cross join lateral public.distribute_meso(p.pot_meso, a.keys, a.weights) d
join public.v_run_share_weights w
  on w.run_id = p.run_id and w.participant_id = d.key;

comment on view public.v_run_crystal_settlement is
  '결정석 pot 의 참가자별 정산 결과. 게스트 포함 전원이 대상이라 amount_meso 합계가 pot 과 정확히 일치한다.';

drop view if exists public.v_run_drop_recipients cascade;
create view public.v_run_drop_recipients
with (security_invoker = true) as
select d.id as drop_id, w.participant_id, w.weight
from public.run_drops d
join public.v_run_share_weights w on w.run_id = d.run_id
where d.share_mode = 'party_default'
union all
select d.id, s.participant_id, s.share_bp
from public.run_drops d
join public.run_drop_shares s on s.drop_id = d.id
where d.share_mode = 'custom'
  and s.share_bp > 0
union all
select d.id, d.solo_participant_id, 1
from public.run_drops d
where d.share_mode = 'solo'
  and d.solo_participant_id is not null;

comment on view public.v_run_drop_recipients is
  '드랍 건별 수령자와 가중치. party_default/custom/solo 세 방식을 하나로 해석한다.';

drop view if exists public.v_run_drop_settlement;
create view public.v_run_drop_settlement
with (security_invoker = true) as
with agg as (
  select rc.drop_id,
         array_agg(rc.participant_id order by rc.participant_id) as keys,
         array_agg(rc.weight order by rc.participant_id)         as weights
  from public.v_run_drop_recipients rc
  group by rc.drop_id
)
select
  d.id       as drop_id,
  d.run_id,
  d.week_key,
  d.item_name,
  d.share_mode,
  d.sale_amount_meso,
  x.key      as participant_id,
  pp.member_no,
  pp.user_id,
  pp.display_name,
  x.amount   as amount_meso
from public.run_drops d
join agg a on a.drop_id = d.id
cross join lateral public.distribute_meso(d.sale_amount_meso, a.keys, a.weights) x
join public.party_participants pp on pp.id = x.key
where d.sale_amount_meso is not null;

comment on view public.v_run_drop_settlement is
  '드랍 건별 참가자 정산. 미판매(금액 null)는 제외되며 합계는 판매 금액과 정확히 일치한다.';

drop view if exists public.v_weekly_drop_income cascade;
create view public.v_weekly_drop_income
with (security_invoker = true) as
select
  s.user_id,
  s.week_key,
  sum(s.amount_meso)::bigint  as drop_income_meso,
  count(*)                    as drop_share_count,
  count(distinct s.drop_id)   as drop_count
from public.v_run_drop_settlement s
where s.user_id is not null
group by s.user_id, s.week_key;

comment on view public.v_weekly_drop_income is
  '사용자 × 주차 기타 드랍 수익. 결정석 12개 한도와 무관한 별도 계통이다.';

drop view if exists public.v_weekly_income;
create view public.v_weekly_income
with (security_invoker = true) as
with keys as (
  select user_id, week_key from public.v_weekly_crystal_income
  union
  select user_id, week_key from public.v_weekly_drop_income
  union
  select user_id, week_key from public.v_weekly_unsold_drops
)
select
  k.user_id,
  k.week_key,
  coalesce(c.income_meso, 0)             as crystal_income_meso,
  coalesce(c.clear_count, 0)             as clear_count,
  coalesce(c.weekly_clear_count, 0)      as weekly_clear_count,
  coalesce(c.unknown_price_count, 0)     as unknown_price_count,
  coalesce(c.weekly_over_limit_count, 0) as weekly_over_limit_count,
  coalesce(d.drop_income_meso, 0)        as drop_income_meso,
  coalesce(d.drop_count, 0)              as drop_count,
  coalesce(u.unsold_drop_count, 0)       as unsold_drop_count,
  (coalesce(c.income_meso, 0) + coalesce(d.drop_income_meso, 0))::bigint as total_income_meso
from keys k
left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
left join public.v_weekly_drop_income    d on d.user_id = k.user_id and d.week_key = k.week_key
left join public.v_weekly_unsold_drops   u on u.user_id = k.user_id and u.week_key = k.week_key;

comment on view public.v_weekly_income is
  '주간 총수익 = 결정석 분배 몫 + 드랍 분배 몫. 두 계통을 분리해 보여준다(12개 한도는 결정석에만 적용). 미판매 드랍은 금액이 아니라 건수로 보고한다.';

-- (b) 균등 분배의 결정론적 순서
create or replace function public.rebalance_run_shares(p_run_id uuid)
returns integer
language plpgsql
as $func$
declare
  v_mode  public.run_share_mode;
  v_n     integer;
  v_total integer;
  v_rows  integer := 0;
begin
  select r.share_mode into v_mode from public.party_runs r where r.id = p_run_id;
  if not found then
    return 0;
  end if;

  update public.run_signups
     set share_bp = 0
   where run_id = p_run_id and status <> 'going' and share_bp <> 0;

  select count(*), coalesce(sum(share_bp), 0)
    into v_n, v_total
    from public.run_signups
   where run_id = p_run_id and status = 'going';

  if v_n = 0 then
    return 0;
  end if;

  if v_mode = 'manual' and v_total = 10000 then
    return 0;
  end if;

  if v_mode = 'auto_equal' or v_total = 0 then
    -- 균등 분배. 나머지는 **파티원 번호 순**으로 앞에서부터 1씩. 완전 결정론적이다.
    with ordered as (
      select s.id, row_number() over (order by pp.member_no) as rn
        from public.run_signups s
        join public.party_participants pp on pp.id = s.participant_id
       where s.run_id = p_run_id and s.status = 'going'
    )
    update public.run_signups s
       set share_bp = (10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end
      from ordered o
     where s.id = o.id
       and s.share_bp is distinct from
           ((10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end);
    get diagnostics v_rows = row_count;
  else
    with recipients as (
      select id, share_bp
        from public.run_signups
       where run_id = p_run_id and status = 'going'
    ),
    agg as (
      select array_agg(id order by id) as keys,
             array_agg(share_bp order by id) as weights
      from recipients
    ),
    dist as (
      select d.key, d.amount
      from agg, public.distribute_meso(10000, agg.keys, agg.weights) d
    )
    update public.run_signups s
       set share_bp = dist.amount::integer
      from dist
     where s.id = dist.key
       and s.share_bp is distinct from dist.amount::integer;
    get diagnostics v_rows = row_count;
  end if;

  return v_rows;
end;
$func$;

-- (c) 알림 문구의 이름 나열 순서
create or replace function public.format_run_notice(
  p_run_id    uuid,
  p_kind      text default 'plain',
  p_now       timestamptz default now(),
  p_max_names integer default 4
)
returns text
language plpgsql
stable
as $func$
declare
  v_boss    text;
  v_sched   timestamptz;
  v_week    text;
  v_party   uuid;
  v_when    text;
  v_no      smallint;
  v_names   text[];
  v_total   integer;
  v_names_s text;
  v_line    text;
begin
  select bd.korean_name, r.scheduled_at, r.week_key, r.party_id
    into v_boss, v_sched, v_week, v_party
    from public.party_runs r
    join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
   where r.id = p_run_id;

  if not found then
    return null;
  end if;

  v_when := case
    when v_sched is null then '시간미정'
    else public.format_kst_when(v_sched, p_now)
  end;

  select n.party_no into v_no
    from public.party_room_numbers n
   where n.party_id = v_party and n.week_key = v_week;

  -- 이름은 display_name 스냅샷만 쓰고, 순서는 파티원 번호를 따른다.
  select array_agg(pp.display_name order by pp.member_no), count(*)
    into v_names, v_total
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.run_id = p_run_id and s.status = 'going';

  v_total := coalesce(v_total, 0);

  if v_total = 0 then
    v_names_s := '모집중';
  elsif v_total > p_max_names then
    v_names_s := array_to_string(v_names[1:p_max_names], ', ')
              || ' …외 ' || (v_total - p_max_names)::text || '명';
  else
    v_names_s := array_to_string(v_names, ', ');
  end if;

  v_line := v_when || ' '
         || case when v_no is not null then v_no::text || '파티 ' else '' end
         || v_boss
         || ' (' || v_names_s || ')';

  v_line := case p_kind
    when 'created' then '📌 ' || v_line
    when 'remind'  then '⏰ 30분 전' || chr(10) || v_line
    else v_line
  end;

  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$func$;

-- (d) seat_no 제거 — 트리거 → 함수 → 컬럼 순
drop trigger if exists run_signups_assign_seat_no on public.run_signups;
drop function if exists public.run_signups_assign_seat_no();

alter table public.run_signups drop column if exists seat_no cascade;

-- -----------------------------------------------------------------------------
-- 14-4. 공개 컬럼 권한 재정리
-- -----------------------------------------------------------------------------
-- member_no / run_no 는 seat_no 와 같은 성격의 **관리 번호**다. 금전 정보가 아니고,
-- 공개 시간표에서 "1번 우레푸", "#2 하드 스우"로 표시하는 데 쓴다(§1.4).
revoke all on table public.party_participants from anon;
revoke all on table public.party_participants from authenticated;
grant select (
  id, party_id, display_name, role, member_no, joined_at, left_at, created_at, updated_at
) on table public.party_participants to anon, authenticated;

revoke all on table public.party_runs from anon;
revoke all on table public.party_runs from authenticated;
grant select (
  id, party_id, boss_difficulty_id, scheduled_at, duration_minutes, status,
  capacity, entry_party_size, week_key, run_no, note, created_at, updated_at, cancelled_at
) on table public.party_runs to anon, authenticated;

-- seat_no 가 사라졌으므로 run_signups 권한도 다시 명시한다.
revoke all on table public.run_signups from anon;
revoke all on table public.run_signups from authenticated;
grant select (
  id, run_id, participant_id, status, created_at, updated_at
) on table public.run_signups to anon, authenticated;

-- cascade 로 다시 만든 뷰들의 권한을 복구한다.
do $$
declare
  v text;
  private_views text[] := array[
    'v_run_share_weights',
    'v_run_crystal_settlement',
    'v_run_drop_recipients',
    'v_run_drop_settlement',
    'v_weekly_drop_income',
    'v_weekly_income'
  ];
begin
  foreach v in array private_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  perform public.assert_no_public_sensitive_columns();

  -- seat_no 가 실제로 사라졌는가
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='run_signups' and column_name='seat_no') then
    raise exception 'run_signups.seat_no 가 아직 남아 있습니다.';
  end if;

  -- 새 번호가 공개 시간표에서 읽히는가(표시용이므로 열려 있어야 한다)
  if not has_column_privilege('anon', 'public.party_participants', 'member_no', 'SELECT')
     or not has_column_privilege('anon', 'public.party_runs', 'run_no', 'SELECT') then
    raise exception '관리 번호가 공개 시간표에서 읽히지 않습니다.';
  end if;

  -- 방 바인딩은 여전히 비공개여야 한다
  if has_column_privilege('anon', 'public.parties', 'bot_channel_id', 'SELECT') then
    raise exception 'parties.bot_channel_id 가 anon 에게 노출되어 있습니다.';
  end if;

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

  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817093000_harden_search_path_and_fk_indexes.sql
-- ============================================================
-- =====================================================================
-- 20260817093000_harden_search_path_and_fk_indexes.sql
--
-- Supabase advisor 가 지적한 두 가지를 해소한다.
--   (1) 보안 : function_search_path_mutable  42건
--   (2) 성능 : unindexed_foreign_keys        19건 중 16건 (3건은 의도적 미생성)
--
-- 이 마이그레이션은 **새 테이블/뷰를 만들지 않는다.** 따라서 새로 필요한 RLS
-- 정책도 없다 (CLAUDE.md §0.3). 인덱스는 행을 담는 객체가 아니라 기존 테이블의
-- 접근 경로일 뿐이며, 부모 테이블의 RLS 를 그대로 상속한다.
--
-- 데이터는 넣지도 지우지도 않는다.
-- 기존 마이그레이션 14개는 수정하지 않는다. 보강은 이 파일에서만 한다.
-- =====================================================================


-- =====================================================================
-- 1. 함수 search_path 고정
-- =====================================================================
--
-- [왜 필요한가]
-- advisor 가 지적한 42건은 전부 SECURITY INVOKER 다. (SECURITY DEFINER 는 이 DB에
-- 단 2개뿐이고 둘 다 이미 고정되어 있다 — claim_guest_profile / rls_auto_enable.)
-- 그래서 "정의자 권한 탈취" 형태의 고전적 권한 상승은 성립하지 않는다.
--
-- 그럼에도 고정하는 이유는 이 프로젝트의 쓰기 경로가 전부 service_role 이기 때문이다.
-- service_role 은 RLS 를 우회하는 최고 권한 역할이고, 이 역할이 실행하는 세션의
-- search_path 가 가변이면 함수 본문의 미수식 이름(`boss_clears`, `week_key(...)`)이
-- 경로 앞쪽 스키마에 심어진 동명 객체로 해석될 수 있다. 즉 권한 상승이 아니라
-- **최고 권한 세션에서의 객체 하이재킹**이 위험이다. 고정이 맞다.
--
-- [왜 `public, pg_temp` 인가]
--   · public   — 이 프로젝트의 모든 테이블/함수가 public 에 있다.
--   · pg_catalog 는 적지 않는다. 경로에 명시하지 않으면 Postgres 가 **암묵적으로 맨 앞**
--     에서 먼저 찾기 때문이다. 굳이 적으면 우리 public 객체보다 뒤로 밀 수도 있어 손해다.
--   · pg_temp 를 **맨 끝**에 두는 것이 이 설정의 핵심이다.
--     pg_temp 를 아예 적지 않으면 Postgres 는 임시 스키마를 경로의 **맨 앞**에서 찾는다.
--     그러면 임시 테이블/함수를 만들 수 있는 호출자가 `pg_temp.boss_clears` 같은 것을
--     심어 우리 public 객체를 가릴 수 있다. 명시적으로 마지막에 적으면 public 이 항상
--     먼저 이기므로 그 경로가 막힌다. "적지 않는 것"과 "마지막에 적는 것"은 전혀 다르다.
--
-- [안전성 사전 확인 — 실측]
-- 이 DB 의 세션 기본 search_path 는 `"$user", public, extensions` 이고,
-- pgcrypto / uuid-ossp 는 `extensions` 스키마에 있다. 경로에서 extensions 를 빼면
-- 미수식 pgcrypto 호출(digest/gen_random_bytes/crypt/uuid_generate_v4)이 깨진다.
-- 그래서 적용 전에 public 의 전 함수 본문을 두 가지 방법으로 훑었다.
--   · pg_depend (SQL 언어 함수는 생성 시점에 파싱되어 의존성이 기록된다) → 0건
--   · 본문 정규식 스캔 (plpgsql 본문은 파싱되지 않으므로 텍스트로 확인) → extensions
--     스키마 함수 이름과 겹치는 호출 0건
-- 유일하게 public 밖을 참조하는 것은 assert_no_public_sensitive_columns() 의
-- `information_schema.columns` 인데 **스키마가 이미 수식되어 있어** 영향이 없다.
-- 따라서 42건 전부 `public, pg_temp` 로 안전하다.
--
-- [왜 함수를 하나씩 하드코딩하지 않는가]
-- 앞으로 추가되는 함수도 이 마이그레이션을 다시 돌리면 그대로 잡히게 하려고
-- pg_proc 순회 DO 블록으로 쓴다. 이미 고정된 함수는 건너뛰므로 몇 번 돌려도 무해하다.

do $$
declare
  r        record;
  v_count  integer := 0;
begin
  for r in
    select
      n.nspname                                  as schema_name,
      p.proname                                  as func_name,
      pg_get_function_identity_arguments(p.oid)  as identity_args,
      p.oid::regprocedure::text                  as pretty_sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'

      -- 집합함수(a)/윈도우함수(w)는 SET 절을 받지 못한다. 함수와 프로시저만.
      and p.prokind in ('f', 'p')

      -- 소유자가 우리가 아닌 함수는 제외한다.
      and pg_get_userbyid(p.proowner) = current_user

      -- 확장(extension)이 설치한 함수는 우리 것이 아니다. 확장 업그레이드가
      -- 되돌려 놓을 뿐 아니라, 남의 함수 동작을 바꾸는 것 자체가 월권이다.
      and not exists (
        select 1
        from pg_depend d
        where d.classid  = 'pg_proc'::regclass
          and d.objid    = p.oid
          and d.deptype  = 'e'
      )

      -- 이벤트 트리거 함수는 Supabase 플랫폼이 심은 것이다. 우리 소유가 아니다.
      -- 여기서 걸러지는 것이 `rls_auto_enable()` (이벤트 트리거 `ensure_rls`) 이며,
      -- 이미 search_path = pg_catalog 로 고정되어 있다. 건드리지 않는다.
      and not exists (
        select 1 from pg_event_trigger et where et.evtfoid = p.oid
      )

      -- 위 조건과 중복이지만 명시적으로 한 번 더 막는다. 이 함수는 우리 것이 아니다.
      and p.proname <> 'rls_auto_enable'

      -- 이미 search_path 가 고정된 함수는 건너뛴다.
      -- claim_guest_profile(= public, pg_temp) 이 여기서 제외된다. 덮어쓰지 않는다.
      and coalesce(array_to_string(p.proconfig, ','), '') !~ 'search_path'
  loop
    -- 오버로드를 정확히 구분해야 한다. proname 만으로는 distribute_meso 처럼 인자만
    -- 다른 동명 함수를 구분할 수 없으므로 identity arguments 를 붙여 시그니처를 만든다.
    execute format(
      'alter function %I.%I(%s) set search_path = public, pg_temp',
      r.schema_name, r.func_name, r.identity_args
    );
    v_count := v_count + 1;
    raise notice 'search_path 고정: %', r.pretty_sig;
  end loop;

  raise notice '총 % 개 함수의 search_path 를 public, pg_temp 로 고정했다.', v_count;
end;
$$;


-- =====================================================================
-- 2. 외래키 인덱스
-- =====================================================================
--
-- [판단 기준]
-- 19건을 무지성으로 만들지 않는다. 각 FK 마다 다음을 따졌다.
--
--   (a) 참조 동작 비용 — on delete cascade / set null / restrict 가 걸린 FK 는
--       부모 행이 지워질 때마다 Postgres 가 자식 테이블에서 참조 행을 찾는다.
--       인덱스가 없으면 그 탐색이 **자식 테이블 전체 순차 스캔**이다.
--       부모 삭제가 일상적인 조작이고 자식 테이블이 계속 커진다면 반드시 필요하다.
--   (b) 조회 경로 — 그 컬럼이 실제 화면/봇 질의의 필터로 쓰이는가.
--   (c) 비용 — 인덱스는 공짜가 아니다. 자식 테이블이 **영구히 작고** 부모 삭제도
--       사실상 없다면 쓰기 비용과 저장공간만 늘 뿐이므로 만들지 않는 편이 낫다.
--
-- [nullable FK 는 전부 부분 인덱스로 만든다]
-- `where col is not null` 부분 인덱스는 nullable FK 에 대해 완전 인덱스보다
-- **엄격히 낫다.** 완전 btree 는 NULL 행까지 저장하는데 그 항목은 FK 참조 검사에
-- 절대 쓰이지 않는다(참조 검사는 항상 부모의 non-null 값을 찾는다). 즉 순수한 낭비다.
-- 그리고 Postgres 플래너는 `col = $1` 이 `col is not null` 을 함의한다는 것을
-- 증명할 수 있으므로 참조 검사 질의가 부분 인덱스를 그대로 탄다.
-- 실증: 기존 스키마의 characters_account_idx / bot_channels_owner_idx /
-- chore_definitions_owner_idx / parties_channel_idx 가 모두 부분 인덱스인데
-- 해당 FK 들은 advisor 의 19건 목록에 **없다**. Supabase 린터도 부분 인덱스를
-- 커버로 인정한다는 뜻이다.
--
-- [중복 확인]
-- 기존 인덱스의 **선행 컬럼**이 이미 FK 를 덮는 경우는 없었다. 예를 들어
-- boss_clears_week_uniq 는 boss_difficulty_id 를 갖지만 3번째 컬럼이라 참조 검사에
-- 쓸 수 없다. chore_completions 의 유니크 인덱스들도 character_id 가 2번째다.
-- 따라서 아래 16건은 모두 신규이며 중복이 아니다.


-- ---------------------------------------------------------------------
-- boss_clears — 이 스키마에서 가장 크게 자랄 테이블 (사용자 × 캐릭터 × 보스 × 주)
-- ---------------------------------------------------------------------

-- FK: boss_clears_boss_difficulty_id_fkey → boss_difficulties (on delete restrict, not null)
-- 생성. restrict 도 "참조 행이 있는가"를 확인해야 하므로 인덱스가 없으면 최대 테이블을
-- 통째로 순차 스캔한다. 게다가 boss_difficulty_id 는 실제 조회 필터다
-- ("이번 주 이 보스를 클리어한 사람"). week_key 를 뒤에 붙여 그 질의까지 한 번에 받는다.
-- 선행 컬럼이 FK 컬럼이므로 참조 검사 용도로도 그대로 유효하다.
create index if not exists boss_clears_difficulty_week_idx
  on public.boss_clears (boss_difficulty_id, week_key);

-- FK: boss_clears_crystal_price_id_fkey → boss_crystal_prices (on delete set null, nullable)
-- 생성. 시세표 행이 지워지면 set null 이 최대 테이블 전체를 훑는다.
-- §1.3 D4 대로 시세 미상(Velona 등) 행은 null 이므로 부분 인덱스가 그만큼 작아진다.
create index if not exists boss_clears_crystal_price_idx
  on public.boss_clears (crystal_price_id)
  where crystal_price_id is not null;


-- ---------------------------------------------------------------------
-- bot_command_log — 봇 명령이 들어올 때마다 한 행. 무한 증가하는 로그 테이블
-- ---------------------------------------------------------------------

-- FK: bot_command_log_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 로그 테이블이 가장 커지므로 계정 삭제 시의 set null 순차 스캔이 최악이다.
-- created_at desc 를 붙여 "이 사용자의 최근 명령 이력"(어뷰징 조사) 경로도 받는다.
-- !연결 안 한 발신자는 user_id 가 null 이라 부분 인덱스에서 빠진다 — 로그 적재
-- 비용을 그만큼 아낀다.
create index if not exists bot_command_log_user_idx
  on public.bot_command_log (user_id, created_at desc)
  where user_id is not null;


-- ---------------------------------------------------------------------
-- chore_completions — 일간 × 캐릭터 × 숙제. 행 수가 빠르게 늘어난다
-- ---------------------------------------------------------------------

-- FK: chore_completions_character_id_fkey → characters (on delete set null, nullable)
-- 생성. §2.1.1 의 캐릭터 선택 모달은 언제든 다시 열어 추적 캐릭터를 뺄 수 있다.
-- 즉 캐릭터 삭제는 **일상적인 조작**이고, 그때마다 set null 이 이 큰 테이블을 훑는다.
create index if not exists chore_completions_character_idx
  on public.chore_completions (character_id)
  where character_id is not null;

-- FK: chore_completions_definition_fk → chore_definitions (on delete cascade, not null)
-- 생성. chore_definitions 에는 owner_user_id 가 있으므로 사용자가 만든 커스텀 숙제가
-- 존재하고, 그 삭제 역시 일상적인 조작이다. cascade 가 이 테이블을 통째로 훑게 둘 수 없다.
-- 복합 FK 이므로 컬럼 순서를 제약과 동일하게 맞춘다.
create index if not exists chore_completions_definition_idx
  on public.chore_completions (chore_definition_id, scope);


-- ---------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------

-- FK: friendships_blocked_by_user_id_fkey → app_users (on delete cascade, nullable)
-- 생성. 이 컬럼은 차단이 걸린 관계에만 채워지므로 거의 항상 null 이다. 즉 부분
-- 인덱스가 거의 빈 인덱스라 사실상 공짜다. 그 대가로 계정 삭제 시의 cascade 순차
-- 스캔이 사라지고, "내가 차단한 관계" 목록 조회 경로도 덤으로 얻는다.
create index if not exists friendships_blocked_by_idx
  on public.friendships (blocked_by_user_id)
  where blocked_by_user_id is not null;


-- ---------------------------------------------------------------------
-- 초대 계열 — 파티 삭제가 invite_links → guest_profiles/invite_redemptions 로 번진다
-- ---------------------------------------------------------------------

-- FK: guest_profiles_created_via_invite_id_fkey → invite_links (on delete set null, nullable)
-- 생성. 파티가 지워지면 invite_links 가 cascade 로 지워지고, 그 각각이 다시
-- guest_profiles 에 set null 스캔을 유발한다. 파티 삭제는 일상적인 조작이고
-- guest_profiles 는 초대받은 비회원 수만큼 계속 늘어난다.
create index if not exists guest_profiles_invite_idx
  on public.guest_profiles (created_via_invite_id)
  where created_via_invite_id is not null;

-- FK: invite_links_created_by_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 계정 삭제 시 set null 스캔을 없애고 "내가 만든 초대 링크" 관리 화면 경로를 받는다.
create index if not exists invite_links_creator_idx
  on public.invite_links (created_by_user_id)
  where created_by_user_id is not null;

-- FK: invite_redemptions_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. party_participants 는 파티 삭제 시 cascade 로 사라지는데, 6인 파티면 참가자
-- 삭제 6번이 각각 set null 스캔을 부른다.
create index if not exists invite_redemptions_participant_idx
  on public.invite_redemptions (participant_id)
  where participant_id is not null;

-- FK: invite_redemptions_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 적재 속도는 낮지만 감사 로그라 삭제 없이 무한히 쌓인다("영구히 작다"에 해당하지
-- 않는다). 계정 삭제가 이 테이블을 순차 스캔하지 않도록 한다.
-- 게스트가 사용한 초대는 user_id 가 null 이라 부분 인덱스에서 빠진다.
create index if not exists invite_redemptions_user_idx
  on public.invite_redemptions (user_id)
  where user_id is not null;


-- ---------------------------------------------------------------------
-- party_participants
-- ---------------------------------------------------------------------

-- FK: party_participants_character_id_fkey → characters (on delete set null, nullable)
-- 생성. 캐릭터 추적 해제(§2.1.1)마다 set null 스캔이 걸린다. 게스트 참가자와
-- 캐릭터 미지정 참가자는 null 이라 부분 인덱스가 실제보다 작다.
create index if not exists party_participants_character_idx
  on public.party_participants (character_id)
  where character_id is not null;

-- FK: party_participants_invited_by_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 이 컬럼은 감사용이라 조회 필터로 쓰이지는 않는다. 그럼에도 만드는 이유는
-- (a) 기준 하나뿐 — 계정 삭제 시 set null 이 계속 커지는 테이블을 훑기 때문이다.
-- 삽입 시 1회 기록되고 이후 갱신되지 않으므로 유지 비용은 삽입당 btree 항목 하나다.
create index if not exists party_participants_invited_by_idx
  on public.party_participants (invited_by_user_id)
  where invited_by_user_id is not null;


-- ---------------------------------------------------------------------
-- party_runs / run_drops / run_signups
-- ---------------------------------------------------------------------

-- FK: party_runs_created_by_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. §1.4 대로 참가자는 파티에서 빠질 수 있고(#3번이 나가도 #4는 #4로 남는다),
-- 그 삭제마다 set null 스캔이 걸린다.
create index if not exists party_runs_creator_idx
  on public.party_runs (created_by_participant_id)
  where created_by_participant_id is not null;

-- FK: run_drops_recorded_by_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. 위와 동일한 이유. 드랍 기록은 런마다 쌓이므로 테이블이 계속 커진다.
create index if not exists run_drops_recorded_by_idx
  on public.run_drops (recorded_by_participant_id)
  where recorded_by_participant_id is not null;

-- FK: run_drops_solo_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. 분배하지 않고 한 사람이 먹는 드랍에만 채워지므로 대부분 null 이다.
-- 부분 인덱스가 아주 작게 유지된다.
create index if not exists run_drops_solo_participant_idx
  on public.run_drops (solo_participant_id)
  where solo_participant_id is not null;

-- FK: run_signups_character_id_fkey → characters (on delete set null, nullable)
-- 생성. 캐릭터 추적 해제마다 set null 스캔. 참가 신청 시 캐릭터를 아직 안 고른
-- 행은 null 이라 부분 인덱스에서 빠진다.
create index if not exists run_signups_character_idx
  on public.run_signups (character_id)
  where character_id is not null;


-- ---------------------------------------------------------------------
-- 의도적으로 만들지 않는 3건
-- ---------------------------------------------------------------------
--
-- 아래 3건은 advisor 목록에 계속 남는다. 놓친 것이 아니라 판단한 결과다.
-- 나중에 이 테이블들의 전제(영구히 작다)가 깨지면 그때 만들면 된다.
--
-- ① boss_aliases_entry_belongs_to_boss  (boss_aliases → boss_difficulties, cascade)
--    미생성. boss_aliases 는 보스 마스터에 딸린 별칭표로 행 수가 보스 수에 묶여 있다
--    (수백 행 수준에서 영구히 멈춘다). 부모인 boss_difficulties 삭제는 패치 정비 때나
--    일어나는 일이고, 그 위의 bosses 는 애초에 restrict 로 잠겨 있어 함부로 지워지지도
--    않는다. 게다가 실제 조회 경로인 별칭 해석(`!등록 카룡` 파싱)은 이미
--    boss_aliases_normalized_uniq / _normalized_group_uniq 가 받고 있고, 그 반대 방향
--    (난이도 → 별칭 목록)은 수백 행짜리 관리 화면이다. 인덱스를 얹어봐야 쓰기 비용만 는다.
--
-- ② bot_link_codes_channel_id_fkey            (bot_link_codes → bot_channels, cascade)
-- ③ bot_link_codes_consumed_by_channel_id_fkey(bot_link_codes → bot_channels, set null)
--    둘 다 미생성. bot_link_codes 는 `!연결 <코드>` 용 6자리 코드로, 한 사용자가 평생
--    몇 번 발급받는 게 전부라 행 수가 (사용자 수 × 소수) 로 묶인다. 부모인 bot_channels
--    삭제(카톡방 제거)도 드문 사건이다. 즉 (a) 참조 동작 비용도 (b) 조회 경로도 없이
--    (c) 비용만 남는 전형적인 경우다. 특히 ③ 은 코드가 소비되기 전까지 계속 null 이라
--    인덱스가 거의 비어 있게 되는데, 그 빈 인덱스를 유지하려고 코드 발급마다 쓰기를
--    더할 이유가 없다.


-- =====================================================================
-- 3. 자체 검증 — 이 마이그레이션이 목표를 실제로 달성했는지 트랜잭션 안에서 확인
-- =====================================================================

do $$
declare
  v_mutable integer;
  v_names   text;
begin
  select count(*), string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into v_mutable, v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and pg_get_userbyid(p.proowner) = current_user
    and p.proname <> 'rls_auto_enable'
    and not exists (select 1 from pg_event_trigger et where et.evtfoid = p.oid)
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and coalesce(array_to_string(p.proconfig, ','), '') !~ 'search_path';

  if v_mutable > 0 then
    raise exception 'search_path 가 고정되지 않은 public 함수가 % 개 남았다: %', v_mutable, v_names;
  end if;
end;
$$;

-- 이미 고정되어 있던 claim_guest_profile 을 덮어쓰지 않았는지 확인한다.
do $$
declare
  v_cfg text;
begin
  select array_to_string(p.proconfig, ',') into v_cfg
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_guest_profile';

  if v_cfg is distinct from 'search_path=public, pg_temp' then
    raise exception 'claim_guest_profile 의 search_path 가 바뀌었다: %', v_cfg;
  end if;
end;
$$;

-- rls_auto_enable 은 우리 소유가 아니다. 손대지 않았음을 확인한다.
--
-- ⚠️ **없을 수도 있다.** 이 함수는 Supabase 플랫폼이 심는 이벤트 트리거 함수라
--    이 프로젝트에는 처음부터 있었지만, 새 Supabase 프로젝트나 로컬/CI 의 맨 Postgres 에는
--    존재하지 않는다. 가드의 의도는 "있으면 건드리지 않았는지 확인한다"이지
--    "반드시 존재해야 한다"가 아니므로 **없으면 검사할 대상 자체가 없다 → 건너뛴다.**
--
-- [이미 적용된 마이그레이션을 수정한 이유 — 이 저장소의 원칙에 대한 예외]
--   원칙은 "적용된 마이그레이션은 고치지 않는다"이다. 여기만 예외로 두는 근거는 두 가지다.
--     ① 라이브 DB(hryikreaxngexhjjxfyl)에는 함수가 존재하고 proconfig 도
--        `search_path=pg_catalog` 로 일치한다 → 아래 분기 중 **기존과 동일한 경로**를 타므로
--        동작 변화가 정확히 0 이다. 새 마이그레이션으로는 이미 실행된 DO 블록을 되돌릴 수 없다.
--     ② 고치지 않으면 **새 배포가 불가능**하다. 예전 판은 함수가 없을 때
--        `select ... into v_cfg` 가 v_cfg 를 NULL 로 남기고 `is distinct from` 이 참이 되어
--        깨끗한 Postgres 에서 전체 마이그레이션이 이 지점에서 멈췄다(실측 재현:
--        "rls_auto_enable 을 건드렸다. … : <NULL>").
--
-- 건너뛴 사실은 raise notice 로 남긴다. 조용히 지나가면 나중에 "왜 이 검사가 안 돌았지"를
-- 로그로 되짚을 수 없다.
do $$
declare
  v_cfg text;
begin
  select array_to_string(p.proconfig, ',') into v_cfg
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rls_auto_enable';

  -- SELECT INTO 는 행이 배정되지 않으면 FOUND 를 false 로 둔다. proconfig 가 NULL 인
  -- "존재하지만 search_path 미설정" 과 "아예 없음" 을 이 플래그로만 구별할 수 있다.
  -- (v_cfg 의 NULL 여부로 구별하면 전자를 후자로 오판해 진짜 사고를 놓친다.)
  if not found then
    raise notice 'rls_auto_enable 이 이 DB 에 없다 — Supabase 플랫폼 객체이므로 검사를 건너뛴다.';
  elsif v_cfg is distinct from 'search_path=pg_catalog' then
    raise exception 'rls_auto_enable 을 건드렸다. 이 함수는 우리 소유가 아니다: %', v_cfg;
  end if;
end;
$$;

-- KST 목요일 00:00 주간 리셋 경계가 그대로인지 확인한다 (CLAUDE.md §1, §0.3).
-- search_path 고정이 week_key/week_start 의 해석을 바꾸지 않았음을 보증한다.
do $$
begin
  if public.week_key('2026-08-19 23:59:59+09'::timestamptz) <> '2026-W33' then
    raise exception '주차 경계 파손: 수요일 23:59 KST 가 2026-W33 이 아니다';
  end if;
  if public.week_key('2026-08-20 00:00:00+09'::timestamptz) <> '2026-W34' then
    raise exception '주차 경계 파손: 목요일 00:00 KST 가 2026-W34 가 아니다';
  end if;
  if public.week_start('2026-08-20 00:00:00+09'::timestamptz) <> '2026-08-19 15:00:00+00'::timestamptz then
    raise exception '주 시작 파손: 2026-W34 의 시작이 목요일 00:00 KST 가 아니다';
  end if;
end;
$$;

-- 1/n 분배가 메소를 잃지도 만들지도 않는지 확인한다 (§1.3 D3).
do $$
declare
  v_total bigint;
begin
  select sum(amount) into v_total
  from public.distribute_meso(
    1000000000,
    array['11111111-1111-1111-1111-111111111111'::uuid,
          '22222222-2222-2222-2222-222222222222'::uuid,
          '33333333-3333-3333-3333-333333333333'::uuid],
    array[3333, 3333, 3334]);

  if v_total <> 1000000000 then
    raise exception 'distribute_meso 파손: 합계가 %', v_total;
  end if;
end;
$$;


-- =====================================================================
-- 4. DoD — 민감 컬럼이 anon/authenticated 에 새어나가지 않는지 (CLAUDE.md §0.3)
-- =====================================================================
-- 이 마이그레이션은 컬럼을 추가하지 않지만, 호출을 생략하지 않는다.
-- share_bp 가 새던 사고가 바로 "이번엔 컬럼 안 건드렸으니 괜찮겠지"에서 나왔다.
select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817094000_nexon_mapping_and_sync_selection.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 16. 넥슨 API 매핑 계층 + 동기화 대상 선택
-- =============================================================================
-- 근거: Claude/NEXON-API-OBSERVED.md (실제 키로 18회 호출한 **실측** 결과, 추정 아님)
--
-- 실측으로 확정된 것:
--   * cycle 실제 값 = `bossDaily` / `bossWeekly` / `bossMonthly`  ← 우리 enum 과 다르다
--   * difficulty 실제 값 = `easy` `normal` `chaos` `hard` `extreme` ← 우리 enum 과 **정확히 같다**
--   * content_name 은 한글 보스명 32종. 그중 `시즌 보스 메이린` 은 우리가 **의도적으로 제외**한 보스다
--   * 이 계정 캐릭터 59명 → 전체 동기화 59콜 (개발 키 하루 1,000콜)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 16-1. cycle 변환 — 한 곳에만 둔다
-- -----------------------------------------------------------------------------
-- API 는 camelCase 에 `boss` 접두사를 붙여 준다. 우리 enum 은 소문자 단어다.
-- 이 변환이 여러 곳에 흩어지면 한 곳만 빠뜨려도 주간 보스가 일간으로 들어간다
-- (= 12개 카운터 대상이 통째로 어긋난다).
--
-- **모르는 값은 null 을 돌려준다.** 예외를 던지지 않는 이유:
--   넥슨이 새 주기를 추가했을 때 동기화 전체가 죽으면 안 된다. 대신 null 로 만들고
--   nexon_record_unmapped_content() 가 그 사실을 **반드시 기록**한다(16-3).
--   조용히 'daily' 같은 기본값으로 떨어지는 것만은 절대 하지 않는다.
create or replace function public.nexon_cycle_to_boss_cycle(p_cycle text)
returns public.boss_cycle
language sql
immutable
parallel safe
set search_path = ''
as $func$
  select case lower(btrim(coalesce(p_cycle, '')))
           when 'bossdaily'   then 'daily'::public.boss_cycle
           when 'bossweekly'  then 'weekly'::public.boss_cycle
           when 'bossmonthly' then 'monthly'::public.boss_cycle
           else null
         end;
$func$;

comment on function public.nexon_cycle_to_boss_cycle(text) is
  '넥슨 boss_contents[].cycle(bossDaily/bossWeekly/bossMonthly) → boss_cycle. 모르는 값은 null 이며 절대 기본값으로 떨어지지 않는다.';

-- difficulty 는 실측상 우리 enum 과 값이 같지만, 그 사실을 코드가 아니라 **함수**로 붙잡아 둔다.
-- 넥슨이 값을 바꾸면 여기서만 고치면 된다.
create or replace function public.nexon_difficulty_to_tier(p_difficulty text)
returns public.boss_difficulty_tier
language sql
immutable
parallel safe
set search_path = ''
as $func$
  select case lower(btrim(coalesce(p_difficulty, '')))
           when 'easy'    then 'easy'::public.boss_difficulty_tier
           when 'normal'  then 'normal'::public.boss_difficulty_tier
           when 'chaos'   then 'chaos'::public.boss_difficulty_tier
           when 'hard'    then 'hard'::public.boss_difficulty_tier
           when 'extreme' then 'extreme'::public.boss_difficulty_tier
           else null
         end;
$func$;

comment on function public.nexon_difficulty_to_tier(text) is
  '넥슨 boss_contents[].difficulty → boss_difficulty_tier. 실측상 값이 동일하지만 변환 지점을 한 곳에 고정한다.';

-- 문자열 "true"/"false" → boolean. 실측 확인: 모든 flag 가 **문자열**이다.
create or replace function public.nexon_flag_to_boolean(p_flag text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $func$
  select case lower(btrim(coalesce(p_flag, '')))
           when 'true'  then true
           when 'false' then false
           else null
         end;
$func$;

comment on function public.nexon_flag_to_boolean(text) is
  '넥슨 registration_flag/complete_flag 는 실측상 boolean 이 아니라 문자열 "true"/"false" 다. 파싱을 한 곳에 고정한다.';

-- -----------------------------------------------------------------------------
-- 16-2. 미매핑 기록처
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'nexon_mapping_resolution' and n.nspname = 'public') then
    -- unknown                : 정체 불명. **사람이 봐야 한다** (신규 보스일 가능성)
    -- intentionally_excluded : 우리가 일부러 뺐다 (이벤트 보스 등). 조용히 무시해도 되는 것
    -- pending_release        : 우리 마스터에는 있으나 아직 released=false
    create type public.nexon_mapping_resolution as enum
      ('unknown', 'intentionally_excluded', 'pending_release');
  end if;
end
$$;

-- 동기화가 우리 마스터에 없는 보스를 만났을 때 **죽지 않고 여기에 남긴다.**
-- ★ 핵심: `의도적 제외`와 `미지의 신규 보스`가 구분되어야 한다.
--   메이린처럼 일부러 뺀 것까지 매번 경고하면 진짜 신규 보스 경고가 묻힌다.
create table if not exists public.nexon_unmapped_contents (
  id             uuid primary key default gen_random_uuid(),

  -- 넥슨이 준 원문 그대로. 가공하지 않는다.
  content_name   text not null,
  difficulty     text,
  cycle          text,

  resolution     public.nexon_mapping_resolution not null default 'unknown',
  note           text,

  seen_count     integer not null default 1 check (seen_count >= 0),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),

  constraint nexon_unmapped_contents_uniq
    unique nulls not distinct (content_name, difficulty, cycle)
);

comment on table public.nexon_unmapped_contents is
  '우리 보스 마스터에 매핑되지 않은 넥슨 content_name 기록. 동기화를 죽이지 않고 남긴다. resolution 으로 의도적 제외와 미지의 신규 보스를 구분한다.';
comment on column public.nexon_unmapped_contents.resolution is
  'unknown = 사람이 확인해야 함(신규 보스 가능성) / intentionally_excluded = 우리가 일부러 뺌 / pending_release = 마스터에 있으나 미출시.';

create index if not exists nexon_unmapped_contents_open_idx
  on public.nexon_unmapped_contents (last_seen_at desc)
  where resolution = 'unknown';

-- 기록 함수. 같은 조합이 다시 오면 카운트만 올린다(멱등).
-- 이미 사람이 분류(resolution)해 둔 건은 **덮어쓰지 않는다.**
create or replace function public.nexon_record_unmapped_content(
  p_content_name text,
  p_difficulty   text default null,
  p_cycle        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_id uuid;
begin
  if p_content_name is null or btrim(p_content_name) = '' then
    return null;
  end if;

  insert into public.nexon_unmapped_contents (content_name, difficulty, cycle)
  values (btrim(p_content_name), p_difficulty, p_cycle)
  on conflict (content_name, difficulty, cycle) do update
    set seen_count   = public.nexon_unmapped_contents.seen_count + 1,
        last_seen_at = now()
  returning id into v_id;

  return v_id;
end;
$func$;

comment on function public.nexon_record_unmapped_content(text, text, text) is
  '미매핑 content_name 을 기록한다. 재관측 시 카운트만 올리고 사람이 분류한 resolution 은 보존한다.';

-- 사람이 봐야 할 것만 추린다. 의도적 제외는 여기 안 나온다.
drop view if exists public.v_nexon_unmapped_open;
create view public.v_nexon_unmapped_open
with (security_invoker = true) as
select content_name, difficulty, cycle, seen_count, first_seen_at, last_seen_at
from public.nexon_unmapped_contents
where resolution = 'unknown'
order by last_seen_at desc;

comment on view public.v_nexon_unmapped_open is
  '아직 분류되지 않은 미매핑 보스명. 비어 있어야 정상이고, 행이 생기면 신규 보스가 나왔다는 뜻이다.';

-- -----------------------------------------------------------------------------
-- 16-3. 매핑 해석 — 동기화가 부르는 단일 진입점
-- -----------------------------------------------------------------------------
-- 성공하면 boss_difficulties.id, 실패하면 null 을 돌려주고 **반드시 기록**한다.
create or replace function public.nexon_resolve_boss_difficulty(
  p_content_name text,
  p_difficulty   text,
  p_cycle        text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_tier public.boss_difficulty_tier;
  v_id   text;
begin
  v_tier := public.nexon_difficulty_to_tier(p_difficulty);

  if v_tier is not null then
    select bd.id into v_id
      from public.boss_difficulties bd
      join public.bosses b on b.id = bd.boss_id
     where b.nexon_content_name = btrim(p_content_name)
       and bd.difficulty = v_tier;
  end if;

  if v_id is null then
    -- 모르는 보스명이든, 모르는 난이도든, 모르는 주기든 전부 여기로 모인다.
    perform public.nexon_record_unmapped_content(p_content_name, p_difficulty, p_cycle);
  end if;

  return v_id;
end;
$func$;

comment on function public.nexon_resolve_boss_difficulty(text, text, text) is
  '넥슨 (content_name, difficulty) → boss_difficulties.id. 실패 시 null 을 돌려주고 nexon_unmapped_contents 에 기록한다. 동기화는 이 함수만 부른다.';

-- -----------------------------------------------------------------------------
-- 16-4. 보스명 실측 여부 표시
-- -----------------------------------------------------------------------------
-- ★ 조인 실패가 조용히 일어나면 안 된다. 실측으로 확인한 이름과 추정한 이름을 구분한다.
alter table public.bosses
  add column if not exists nexon_name_verified boolean not null default false;

comment on column public.bosses.nexon_name_verified is
  'true = NEXON-API-OBSERVED.md 실측 목록에서 확인된 content_name. false = 추정값(미출시 보스 등)이라 조인이 실패할 수 있다.';

drop view if exists public.v_boss_nexon_mapping_health;
create view public.v_boss_nexon_mapping_health
with (security_invoker = true) as
select
  b.id            as boss_id,
  b.korean_name,
  b.nexon_content_name,
  b.nexon_name_verified,
  count(bd.id)                                  as difficulty_count,
  count(bd.id) filter (where bd.released)       as released_count
from public.bosses b
left join public.boss_difficulties bd on bd.boss_id = b.id
group by b.id;

comment on view public.v_boss_nexon_mapping_health is
  '보스별 넥슨 매핑 상태. nexon_name_verified = false 인 행은 실측되지 않은 추정 이름이라 조인 실패 가능성이 있다.';

-- -----------------------------------------------------------------------------
-- 16-5. 동기화 대상 선택 — 59명 전부 돌리지 않는다
-- -----------------------------------------------------------------------------
-- 실측: 이 계정 캐릭터 **59명**. 전체 동기화는 캐릭터당 1콜이라 59콜이고,
-- 개발 키 하루 1,000콜 기준 하루 약 17회 전체 동기화가 한계다.
-- CLAUDE.md §2.1.1 대로 **사용자가 고른 캐릭터만** 동기화한다.
alter table public.characters
  add column if not exists is_tracked boolean not null default false;

comment on column public.characters.is_tracked is
  '동기화 대상 여부. 실측상 계정당 캐릭터가 59명이라 전량 동기화는 개발 키 예산(1,000콜/일)을 금방 태운다. 사용자가 고른 캐릭터만 true.';

-- 동기화 배치가 대상 목록을 뽑는 인덱스
create index if not exists characters_tracked_idx
  on public.characters (user_id)
  where is_tracked and sync_state = 'syncable';

-- 개발 단계 키 하루 허용량. 서비스 키로 승격하면 여기만 고친다.
create or replace function public.nexon_daily_call_budget()
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $func$ select 1000 $func$;

comment on function public.nexon_daily_call_budget() is
  '넥슨 개발 단계 키의 하루 허용량(1,000콜). 실측상 응답 헤더에 잔여량이 없어 우리가 직접 센다.';

-- 자격증명별로 "오늘 한 번 더 전체 동기화가 가능한가"를 바로 답해 주는 뷰.
drop view if exists public.v_nexon_sync_plan;
create view public.v_nexon_sync_plan
with (security_invoker = true) as
select
  c.user_id,
  cred.id                                   as credential_id,
  cred.label                                as credential_label,
  public.day_key(now())                     as day_key,
  count(*) filter (where c.is_tracked)      as tracked_character_count,
  count(*)                                  as total_character_count,
  coalesce(q.call_count, 0)                 as calls_used_today,
  public.nexon_daily_call_budget()          as daily_budget,
  greatest(public.nexon_daily_call_budget() - coalesce(q.call_count, 0), 0) as calls_remaining,
  -- 추적 대상 캐릭터 1명당 스케줄러 1콜.
  (count(*) filter (where c.is_tracked))
    <= greatest(public.nexon_daily_call_budget() - coalesce(q.call_count, 0), 0) as full_sync_fits
from public.characters c
join public.credential_nexon_accounts l on l.nexon_account_ref = c.nexon_account_ref
join public.user_credentials cred       on cred.id = l.credential_id and cred.user_id = c.user_id
left join public.nexon_api_quota_usage q
       on q.credential_id = cred.id and q.day_key = public.day_key(now())
where cred.invalidated_at is null
group by c.user_id, cred.id, cred.label, q.call_count;

comment on view public.v_nexon_sync_plan is
  '자격증명별 동기화 계획. 추적 캐릭터 수 vs 남은 하루 예산. full_sync_fits 가 false 면 이번엔 전체 동기화를 돌리면 안 된다.';

-- -----------------------------------------------------------------------------
-- 16-6. RLS / 권한
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  private_tables text[] := array['nexon_unmapped_contents'];
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

-- 매핑 상태 뷰는 보스 마스터(공개)만 읽으므로 공개해도 무해하다.
revoke all on table public.v_boss_nexon_mapping_health from anon;
revoke all on table public.v_boss_nexon_mapping_health from authenticated;
grant select on table public.v_boss_nexon_mapping_health to anon, authenticated;
grant all on table public.v_boss_nexon_mapping_health to service_role;

-- 나머지는 서버 전용.
revoke all on table public.v_nexon_unmapped_open from anon;
revoke all on table public.v_nexon_unmapped_open from authenticated;
grant all on table public.v_nexon_unmapped_open to service_role;

revoke all on table public.v_nexon_sync_plan from anon;
revoke all on table public.v_nexon_sync_plan from authenticated;
grant all on table public.v_nexon_sync_plan to service_role;

revoke all on function public.nexon_record_unmapped_content(text, text, text) from public;
revoke all on function public.nexon_record_unmapped_content(text, text, text) from anon;
revoke all on function public.nexon_record_unmapped_content(text, text, text) from authenticated;
grant execute on function public.nexon_record_unmapped_content(text, text, text) to service_role;

revoke all on function public.nexon_resolve_boss_difficulty(text, text, text) from public;
revoke all on function public.nexon_resolve_boss_difficulty(text, text, text) from anon;
revoke all on function public.nexon_resolve_boss_difficulty(text, text, text) from authenticated;
grant execute on function public.nexon_resolve_boss_difficulty(text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
begin
  -- 실측 cycle 3종이 정확히 매핑되는가
  if public.nexon_cycle_to_boss_cycle('bossDaily')   <> 'daily'
     or public.nexon_cycle_to_boss_cycle('bossWeekly')  <> 'weekly'
     or public.nexon_cycle_to_boss_cycle('bossMonthly') <> 'monthly' then
    raise exception 'cycle 매핑이 실측값과 어긋납니다.';
  end if;

  -- 모르는 값이 조용히 기본값으로 떨어지지 않는가
  if public.nexon_cycle_to_boss_cycle('bossYearly') is not null
     or public.nexon_cycle_to_boss_cycle('daily') is not null
     or public.nexon_cycle_to_boss_cycle(null) is not null then
    raise exception '모르는 cycle 이 null 이 아닙니다 — 조용히 기본값으로 떨어지고 있습니다.';
  end if;

  -- difficulty 5종
  if public.nexon_difficulty_to_tier('easy') <> 'easy'
     or public.nexon_difficulty_to_tier('extreme') <> 'extreme'
     or public.nexon_difficulty_to_tier('버스') is not null then
    raise exception 'difficulty 매핑 오류';
  end if;

  -- 문자열 플래그
  if public.nexon_flag_to_boolean('true') is not true
     or public.nexon_flag_to_boolean('false') is not false
     or public.nexon_flag_to_boolean('yes') is not null then
    raise exception 'flag 파싱 오류';
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817094100_seed_boss_master.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 17. 보스 마스터 시드
-- =============================================================================
-- 출처: Claude/research-BOSS-DATA.md (표) + Claude/review-BOSS-DATA.md (교차검증)
--       + Claude/NEXON-API-OBSERVED.md (실측 content_name 32종)
--
-- 보스 그룹 32 / 난이도 엔트리 78 (일간 24 · 주간 52 · 월간 2)
--
-- ── 시드하면서 내린 판단 3가지 ────────────────────────────────────────────
-- 1. `radiant_omen` → **`radiant_malefic_star`** 로 고쳐 넣는다.
--    review-BOSS-DATA.md 가 "찬란한 흉성의 영문명은 Radiant Malefic Star 이고,
--    id 가 DB 영구 키라고 스스로 못 박은 이상 지금 고치는 것이 옳다"고 지적했다.
--    출시 후에는 변경 비용이 발생하므로 **시드 시점인 지금이 마지막 기회**다.
--
-- 2. **모호한 별칭 2개는 넣지 않는다.**
--    `노벨` → 노멀 벨룸 / 노멀 벨로나 양쪽에 걸린다.
--    `노반` → 노멀 반반 / 노멀 반 레온 양쪽에 걸린다.
--    봇이 조용히 엉뚱한 보스에 등록하는 것보다 두 글자 더 치게 하는 편이 낫다
--    (research-KAKAO-BOT §2.10 이 정확히 경고한 사고 유형).
--    → `노벨룸`/`노벨로나`, `노반반`/`노반레` 를 쓴다.
--
-- 3. **벨로나 3종은 가격 null + released=false** (CLAUDE.md §1.3 D4).
--    이지/하드는 단일 출처, 노멀은 850M vs 890M 출처 충돌이라 셋 다 신뢰도가 같다.
--    null 은 0 이 아니라 "미확인"이며 수익 집계에서 제외되고 별도로 카운트된다.
--
-- 재실행 안전: 전부 on conflict do update. 별칭만 seed 출처로 지우고 다시 넣는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 17-1. 보스 그룹 (32)
-- -----------------------------------------------------------------------------
-- nexon_content_name 은 NEXON-API-OBSERVED.md 의 실측 32종에서 그대로 가져왔다.
-- 벨로나만 미출시라 실측되지 않았고, 그 사실을 nexon_name_verified = false 로 남긴다.
insert into public.bosses (id, korean_name, generation, nexon_content_name, nexon_name_verified, sort_order)
values
  ('zakum',                '자쿰',              'classic', '자쿰',              true,  10),
  ('papulatus',            '파풀라투스',        'classic', '파풀라투스',        true,  20),
  ('magnus',               '매그너스',          'classic', '매그너스',          true,  30),
  ('hilla',                '힐라',              'classic', '힐라',              true,  40),
  ('horntail',             '혼테일',            'classic', '혼테일',            true,  50),
  ('bloody_queen',         '블러디퀸',          'classic', '블러디퀸',          true,  60),
  ('von_bon',              '반반',              'classic', '반반',              true,  70),
  ('pierre',               '피에르',            'classic', '피에르',            true,  80),
  ('vellum',               '벨룸',              'classic', '벨룸',              true,  90),
  ('von_leon',             '반 레온',           'classic', '반 레온',           true, 100),
  ('arkarium',             '아카이럼',          'classic', '아카이럼',          true, 110),
  ('kaung',                '카웅',              'classic', '카웅',              true, 120),
  ('pink_bean',            '핑크빈',            'classic', '핑크빈',            true, 130),
  ('cygnus',               '시그너스',          'classic', '시그너스',          true, 140),
  ('lotus',                '스우',              'classic', '스우',              true, 150),
  ('damien',               '데미안',            'classic', '데미안',            true, 160),
  ('guardian_angel_slime', '가디언 엔젤 슬라임','classic', '가디언 엔젤 슬라임',true, 170),
  ('lucid',                '루시드',            'classic', '루시드',            true, 180),
  ('will',                 '윌',                'classic', '윌',                true, 190),
  ('dusk',                 '더스크',            'classic', '더스크',            true, 200),
  ('dunkel',               '듄켈',              'classic', '듄켈',              true, 210),
  ('verus_hilla',          '진 힐라',           'classic', '진 힐라',           true, 220),
  ('seren',                '선택받은 세렌',     'classic', '선택받은 세렌',     true, 230),
  ('kalos',                '감시자 칼로스',     'classic', '감시자 칼로스',     true, 240),
  ('first_adversary',      '최초의 대적자',     'modern',  '최초의 대적자',     true, 250),
  ('kaling',               '카링',              'classic', '카링',              true, 260),
  -- 미출시라 실측되지 않았다. 이름은 추정이며 조인이 실패할 수 있다.
  ('bellona',              '벨로나',            'modern',  '벨로나',            false,270),
  ('radiant_malefic_star', '찬란한 흉성',       'modern',  '찬란한 흉성',       true, 280),
  ('limbo',                '림보',              'modern',  '림보',              true, 290),
  ('baldrix',              '발드릭스',          'modern',  '발드릭스',          true, 300),
  ('jupiter',              '유피테르',          'modern',  '유피테르',          true, 310),
  ('black_mage',           '검은 마법사',       'classic', '검은 마법사',       true, 320)
on conflict (id) do update set
  korean_name         = excluded.korean_name,
  generation          = excluded.generation,
  nexon_content_name  = excluded.nexon_content_name,
  nexon_name_verified = excluded.nexon_name_verified,
  sort_order          = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 17-2. 난이도 엔트리 (78)
-- -----------------------------------------------------------------------------
-- max_party: 구세대 6 / 신세대 3 / **익스트림 스우만 2** (CLAUDE.md §1.3 D5 — 소프트 상한)
insert into public.boss_difficulties
  (id, boss_id, korean_name, difficulty, cycle, max_party, entry_level, released, nexon_difficulty, sort_order)
values
  -- ── 일간 24 ─────────────────────────────────────────────────────────────
  ('zakum_easy',                'zakum',       '이지 자쿰',        'easy',   'daily', 6,  50, true, 'easy',    10),
  ('zakum_normal',              'zakum',       '노멀 자쿰',        'normal', 'daily', 6,  90, true, 'normal',  20),
  ('papulatus_easy',            'papulatus',   '이지 파풀라투스',  'easy',   'daily', 6, 115, true, 'easy',    30),
  ('magnus_easy',               'magnus',      '이지 매그너스',    'easy',   'daily', 6, 115, true, 'easy',    40),
  ('hilla_normal',              'hilla',       '노멀 힐라',        'normal', 'daily', 6,  85, true, 'normal',  50),
  ('horntail_easy',             'horntail',    '이지 혼테일',      'easy',   'daily', 6, 130, true, 'easy',    60),
  ('bloody_queen_normal',       'bloody_queen','노멀 블러디퀸',    'normal', 'daily', 6, 125, true, 'normal',  70),
  ('von_bon_normal',            'von_bon',     '노멀 반반',        'normal', 'daily', 6, 125, true, 'normal',  80),
  ('pierre_normal',             'pierre',      '노멀 피에르',      'normal', 'daily', 6, 125, true, 'normal',  90),
  ('vellum_normal',             'vellum',      '노멀 벨룸',        'normal', 'daily', 6, 125, true, 'normal', 100),
  ('horntail_normal',           'horntail',    '노멀 혼테일',      'normal', 'daily', 6, 130, true, 'normal', 110),
  ('von_leon_easy',             'von_leon',    '이지 반 레온',     'easy',   'daily', 6, 125, true, 'easy',   120),
  ('arkarium_easy',             'arkarium',    '이지 아카이럼',    'easy',   'daily', 6, 140, true, 'easy',   130),
  ('kaung_normal',              'kaung',       '노멀 카웅',        'normal', 'daily', 6, 180, true, 'normal', 140),
  ('horntail_chaos',            'horntail',    '카오스 혼테일',    'chaos',  'daily', 6, 135, true, 'chaos',  150),
  ('pink_bean_normal',          'pink_bean',   '노멀 핑크빈',      'normal', 'daily', 6, 140, true, 'normal', 160),
  ('von_leon_normal',           'von_leon',    '노멀 반 레온',     'normal', 'daily', 6, 125, true, 'normal', 170),
  ('von_leon_hard',             'von_leon',    '하드 반 레온',     'hard',   'daily', 6, 125, true, 'hard',   180),
  ('arkarium_normal',           'arkarium',    '노멀 아카이럼',    'normal', 'daily', 6, 140, true, 'normal', 190),
  ('magnus_normal',             'magnus',      '노멀 매그너스',    'normal', 'daily', 6, 155, true, 'normal', 200),
  ('papulatus_normal',          'papulatus',   '노멀 파풀라투스',  'normal', 'daily', 6, 155, true, 'normal', 210),
  ('hilla_hard',                'hilla',       '하드 힐라',        'hard',   'daily', 6, 170, true, 'hard',   220),
  ('pink_bean_chaos',           'pink_bean',   '카오스 핑크빈',    'chaos',  'daily', 6, 170, true, 'chaos',  230),
  ('cygnus_normal',             'cygnus',      '노멀 시그너스',    'normal', 'daily', 6, 165, true, 'normal', 240),

  -- ── 주간 52 ─────────────────────────────────────────────────────────────
  ('zakum_chaos',                     'zakum',                '카오스 자쿰',                 'chaos',   'weekly', 6,  90, true, 'chaos',  310),
  ('bloody_queen_chaos',              'bloody_queen',         '카오스 블러디퀸',             'chaos',   'weekly', 6, 180, true, 'chaos',  320),
  ('von_bon_chaos',                   'von_bon',              '카오스 반반',                 'chaos',   'weekly', 6, 180, true, 'chaos',  330),
  ('pierre_chaos',                    'pierre',               '카오스 피에르',               'chaos',   'weekly', 6, 180, true, 'chaos',  340),
  ('magnus_hard',                     'magnus',               '하드 매그너스',               'hard',    'weekly', 6, 175, true, 'hard',   350),
  ('vellum_chaos',                    'vellum',               '카오스 벨룸',                 'chaos',   'weekly', 6, 180, true, 'chaos',  360),
  ('papulatus_chaos',                 'papulatus',            '카오스 파풀라투스',           'chaos',   'weekly', 6, 190, true, 'chaos',  370),
  ('lotus_normal',                    'lotus',                '노멀 스우',                   'normal',  'weekly', 6, 190, true, 'normal', 380),
  ('damien_normal',                   'damien',               '노멀 데미안',                 'normal',  'weekly', 6, 190, true, 'normal', 390),
  ('guardian_angel_slime_normal',     'guardian_angel_slime', '노멀 가디언 엔젤 슬라임',     'normal',  'weekly', 6, 210, true, 'normal', 400),
  ('lucid_easy',                      'lucid',                '이지 루시드',                 'easy',    'weekly', 6, 220, true, 'easy',   410),
  ('will_easy',                       'will',                 '이지 윌',                     'easy',    'weekly', 6, 235, true, 'easy',   420),
  ('lucid_normal',                    'lucid',                '노멀 루시드',                 'normal',  'weekly', 6, 220, true, 'normal', 430),
  ('will_normal',                     'will',                 '노멀 윌',                     'normal',  'weekly', 6, 235, true, 'normal', 440),
  ('dusk_normal',                     'dusk',                 '노멀 더스크',                 'normal',  'weekly', 6, 245, true, 'normal', 450),
  ('dunkel_normal',                   'dunkel',               '노멀 듄켈',                   'normal',  'weekly', 6, 255, true, 'normal', 460),
  ('damien_hard',                     'damien',               '하드 데미안',                 'hard',    'weekly', 6, 190, true, 'hard',   470),
  ('lotus_hard',                      'lotus',                '하드 스우',                   'hard',    'weekly', 6, 190, true, 'hard',   480),
  ('lucid_hard',                      'lucid',                '하드 루시드',                 'hard',    'weekly', 6, 220, true, 'hard',   490),
  ('dusk_chaos',                      'dusk',                 '카오스 더스크',               'chaos',   'weekly', 6, 245, true, 'chaos',  500),
  ('verus_hilla_normal',              'verus_hilla',          '노멀 진 힐라',                'normal',  'weekly', 6, 250, true, 'normal', 510),
  ('guardian_angel_slime_chaos',      'guardian_angel_slime', '카오스 가디언 엔젤 슬라임',   'chaos',   'weekly', 6, 210, true, 'chaos',  520),
  ('will_hard',                       'will',                 '하드 윌',                     'hard',    'weekly', 6, 235, true, 'hard',   530),
  ('dunkel_hard',                     'dunkel',               '하드 듄켈',                   'hard',    'weekly', 6, 255, true, 'hard',   540),
  ('verus_hilla_hard',                'verus_hilla',          '하드 진 힐라',                'hard',    'weekly', 6, 250, true, 'hard',   550),
  ('seren_normal',                    'seren',                '노멀 선택받은 세렌',          'normal',  'weekly', 6, 260, true, 'normal', 560),
  ('kalos_easy',                      'kalos',                '이지 감시자 칼로스',          'easy',    'weekly', 6, 265, true, 'easy',   570),
  ('first_adversary_easy',            'first_adversary',      '이지 최초의 대적자',          'easy',    'weekly', 3, 270, true, 'easy',   580),
  ('seren_hard',                      'seren',                '하드 선택받은 세렌',          'hard',    'weekly', 6, 260, true, 'hard',   590),
  ('kaling_easy',                     'kaling',               '이지 카링',                   'easy',    'weekly', 6, 275, true, 'easy',   600),
  ('bellona_easy',                    'bellona',              '이지 벨로나',                 'easy',    'weekly', 3, 280, false,'easy',   610),
  ('kalos_normal',                    'kalos',                '노멀 감시자 칼로스',          'normal',  'weekly', 6, 265, true, 'normal', 620),
  ('first_adversary_normal',          'first_adversary',      '노멀 최초의 대적자',          'normal',  'weekly', 3, 270, true, 'normal', 630),
  ('lotus_extreme',                   'lotus',                '익스트림 스우',               'extreme', 'weekly', 2, 190, true, 'extreme',640),
  ('radiant_malefic_star_normal',     'radiant_malefic_star', '노멀 찬란한 흉성',            'normal',  'weekly', 3, 280, true, 'normal', 650),
  ('kaling_normal',                   'kaling',               '노멀 카링',                   'normal',  'weekly', 6, 275, true, 'normal', 660),
  ('bellona_normal',                  'bellona',              '노멀 벨로나',                 'normal',  'weekly', 3, 280, false,'normal', 670),
  ('limbo_normal',                    'limbo',                '노멀 림보',                   'normal',  'weekly', 3, 285, true, 'normal', 680),
  ('kalos_chaos',                     'kalos',                '카오스 감시자 칼로스',        'chaos',   'weekly', 6, 265, true, 'chaos',  690),
  ('baldrix_normal',                  'baldrix',              '노멀 발드릭스',               'normal',  'weekly', 3, 290, true, 'normal', 700),
  ('first_adversary_hard',            'first_adversary',      '하드 최초의 대적자',          'hard',    'weekly', 3, 270, true, 'hard',   710),
  ('jupiter_normal',                  'jupiter',              '노멀 유피테르',               'normal',  'weekly', 3, 295, true, 'normal', 720),
  ('kaling_hard',                     'kaling',               '하드 카링',                   'hard',    'weekly', 6, 275, true, 'hard',   730),
  ('limbo_hard',                      'limbo',                '하드 림보',                   'hard',    'weekly', 3, 285, true, 'hard',   740),
  ('radiant_malefic_star_hard',       'radiant_malefic_star', '하드 찬란한 흉성',            'hard',    'weekly', 3, 280, true, 'hard',   750),
  ('seren_extreme',                   'seren',                '익스트림 선택받은 세렌',      'extreme', 'weekly', 6, 260, true, 'extreme',760),
  ('bellona_hard',                    'bellona',              '하드 벨로나',                 'hard',    'weekly', 3, 280, false,'hard',   770),
  ('baldrix_hard',                    'baldrix',              '하드 발드릭스',               'hard',    'weekly', 3, 290, true, 'hard',   780),
  ('kalos_extreme',                   'kalos',                '익스트림 감시자 칼로스',      'extreme', 'weekly', 6, 265, true, 'extreme',790),
  ('first_adversary_extreme',         'first_adversary',      '익스트림 최초의 대적자',      'extreme', 'weekly', 3, 270, true, 'extreme',800),
  ('jupiter_hard',                    'jupiter',              '하드 유피테르',               'hard',    'weekly', 3, 295, true, 'hard',   810),
  ('kaling_extreme',                  'kaling',               '익스트림 카링',               'extreme', 'weekly', 6, 275, true, 'extreme',820),

  -- ── 월간 2 ──────────────────────────────────────────────────────────────
  ('black_mage_hard',    'black_mage', '하드 검은 마법사',     'hard',    'monthly', 6, 255, true, 'hard',    910),
  ('black_mage_extreme', 'black_mage', '익스트림 검은 마법사', 'extreme', 'monthly', 6, 255, true, 'extreme', 920)
on conflict (id) do update set
  boss_id          = excluded.boss_id,
  korean_name      = excluded.korean_name,
  difficulty       = excluded.difficulty,
  cycle            = excluded.cycle,
  max_party        = excluded.max_party,
  entry_level      = excluded.entry_level,
  released         = excluded.released,
  nexon_difficulty = excluded.nexon_difficulty,
  sort_order       = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 17-3. 결정석 시세
-- -----------------------------------------------------------------------------
-- 기준 패치: 1.2.202 (2026-06-18 OVERDRIVE). 월간(검은 마법사)만 2026-07-01 적용.
insert into public.boss_crystal_prices (boss_difficulty_id, price_meso, effective_from, patch_label, note)
values
  ('zakum_easy',                   114000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('zakum_normal',                 349000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('papulatus_easy',               390000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('magnus_easy',                  411000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('hilla_normal',                 455000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('horntail_easy',                502000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bloody_queen_normal',          551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_bon_normal',               551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('pierre_normal',                551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('vellum_normal',                551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('horntail_normal',              576000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_leon_easy',                602000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('arkarium_easy',                656000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaung_normal',                 712000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('horntail_chaos',               770000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('pink_bean_normal',             799000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_leon_normal',              830000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_leon_hard',               1070000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('arkarium_normal',             1110000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('magnus_normal',               1160000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('papulatus_normal',            1200000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('hilla_hard',                  1280000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '2026-06-18 주간→일간 원복'),
  ('pink_bean_chaos',             1320000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '2026-06-18 주간→일간 원복'),
  ('cygnus_normal',               1360000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '2026-06-18 주간→일간 원복 + 이지/노멀 통합'),

  ('zakum_chaos',                 8080000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bloody_queen_chaos',          8140000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_bon_chaos',               8150000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('pierre_chaos',                8170000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('magnus_hard',                 8560000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('vellum_chaos',                9280000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('papulatus_chaos',            13100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lotus_normal',               16700000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('damien_normal',              17500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('guardian_angel_slime_normal',25500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lucid_easy',                 29800000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('will_easy',                  32300000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lucid_normal',               35600000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('will_normal',                41100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dusk_normal',                44000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dunkel_normal',              47500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('damien_hard',                48900000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lotus_hard',                 51500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lucid_hard',                 62900000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dusk_chaos',                 69800000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('verus_hilla_normal',         71200000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('guardian_angel_slime_chaos', 75100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('will_hard',                  77100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dunkel_hard',                94400000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('verus_hilla_hard',          106000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('seren_normal',              239000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kalos_easy',                280000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_easy',      308000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('seren_hard',                356000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_easy',               377000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  -- ★ 벨로나 3종: 가격 미확인. null 은 0 이 아니다 (CLAUDE.md §1.3 D4)
  ('bellona_easy',                   null, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '미출시(2026-08-20 예정). 단일 출처뿐이라 확정 불가 — null 은 0 이 아니라 미확인'),
  ('kalos_normal',              505000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_normal',    560000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lotus_extreme',             574000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '최대 2인 — 1인당 287,000,000'),
  ('radiant_malefic_star_normal',625000000,timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_normal',             678000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bellona_normal',                 null, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '미출시(2026-08-20 예정). 출처 충돌 850,000,000 vs 890,000,000 — 확정 불가'),
  ('limbo_normal',             1026000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kalos_chaos',              1273000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('baldrix_normal',           1368000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_hard',     1435000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('jupiter_normal',           1615000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_hard',              1739000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('limbo_hard',               2385000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('radiant_malefic_star_hard',2678000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('seren_extreme',            2835000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bellona_hard',                   null, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '미출시(2026-08-21 예정). 단일 출처뿐이라 확정 불가'),
  ('baldrix_hard',             3078000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kalos_extreme',            4104000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_extreme',  4712000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('jupiter_hard',             4845000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_extreme',           5387000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),

  ('black_mage_hard',           665000000, timestamptz '2026-07-01 00:00+09', '월간 결정 2026-07-01 적용', null),
  ('black_mage_extreme',       8740000000, timestamptz '2026-07-01 00:00+09', '월간 결정 2026-07-01 적용', null)
on conflict (boss_difficulty_id, effective_from) do update set
  price_meso  = excluded.price_meso,
  patch_label = excluded.patch_label,
  note        = excluded.note;

-- -----------------------------------------------------------------------------
-- 17-4. 별칭
-- -----------------------------------------------------------------------------
-- 시드 출처 행만 지우고 다시 넣는다. 운영 중 손으로 추가한 별칭(source <> 'seed:...')은 보존된다.
delete from public.boss_aliases where source = 'seed:research-BOSS-DATA';

insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id, v.entry_id, v.alias, lower(btrim(replace(v.alias, ' ', ''))), 'seed:research-BOSS-DATA'
from (values
  -- ── 그룹 별칭 (난이도 미지정 → 봇이 후보가 여럿이면 되묻는다) ─────────────
  ('zakum', null, '자쿰'), ('zakum', null, '쟈쿰'),
  ('papulatus', null, '파풀라투스'), ('papulatus', null, '파풀'),
  ('magnus', null, '매그너스'), ('magnus', null, '매그'),
  ('hilla', null, '힐라'),
  ('horntail', null, '혼테일'), ('horntail', null, '혼테'),
  ('bloody_queen', null, '블러디퀸'), ('bloody_queen', null, '블퀸'),
  ('von_bon', null, '반반'),
  ('pierre', null, '피에르'),
  ('vellum', null, '벨룸'),
  ('von_leon', null, '반레온'), ('von_leon', null, '반레'),
  ('arkarium', null, '아카이럼'), ('arkarium', null, '아카'),
  ('kaung', null, '카웅'),
  ('pink_bean', null, '핑크빈'), ('pink_bean', null, '핑빈'),
  ('cygnus', null, '시그너스'), ('cygnus', null, '시그'), ('cygnus', null, '여제'),
  ('lotus', null, '스우'),
  ('damien', null, '데미안'), ('damien', null, '데미'),
  ('guardian_angel_slime', null, '가엔슬'), ('guardian_angel_slime', null, '슬라임'), ('guardian_angel_slime', null, 'GAS'),
  ('lucid', null, '루시드'),
  ('will', null, '윌'),
  ('dusk', null, '더스크'),
  ('dunkel', null, '듄켈'),
  ('verus_hilla', null, '진힐라'), ('verus_hilla', null, '진힐'),
  ('seren', null, '세렌'),
  ('kalos', null, '칼로스'),
  ('first_adversary', null, '적자'), ('first_adversary', null, '최적자'),
  ('kaling', null, '카링'),
  ('bellona', null, '벨로나'),
  ('radiant_malefic_star', null, '흉성'), ('radiant_malefic_star', null, '찬흉'),
  ('limbo', null, '림보'),
  ('baldrix', null, '발드릭스'), ('baldrix', null, '발드'),
  ('jupiter', null, '유피테르'), ('jupiter', null, '유피'),
  ('black_mage', null, '검마'), ('black_mage', null, '흑마'),

  -- ── 난이도 특정 별칭 ──────────────────────────────────────────────────────
  ('zakum','zakum_easy','이자쿰'), ('zakum','zakum_easy','이쟈쿰'), ('zakum','zakum_easy','이자'),
  ('zakum','zakum_normal','노자쿰'), ('zakum','zakum_normal','노자'),
  ('zakum','zakum_chaos','카자쿰'), ('zakum','zakum_chaos','카쿰'), ('zakum','zakum_chaos','카자'),
  ('papulatus','papulatus_easy','이파풀'), ('papulatus','papulatus_easy','이파'),
  ('papulatus','papulatus_normal','노파풀'), ('papulatus','papulatus_normal','노파'),
  ('papulatus','papulatus_chaos','카파풀'), ('papulatus','papulatus_chaos','카파'),
  ('magnus','magnus_easy','이매그'), ('magnus','magnus_easy','이매'),
  ('magnus','magnus_normal','노매그'), ('magnus','magnus_normal','노매'),
  ('magnus','magnus_hard','하매그'), ('magnus','magnus_hard','하매'),
  ('hilla','hilla_normal','노힐라'), ('hilla','hilla_normal','노힐'),
  ('hilla','hilla_hard','하드힐라'), ('hilla','hilla_hard','하힐라'), ('hilla','hilla_hard','하힐'),
  ('horntail','horntail_easy','이혼테'), ('horntail','horntail_easy','이혼'),
  ('horntail','horntail_normal','노혼테'), ('horntail','horntail_normal','노혼'),
  ('horntail','horntail_chaos','카혼테'), ('horntail','horntail_chaos','카혼'), ('horntail','horntail_chaos','카오스혼테일'),
  ('bloody_queen','bloody_queen_normal','노블퀸'), ('bloody_queen','bloody_queen_normal','노블'),
  ('bloody_queen','bloody_queen_chaos','카블퀸'), ('bloody_queen','bloody_queen_chaos','카블'),
  -- ⚠️ `노반` 은 노멀 반반 / 노멀 반 레온 양쪽에 걸려 **의도적으로 제외**한다.
  ('von_bon','von_bon_normal','노반반'),
  ('von_bon','von_bon_chaos','카반반'), ('von_bon','von_bon_chaos','카반'),
  ('pierre','pierre_normal','노피에르'), ('pierre','pierre_normal','노피'),
  ('pierre','pierre_chaos','카피에르'), ('pierre','pierre_chaos','카피'),
  -- ⚠️ `노벨` 은 노멀 벨룸 / 노멀 벨로나 양쪽에 걸려 **의도적으로 제외**한다.
  ('vellum','vellum_normal','노벨룸'),
  ('vellum','vellum_chaos','카벨룸'), ('vellum','vellum_chaos','카벨'),
  ('von_leon','von_leon_easy','이반레'), ('von_leon','von_leon_easy','이반'),
  ('von_leon','von_leon_normal','노반레'),
  ('von_leon','von_leon_hard','하반레'), ('von_leon','von_leon_hard','하반'), ('von_leon','von_leon_hard','하드반레온'),
  ('arkarium','arkarium_easy','이아카'),
  ('arkarium','arkarium_normal','노아카'),
  ('kaung','kaung_normal','노카웅'),
  ('pink_bean','pink_bean_normal','노핑빈'), ('pink_bean','pink_bean_normal','노핑'),
  ('pink_bean','pink_bean_chaos','카핑빈'), ('pink_bean','pink_bean_chaos','카핑'), ('pink_bean','pink_bean_chaos','카오스핑크빈'),
  ('cygnus','cygnus_normal','노시그'),
  ('lotus','lotus_normal','노스우'), ('lotus','lotus_normal','노스'),
  ('lotus','lotus_hard','하스우'), ('lotus','lotus_hard','하스'),
  ('lotus','lotus_extreme','익스우'), ('lotus','lotus_extreme','익스스우'), ('lotus','lotus_extreme','익스'),
  ('damien','damien_normal','노데미'), ('damien','damien_normal','노데'),
  ('damien','damien_hard','하데미'), ('damien','damien_hard','하데'),
  ('guardian_angel_slime','guardian_angel_slime_normal','노가엔슬'),
  ('guardian_angel_slime','guardian_angel_slime_chaos','카가엔슬'), ('guardian_angel_slime','guardian_angel_slime_chaos','카슬라임'),
  ('lucid','lucid_easy','이루시드'), ('lucid','lucid_easy','이루'),
  ('lucid','lucid_normal','노루시드'), ('lucid','lucid_normal','노루'),
  ('lucid','lucid_hard','하루시드'), ('lucid','lucid_hard','하루'),
  ('will','will_easy','이윌'), ('will','will_normal','노윌'), ('will','will_hard','하윌'),
  ('dusk','dusk_normal','노더스크'), ('dusk','dusk_normal','노더'),
  ('dusk','dusk_chaos','카더스크'), ('dusk','dusk_chaos','카더'),
  ('dunkel','dunkel_normal','노듄켈'), ('dunkel','dunkel_normal','노듄'),
  ('dunkel','dunkel_hard','하듄켈'), ('dunkel','dunkel_hard','하듄'),
  ('verus_hilla','verus_hilla_normal','노진힐라'), ('verus_hilla','verus_hilla_normal','노진힐'),
  ('verus_hilla','verus_hilla_hard','하진힐라'), ('verus_hilla','verus_hilla_hard','하진힐'),
  ('seren','seren_normal','노세렌'), ('seren','seren_normal','노세'),
  ('seren','seren_hard','하세렌'), ('seren','seren_hard','하세'),
  ('seren','seren_extreme','익세렌'), ('seren','seren_extreme','익세'),
  ('kalos','kalos_easy','이칼로스'), ('kalos','kalos_easy','이칼'),
  ('kalos','kalos_normal','노칼로스'), ('kalos','kalos_normal','노칼'),
  ('kalos','kalos_chaos','카칼로스'), ('kalos','kalos_chaos','카칼'),
  ('kalos','kalos_extreme','익칼로스'), ('kalos','kalos_extreme','익칼'),
  ('first_adversary','first_adversary_easy','이적자'), ('first_adversary','first_adversary_easy','이최적자'),
  ('first_adversary','first_adversary_normal','노적자'), ('first_adversary','first_adversary_normal','노최적자'),
  ('first_adversary','first_adversary_hard','하적자'), ('first_adversary','first_adversary_hard','하최적자'),
  ('first_adversary','first_adversary_extreme','익적자'), ('first_adversary','first_adversary_extreme','익최적자'),
  ('kaling','kaling_easy','이카링'), ('kaling','kaling_easy','이카'),
  ('kaling','kaling_normal','노카링'), ('kaling','kaling_normal','노카'),
  ('kaling','kaling_hard','하카링'), ('kaling','kaling_hard','하카'),
  ('kaling','kaling_extreme','익카링'), ('kaling','kaling_extreme','익카'),
  ('bellona','bellona_easy','이벨로나'), ('bellona','bellona_easy','이벨'),
  ('bellona','bellona_normal','노벨로나'),
  ('bellona','bellona_hard','하벨로나'), ('bellona','bellona_hard','하벨'),
  ('radiant_malefic_star','radiant_malefic_star_normal','노흉성'),
  ('radiant_malefic_star','radiant_malefic_star_hard','하흉성'), ('radiant_malefic_star','radiant_malefic_star_hard','하흉'),
  ('limbo','limbo_normal','노림보'), ('limbo','limbo_normal','노림'),
  ('limbo','limbo_hard','하림보'), ('limbo','limbo_hard','하림'),
  ('baldrix','baldrix_normal','노발드'),
  ('baldrix','baldrix_hard','하발드릭스'), ('baldrix','baldrix_hard','하발드'),
  ('jupiter','jupiter_normal','노유피'),
  ('jupiter','jupiter_hard','하유피테르'), ('jupiter','jupiter_hard','하유피'),
  ('black_mage','black_mage_hard','하검마'), ('black_mage','black_mage_hard','하검'), ('black_mage','black_mage_hard','하드검은마법사'),
  ('black_mage','black_mage_extreme','익검마'), ('black_mage','black_mage_extreme','익검'), ('black_mage','black_mage_extreme','익스검마')
) as v(boss_id, entry_id, alias);

-- -----------------------------------------------------------------------------
-- 17-5. 의도적 제외 보스 등록
-- -----------------------------------------------------------------------------
-- 실측 content_name 32종 중 `시즌 보스 메이린` 은 챌린저스 월드 전용 이벤트 보스라
-- 우리 마스터에서 **의도적으로 제외**했다(주간 12회 제한 미포함, 2026-09-16 입장 종료).
-- 미리 등록해 두지 않으면 동기화가 이걸 "미지의 신규 보스"로 계속 경고한다.
insert into public.nexon_unmapped_contents (content_name, difficulty, cycle, resolution, note)
values
  ('시즌 보스 메이린', null, null, 'intentionally_excluded',
   '챌린저스 월드 전용 이벤트 보스. 주간 12회 제한에 포함되지 않고 2026-09-16 입장 종료. 결정석 수익 계산 대상이 아니라 의도적으로 마스터에서 제외했다.')
on conflict (content_name, difficulty, cycle) do update set
  resolution = excluded.resolution,
  note       = excluded.note;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_bosses   integer;
  v_entries  integer;
  v_daily    integer;
  v_weekly   integer;
  v_monthly  integer;
  v_missing  text;
  v_observed text[] := array[
    '가디언 엔젤 슬라임','감시자 칼로스','검은 마법사','더스크','데미안','듄켈','루시드','림보',
    '매그너스','반 레온','반반','발드릭스','벨룸','블러디퀸','선택받은 세렌','스우','시그너스',
    '시즌 보스 메이린','아카이럼','윌','유피테르','자쿰','진 힐라','찬란한 흉성','최초의 대적자',
    '카링','카웅','파풀라투스','피에르','핑크빈','혼테일','힐라'
  ];
begin
  select count(*) into v_bosses  from public.bosses;
  select count(*) into v_entries from public.boss_difficulties;
  if v_bosses <> 32 then raise exception '보스 그룹이 32개가 아닙니다: %', v_bosses; end if;
  if v_entries <> 78 then raise exception '난이도 엔트리가 78개가 아닙니다: %', v_entries; end if;

  select count(*) filter (where cycle='daily'),
         count(*) filter (where cycle='weekly'),
         count(*) filter (where cycle='monthly')
    into v_daily, v_weekly, v_monthly
    from public.boss_difficulties;
  if v_daily <> 24 or v_weekly <> 52 or v_monthly <> 2 then
    raise exception '주기별 개수 오류: daily=% weekly=% monthly=%', v_daily, v_weekly, v_monthly;
  end if;

  -- ★ 핵심: 실측 32종이 전부 해석되는가.
  --   메이린은 의도적 제외로 등록되어 있어야 하고, 나머지 31종은 보스로 조인되어야 한다.
  select string_agg(o.name, ', ') into v_missing
  from unnest(v_observed) as o(name)
  where not exists (select 1 from public.bosses b where b.nexon_content_name = o.name)
    and not exists (
      select 1 from public.nexon_unmapped_contents u
      where u.content_name = o.name and u.resolution <> 'unknown'
    );
  if v_missing is not null then
    raise exception '실측 content_name 중 해석되지 않는 것이 있습니다: %', v_missing;
  end if;

  -- 벨로나 3종은 가격이 없어야 한다.
  if exists (
    select 1 from public.boss_crystal_prices p
    join public.boss_difficulties bd on bd.id = p.boss_difficulty_id
    where bd.boss_id = 'bellona' and p.price_meso is not null
  ) then
    raise exception '벨로나에 가격이 들어갔습니다. null(미확인)이어야 합니다.';
  end if;

  if exists (select 1 from public.boss_difficulties where boss_id = 'bellona' and released) then
    raise exception '벨로나가 released=true 입니다. 미출시여야 합니다.';
  end if;

  -- 모호 별칭이 들어가지 않았는가
  if exists (select 1 from public.boss_aliases where normalized_alias in ('노벨', '노반')) then
    raise exception '모호한 별칭(노벨/노반)이 시드되었습니다.';
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817094200_fix_unmapped_resolution_scope.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 18. 미매핑 분류 범위 수정 — 결정은 **보스 단위**다
-- =============================================================================
-- ── 실제 DB 에서 잡은 결함 ──────────────────────────────────────────────────
-- 17 번에서 `시즌 보스 메이린` 을 (content_name=메이린, difficulty=null, cycle=null) 로
-- `intentionally_excluded` 등록했다. 그런데 실제 API 는 난이도·주기를 채워서 보낸다:
--   nexon_resolve_boss_difficulty('시즌 보스 메이린','normal','bossWeekly')
-- 유니크 키가 (content_name, difficulty, cycle) 이라 **새 행**이 생기고 resolution 이
-- 기본값 `unknown` 으로 들어갔다. 결과적으로 의도적 제외 보스가 매번
-- "미지의 신규 보스" 경고 목록에 뜬다 — 요구사항이 금지한 바로 그 상황이다.
--
-- ── 원인 ────────────────────────────────────────────────────────────────────
-- "이 보스는 우리가 안 쓴다"는 판단은 **보스(content_name) 단위**다.
-- 난이도별로 다르게 판단할 일이 없는데 분류를 난이도까지 포함한 키에 매달아 둔 것이 잘못이다.
-- 관측 행은 난이도·주기까지 남기는 게 맞지만(진단에 필요), **분류는 이름 단위로 전파**해야 한다.
--
-- ── 수정 ────────────────────────────────────────────────────────────────────
-- 기록 시 같은 content_name 에 이미 내려진 분류가 있으면 **그것을 물려받는다.**
-- 그리고 사람이 분류할 때는 그 이름의 **모든 행**에 한 번에 적용한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 18-1. 기록 함수 — 같은 보스에 내려진 분류를 물려받는다
-- -----------------------------------------------------------------------------
create or replace function public.nexon_record_unmapped_content(
  p_content_name text,
  p_difficulty   text default null,
  p_cycle        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_id         uuid;
  v_name       text := btrim(p_content_name);
  v_resolution public.nexon_mapping_resolution;
  v_note       text;
begin
  if p_content_name is null or v_name = '' then
    return null;
  end if;

  -- ★ 분류는 보스 단위다. 같은 이름에 이미 판단이 내려져 있으면 물려받는다.
  --   그러지 않으면 의도적으로 제외한 보스가 난이도 조합마다 새로 "미지의 보스"로 뜬다.
  select u.resolution, u.note
    into v_resolution, v_note
    from public.nexon_unmapped_contents u
   where u.content_name = v_name
     and u.resolution <> 'unknown'
   order by u.first_seen_at
   limit 1;

  insert into public.nexon_unmapped_contents (content_name, difficulty, cycle, resolution, note)
  values (v_name, p_difficulty, p_cycle,
          coalesce(v_resolution, 'unknown'::public.nexon_mapping_resolution),
          v_note)
  on conflict (content_name, difficulty, cycle) do update
    set seen_count   = public.nexon_unmapped_contents.seen_count + 1,
        last_seen_at = now()
  returning id into v_id;

  return v_id;
end;
$func$;

comment on function public.nexon_record_unmapped_content(text, text, text) is
  '미매핑 content_name 기록. 분류(resolution)는 **보스 이름 단위**라 같은 이름의 기존 판단을 물려받는다. 재관측 시 카운트만 올린다.';

-- -----------------------------------------------------------------------------
-- 18-2. 사람이 분류하는 진입점 — 이름 단위로 한 번에
-- -----------------------------------------------------------------------------
create or replace function public.nexon_classify_content(
  p_content_name text,
  p_resolution   public.nexon_mapping_resolution,
  p_note         text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_rows integer;
begin
  update public.nexon_unmapped_contents
     set resolution = p_resolution,
         note       = coalesce(p_note, note)
   where content_name = btrim(p_content_name);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$func$;

comment on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) is
  '미매핑 보스를 이름 단위로 분류한다. 난이도·주기 조합이 여러 개여도 한 번에 적용되어 경고 목록에서 함께 사라진다.';

revoke all on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) from public;
revoke all on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) from anon;
revoke all on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) from authenticated;
grant execute on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) to service_role;

-- -----------------------------------------------------------------------------
-- 18-3. 이미 쌓인 행 보정
-- -----------------------------------------------------------------------------
-- 같은 이름에 판단이 있는데 'unknown' 으로 남은 행들을 끌어올린다.
update public.nexon_unmapped_contents u
   set resolution = d.resolution,
       note       = coalesce(u.note, d.note)
  from (
    select distinct on (content_name) content_name, resolution, note
    from public.nexon_unmapped_contents
    where resolution <> 'unknown'
    order by content_name, first_seen_at
  ) d
 where u.content_name = d.content_name
   and u.resolution = 'unknown';

-- 검증 중 만든 가짜 보스 기록 제거 (실제 API 가 준 이름이 아니다)
delete from public.nexon_unmapped_contents where content_name = '신규 보스 테스트';

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_open integer;
begin
  -- 실제 API 형태(난이도·주기 포함)로 의도적 제외 보스를 다시 만나도
  -- 경고 목록에 뜨면 안 된다.
  perform public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'normal', 'bossWeekly');
  perform public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'hard',   'bossWeekly');

  select count(*) into v_open
    from public.v_nexon_unmapped_open
   where content_name = '시즌 보스 메이린';

  if v_open <> 0 then
    raise exception '의도적 제외 보스가 여전히 경고 목록에 뜹니다 (%건).', v_open;
  end if;

  -- 반대로 진짜 미지의 보스는 반드시 떠야 한다.
  perform public.nexon_resolve_boss_difficulty('가상의 신규 보스 XYZ', 'hard', 'bossWeekly');
  if not exists (select 1 from public.v_nexon_unmapped_open where content_name = '가상의 신규 보스 XYZ') then
    raise exception '미지의 신규 보스가 경고 목록에 뜨지 않습니다.';
  end if;
  delete from public.nexon_unmapped_contents where content_name = '가상의 신규 보스 XYZ';
end
$$;

select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817095000_character_boss_plans.sql
-- ============================================================
-- =============================================================================
-- M_Schedule · 19. 캐릭터별 주간 보스 계획 (character_boss_plans)
-- =============================================================================
-- 발주자 요구:
--   "일정 등록할 때 캐릭터 이름을 넣어야 하고. 각 캐릭터마다 가는 주간 보스를 저장해야 함"
--
-- 앞부분(일정 등록 시 캐릭터 지정)은 이미 `run_signups.character_id` 로 해결되어 있다.
-- 이 마이그레이션은 **뒷부분**만 다룬다 — 캐릭터 하나가 "매주 가는 보스" 목록.
--
-- ── 이 테이블이 무엇이 아닌지부터 못박는다 ──────────────────────────────────
--   · **주차별 기록이 아니다.** `boss_clears` 가 "이번 주에 실제로 깼다"를 담고,
--     이 테이블은 "이 캐릭터는 평소 이 보스들을 간다"는 **상시 계획**이다.
--     주차 컬럼이 없는 것이 설계다 — 매주 다시 입력시키지 않는다(§1.4 의 기조와 동일).
--   · **`character_scheduler_snapshots` 의 대체가 아니다.** 그쪽은 넥슨 응답 원문 미러이고
--     읽기 전용 성격이다. 이 테이블은 사용자가 편집하는 1차 데이터다.
--
-- ── 산출물 ──────────────────────────────────────────────────────────────────
--   테이블 1 : character_boss_plans
--   뷰   3 : v_character_boss_plan_status
--            v_character_weekly_boss_progress
--            v_user_weekly_boss_progress
--   함수 3 : character_boss_plans_apply_state() (트리거)
--            set_character_boss_plan()   — 사람이 쓰는 단일 진입점
--            sync_character_boss_plan()  — 넥슨 동기화의 단일 진입점
--            can_view_character_plans()  — 열람 범위 단일 구현
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 19-1. 테이블
-- -----------------------------------------------------------------------------
create table if not exists public.character_boss_plans (
  id                 uuid primary key default gen_random_uuid(),

  -- user_id 는 characters 로부터 **트리거가 유도**한다. 애플리케이션이 넣는 값이 아니다.
  -- 비정규화한 이유: 사용자 단위 합계 뷰와 RLS 판정이 characters 를 매번 조인하지 않아도 되고,
  -- boss_clears 가 이미 (user_id, character_id) 를 함께 들고 있어 집계 형태가 같아진다.
  -- 드리프트 위험은 "앱이 절대 쓰지 않고 트리거만 쓴다"로 원천 차단한다.
  user_id            uuid not null references public.app_users(id)         on delete cascade,
  character_id       uuid not null references public.characters(id)        on delete cascade,

  -- ★ 난이도까지 특정된 보스다. "스우"가 아니라 "하드 스우".
  --   boss_difficulties 의 text PK(예: `lotus_hard`)를 그대로 쓴다 — 원장에서 눈으로 읽힌다(§난제 4).
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete restrict,

  -- ── 출처 2계통 ────────────────────────────────────────────────────────────
  -- 사람이 직접 넣은 값 (null = 사람이 이 보스에 대해 한 번도 판단한 적 없음)
  manual_active      boolean,
  manual_set_at      timestamptz,

  -- 넥슨 `boss_contents[].registration_flag` (문자열 "true"/"false" → boolean 변환 후 저장)
  -- (null = API 응답에서 이 보스를 한 번도 본 적 없음)
  api_registered     boolean,
  -- ★ "호출 시각"이 아니라 **응답이 말하는 데이터 기준 시각**이다.
  --   넥슨 데이터는 ~15분 지연되므로 호출 시각으로 다루면 항상 API 가 최신인 척하게 된다.
  api_observed_at    timestamptz,

  -- ── 트리거가 계산하는 값 ──────────────────────────────────────────────────
  is_active          boolean not null default true,   -- 승자. 목록에 실제로 들어있는가
  has_conflict       boolean not null default false,  -- 두 출처가 어긋남 (UI 배지)

  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 같은 캐릭터에 같은 보스난이도는 하나뿐이다.
  constraint character_boss_plans_uniq
    unique (character_id, boss_difficulty_id),

  -- 값과 그 관측 시각은 항상 짝으로 존재한다. 한쪽만 있으면 승자 판정이 성립하지 않는다.
  constraint character_boss_plans_manual_pair
    check ((manual_active is null) = (manual_set_at is null)),
  constraint character_boss_plans_api_pair
    check ((api_registered is null) = (api_observed_at is null)),

  -- 출처가 하나도 없는 행은 존재 이유가 없다. 유령 행을 만들지 못하게 막는다.
  constraint character_boss_plans_has_source
    check (num_nonnulls(manual_active, api_registered) >= 1)
);

comment on table public.character_boss_plans is
  '캐릭터별 "매주 가는 보스" 상시 계획. 주차별 기록이 아니다(그건 boss_clears). is_active 로 목록에서 켜고 끈다.';
comment on column public.character_boss_plans.user_id is
  '트리거가 characters.user_id 에서 유도한다. 애플리케이션은 이 컬럼에 값을 쓰지 않는다.';
comment on column public.character_boss_plans.manual_active is
  '사용자가 직접 내린 판단. null 이면 미판단. **넥슨 동기화가 이 값을 절대 덮어쓰지 않는다.**';
comment on column public.character_boss_plans.api_registered is
  '넥슨 registration_flag("true"/"false" 문자열)를 boolean 으로 변환한 값. 참고용이며 수동 값을 이기지 못한다.';
comment on column public.character_boss_plans.api_observed_at is
  '응답이 말하는 데이터 기준 시각(호출 시각 아님). 넥슨 데이터는 ~15분 지연된다.';
comment on column public.character_boss_plans.is_active is
  '트리거 계산값. coalesce(manual_active, api_registered). 목록에 실제로 들어 있는지 여부.';
comment on column public.character_boss_plans.has_conflict is
  '수동 값과 API 값이 다름. 덮어쓰지 않고 UI 배지로 노출해 사용자가 결정하게 한다.';


-- -----------------------------------------------------------------------------
-- 19-2. 충돌 규칙 — **수동이 무조건 이긴다** (boss_clears 의 최신성 규칙과 다르다)
-- -----------------------------------------------------------------------------
-- boss_clears(난제 6)는 "더 최신 관측이 이긴다"였다. 여기서는 일부러 다르게 간다.
--
--   · `complete_flag` 는 **이미 일어난 사건의 관측**이다. 두 출처가 같은 객관적 사실을
--     서술하므로 더 최신 관측이 더 옳을 가능성이 높다. → 최신성 규칙이 맞다.
--   · `registration_flag` 는 **앞으로의 의사 표명**이고, 무엇보다 **인게임 체크리스트라는
--     별도의 목록**이다. 대다수 사용자는 그 체크리스트를 관리하지 않는다.
--     최신성 규칙을 쓰면, 사용자가 우리 앱에서 방금 "하드 스우 감"이라고 넣어도
--     다음 동기화가 방치된 인게임 체크리스트(false)를 관측하는 순간 **조용히 지워진다.**
--     이것이 브리프가 금지한 바로 그 상황이다.
--
-- 그래서 규칙은 단 두 줄이다:
--   1. manual_active 가 있으면 그것이 결과다. api_registered 는 결과에 영향을 주지 않는다.
--   2. manual_active 가 없을 때만 api_registered 가 결과가 된다.
-- 진 쪽 값은 **지우지 않는다.** 두 값이 다르면 has_conflict 로 표시하고, 사용자가
-- "API 값을 채택" 하면 그것은 set_character_boss_plan() 으로 들어오는 **새 수동 값**이다.
-- 즉 자동 반영은 없고, 사람이 명시적으로 누른 것만 반영된다.
create or replace function public.character_boss_plans_apply_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_owner uuid;
begin
  select c.user_id into v_owner
    from public.characters c
   where c.id = new.character_id;

  if v_owner is null then
    raise exception '존재하지 않는 캐릭터입니다: %', new.character_id
      using errcode = 'foreign_key_violation';
  end if;

  new.user_id := v_owner;

  -- ★ 수동 우선. coalesce 한 줄이 곧 충돌 규칙이다.
  new.is_active := coalesce(new.manual_active, new.api_registered, false);

  new.has_conflict := (
        new.manual_active  is not null
    and new.api_registered is not null
    and new.manual_active is distinct from new.api_registered
  );

  return new;
end;
$func$;

comment on function public.character_boss_plans_apply_state() is
  'user_id 유도 + 충돌 규칙 적용. 규칙: 수동 값이 있으면 무조건 수동이 이긴다(최신성 비교 없음).';

drop trigger if exists character_boss_plans_apply_state on public.character_boss_plans;
create trigger character_boss_plans_apply_state
  before insert or update on public.character_boss_plans
  for each row execute function public.character_boss_plans_apply_state();

drop trigger if exists character_boss_plans_set_updated_at on public.character_boss_plans;
create trigger character_boss_plans_set_updated_at
  before update on public.character_boss_plans
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 19-3. 인덱스
-- -----------------------------------------------------------------------------
-- (character_id, boss_difficulty_id) 는 유니크 제약이 이미 인덱스를 만든다.
-- FK 인덱스 정책(마이그레이션 15)에 맞춰 나머지 FK 컬럼에도 인덱스를 붙인다.
create index if not exists character_boss_plans_user_idx
  on public.character_boss_plans (user_id);

create index if not exists character_boss_plans_boss_difficulty_idx
  on public.character_boss_plans (boss_difficulty_id);

-- 진행 상황 뷰가 실제로 타는 경로: 캐릭터의 **켜져 있는** 계획만 훑는다.
create index if not exists character_boss_plans_active_idx
  on public.character_boss_plans (character_id)
  where is_active;

-- 충돌 배지는 전체를 훑지 않고 충돌 행만 집는다.
create index if not exists character_boss_plans_conflict_idx
  on public.character_boss_plans (user_id)
  where has_conflict;


-- -----------------------------------------------------------------------------
-- 19-4. 12개 상한 — **집계·경고만 한다. DB 는 막지 않는다.**
-- -----------------------------------------------------------------------------
-- 사실관계(§1, 실측 `weekly_boss_clear_limit_count` = 12):
--   주간 결정석 판매는 캐릭터당 12개이고, 2025-08-21 패치 이후 13번째 주간 보스는
--   입장 자체가 불가하다. 그러니 "13개를 계획에 넣는 것"은 게임에서 성립하지 않는다.
--
-- 그럼에도 하드 제약(트리거 차단)을 두지 않는 이유:
--
--   1. **계획은 탐색적이다.** "이 캐릭터가 갈 12개를 어느 것으로 고를까"를 정하려면
--      후보 15개를 올려놓고 3개를 끄는 과정을 반드시 지난다. 13번째 INSERT 에서
--      막으면 도구가 가장 필요한 순간에 도구가 멈춘다.
--   2. **끄기(is_active=false)가 이미 있다.** 15개를 목록에 두고 12개만 켜는 것이
--      정상적인 사용법이다. 하드 제약은 이 사용법과 정면으로 충돌한다.
--   3. **12는 판매 상한이지 계획 상한이 아니다.** 결정석은 획득 후 1주일 유효라
--      지난주 클리어분을 이번 주에 팔 수 있다(§1.3 D1). 즉 실제 슬롯 소모는
--      계획 테이블만 봐서는 알 수 없다 — 우리가 알 수 없는 것을 강제하면 안 된다.
--   4. 여러 행에 걸친 개수 불변식은 CHECK 로 표현할 수 없어 트리거가 필요한데,
--      차단 트리거는 같은 캐릭터에 대한 동시 INSERT 를 직렬화시키고
--      사용자에게는 알아보기 힘든 raw 오류로 새어 나간다.
--   5. `max_party` 를 소프트 상한으로 둔 판단(§1.3 D5)과 **같은 기조**다.
--      우리 쪽 추정이 사용자의 실제 상황을 막는 일은 만들지 않는다.
--
-- → 대신 뷰가 weekly_limit / weekly_over_limit / weekly_slots_remaining 을 낸다.
--   상한값은 코드에 박지 않고 기존 `public.weekly_crystal_sell_limit()` 한 곳을 쓴다.
--
-- ── 일간·월간 보스를 목록에 넣을 수 있게 할 것인가 → **넣을 수 있게 한다.** ──
--   단, 12 카운터에는 절대 넣지 않는다(§1: 일간 결정석은 12에 포함되지 않는다).
--
--   허용하는 이유:
--     · **cycle 은 패치로 바뀌는 값이다.** 2026-06-18 패치가 하드 힐라·카오스 핑크빈·
--       노멀 시그너스를 주간→일간으로 되돌렸다. `check (cycle = 'weekly')` 같은 제약을
--       걸어 두면 게임이 바뀌는 바로 그 순간 기존 행이 위법해지고 UPDATE 가 전부 막힌다.
--       마스터 데이터의 가변 속성에 하드 제약을 거는 것은 구조적으로 잘못된 결합이다.
--     · 고정된 일간 세트(하드 힐라 등)를 매일 도는 사용자가 실제로 있고,
--       "이 캐릭터가 도는 보스 목록"은 그것을 적어 둘 자연스러운 자리다.
--     · 12 카운터에서 빼는 일은 **저장을 막는 것이 아니라 뷰가 cycle 로 거르는 것**으로
--       충분히 달성된다. 저장 금지는 과잉이다.
--
--   대신 뷰가 planned_weekly / planned_daily / planned_monthly 를 **분리해서** 낸다.
--   over_limit 판정은 오직 planned_weekly 만 본다.
--
--   ⚠️ 알려진 근사: `boss_clears` 의 유니크 키가 (user, character, boss_difficulty, week_key)
--   라 일간 보스는 한 주에 최대 1행이다. 따라서 일간 계획의 `is_cleared` 는
--   "이번 주에 한 번이라도 깼다"는 뜻이며 "7일 중 며칠 깼다"가 아니다.
--   일간 보스의 일자별 진척이 필요해지면 그때 boss_clears 의 키를 확장해야 한다.


-- -----------------------------------------------------------------------------
-- 19-5. 열람 범위 단일 구현 — **본인 것만**
-- -----------------------------------------------------------------------------
-- 인증 모델 (c) 에서는 auth.uid() 가 없어 이 규칙을 RLS 술어로 쓸 수 없다(난제 1).
-- 그래서 `can_view_availability` 와 같은 방식으로 함수 하나에 못박고
-- Route Handler / 봇이 호출한다. TS 에 흩어 놓으면 화면과 봇의 범위가 갈라진다.
--
-- 범위는 **본인뿐이다.** 가용시간(본인/친구/같은 파티)보다도 좁다.
-- 남의 보스 계획을 열람할 제품상 이유가 없고, 파티 구성원에게도 열지 않는다.
-- 필요해지면 그때 이 함수 하나만 넓힌다.
create or replace function public.can_view_character_plans(
  p_viewer_user_id uuid,
  p_character_id   uuid
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $func$
  -- ★ 첫 인자가 null(비로그인)이면 무조건 false. 가용시간 함수와 같은 방어다.
  select p_viewer_user_id is not null
     and exists (
           select 1
             from public.characters c
            where c.id      = p_character_id
              and c.user_id = p_viewer_user_id
         );
$func$;

comment on function public.can_view_character_plans(uuid, uuid) is
  '캐릭터 보스 계획 열람 가능 여부. 본인만 true. 비로그인(viewer null)은 무조건 false.';


-- -----------------------------------------------------------------------------
-- 19-6. 쓰기 단일 진입점 2개
-- -----------------------------------------------------------------------------
-- 규칙을 트리거에 두었어도 **UPSERT 구문**을 잘못 쓰면 사고가 난다.
-- 동기화가 `on conflict do update set manual_active = ...` 를 실수로 포함하는 순간
-- 수동 편집이 사라진다. 그래서 두 경로를 각각 하나의 함수로 고정한다.

-- (a) 사람이 켜고 끄는 경로. manual_* 만 건드린다.
create or replace function public.set_character_boss_plan(
  p_character_id       uuid,
  p_boss_difficulty_id text,
  p_active             boolean
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_id uuid;
begin
  if p_active is null then
    raise exception 'p_active 는 null 일 수 없습니다. 목록에서 완전히 지우려면 행을 삭제하세요.'
      using errcode = 'null_value_not_allowed';
  end if;

  -- user_id 는 트리거가 채운다. NOT NULL 은 BEFORE 트리거 이후에 평가되므로 생략해도 된다.
  insert into public.character_boss_plans
    (character_id, boss_difficulty_id, manual_active, manual_set_at)
  values
    (p_character_id, p_boss_difficulty_id, p_active, now())
  on conflict (character_id, boss_difficulty_id) do update
    set manual_active = excluded.manual_active,
        manual_set_at = excluded.manual_set_at
  returning id into v_id;

  return v_id;
end;
$func$;

comment on function public.set_character_boss_plan(uuid, text, boolean) is
  '사용자가 캐릭터의 보스 계획을 켜거나 끈다. manual_* 만 갱신하며 API 값은 보존된다.';

-- (b) 넥슨 동기화 경로. api_* 만 건드린다. manual_* 는 문법적으로 손댈 수 없다.
create or replace function public.sync_character_boss_plan(
  p_character_id       uuid,
  p_boss_difficulty_id text,
  p_registration_flag  text,          -- ★ 실측: 넥슨은 "true"/"false" **문자열**을 준다
  p_observed_at        timestamptz default now()
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_id         uuid;
  v_registered boolean := public.nexon_flag_to_boolean(p_registration_flag);
begin
  -- 파싱 실패(예상 밖의 문자열)를 조용히 null 로 흘리지 않는다.
  -- null 로 흘리면 has_source 제약에 걸려 알아보기 힘든 오류가 난다.
  if v_registered is null then
    raise exception 'registration_flag 를 해석할 수 없습니다: %. 기대값은 "true" 또는 "false" 입니다.',
      coalesce(p_registration_flag, '(null)')
      using errcode = 'invalid_text_representation';
  end if;

  insert into public.character_boss_plans
    (character_id, boss_difficulty_id, api_registered, api_observed_at)
  values
    (p_character_id, p_boss_difficulty_id, v_registered, p_observed_at)
  on conflict (character_id, boss_difficulty_id) do update
    set api_registered  = excluded.api_registered,
        api_observed_at = excluded.api_observed_at
    -- 순서가 뒤집힌 관측(재시도·지연 응답)이 최신 관측을 덮어쓰지 못하게 막는다.
    where public.character_boss_plans.api_observed_at is null
       or public.character_boss_plans.api_observed_at <= excluded.api_observed_at
  returning id into v_id;

  if v_id is null then
    -- do update 의 WHERE 에서 걸러진 경우(= 더 오래된 관측). 행은 그대로 두고 id 만 돌려준다.
    select p.id into v_id
      from public.character_boss_plans p
     where p.character_id       = p_character_id
       and p.boss_difficulty_id = p_boss_difficulty_id;
  end if;

  return v_id;
end;
$func$;

comment on function public.sync_character_boss_plan(uuid, text, text, timestamptz) is
  '넥슨 registration_flag 동기화. api_* 만 갱신하므로 수동 편집을 절대 덮어쓰지 않는다. 역행 관측은 무시한다.';


-- -----------------------------------------------------------------------------
-- 19-7. 뷰 1 — 계획 한 줄 = 뷰 한 행. 이번 주 클리어 여부까지 붙인다.
-- -----------------------------------------------------------------------------
-- "남은 것 목록"은 이 뷰를 `where is_active and not is_cleared` 로 거르면 끝난다.
-- 애플리케이션이 boss_clears 와 다시 조인할 일이 없어야 한다(웹과 카톡 봇이 같은 답을 내야 함).
-- ★ `cascade` 가 필요하다. 아래 19-8 / 19-9 뷰가 이 뷰 위에 얹히므로, 재실행 시
--   이 문장은 "다른 객체가 의존한다"로 실패한다(실측: 2회차 적용에서 전체 중단).
--   의존 뷰 2개는 바로 아래에서 같은 파일이 다시 만들고 19-10 이 권한도 다시 잠그므로
--   cascade 로 사라져도 최종 상태는 동일하다 — 마이그레이션 8·10·14 가 쓰는 방식과 같다.
drop view if exists public.v_character_boss_plan_status cascade;
create view public.v_character_boss_plan_status
with (security_invoker = true) as
select
  p.id                                  as plan_id,
  p.user_id,
  p.character_id,
  ch.character_name,
  ch.world_name,

  p.boss_difficulty_id,
  bd.boss_id,
  bd.korean_name                        as boss_display_name,
  bd.difficulty,
  bd.cycle,
  bd.max_party,
  bd.released,
  b.sort_order                          as boss_sort_order,
  bd.sort_order                         as difficulty_sort_order,

  p.is_active,
  p.manual_active,
  p.api_registered,
  p.api_observed_at,
  p.has_conflict,
  -- 어느 출처에서 온 행인지 UI 가 그대로 쓸 수 있는 라벨
  case
    when p.manual_active is not null and p.api_registered is not null then 'both'
    when p.manual_active is not null                                  then 'manual'
    else 'nexon_api'
  end                                   as origin,

  -- ★ 12개 카운터에 들어가는지 여부. 일간·월간은 false (§1).
  (bd.cycle = 'weekly'::public.boss_cycle) as counts_toward_weekly_limit,

  public.week_key(now())                as week_key,
  coalesce(bc.effective_cleared, false) as is_cleared,
  bc.id                                 as clear_id,
  bc.cleared_at,
  bc.has_conflict                       as clear_has_conflict,
  p.note,
  p.created_at,
  p.updated_at
from public.character_boss_plans p
join public.characters        ch on ch.id = p.character_id
join public.boss_difficulties bd on bd.id = p.boss_difficulty_id
join public.bosses            b  on b.id  = bd.boss_id
-- boss_clears 유니크 키는 (user_id, character_id, boss_difficulty_id, week_key) 이므로
-- 아래 조건으로 이번 주 행이 최대 1건만 매칭된다.
left join public.boss_clears bc
       on bc.character_id       = p.character_id
      and bc.boss_difficulty_id = p.boss_difficulty_id
      and bc.week_key           = public.week_key(now());

comment on view public.v_character_boss_plan_status is
  '캐릭터 보스 계획 + 이번 주(KST 목요일 리셋 기준) 클리어 여부. 남은 목록 = where is_active and not is_cleared.';


-- -----------------------------------------------------------------------------
-- 19-8. 뷰 2 — 캐릭터 × 이번 주 진행 상황 (12개 상한 판정 지점)
-- -----------------------------------------------------------------------------
-- 12개 상한은 **캐릭터 단위**이므로 집계도 캐릭터에서 먼저 끝낸다.
-- (v_weekly_crystal_income_by_character → v_weekly_crystal_income 과 같은 2단 구조)
-- 위 cascade 가 이미 지웠겠지만, 이 문장 하나만 떼어 돌려도 안전하도록 같이 붙인다
-- (19-9 가 이 뷰에 얹혀 있다).
drop view if exists public.v_character_weekly_boss_progress cascade;
create view public.v_character_weekly_boss_progress
with (security_invoker = true) as
select
  s.user_id,
  s.character_id,
  s.character_name,
  s.world_name,
  s.week_key,

  -- 계획 (켜져 있는 것만 센다. 끈 것은 목록에서 뺀 것이므로 진행률에 들어가지 않는다.)
  count(*) filter (where s.is_active)                                              as planned_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly')                       as planned_weekly,
  count(*) filter (where s.is_active and s.cycle = 'daily')                        as planned_daily,
  count(*) filter (where s.is_active and s.cycle = 'monthly')                      as planned_monthly,

  -- 진척
  count(*) filter (where s.is_active and s.is_cleared)                             as cleared_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly' and s.is_cleared)      as cleared_weekly,
  count(*) filter (where s.is_active and not s.is_cleared)                         as remaining_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly' and not s.is_cleared)  as remaining_weekly,

  -- 목록에서 꺼 둔 행 (UI 가 "숨긴 항목 3개"로 쓸 수 있다)
  count(*) filter (where not s.is_active)                                          as inactive_total,
  -- 넥슨 값과 어긋난 행 (배지)
  count(*) filter (where s.has_conflict)                                           as conflict_count,

  -- ── 12개 상한: 경고만 한다 (19-4 참조) ──────────────────────────────────
  -- 상한값은 코드에 박지 않고 기존 단일 출처 함수를 쓴다.
  public.weekly_crystal_sell_limit()                                               as weekly_limit,
  (count(*) filter (where s.is_active and s.cycle = 'weekly'))
    > public.weekly_crystal_sell_limit()                                           as weekly_over_limit,
  greatest(
    public.weekly_crystal_sell_limit()
      - (count(*) filter (where s.is_active and s.cycle = 'weekly')),
    0
  )                                                                                as weekly_slots_remaining
from public.v_character_boss_plan_status s
group by s.user_id, s.character_id, s.character_name, s.world_name, s.week_key;

comment on view public.v_character_weekly_boss_progress is
  '캐릭터 × 이번 주 진행 상황. 계획 N개 중 클리어 M개. weekly_over_limit 은 경고일 뿐 DB 는 막지 않는다.';


-- -----------------------------------------------------------------------------
-- 19-9. 뷰 3 — 사용자 × 이번 주 합계 (캐릭터를 여러 개 굴리므로)
-- -----------------------------------------------------------------------------
-- ★ 사용자 단위에는 12개 상한을 적용하지 않는다. 상한은 캐릭터당이므로
--   사용자 총합에 12 를 들이대면 무의미하다. 대신 "몇 캐릭터가 넘겼는지"를 센다.
drop view if exists public.v_user_weekly_boss_progress;
create view public.v_user_weekly_boss_progress
with (security_invoker = true) as
select
  g.user_id,
  g.week_key,
  count(*)                                     as character_count,
  sum(g.planned_total)                         as planned_total,
  sum(g.planned_weekly)                        as planned_weekly,
  sum(g.planned_daily)                         as planned_daily,
  sum(g.planned_monthly)                       as planned_monthly,
  sum(g.cleared_total)                         as cleared_total,
  sum(g.cleared_weekly)                        as cleared_weekly,
  sum(g.remaining_total)                       as remaining_total,
  sum(g.remaining_weekly)                      as remaining_weekly,
  sum(g.inactive_total)                        as inactive_total,
  sum(g.conflict_count)                        as conflict_count,
  count(*) filter (where g.weekly_over_limit)  as over_limit_character_count
from public.v_character_weekly_boss_progress g
group by g.user_id, g.week_key;

comment on view public.v_user_weekly_boss_progress is
  '사용자 × 이번 주 합계. 12개 상한은 캐릭터당이므로 여기서는 초과 캐릭터 수만 센다.';


-- -----------------------------------------------------------------------------
-- 19-10. RLS / 권한
-- -----------------------------------------------------------------------------
-- 난제 1 의 (c) 모델 그대로: anon/authenticated 전면 차단 + 권한 자체 회수(이중 방어).
-- "본인 것만"은 can_view_character_plans() 로 표현하고 Route Handler 가 강제한다.
alter table public.character_boss_plans enable row level security;

revoke all on table public.character_boss_plans from anon;
revoke all on table public.character_boss_plans from authenticated;
grant all  on table public.character_boss_plans to service_role;

drop policy if exists character_boss_plans_no_public_access on public.character_boss_plans;
create policy character_boss_plans_no_public_access
  on public.character_boss_plans
  as permissive for all
  to anon, authenticated
  using (false) with check (false);

drop policy if exists character_boss_plans_service_role_all on public.character_boss_plans;
create policy character_boss_plans_service_role_all
  on public.character_boss_plans
  as permissive for all
  to service_role
  using (true) with check (true);

-- 뷰 3종도 전부 비공개. 개인의 보스 계획은 공개 시간표에 나갈 정보가 아니다.
revoke all on table public.v_character_boss_plan_status       from anon, authenticated;
revoke all on table public.v_character_weekly_boss_progress   from anon, authenticated;
revoke all on table public.v_user_weekly_boss_progress        from anon, authenticated;
grant all  on table public.v_character_boss_plan_status       to service_role;
grant all  on table public.v_character_weekly_boss_progress   to service_role;
grant all  on table public.v_user_weekly_boss_progress        to service_role;

-- 함수 실행권 — PostgreSQL 은 EXECUTE 를 기본으로 PUBLIC 에 준다. 반드시 회수한다(난제 7 의 교훈).
revoke all on function public.set_character_boss_plan(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.set_character_boss_plan(uuid, text, boolean) to service_role;

revoke all on function public.sync_character_boss_plan(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.sync_character_boss_plan(uuid, text, text, timestamptz) to service_role;

revoke all on function public.can_view_character_plans(uuid, uuid) from public, anon, authenticated;
grant execute on function public.can_view_character_plans(uuid, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 자기검증 — 어긋나면 마이그레이션이 실패한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_user       uuid;
  v_char       uuid;
  v_plan       uuid;
  v_n          bigint;
  v_flag       boolean;
  v_this_wk    timestamptz;
  v_next_wk    timestamptz;
  v_clear_this uuid;
  v_clear_id   uuid;
begin
  -- 검증용 임시 사용자/캐릭터
  insert into public.app_users (display_name) values ('__plan_selftest__')
  returning id into v_user;

  insert into public.characters (user_id, character_name, world_name, character_level)
  values (v_user, '__plan_selftest_char__', '스카니아', 285)
  returning id into v_char;

  -- (1) 수동 등록 → is_active true, origin manual
  v_plan := public.set_character_boss_plan(v_char, 'lotus_hard', true);
  select is_active into v_flag from public.character_boss_plans where id = v_plan;
  if v_flag is not true then
    raise exception '수동 등록이 is_active=true 로 계산되지 않았습니다.';
  end if;

  -- (2) 중복 등록은 새 행을 만들지 않는다 (같은 캐릭터 + 같은 보스난이도)
  perform public.set_character_boss_plan(v_char, 'lotus_hard', true);
  select count(*) into v_n
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_n <> 1 then
    raise exception '같은 캐릭터+보스난이도가 % 행 존재합니다. 유니크 제약이 동작하지 않습니다.', v_n;
  end if;

  -- (3) 직접 INSERT 로도 중복이 거부되는지
  begin
    insert into public.character_boss_plans
      (character_id, boss_difficulty_id, manual_active, manual_set_at)
    values (v_char, 'lotus_hard', false, now());
    raise exception '중복 INSERT 가 거부되지 않았습니다.';
  exception when unique_violation then
    null;  -- 기대한 결과
  end;

  -- (4) 넥슨 동기화가 수동 값을 덮어쓰지 않는다 + 충돌이 표시된다
  perform public.sync_character_boss_plan(v_char, 'lotus_hard', 'false', now());
  select is_active into v_flag from public.character_boss_plans where id = v_plan;
  if v_flag is not true then
    raise exception '넥슨 동기화가 수동 값을 덮어썼습니다. 충돌 규칙이 깨졌습니다.';
  end if;
  select has_conflict into v_flag from public.character_boss_plans where id = v_plan;
  if v_flag is not true then
    raise exception '수동/API 불일치가 has_conflict 로 표시되지 않았습니다.';
  end if;

  -- (5) 수동 값이 없으면 API 값이 결과가 된다
  perform public.sync_character_boss_plan(v_char, 'seren_normal', 'true', now());
  select is_active into v_flag
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'seren_normal';
  if v_flag is not true then
    raise exception 'API 단독 출처가 is_active 로 반영되지 않았습니다.';
  end if;

  -- (6) 출처가 하나도 없는 행은 만들 수 없다
  begin
    insert into public.character_boss_plans (character_id, boss_difficulty_id)
    values (v_char, 'kalos_easy');
    raise exception '출처 없는 행이 허용되었습니다.';
  exception when check_violation then
    null;  -- 기대한 결과
  end;

  -- (7) 13개 이상 등록이 **막히지 않고** 경고로만 나온다
  declare
    r record;
    v_added integer := 0;
  begin
    for r in
      select bd.id from public.boss_difficulties bd
       where bd.cycle = 'weekly' and bd.id <> 'lotus_hard'
       order by bd.id
       limit 14
    loop
      perform public.set_character_boss_plan(v_char, r.id, true);
      v_added := v_added + 1;
    end loop;
    if v_added <> 14 then
      raise exception '주간 보스 14건을 넣지 못했습니다 (%건).', v_added;
    end if;
  end;

  select planned_weekly into v_n
    from public.v_character_weekly_boss_progress where character_id = v_char;
  if v_n < 13 then
    raise exception '13개 이상 등록이 차단되었습니다 (planned_weekly=%).', v_n;
  end if;

  select weekly_over_limit into v_flag
    from public.v_character_weekly_boss_progress where character_id = v_char;
  if v_flag is not true then
    raise exception '12개 초과인데 weekly_over_limit 이 true 가 아닙니다.';
  end if;

  select weekly_slots_remaining into v_n
    from public.v_character_weekly_boss_progress where character_id = v_char;
  if v_n <> 0 then
    raise exception '초과 상태의 weekly_slots_remaining 이 0 이 아닙니다 (%).', v_n;
  end if;

  -- (8) 끄면 계획 수에서 빠진다
  perform public.set_character_boss_plan(v_char, 'lotus_hard', false);
  select inactive_total into v_n
    from public.v_character_weekly_boss_progress where character_id = v_char;
  if v_n < 1 then
    raise exception '끈 항목이 inactive_total 에 잡히지 않았습니다.';
  end if;

  -- (9) 사용자 단위 합계가 캐릭터 합과 같다
  select planned_weekly into v_n
    from public.v_user_weekly_boss_progress where user_id = v_user;
  if v_n <> (select sum(planned_weekly) from public.v_character_weekly_boss_progress where user_id = v_user) then
    raise exception '사용자 합계가 캐릭터 합과 다릅니다.';
  end if;

  -- (10) 열람 범위: 본인 true / 타인·비로그인 false
  if not public.can_view_character_plans(v_user, v_char) then
    raise exception '본인이 자기 캐릭터 계획을 볼 수 없습니다.';
  end if;
  if public.can_view_character_plans(null, v_char) then
    raise exception '비로그인이 캐릭터 계획을 볼 수 있습니다.';
  end if;
  if public.can_view_character_plans(gen_random_uuid(), v_char) then
    raise exception '타인이 캐릭터 계획을 볼 수 있습니다.';
  end if;

  -- (11) week_key 목요일 00:00 KST 경계 회귀 (난제 3 의 자기검증과 같은 값)
  --      진행 상황 뷰 전체가 이 함수 위에 서 있으므로 여기서 한 번 더 못박는다.
  if public.week_key(timestamptz '2026-08-19 23:59:59+09') <> '2026-W33'
     or public.week_key(timestamptz '2026-08-20 00:00:00+09') <> '2026-W34' then
    raise exception 'week_key 주간 경계(목 00:00 KST)가 어긋났습니다: % / %',
      public.week_key(timestamptz '2026-08-19 23:59:59+09'),
      public.week_key(timestamptz '2026-08-20 00:00:00+09');
  end if;

  -- (12) 진행 상황 뷰가 **이번 주** boss_clears 만 집는가
  --      날짜 리터럴을 박으면 다음 주에 이 마이그레이션을 다시 돌릴 때 깨진다.
  --      그래서 now() 기준으로 "이번 주 마지막 순간"과 "다음 주 첫 순간"을 만들어 쓴다.
  v_this_wk := public.next_week_reset(now()) - interval '1 second';
  v_next_wk := public.next_week_reset(now());

  if public.week_key(v_this_wk) <> public.week_key(now())
     or public.week_key(v_next_wk) =  public.week_key(now()) then
    raise exception '주 경계 계산이 어긋났습니다: this=% next=% now=%',
      public.week_key(v_this_wk), public.week_key(v_next_wk), public.week_key(now());
  end if;

  -- 이번 주 클리어 1건
  insert into public.boss_clears
    (user_id, character_id, boss_difficulty_id, manual_cleared, manual_set_at, cleared_at, party_size)
  values (v_user, v_char, 'seren_normal', true, v_this_wk, v_this_wk, 1)
  returning id into v_clear_this;

  -- 다음 주 클리어 1건 (뷰에 절대 잡히면 안 된다)
  insert into public.boss_clears
    (user_id, character_id, boss_difficulty_id, manual_cleared, manual_set_at, cleared_at, party_size)
  values (v_user, v_char, 'seren_normal', true, v_next_wk, v_next_wk, 1);

  select count(*) into v_n
    from public.v_character_boss_plan_status
   where character_id = v_char and boss_difficulty_id = 'seren_normal';
  if v_n <> 1 then
    raise exception '클리어가 2주치 있는데 계획 행이 %개로 부풀었습니다. 조인이 주차로 걸러지지 않습니다.', v_n;
  end if;

  select is_cleared, clear_id into v_flag, v_clear_id
    from public.v_character_boss_plan_status
   where character_id = v_char and boss_difficulty_id = 'seren_normal';
  if v_flag is not true then
    raise exception '이번 주 클리어가 뷰에 반영되지 않았습니다.';
  end if;
  if v_clear_id <> v_clear_this then
    raise exception '뷰가 이번 주가 아닌 클리어를 집었습니다.';
  end if;

  select cleared_weekly into v_n
    from public.v_character_weekly_boss_progress where character_id = v_char;
  if v_n <> 1 then
    raise exception '집계 뷰의 cleared_weekly 가 1 이 아닙니다 (%).', v_n;
  end if;

  -- 다음 주 것까지 세었다면 remaining 이 하나 모자랐을 것이다. 정합성 확인.
  select planned_weekly - cleared_weekly - remaining_weekly into v_n
    from public.v_character_weekly_boss_progress where character_id = v_char;
  if v_n <> 0 then
    raise exception 'planned_weekly = cleared_weekly + remaining_weekly 가 성립하지 않습니다 (차이 %).', v_n;
  end if;

  -- 정리 (app_users 삭제가 characters → character_boss_plans / boss_clears 까지 cascade)
  delete from public.app_users where id = v_user;

  if exists (select 1 from public.character_boss_plans where character_id = v_char) then
    raise exception 'cascade 삭제가 동작하지 않았습니다.';
  end if;
  if exists (select 1 from public.boss_clears where user_id = v_user) then
    raise exception 'boss_clears cascade 삭제가 동작하지 않았습니다.';
  end if;

  raise notice '19. character_boss_plans 자기검증 12항목 전부 통과';
end
$$;

select public.assert_no_public_sensitive_columns();

-- ============================================================
-- 20260817096000_clear_snapshot_integrity.sql
-- ============================================================
-- ============================================================================
-- 20260817096000_clear_snapshot_integrity.sql
--
-- 목적 두 가지.
--
--  (1) 클리어 기록의 **스냅샷 무결성** 복구.
--      `boss_clears_apply_state()` 는 `price_snapshotted_at is null` 일 때 금액을 다시
--      찍는데, 그 블록이 `new.cycle := <보스 마스터의 현재 cycle>` 로 주기까지 **재스탬프**
--      한다. 인원 수정은 `party_size` 와 함께 `price_snapshotted_at = null` 을 넘겨 바로
--      그 블록을 태우는 방식이라, **과거 기록의 인원을 고치면 주기가 현재 값으로 덮인다.**
--
--      보스 주기는 패치로 바뀐다. 실제로 2026-06-18 패치에서 하드 힐라 · 카오스 핑크빈 ·
--      노멀 시그너스가 주간 → 일간으로 원복됐다. 그 뒤 과거 기록의 인원을 고치면 당시
--      **주간이었던 클리어가 일간으로 바뀌고**, 주당 12개 카운터 집계가 통째로 틀어진다.
--      CLAUDE.md §1 의 "클리어 시점 값을 스냅샷해 나중 패치가 과거 기록을 다시 쓰지 못하게
--      한다"를 정면으로 위반한다.
--
--      ★ 근본 원인은 **시세와 주기의 비대칭**이다.
--        - 시세는 `boss_crystal_prices(boss_difficulty_id, effective_from)` 라는 **이력 테이블**을
--          갖고, `current_crystal_price(boss, cleared_at)` 가 클리어 시각 기준으로 조회한다.
--          그래서 재조회해도 같은 행이 나온다(나중 패치는 `effective_from > cleared_at` 이라
--          애초에 선택되지 않는다). 즉 시세는 **구조적으로 이미 안전**했다.
--        - 주기는 `boss_difficulties.cycle` **단일 현재값**이고 이력이 없다. 시각 기준으로
--          조회할 방법 자체가 없다. 그래서 재조회 = 과거 덮어쓰기다.
--        보존 외에 다른 해법이 없는 이유가 이것이다.
--
--  (2) "인원 미확인" 판정을 **추론에서 저장된 사실로** 승격.
--      지금 UI 는 `source='nexon_api' and run_id is null and party_size = 1` 이라는 추론으로
--      "확인 필요"를 띄운다(`src/features/income/server/income-repo.ts`
--      `isPartySizeUnconfirmed()`). 진짜로 솔로였던 API 클리어는 사용자가 몇 번을 확인해도
--      값이 1 이라 **영원히 "확인 필요"로 남는다.** 저장할 자리가 없어서 생긴 오탐이다.
--
-- 넥슨 API 호출 없음. 시드 데이터의 값 변경 없음(새 컬럼 백필만).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) `party_size_confirmed` — 인원이 "사람이 확인한 값"인가
-- ────────────────────────────────────────────────────────────────────────────
-- 넥슨 API 에는 파티 정보가 **아예 없다**(§1.1 확정). 그래서 관측만으로 만들어진 행의
-- `party_size = 1` 은 사실 주장이 아니라 그냥 DB 기본값이다. 그 구분을 값이 아니라
-- **별도 비트**로 들면, 사용자가 "맞아요 솔로였어요"라고 확인한 1 과 아무도 안 본 1 이
-- 비로소 구별된다.
--
-- 기본값이 false 인 이유(안전한 쪽이 어느 쪽인가):
--   - 거짓 "확인됨" → 경고가 안 뜬다 → 6인 보스가 조용히 6배로 잡힌다.
--   - 거짓 "미확인" → 이미 맞는 값에 확인 요청이 한 번 더 뜬다.
-- 손해가 압도적으로 비대칭이라 **모르면 미확인**이 맞다. 스케줄링에서 "거짓 available 보다
-- 거짓 unavailable 이 낫다"고 정한 것과 같은 기조다(CLAUDE.md §1.4).
-- `if not exists` — 이 저장소의 모든 마이그레이션은 재실행 안전이 불변식이다(연속 2회 적용 검증됨).
alter table public.boss_clears
  add column if not exists party_size_confirmed boolean not null default false;

comment on column public.boss_clears.party_size_confirmed is
  '이 기록의 party_size 를 사람이 확인했는가. false = 아무도 확인한 적 없음(넥슨 관측 기본값 1 일 가능성). '
  'INSERT 시 트리거가 유도하고, set_clear_party_size() 가 true 로 올린다. '
  '넥슨 API 에는 파티 정보가 없으므로(§1.1) source=nexon_api 이고 런 미연결이면 false 다.';

-- 백필 — INSERT 트리거가 쓸 규칙과 **완전히 같은 식**을 기존 행에 적용한다.
-- 규칙을 두 벌 만들지 않는 것이 요점이다. 오늘의 화면 판정(`isPartySizeUnconfirmed`)에서
-- 오탐 조항인 `party_size = 1` 만 뺀 것과 정확히 같은 식이기도 해서, 이 백필로 **기존 행의
-- 의미는 하나도 바뀌지 않는다.**
--   - 시드 12행은 전부 `source='manual'` → 전부 확인됨. 사람이 넣은 값이니 자연스럽다.
--   - 런에 걸린 행은 그 런의 입장 인원에서 왔으므로 확인된 값으로 본다.
update public.boss_clears
   set party_size_confirmed = true
 where party_size_confirmed = false          -- 재실행 시 무동작
   and (source <> 'nexon_api' or run_id is not null);


-- ────────────────────────────────────────────────────────────────────────────
-- 2) 트리거 교체 — 재스냅샷 시 **관측값은 보존하고 파생값만 다시 계산**한다
-- ────────────────────────────────────────────────────────────────────────────
-- 우회(전용 함수만 추가)가 아니라 트리거를 고치는 쪽을 골랐다. 근거:
--
--   ① `price_snapshotted_at = null` 로 재스냅샷을 유도하는 경로가 이미 **세 곳**이다
--      (`income-repo.ts` 845 / 868 / 1066행 — 단건 인원 수정, 런 전체 인원 수정,
--      런 클리어 표시 시 인원 채택). 전용 함수만 만들면 나머지 두 곳은 계속 주기를 덮는다.
--   ② 셋 다 "이미 클리어로 스냅샷된 행을 다시 계산"이라는 **같은 성격**의 UPDATE 다.
--      개별 호출자마다 조심하게 만드는 것보다 불변식을 트리거에 두는 쪽이 맞다.
--   ③ 어떤 경로도 "과거 기록의 주기를 마스터 현재값으로 되살리고 싶다"고 요구하지 않는다.
--      그런 일이 필요하다면 그건 의도적인 데이터 마이그레이션이지, 인원 수정의 부작용으로
--      일어날 일이 아니다.
--
-- 영향 범위는 `boss_clears` 에 쓰는 전 경로를 훑어 확인했다:
--   - 트리거: `boss_clears_apply_state`(BEFORE INS/UPD), `boss_clears_set_updated_at` 둘뿐.
--   - `boss_clears` 를 UPDATE 하는 함수: `recompute_run_crystal_shares()` 하나이며
--     `share_bp` / `crystal_share_meso` 만 건드리고 `price_snapshotted_at` 은 손대지 않는다
--     → 재스냅샷 블록에 들어가지 않으므로 영향 없음.
--   - `boss_clears` 를 읽는 뷰 5개(`v_character_boss_plan_status`, `v_run_crystal_settlement`,
--     `v_weekly_crystal_income_by_character`, `v_weekly_crystal_pending`,
--     `v_weekly_crystal_world_usage`)는 컬럼 정의가 그대로라 재정의 불필요.
--
-- 행동 변화는 **정확히 한 가지**다: `old.price_snapshotted_at is not null and
-- old.effective_cleared` 인 UPDATE(= 재스냅샷)에서 `cycle` 과 시세 스냅샷이 보존된다.
-- INSERT, 그리고 미클리어 → 클리어 전이는 종전과 완전히 동일하게 새로 스탬프한다.
create or replace function public.boss_clears_apply_state()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_winner   text;
  v_cycle    public.boss_cycle;
  v_price_id uuid;
  v_base     bigint;
  v_pot      bigint;
  v_bp       integer;
  v_amount   bigint;

  -- 재스냅샷 판정 + 보존할 이전 관측값.
  -- ★ INSERT 에서는 `old` 가 배정되지 않아 참조 자체가 에러다. 그리고 plpgsql 의 조건식은
  --   SQL 식으로 평가되어 `and` 의 단축 평가가 보장되지 않는다. 그래서 `old` 접근은
  --   반드시 `tg_op = 'UPDATE'` **블록 안에서만** 한다.
  v_resnap       boolean := false;
  v_old_cycle    public.boss_cycle;
  v_old_price_id uuid;
  v_old_base     bigint;
  v_old_manual   bigint;
  v_old_at       timestamptz;
begin
  -- 0) 보스 엔트리 확인 (max_party 는 소프트 상한이라 검증하지 않는다 — CLAUDE.md §1.3 D5)
  select bd.cycle into v_cycle
    from public.boss_difficulties bd
   where bd.id = new.boss_difficulty_id;

  if not found then
    raise exception '알 수 없는 보스 엔트리입니다: %', new.boss_difficulty_id
      using errcode = 'foreign_key_violation';
  end if;

  -- 0 으로 나누는 사고 방지. CHECK 는 BEFORE 트리거보다 나중에 평가되므로 여기서 먼저 막는다.
  if new.party_size is null or new.party_size < 1 then
    raise exception '파티 인원(party_size)은 1 이상이어야 합니다 (입력: %).', new.party_size
      using errcode = 'check_violation';
  end if;

  if new.world_name is null and new.character_id is not null then
    select ch.world_name into new.world_name
      from public.characters ch where ch.id = new.character_id;
  end if;

  -- 0-b) 인원 확인 비트 — INSERT 에서만 유도한다.
  --      UPDATE 에서 건드리지 않는 이유: 한번 확인된 값을 트리거가 다시 미확인으로 되돌리면
  --      사용자가 방금 한 확인이 조용히 취소된다. 이 비트를 올리는 주체는
  --      `set_clear_party_size()` 와 명시적으로 값을 넘기는 INSERT 뿐이다.
  --      명시적으로 true 를 넘긴 INSERT 는 그대로 존중한다(`or` 의 첫 항).
  if tg_op = 'INSERT' then
    new.party_size_confirmed :=
         coalesce(new.party_size_confirmed, false)
      or new.source <> 'nexon_api'   -- 사람/봇이 만든 행은 인원을 알고 만든다
      or new.run_id is not null;     -- 런에 걸렸으면 그 입장의 인원을 안다
  end if;

  -- 0-c) 이 UPDATE 가 "이미 스냅샷된 클리어의 재계산"인가.
  --      보스 엔트리가 바뀌었다면 다른 보스이므로 보존 대상이 아니다(새로 스탬프).
  if tg_op = 'UPDATE' then
    if old.price_snapshotted_at is not null
       and old.effective_cleared
       and new.boss_difficulty_id = old.boss_difficulty_id then
      v_resnap       := true;
      v_old_cycle    := old.cycle;
      v_old_price_id := old.crystal_price_id;
      v_old_base     := old.base_price_meso;
      v_old_manual   := old.manual_base_price_meso;
      v_old_at       := old.cleared_at;
    end if;
  end if;

  -- 1) 승자 판정 (관측 시각이 더 최신인 쪽. 동률이면 사람이 이긴다)
  if new.manual_cleared is null and new.api_cleared is null then
    v_winner := 'none';
  elsif new.manual_cleared is null then
    v_winner := 'api';
  elsif new.api_cleared is null then
    v_winner := 'manual';
  elsif coalesce(new.manual_set_at, '-infinity'::timestamptz)
        >= coalesce(new.api_observed_at, '-infinity'::timestamptz) then
    v_winner := 'manual';
  else
    v_winner := 'api';
  end if;

  new.effective_cleared := case v_winner
    when 'manual' then coalesce(new.manual_cleared, false)
    when 'api'    then coalesce(new.api_cleared, false)
    else false
  end;

  -- 2) 충돌 보존
  new.has_conflict := (
    new.manual_cleared is not null
    and new.api_cleared is not null
    and new.manual_cleared is distinct from new.api_cleared
  );

  -- 3) 클리어 시각 / 금액 스냅샷
  if new.effective_cleared then
    if new.cleared_at is null then
      new.cleared_at := coalesce(
        case v_winner when 'manual' then new.manual_set_at else new.api_observed_at end,
        now()
      );
    end if;

    if new.price_snapshotted_at is null then
      -- ★★ 주기는 **관측 스냅샷**이다. 절대 재조회하지 않는다. ★★
      --    `boss_difficulties.cycle` 은 이력 없는 단일 현재값이라, 여기서 다시 읽으면
      --    패치로 주기가 바뀐 뒤 과거 기록이 조용히 덮인다(2026-06-18 주간→일간 원복).
      if v_resnap then
        new.cycle := v_old_cycle;
      else
        new.cycle := v_cycle;
      end if;

      if v_resnap
         and new.manual_base_price_meso is not distinct from v_old_manual
         and new.cleared_at              is not distinct from v_old_at then
        -- 가격 입력(수동가 · 클리어 시각)이 그대로다 → 당시 시세 행을 그대로 유지한다.
        -- `current_crystal_price()` 가 시각 기준이라 재조회해도 같은 값이 나오지만,
        -- "같은 값이 나올 것"에 기대지 않고 **명시적으로 보존**한다. 시세 이력에 소급
        -- 정정 행이 들어오더라도 과거 기록이 흔들리지 않는다.
        v_price_id := v_old_price_id;
        v_base     := v_old_base;
      elsif new.manual_base_price_meso is not null then
        v_base := new.manual_base_price_meso;
        v_price_id := null;
      else
        select cp.price_id, cp.price_meso
          into v_price_id, v_base
          from public.current_crystal_price(new.boss_difficulty_id, new.cleared_at) cp;
      end if;

      new.crystal_price_id := v_price_id;
      new.base_price_meso  := v_base;

      if v_base is null then
        -- 가격 미확인. 0 으로 채우지 않는다.
        new.pot_meso           := null;
        new.share_bp           := null;
        new.crystal_share_meso := null;
      else
        -- 게임 규칙: 파티 전체가 받는 총액
        v_pot := new.party_size * (v_base / new.party_size);
        new.pot_meso := v_pot;

        -- 우리 모델: 그 총액을 파티원끼리 어떻게 나눴는가
        select p.share_bp, p.amount
          into v_bp, v_amount
          from public.resolve_crystal_payout(new.run_id, new.user_id, v_pot, new.party_size) p;

        new.share_bp           := v_bp;
        new.crystal_share_meso := v_amount;
      end if;

      new.price_snapshotted_at := now();
    end if;
  else
    new.cleared_at           := null;
    new.crystal_price_id     := null;
    new.base_price_meso      := null;
    new.pot_meso             := null;
    new.share_bp             := null;
    new.crystal_share_meso   := null;
    new.price_snapshotted_at := null;
    -- 클리어가 아닌 행은 지킬 스냅샷이 없다. 다시 켤 때 그 시점 주기로 새로 찍힌다.
    new.cycle                := v_cycle;
  end if;

  -- 4) 주차 버킷
  if new.cleared_at is not null then
    new.week_key := public.week_key(new.cleared_at);
  else
    new.week_key := coalesce(
      nullif(new.week_key, ''),
      public.week_key(coalesce(new.created_at, now()))
    );
  end if;

  return new;
end;
$function$;

comment on function public.boss_clears_apply_state() is
  'boss_clears BEFORE INSERT/UPDATE — 승자 판정 · 충돌 플래그 · 금액 스냅샷 · 주차 버킷을 한 패스에서 처리. '
  '이미 스냅샷된 클리어를 다시 계산할 때(price_snapshotted_at 을 null 로 넘기는 재스냅샷) '
  'cycle 과 시세 스냅샷은 보존하고 pot/share 만 다시 만든다 — 보스 주기는 패치로 바뀌는데 '
  'boss_difficulties.cycle 에는 이력이 없어 재조회가 곧 과거 덮어쓰기이기 때문이다(CLAUDE.md §1).';


-- ────────────────────────────────────────────────────────────────────────────
-- 3) `set_clear_party_size()` — 인원 수정의 정식 입구
-- ────────────────────────────────────────────────────────────────────────────
-- §1.3 D3: "party_size 는 실제로 몇 명이 입장했는가이며 사용자가 고칠 수 있어야 한다."
--
-- 금액(`pot_meso` · `share_bp` · `crystal_share_meso`)은 다시 계산하고,
-- `cycle` 과 `crystal_price_id`(당시 시세)는 건드리지 않는다. 후자는 위 트리거가 보장하므로
-- 이 함수는 공식을 한 줄도 갖지 않는다 — pot 계산식이 DB 안에서도 두 벌이 되지 않게 한다.
--
-- `price_snapshotted_at` 은 **재계산 시각으로 갱신한다**(트리거가 `now()` 로 찍는다). 근거:
--   - 이 컬럼의 역할은 "이 행의 금액은 확정되었다"는 **완료 표식**이다(가격이 정당히 null 일
--     수 있어 금액 컬럼의 null 여부로는 판정할 수 없어서 따로 둔 것). 금액을 다시 확정했으면
--     표식도 그때를 가리키는 것이 맞다.
--   - "어느 시세 행을 썼는가"라는 **출처**는 `crystal_price_id` / `base_price_meso` 가 따로
--     들고 있고 그쪽은 보존된다. 그래서 이 타임스탬프를 옮겨도 감사 정보가 사라지지 않는다.
--
-- ⚠️ 소유권 검사는 하지 않는다. service_role 전용이고, 호출자(Route Handler)가 세션의
--    user_id 로 대상 기록을 먼저 확인한다. `recompute_run_crystal_shares()` 와 같은 규약이다.
create or replace function public.set_clear_party_size(
  p_clear_id   uuid,
  p_party_size integer
)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_run_id uuid;
begin
  -- `boss_clears_party_size_check` 와 같은 범위. max_party 는 막지 않는다(§1.3 D5) —
  -- 대부분 세대 규칙에서 유도된 값이라 실제 파티를 거부하면 사용자가 앱을 못 쓴다.
  if p_party_size is null or p_party_size < 1 or p_party_size > 24 then
    raise exception '파티 인원은 1명 이상 24명 이하여야 합니다 (입력: %).', p_party_size
      using errcode = 'check_violation';
  end if;

  select bc.run_id into v_run_id
    from public.boss_clears bc
   where bc.id = p_clear_id
   for update;

  if not found then
    raise exception '클리어 기록을 찾을 수 없습니다: %', p_clear_id
      using errcode = 'no_data_found';
  end if;

  -- 값이 이미 같아도 그냥 지나치지 않는다. "인원이 2명 맞다"는 **확인 행위 자체가 결과**이고,
  -- 그래야 party_size_confirmed 가 올라간다. 재계산은 멱등이라 손해가 없다.
  if v_run_id is null then
    update public.boss_clears
       set party_size           = p_party_size,
           party_size_confirmed = true,
           price_snapshotted_at = null   -- 트리거 재계산 유도(주기·시세는 트리거가 보존)
     where id = p_clear_id;
    return;
  end if;

  -- 런에 걸린 기록은 **그 런 전체를 함께 고친다.**
  -- "몇 명이 입장했는가"는 개인이 아니라 그 입장 자체의 사실이다. 내 행만 고치면 같은 런의
  -- 참가자들이 서로 다른 pot 을 갖게 되고 `v_run_crystal_settlement`(합계 = pot 검증)이 깨진다.
  update public.party_runs
     set entry_party_size = p_party_size
   where id = v_run_id;

  update public.boss_clears
     set party_size           = p_party_size,
         party_size_confirmed = true,
         price_snapshotted_at = null
   where run_id = v_run_id;

  -- 분배 몫이 새 pot 과 맞는지 DB 가 마무리한다. 트리거가 이미 맞춰 뒀다면 0건이다.
  perform public.recompute_run_crystal_shares(v_run_id);
end;
$function$;

comment on function public.set_clear_party_size(uuid, integer) is
  '클리어 기록의 party_size 를 고치고 금액을 다시 계산한다(§1.3 D3). '
  'cycle 과 crystal_price_id 는 클리어 시점 스냅샷이라 보존된다. party_size_confirmed 를 true 로 올린다. '
  '런에 걸린 기록이면 party_runs.entry_party_size 와 그 런의 모든 클리어를 함께 고친다. '
  '소유권 검사는 호출자 책임(service_role 전용).';

-- 권한 — 기존 정산 계열 함수와 동일하게 service_role 전용.
-- anon/authenticated 가 남의 클리어 금액을 다시 쓰게 둘 수 없다.
revoke all on function public.set_clear_party_size(uuid, integer) from public;
revoke all on function public.set_clear_party_size(uuid, integer) from anon;
revoke all on function public.set_clear_party_size(uuid, integer) from authenticated;
grant execute on function public.set_clear_party_size(uuid, integer) to service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- ────────────────────────────────────────────────────────────────────────────
-- `boss_clears` 에는 anon/authenticated GRANT 자체가 없어 새 컬럼이 노출될 경로가 없다.
-- 그래도 호출은 생략하지 않는다 — 생략이 바로 share_bp 가 한번 샜던 경로다.
select public.assert_no_public_sensitive_columns();

