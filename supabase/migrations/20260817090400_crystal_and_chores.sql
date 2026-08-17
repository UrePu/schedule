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
