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
