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
