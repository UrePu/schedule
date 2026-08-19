-- =============================================================================
-- 분배 규칙을 **런이 아니라 파티**가 갖는다
-- =============================================================================
--
-- 발주 지시(2026-08-19): *"분배를 보스별로 붙이지말고 파티 자체에 설정을 넣어줘"*
--
-- 그전까지 방식은 `party_runs.share_mode`, 비율은 `run_signups.share_bp` 에 있었다. 즉 같은
-- 파티인데 런마다 다른 분배가 성립했고, 실제로 그렇게 쓰는 사람은 없다 — 파티가 합의한
-- 비율은 **그 파티의 성질**이지 보스의 성질이 아니다.
--
-- 옮기고 나면 좋아지는 것이 하나 더 있다: 드랍은 `run_drops.share_mode` 기본값이
-- `party_default` 라 `v_run_share_weights` 를 그대로 탄다. 그래서 **파티 분배를 한 번 바꾸면
-- 결정석 정산도 드랍 정산도 같이 따라온다.**
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ 뷰 여섯 개가 사슬로 묶여 있어 전부 다시 만들어야 했다
-- ─────────────────────────────────────────────────────────────────────────────
--   v_run_share_weights
--     → v_run_crystal_settlement
--     → v_run_drop_recipients → v_run_drop_settlement → v_weekly_drop_income → v_weekly_income
--
-- 그리고 **새로 만든 뷰는 기본 권한으로 anon/authenticated 에 열린다.** 정산 금액이 그대로
-- 공개면으로 나갈 뻔했고, `assert_no_public_sensitive_columns()` 가 그것을 잡아 적용을
-- 실패시켰다. 아래 `revoke` 들이 그 결과다 — 가드가 없었으면 조용히 새어 나갔을 변경이다.
--
-- 옛 컬럼(`party_runs.share_mode` · `run_signups.share_bp`)은 **더 이상 읽지 않는다.**
-- 지우지 않은 이유는 과거 값 보존뿐이며, 그 사실을 컬럼 주석에 남겼다.
-- =============================================================================

-- 1. 파티가 분배 규칙을 갖는다 -----------------------------------------------
alter table public.parties
  add column if not exists share_mode public.run_share_mode not null default 'auto_equal';

comment on column public.parties.share_mode is
  '이 파티의 분배 방식. auto_equal = 균등, manual = party_participants.share_bp 비율. '
  '런마다 정하지 않는다(발주 지시 2026-08-19).';

alter table public.party_participants
  add column if not exists share_bp integer;

alter table public.party_participants
  drop constraint if exists party_participants_share_bp_range;
alter table public.party_participants
  add constraint party_participants_share_bp_range
  check (share_bp is null or (share_bp >= 0 and share_bp <= 10000));

comment on column public.party_participants.share_bp is
  '이 파티에서 이 사람의 분배 비율(basis point). null 이면 균등. '
  'parties.share_mode = manual 일 때만 쓰인다.';

-- 비율은 정산 값이다. 공개면(비로그인 시간표)에 나갈 이유가 없다.
revoke select (share_bp) on public.party_participants from anon;
revoke select (share_bp) on public.party_participants from authenticated;

-- 2. 런에 흩어져 있던 비율을 파티로 끌어올린다 --------------------------------
-- 같은 사람이 런마다 다른 값을 갖고 있었다면 **가장 최근 런**의 값을 택한다. 적용 시점의
-- 라이브 데이터에는 manual 런이 0건이라 실질적으로 값만 옮겨지고 동작은 바뀌지 않는다.
update public.party_participants pp
   set share_bp = src.share_bp
  from (
    select distinct on (s.participant_id) s.participant_id, s.share_bp
      from public.run_signups s
      join public.party_runs r on r.id = s.run_id
     where s.share_bp is not null and s.share_bp > 0
     order by s.participant_id, r.created_at desc
  ) src
 where pp.id = src.participant_id and pp.share_bp is null;

-- 3. 가중치의 출처를 파티로 바꾼다 --------------------------------------------
drop view if exists public.v_weekly_income;
drop view if exists public.v_weekly_drop_income;
drop view if exists public.v_run_drop_settlement;
drop view if exists public.v_run_drop_recipients;
drop view if exists public.v_run_crystal_settlement;
drop view if exists public.v_run_share_weights;

create view public.v_run_share_weights
with (security_invoker = true) as
select s.run_id, s.participant_id, pp.member_no, pp.user_id, pp.guest_id,
       pp.display_name, pp.share_bp,
       case
         when p.share_mode = 'auto_equal'::public.run_share_mode then 1
         when coalesce(sum(pp.share_bp) over (partition by s.run_id), 0::bigint) = 0 then 1
         else pp.share_bp
       end as weight
  from public.run_signups s
  join public.party_runs r on r.id = s.run_id
  join public.parties p on p.id = r.party_id
  join public.party_participants pp on pp.id = s.participant_id
 where s.status = 'going'::public.signup_status;

comment on view public.v_run_share_weights is
  '런 참가자의 분배 가중치. 방식은 parties.share_mode, 비율은 party_participants.share_bp '
  '에서 온다 — 런/신청에 있던 것을 파티로 올렸다(발주 지시 2026-08-19).';

create view public.v_run_crystal_settlement
with (security_invoker = true) as
with run_pot as (
  select bc.run_id, max(bc.pot_meso) as pot_meso, max(bc.party_size) as party_size,
         min(bc.week_key) as week_key
    from public.boss_clears bc
   where bc.run_id is not null and bc.effective_cleared and bc.pot_meso is not null
   group by bc.run_id
), agg as (
  select w_1.run_id,
         array_agg(w_1.participant_id order by w_1.participant_id) as keys,
         array_agg(w_1.weight order by w_1.participant_id) as weights
    from public.v_run_share_weights w_1
   group by w_1.run_id
)
select p.run_id, p.week_key, p.pot_meso, p.party_size, d.key as participant_id,
       w.member_no, w.user_id, w.display_name, w.share_bp, d.amount as amount_meso
  from run_pot p
  join agg a on a.run_id = p.run_id
  cross join lateral public.distribute_meso(p.pot_meso, a.keys, a.weights) d(key, weight, amount)
  join public.v_run_share_weights w on w.run_id = p.run_id and w.participant_id = d.key;

create view public.v_run_drop_recipients
with (security_invoker = true) as
select d.id as drop_id, w.participant_id, w.weight
  from public.run_drops d
  join public.v_run_share_weights w on w.run_id = d.run_id
 where d.share_mode = 'party_default'::public.drop_share_mode
union all
select d.id, s.participant_id, s.share_bp
  from public.run_drops d
  join public.run_drop_shares s on s.drop_id = d.id
 where d.share_mode = 'custom'::public.drop_share_mode and s.share_bp > 0
union all
select d.id, d.solo_participant_id, 1
  from public.run_drops d
 where d.share_mode = 'solo'::public.drop_share_mode and d.solo_participant_id is not null;

create view public.v_run_drop_settlement
with (security_invoker = true) as
with agg as (
  select rc.drop_id,
         array_agg(rc.participant_id order by rc.participant_id) as keys,
         array_agg(rc.weight order by rc.participant_id) as weights
    from public.v_run_drop_recipients rc
   group by rc.drop_id
)
select d.id as drop_id, d.run_id, d.week_key, d.item_name, d.share_mode,
       d.sale_amount_meso, x.key as participant_id,
       pp.member_no, pp.user_id, pp.display_name, x.amount as amount_meso
  from public.run_drops d
  join agg a on a.drop_id = d.id
  cross join lateral public.distribute_meso(d.sale_amount_meso, a.keys, a.weights) x(key, weight, amount)
  join public.party_participants pp on pp.id = x.key
 where d.sale_amount_meso is not null;

create view public.v_weekly_drop_income
with (security_invoker = true) as
select user_id, week_key,
       (sum(amount_meso))::bigint as drop_income_meso,
       count(*) as drop_share_count,
       count(distinct drop_id) as drop_count
  from public.v_run_drop_settlement s
 where user_id is not null
 group by user_id, week_key;

create view public.v_weekly_income
with (security_invoker = true) as
with keys as (
  select user_id, week_key from public.v_weekly_crystal_income
  union
  select user_id, week_key from public.v_weekly_drop_income
  union
  select user_id, week_key from public.v_weekly_unsold_drops
)
select k.user_id, k.week_key,
       coalesce(c.income_meso, 0::bigint) as crystal_income_meso,
       coalesce(c.clear_count, 0::numeric) as clear_count,
       coalesce(c.weekly_clear_count, 0::numeric) as weekly_clear_count,
       coalesce(c.unknown_price_count, 0::numeric) as unknown_price_count,
       coalesce(c.weekly_over_limit_count, 0::numeric) as weekly_over_limit_count,
       coalesce(d.drop_income_meso, 0::bigint) as drop_income_meso,
       coalesce(d.drop_count, 0::bigint) as drop_count,
       coalesce(u.unsold_drop_count, 0::bigint) as unsold_drop_count,
       (coalesce(c.income_meso, 0::bigint) + coalesce(d.drop_income_meso, 0::bigint))
         as total_income_meso,
       coalesce(c.monthly_clear_count, 0::numeric) as monthly_clear_count,
       coalesce(c.weekly_income_meso, 0::bigint) as weekly_crystal_income_meso,
       coalesce(c.monthly_income_meso, 0::bigint) as monthly_crystal_income_meso,
       coalesce(c.daily_income_meso, 0::bigint) as daily_crystal_income_meso,
       coalesce(c.weekly_unknown_price_count, 0::numeric) as weekly_unknown_price_count,
       coalesce(c.monthly_unknown_price_count, 0::numeric) as monthly_unknown_price_count
  from keys k
  left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
  left join public.v_weekly_drop_income d on d.user_id = k.user_id and d.week_key = k.week_key
  left join public.v_weekly_unsold_drops u on u.user_id = k.user_id and u.week_key = k.week_key;

-- 3-b. 새 뷰의 기본 권한을 회수한다 -------------------------------------------
-- ⚠️ 이 블록이 없으면 `assert_no_public_sensitive_columns()` 가 적용을 거부한다.
--    실제로 첫 적용이 여기서 실패했고, 그 실패가 정산 금액 유출을 막았다.
revoke all on public.v_run_share_weights from anon, authenticated;
revoke all on public.v_run_crystal_settlement from anon, authenticated;
revoke all on public.v_run_drop_recipients from anon, authenticated;
revoke all on public.v_run_drop_settlement from anon, authenticated;
revoke all on public.v_weekly_drop_income from anon, authenticated;
revoke all on public.v_weekly_income from anon, authenticated;

grant select on public.v_run_share_weights to service_role;
grant select on public.v_run_crystal_settlement to service_role;
grant select on public.v_run_drop_recipients to service_role;
grant select on public.v_run_drop_settlement to service_role;
grant select on public.v_weekly_drop_income to service_role;
grant select on public.v_weekly_income to service_role;

-- 4. 옛 자리는 **읽지 않는다**는 사실을 남긴다 ---------------------------------
comment on column public.party_runs.share_mode is
  '⚠️ 더 이상 읽지 않는다. 분배 방식은 parties.share_mode 가 갖는다(2026-08-19). 과거 값 보존용.';
comment on column public.run_signups.share_bp is
  '⚠️ 더 이상 읽지 않는다. 분배 비율은 party_participants.share_bp 가 갖는다(2026-08-19). 과거 값 보존용.';

-- 5. 자체 검증 — 두 모드가 실제로 다르게 동작하는가 ---------------------------
do $$
declare
  v_party uuid;
  v_run   uuid;
  v_n     integer;
begin
  select r.party_id, r.id into v_party, v_run
    from public.party_runs r
    join public.run_signups s on s.run_id = r.id and s.status = 'going'
   limit 1;
  if v_run is null then return; end if;

  select count(*) into v_n from public.v_run_share_weights where run_id = v_run and weight <> 1;
  if v_n > 0 then raise exception '균등 모드인데 가중치가 1 이 아닌 행이 % 건', v_n; end if;

  update public.parties set share_mode = 'manual' where id = v_party;
  update public.party_participants set share_bp = 7000
   where party_id = v_party
     and id = (select participant_id from public.v_run_share_weights
                where run_id = v_run order by member_no limit 1);

  select count(*) into v_n from public.v_run_share_weights where run_id = v_run and weight = 7000;
  if v_n <> 1 then raise exception 'manual 모드에서 파티 비율이 반영되지 않았습니다'; end if;

  -- 원상복구. 검증이 데이터를 바꿔 놓고 끝나면 안 된다.
  update public.parties set share_mode = 'auto_equal' where id = v_party;
  update public.party_participants set share_bp = null where party_id = v_party;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
select public.assert_no_public_sensitive_columns();
