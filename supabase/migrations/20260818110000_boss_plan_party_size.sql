-- =============================================================================
-- M_Schedule · 21. 보스 계획의 **기본 파티 인원수** (character_boss_plans.default_party_size)
-- =============================================================================
-- 발주자 요구: *"보스 계획 탭에서 인원수 조절하게 해줘"*
--
-- ── 무엇을 푸는가 ───────────────────────────────────────────────────────────
-- 넥슨 API 에는 파티 정보가 **아예 없다**(CLAUDE.md §1.1 확정). 그래서 동기화로 들어온
-- 클리어는 `party_size = 1` 로 앉고, 6인 보스라면 결정석 수익이 **최대 6배 과대 계상**된다
-- (§1.3 D3). 지금 그것을 고치는 유일한 길은 수익 화면에서 클리어를 **한 건씩**
-- `set_clear_party_size()` 로 고치는 것인데, 한 캐릭터에 11건이 한꺼번에 쌓인다.
--
-- 이 마이그레이션은 그 반복을 없앤다. "이 캐릭터는 이 보스를 N인으로 돈다"를 계획에
-- **한 번** 적어 두면, 이후 생기는 클리어가 그 값으로 태어난다.
--
-- ── 계획 단위 기본값 vs 런 단위 실제값 — 누가 이기는가 ─────────────────────
--   · `character_boss_plans.default_party_size` = **평소 몇 명으로 도는가**(의도/기본값)
--   · `party_runs.entry_party_size`             = **그 입장에 실제로 몇 명이 들어갔는가**(사실)
--   · `boss_clears.party_size`                  = 그 클리어에 확정된 인원(사실의 스냅샷)
--
--   규칙: **사실이 기본값을 이긴다. 예외 없다.**
--   기본값은 오직 "아직 아무도 사실을 말하지 않은 순간"에만 쓰인다 —
--     (a) 계획 행에서 일정을 만들 때 인원 입력칸의 **초기값**,
--     (b) 넥슨 관측 클리어를 **새로** 만들 때의 `party_size`.
--   이미 존재하는 클리어·런은 기본값을 바꿔도 **한 행도 움직이지 않는다.** 사용자가 손으로
--   고쳐 둔 값을 나중에 바꾼 기본값이 덮으면, 그건 §1.3 D3 이 지키라고 한 것을 정확히
--   반대로 하는 것이다. 소급 반영이 필요하면 아래 `apply_plan_party_sizes_to_clears()` 를
--   **사람이 명시적으로** 부른다(되돌릴 수 없으므로 UI 가 건수를 먼저 보여 주고 확인받는다).
--
-- ── "설정 안 함"과 "1인"은 다른 상태다 ──────────────────────────────────────
-- `default_party_size is null` = 사용자가 이 보스의 인원을 **한 번도 판단한 적 없음**.
-- `default_party_size = 1`     = 사용자가 **솔로로 돈다고 말한 것**.
-- 이 둘을 합치면 D3 의 과대 계상이 조용히 그대로 남는다. 그래서 값이 아니라 null 로 가른다
-- (`boss_clears.party_size_confirmed` 를 별도 비트로 둔 것과 같은 판단 — 마이그레이션 20).
-- 아래 동기화 경로가 그 차이를 그대로 물려받는다: 미설정이면 `party_size=1` +
-- `party_size_confirmed=false`(= 수익 화면이 계속 "확인 필요"라고 말한다), 1인으로 설정했으면
-- 같은 1 이지만 **확인된 1** 이다.
--
-- ── max_party 는 여기서도 막지 않는다 (§1.3 D5) ─────────────────────────────
-- `boss_difficulties.max_party` 는 대부분 세대 규칙에서 **추정**된 값이라 CHECK 로 굳히면
-- 진짜 파티를 거부한다. 그래서 범위 검사는 `boss_clears.party_size` / `party_runs`
-- `entry_party_size` 와 **똑같이 1~24** 이고, `max_party` 초과는 화면이 경고만 한다.
--
-- 넥슨 API 호출 없음. 추가(additive)만 하며 기존 컬럼·데이터를 바꾸지 않는다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 21-1. 컬럼
-- -----------------------------------------------------------------------------
alter table public.character_boss_plans
  add column if not exists default_party_size integer;

-- `add constraint if not exists` 는 PostgreSQL 에 없다. 이 저장소의 모든 마이그레이션은
-- **재실행 안전**이 불변식이므로 pg_constraint 를 직접 본다.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname  = 'character_boss_plans_default_party_size_range'
       and conrelid = 'public.character_boss_plans'::regclass
  ) then
    alter table public.character_boss_plans
      add constraint character_boss_plans_default_party_size_range
      check (default_party_size is null or default_party_size between 1 and 24);
  end if;
end
$$;

comment on column public.character_boss_plans.default_party_size is
  '이 캐릭터가 이 보스를 평소 몇 인으로 도는가. **이후 생기는 클리어의 party_size 기본값**이며 '
  '이미 있는 클리어·런은 건드리지 않는다(§1.3 D3). '
  'null = 미설정(한 번도 판단한 적 없음)이고 1 = 사용자가 솔로라고 말한 것 — 두 상태는 다르다. '
  'max_party 는 소프트 상한이라 여기서 막지 않는다(§1.3 D5). 범위는 boss_clears.party_size 와 동일한 1~24.';


-- -----------------------------------------------------------------------------
-- 21-2. 쓰기 단일 진입점 — 사람이 인원수를 정한다
-- -----------------------------------------------------------------------------
-- 계획 테이블의 쓰기 경로는 이미 둘로 고정돼 있다(마이그레이션 19-6):
--   `set_character_boss_plan()`  = 사람 → manual_* 만
--   `sync_character_boss_plan()` = 넥슨 → api_* 만
-- 인원수는 **어느 쪽에도 속하지 않는 제3의 축**이다 — 넥슨은 인원을 주지 않으므로(§1.1)
-- 출처가 하나뿐이고, 켜기/끄기와 함께 갱신하면 "인원만 고치려다 계획이 켜지는" 사고가 난다.
-- 그래서 세 번째 함수를 두되 **`default_party_size` 한 컬럼만** 만진다.
--
-- ★ **UPDATE 전용이다.** upsert 로 만들면 `character_boss_plans_has_source` CHECK
--   (manual_active 나 api_registered 중 하나는 있어야 한다)에 걸리고, 그걸 피하려고
--   `manual_active := true` 를 끼워 넣으면 **인원만 고쳤는데 보스가 켜진다.**
--   계획에 없는 보스의 인원을 정할 이유도 없다 — 화면의 인원 입력칸은 계획 행 위에만 있다.
create or replace function public.set_character_boss_plan_party_size(
  p_character_id       uuid,
  p_boss_difficulty_id text,
  p_party_size         integer   -- null = 설정 해제(미설정으로 되돌린다)
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_id uuid;
begin
  -- 범위는 boss_clears / party_runs 와 같은 1~24. max_party 는 막지 않는다(§1.3 D5).
  if p_party_size is not null and (p_party_size < 1 or p_party_size > 24) then
    raise exception '파티 인원은 1명 이상 24명 이하여야 합니다 (입력: %).', p_party_size
      using errcode = 'check_violation';
  end if;

  update public.character_boss_plans
     set default_party_size = p_party_size
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

comment on function public.set_character_boss_plan_party_size(uuid, text, integer) is
  '계획 행의 기본 파티 인원수를 정한다(null = 미설정으로 해제). default_party_size 한 컬럼만 갱신하며 '
  '켜기/끄기·넥슨 값에 손대지 않는다. 계획에 없는 보스면 no_data_found. '
  '이미 쌓인 클리어는 바뀌지 않는다 — 소급 반영은 apply_plan_party_sizes_to_clears() 를 사람이 부른다.';


-- -----------------------------------------------------------------------------
-- 21-3. 소급 적용 — **사람이 명시적으로 부를 때만**
-- -----------------------------------------------------------------------------
-- 기본값은 앞으로 생길 클리어의 것이다. 그런데 이 기능이 필요해진 계기가 "이미 11건이
-- 1인으로 쌓였다"이므로, 쌓인 것을 한 번에 정리할 길이 없으면 문제의 절반만 푸는 셈이다.
--
-- 안전장치는 셋이다.
--   ① **`party_size_confirmed = false` 인 행만** 건드린다. 사람이 이미 확인한 인원은
--      기본값이 이기지 못한다(§1.3 D3 — 사실이 기본값을 이긴다).
--   ② **런에 걸린 클리어는 제외**한다(`run_id is null`). 그쪽 인원은 그 입장의 사실이고
--      `party_runs.entry_party_size` 가 원본이다. 6배 과대 계상은 런 없는 API 관측분에만 산다.
--   ③ **`p_dry_run` 으로 건수만 먼저 셀 수 있다.** 되돌릴 수 없는 작업이라 UI 가 건수를
--      보여 주고 확인을 받은 뒤에만 실제로 부른다. 판정식이 미리보기와 실행에서 **한 벌**이다.
--
-- ★ 인원 수정은 `set_clear_party_size()` 를 통해서만 한다. 직접 UPDATE 하면 금액 재계산과
--   `party_size_confirmed` 승격, 런 동반 수정이 통째로 빠진다 — 그 함수가 이 저장소의 규약이다.
create or replace function public.apply_plan_party_sizes_to_clears(
  p_character_id uuid,
  p_dry_run      boolean default false
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select bc.id as clear_id, p.default_party_size as party_size
      from public.boss_clears bc
      join public.character_boss_plans p
        on p.character_id       = bc.character_id
       and p.boss_difficulty_id = bc.boss_difficulty_id
     where bc.character_id         = p_character_id
       and bc.run_id              is null          -- ② 런의 인원은 그 입장의 사실이다
       and bc.party_size_confirmed = false         -- ① 사람이 확인한 값은 이기지 못한다
       and p.default_party_size   is not null      -- 미설정은 적용할 값이 없다
     order by bc.week_key, bc.boss_difficulty_id
  loop
    v_count := v_count + 1;
    if not coalesce(p_dry_run, false) then
      perform public.set_clear_party_size(r.clear_id, r.party_size);
    end if;
  end loop;

  return v_count;
end;
$func$;

comment on function public.apply_plan_party_sizes_to_clears(uuid, boolean) is
  '이 캐릭터의 **미확인** 클리어(run 미연결)에 계획의 기본 인원수를 적용하고 건수를 돌려준다. '
  'p_dry_run = true 면 세기만 한다(UI 확인 절차용, 판정식은 실행과 동일). '
  '사람이 확인한 인원(party_size_confirmed)과 런에 걸린 클리어는 건드리지 않는다. '
  '수정은 반드시 set_clear_party_size() 를 통과하므로 금액 재계산·주기 보존 규약이 그대로 지켜진다.';


-- -----------------------------------------------------------------------------
-- 21-4. 뷰 재생성 — 계획 한 줄이 자기 인원수를 싣고 나온다
-- -----------------------------------------------------------------------------
-- 화면은 `v_character_boss_plan_status` 한 줄 = 계획 한 줄로 읽는다(마이그레이션 19-7).
-- 인원수만 다른 테이블에서 따로 조인해 오면 "계획 한 줄"의 정의가 두 벌이 된다.
--
-- ⚠️ `cascade` 가 필요하다 — 19-8 / 19-9 뷰가 이 뷰 위에 얹혀 있다. 두 뷰는 컬럼이 하나도
--    바뀌지 않지만 **원문 그대로 다시 만든다**(마이그레이션 19 와 같은 방식). 아래 21-5 가
--    권한도 다시 잠그므로 최종 상태는 동일하다.
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
  -- ★ 21 에서 추가. **null 은 0 이 아니라 "미설정"이다** — 화면이 1 로 접으면 안 된다.
  p.default_party_size,
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
left join public.boss_clears bc
       on bc.character_id       = p.character_id
      and bc.boss_difficulty_id = p.boss_difficulty_id
      and bc.week_key           = public.week_key(now());

comment on view public.v_character_boss_plan_status is
  '캐릭터 보스 계획 + 이번 주(KST 목요일 리셋 기준) 클리어 여부 + 기본 파티 인원수. 남은 목록 = where is_active and not is_cleared.';

-- 아래 두 뷰는 **19-8 / 19-9 원문 그대로**다. cascade 로 지워졌으므로 복원만 한다.
drop view if exists public.v_character_weekly_boss_progress cascade;
create view public.v_character_weekly_boss_progress
with (security_invoker = true) as
select
  s.user_id,
  s.character_id,
  s.character_name,
  s.world_name,
  s.week_key,

  count(*) filter (where s.is_active)                                              as planned_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly')                       as planned_weekly,
  count(*) filter (where s.is_active and s.cycle = 'daily')                        as planned_daily,
  count(*) filter (where s.is_active and s.cycle = 'monthly')                      as planned_monthly,

  count(*) filter (where s.is_active and s.is_cleared)                             as cleared_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly' and s.is_cleared)      as cleared_weekly,
  count(*) filter (where s.is_active and not s.is_cleared)                         as remaining_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly' and not s.is_cleared)  as remaining_weekly,

  count(*) filter (where not s.is_active)                                          as inactive_total,
  count(*) filter (where s.has_conflict)                                           as conflict_count,

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
-- 21-5. RLS / 권한
-- -----------------------------------------------------------------------------
-- 테이블 정책은 **이미 새 컬럼을 덮는다.** RLS 는 행 단위이고
-- `character_boss_plans_no_public_access`(anon/authenticated · using false · with check false) 와
-- `character_boss_plans_service_role_all` 이 테이블 전체에 걸려 있으므로, 컬럼이 늘어도
-- 열리는 경로가 없다. 여기에 더해 anon/authenticated 는 테이블 GRANT 자체가 회수된 상태다
-- (마이그레이션 19-10). 그래도 **다시 못박는다** — 컬럼 추가가 GRANT 를 조용히 넓히는 것이
-- 이 저장소가 share_bp 로 한 번 데인 경로다.
revoke all on table public.character_boss_plans from anon;
revoke all on table public.character_boss_plans from authenticated;
grant all  on table public.character_boss_plans to service_role;

-- cascade 로 지웠다 다시 만든 뷰 3종은 **권한이 초기화된다.** 반드시 다시 잠근다.
revoke all on table public.v_character_boss_plan_status       from anon, authenticated;
revoke all on table public.v_character_weekly_boss_progress   from anon, authenticated;
revoke all on table public.v_user_weekly_boss_progress        from anon, authenticated;
grant all  on table public.v_character_boss_plan_status       to service_role;
grant all  on table public.v_character_weekly_boss_progress   to service_role;
grant all  on table public.v_user_weekly_boss_progress        to service_role;

-- 함수 실행권 — PostgreSQL 은 EXECUTE 를 기본으로 PUBLIC 에 준다. 반드시 회수한다.
revoke all on function public.set_character_boss_plan_party_size(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.set_character_boss_plan_party_size(uuid, text, integer)
  to service_role;

revoke all on function public.apply_plan_party_sizes_to_clears(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.apply_plan_party_sizes_to_clears(uuid, boolean)
  to service_role;


-- -----------------------------------------------------------------------------
-- 자기검증 — 어긋나면 마이그레이션이 실패한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_user     uuid;
  v_char     uuid;
  v_n        integer;
  v_size     integer;
  v_flag     boolean;
  v_wk       timestamptz;
  v_clear    uuid;
begin
  insert into public.app_users (display_name) values ('__plan_size_selftest__')
  returning id into v_user;

  insert into public.characters (user_id, character_name, world_name, character_level)
  values (v_user, '__plan_size_selftest_char__', '스카니아', 285)
  returning id into v_char;

  perform public.set_character_boss_plan(v_char, 'lotus_hard', true);

  -- (1) 처음에는 **미설정**이다. 0 도 1 도 아니다.
  select default_party_size into v_size
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_size is not null then
    raise exception '새 계획 행의 default_party_size 가 null 이 아닙니다 (%).', v_size;
  end if;

  -- (2) 설정 → 저장되고 뷰에도 그대로 나온다
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 3);
  select default_party_size into v_size
    from public.v_character_boss_plan_status
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_size <> 3 then
    raise exception '뷰가 기본 인원수를 3 으로 내지 않았습니다 (%).', v_size;
  end if;

  -- (3) 인원수만 고쳤을 뿐 켜기/끄기와 넥슨 값에는 손대지 않는다
  select is_active into v_flag
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_flag is not true then
    raise exception '인원수 설정이 is_active 를 건드렸습니다.';
  end if;

  -- (4) max_party 초과는 **막지 않는다** (§1.3 D5 — 경고는 화면의 몫)
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 24);
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 3);

  -- (5) 범위 밖은 거부한다
  begin
    perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 25);
    raise exception '25인이 허용되었습니다.';
  exception when check_violation then
    null;
  end;
  begin
    perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 0);
    raise exception '0인이 허용되었습니다.';
  exception when check_violation then
    null;
  end;

  -- (6) 계획에 없는 보스는 거부한다 (upsert 로 계획을 켜 버리지 않는다)
  begin
    perform public.set_character_boss_plan_party_size(v_char, 'seren_normal', 3);
    raise exception '계획에 없는 보스의 인원수가 설정되었습니다.';
  exception when no_data_found then
    null;
  end;
  if exists (
    select 1 from public.character_boss_plans
     where character_id = v_char and boss_difficulty_id = 'seren_normal'
  ) then
    raise exception '인원수 설정이 계획 행을 새로 만들었습니다.';
  end if;

  -- (7) 소급 적용 — 넥슨 관측분(미확인)만 잡는다
  v_wk := public.next_week_reset(now()) - interval '1 second';
  insert into public.boss_clears
    (user_id, character_id, boss_difficulty_id, api_cleared, api_observed_at,
     week_key, source)
  values
    (v_user, v_char, 'lotus_hard', true, v_wk, public.week_key(v_wk), 'nexon_api')
  returning id into v_clear;

  select party_size_confirmed into v_flag from public.boss_clears where id = v_clear;
  if v_flag is not false then
    raise exception '넥슨 관측 클리어가 처음부터 확인됨으로 들어왔습니다.';
  end if;

  -- 미리보기는 세기만 한다
  v_n := public.apply_plan_party_sizes_to_clears(v_char, true);
  if v_n <> 1 then
    raise exception '미리보기 건수가 1 이 아닙니다 (%).', v_n;
  end if;
  select party_size into v_size from public.boss_clears where id = v_clear;
  if v_size <> 1 then
    raise exception '미리보기가 실제로 값을 바꿨습니다 (%).', v_size;
  end if;

  -- 실행하면 값이 들어가고 확인됨으로 올라간다
  v_n := public.apply_plan_party_sizes_to_clears(v_char, false);
  if v_n <> 1 then
    raise exception '적용 건수가 1 이 아닙니다 (%).', v_n;
  end if;
  select party_size, party_size_confirmed into v_size, v_flag
    from public.boss_clears where id = v_clear;
  if v_size <> 3 or v_flag is not true then
    raise exception '적용 후 인원수/확인 비트가 어긋납니다 (size=%, confirmed=%).', v_size, v_flag;
  end if;

  -- (8) 한 번 확인된 클리어는 **두 번 다시 건드리지 않는다** (사실 > 기본값)
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 6);
  v_n := public.apply_plan_party_sizes_to_clears(v_char, true);
  if v_n <> 0 then
    raise exception '확인된 클리어가 다시 대상이 되었습니다 (%건).', v_n;
  end if;
  select party_size into v_size from public.boss_clears where id = v_clear;
  if v_size <> 3 then
    raise exception '확인된 클리어의 인원수가 기본값에 덮였습니다 (%).', v_size;
  end if;

  -- (9) 해제하면 다시 미설정이 된다
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', null);
  select default_party_size into v_size
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_size is not null then
    raise exception '해제 후에도 값이 남아 있습니다 (%).', v_size;
  end if;

  delete from public.app_users where id = v_user;

  raise notice '21. default_party_size 자기검증 9항목 전부 통과';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 새 컬럼(`default_party_size`)은 민감 정보가 아니지만, 이 호출의 목적은 값의 민감도가
-- 아니라 **테이블 단위 GRANT 가 조용히 넓어지지 않았는지**를 확인하는 것이다.
-- 생략이 곧 share_bp 가 샜던 경로다.
select public.assert_no_public_sensitive_columns();
