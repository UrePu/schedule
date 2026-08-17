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
