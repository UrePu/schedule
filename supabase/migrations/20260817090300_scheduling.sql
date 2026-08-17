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
