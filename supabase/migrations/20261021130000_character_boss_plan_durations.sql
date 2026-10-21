-- =============================================================================
-- 캐릭터 × 보스별 **소요 시간** — `character_boss_plans.duration_minutes`
-- =============================================================================
--
-- 발주(2026-10-21): *"하림하흉이 솔플이 되면 하발이 더 짧게 걸릴수도있는거고. 뭔지알지?
-- 림흉은 쎈사람이랑 2인을 갈수도있고 세대카는 또 돌먹을 해서 오래걸릴수도있는거니까.
-- 일단 현재 가장 어려운 보스를 20분으로 잡아서 자동계산 넣어버려. 세세한건 수정 조금씩
-- 해주고. 캐릭별 보스 관리에서 시간 수정 할수 있게. 기본값을 넣어주고 사람이 수정하면
-- 수정되도록."*
--
-- 실제 소요는 **캐릭터**(솔플 · 2인 · 돌먹)에 따라 달라진다. 그래서 캐릭터 × 보스 한 행인
-- 계획에 사람이 고친 값을 둔다.
--
-- ★ ═══════════════════════════════════════════════════════════════════════════
--   **`null` = 기본값을 따른다. 기본값을 행에 박지 않는다.**
--   ═══════════════════════════════════════════════════════════════════════════
--   기본값(지금 가장 어려운 보스 = 20분, 계단마다 2분 아래)은 코드
--   (`src/lib/domain/boss-duration-estimate.ts`)가 보스 마스터 상수에서 계산한다. 그 값을
--   여기 백필하면 ① 계단표를 고쳐도 기본값이 따라오지 않고 ② "사람이 고친 값"과 "기본값"을
--   구분할 수 없게 된다(§1.3 D4 와 같은 기조). 그래서 이 마이그레이션은 **기존 행을 한 줄도
--   바꾸지 않는다** — 새 컬럼은 전부 null 로 태어난다.
--
-- 우선순위(코드 `resolveBossDuration` 이 유일한 정의):
--   묶음에 사람이 넣은 값(party_bundle_bosses.duration_minutes)
--   > 캐릭터에 사람이 넣은 값(이 컬럼)
--   > 전역 기본값 > 20
--
-- 범위 5~20 은 `party_runs.duration_minutes` · `party_bundle_bosses.duration_minutes` 의
-- CHECK 와 같은 경계다(코드 상수 `RUN_DURATION_MIN` / `RUN_DURATION_MAX`).
--
-- 재실행 안전: `add column if not exists` · 제약은 존재 확인 후 추가 · 함수는
-- `create or replace` · 권한은 매번 다시 못박는다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. 컬럼 + 범위 CHECK
-- -----------------------------------------------------------------------------
alter table public.character_boss_plans
  add column if not exists duration_minutes integer;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname  = 'character_boss_plans_duration_minutes_range'
       and conrelid = 'public.character_boss_plans'::regclass
  ) then
    alter table public.character_boss_plans
      add constraint character_boss_plans_duration_minutes_range
      check (duration_minutes is null or duration_minutes between 5 and 20);
  end if;
end
$$;

comment on column public.character_boss_plans.duration_minutes is
  '이 캐릭터가 이 보스를 한 판 도는 데 걸리는 분(사람이 고친 값). '
  'null = 기본값을 따른다 — 기본값은 코드(boss-duration-estimate.ts)가 계산하며 행에 박지 않는다. '
  '우선순위: 묶음 값(party_bundle_bosses) > 이 값 > 전역 기본값 > 20. 범위 5~20(party_runs 와 같음).';


-- -----------------------------------------------------------------------------
-- 2. 쓰기 함수 — 이 한 컬럼만 바꾼다
-- -----------------------------------------------------------------------------
-- `set_character_boss_plan_party_size` 와 같은 모양이다. 켜기/끄기(manual_active)·넥슨 값에
-- 손대지 않는다 — 한 함수가 둘을 함께 쓰면 "시간만 고쳤는데 보스가 켜지는" 사고가 가능해진다.
create or replace function public.set_character_boss_plan_duration(
  p_character_id       uuid,
  p_boss_difficulty_id text,
  p_duration_minutes   integer   -- null = 기본값으로 되돌리기
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_id uuid;
begin
  if p_duration_minutes is not null
     and (p_duration_minutes < 5 or p_duration_minutes > 20) then
    raise exception '소요 시간은 5분 이상 20분 이하여야 합니다 (입력: %).', p_duration_minutes
      using errcode = 'check_violation';
  end if;

  update public.character_boss_plans
     set duration_minutes = p_duration_minutes
   where character_id       = p_character_id
     and boss_difficulty_id = p_boss_difficulty_id
  returning id into v_id;

  if v_id is null then
    raise exception '계획에 없는 보스입니다: % (캐릭터 %). 먼저 목록에 추가해 주세요.',
      p_boss_difficulty_id, p_character_id
      using errcode = 'no_data_found';
  end if;

  return v_id;
end;
$func$;

comment on function public.set_character_boss_plan_duration(uuid, text, integer) is
  '계획 행의 소요 시간(분)을 정한다. null = 기본값으로 되돌리기. duration_minutes 한 컬럼만 갱신하며 '
  '켜기/끄기·넥슨 값에 손대지 않는다. 계획에 없는 보스면 no_data_found, 범위 밖이면 check_violation.';


-- -----------------------------------------------------------------------------
-- 3. 권한 — character_boss_plans 의 기존 규약(service_role 전용)을 다시 못박는다
-- -----------------------------------------------------------------------------
-- RLS 는 테이블 전체에 이미 걸려 있다(`character_boss_plans_no_public_access` ·
-- `character_boss_plans_service_role_all`) — 컬럼이 늘어도 열리는 정책 경로가 없다.
-- 그래도 GRANT 는 다시 못박는다: 컬럼 추가가 GRANT 를 조용히 넓히는 것이 이 저장소가
-- share_bp 로 한 번 데인 경로다.
revoke all on table public.character_boss_plans from anon;
revoke all on table public.character_boss_plans from authenticated;
grant all  on table public.character_boss_plans to service_role;

-- PostgreSQL 은 EXECUTE 를 기본으로 PUBLIC 에 준다. 반드시 회수한다.
revoke all on function public.set_character_boss_plan_duration(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.set_character_boss_plan_duration(uuid, text, integer)
  to service_role;


-- -----------------------------------------------------------------------------
-- 4. 자기검증 — 어긋나면 마이그레이션이 실패한다
-- -----------------------------------------------------------------------------
do $$
begin
  -- 공개 역할이 새 컬럼을 읽거나 쓸 수 없다.
  if has_column_privilege('anon', 'public.character_boss_plans', 'duration_minutes', 'select')
     or has_column_privilege('authenticated', 'public.character_boss_plans', 'duration_minutes', 'select')
     or has_column_privilege('anon', 'public.character_boss_plans', 'duration_minutes', 'update')
     or has_column_privilege('authenticated', 'public.character_boss_plans', 'duration_minutes', 'update') then
    raise exception 'character_boss_plans.duration_minutes 가 공개 역할에 열려 있다';
  end if;

  -- 공개 역할이 쓰기 함수를 부를 수 없다.
  if has_function_privilege('anon', 'public.set_character_boss_plan_duration(uuid, text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.set_character_boss_plan_duration(uuid, text, integer)', 'execute') then
    raise exception 'set_character_boss_plan_duration 이 공개 역할에 열려 있다';
  end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
select public.assert_no_public_sensitive_columns();
