-- =============================================================================
-- 파티별 알리미 — "몇 분 전 · 몇 회" + **적재하는 주체**
-- =============================================================================
--
-- 발주 지시(2026-08-19):
--   "알리미 있어야지 파티 = 방이라고 생각하는게 편하지만 사람이 더 많은경우도 있으니까
--    파티별로? 1 채팅창에 여러방이 있어도되나?"
--
-- → **파티별 설정**이 맞고, **한 채팅방에 여러 파티는 원래 된다.**
--   `parties.bot_channel_id` 는 N:1 이고 `party_room_numbers` 가 방+주차 기준으로
--   `1파티` · `2파티` 번호를 준다(마이그레이션 14). 그 번호가 있는 이유가 정확히 이것이다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 그전까지 알림은 **한 건도 나가지 않았다**
-- ─────────────────────────────────────────────────────────────────────────────
-- `v_pending_run_reminders` 뷰는 "보낼 때가 된 런"을 알려 줬지만 **그걸 아웃박스에 넣는
-- 주체가 없었다.** 뷰만 있고 아무도 부르지 않는 상태였고, 30분도 뷰 본문에 하드코딩,
-- dedupe 키도 T-30 고정이라 회차를 늘릴 수 없었다. 그래서 뷰를 지우고 함수로 바꾼다.
--
-- ★ **크론을 붙이지 않는다.** 런너가 이미 30초마다 `/api/bot/outbox` 를 두드리고 있으므로,
--   그 순간 서버가 "때가 된 알림"을 적재하면 된다. 방이 살아 있을 때만 도는 구조라
--   빈 프로젝트에 스케줄러를 하나 더 세울 이유가 없다.
--
-- ★ **늦게 적재된 알림은 스스로 죽는다.** 서버가 잠깐 멈춰 있다가 T-3 에 깨어나 "30분 전"을
--   보내면 그건 거짓말이다. 각 회차의 `expires_at` 을 **제 시각 +10분**으로 묶어, 늦으면
--   조용히 폐기되게 했다.
-- =============================================================================

-- 1. 파티별 알림 오프셋 -------------------------------------------------------
-- CHECK 에는 서브쿼리를 못 쓴다. 그래서 판정을 IMMUTABLE 함수로 뺀다.
create or replace function public.valid_reminder_minutes(p_minutes smallint[])
returns boolean
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $$
  select p_minutes is not null
     and array_ndims(p_minutes) = 1
     and coalesce(array_length(p_minutes, 1), 0) <= 5
     and not exists (
       select 1 from unnest(p_minutes) m where m < 1 or m > 1440
     )
     and coalesce(array_length(p_minutes, 1), 0)
         = (select count(distinct m) from unnest(p_minutes) m);
$$;

comment on function public.valid_reminder_minutes(smallint[]) is
  '알림 오프셋 배열이 쓸 수 있는 값인가. 최대 5개, 각 1~1440분, 중복 없음. '
  'CHECK 에 서브쿼리를 못 쓰므로 IMMUTABLE 함수로 뺐다.';

alter table public.parties
  add column if not exists reminder_minutes smallint[] not null default '{30}';

alter table public.parties
  drop constraint if exists parties_reminder_minutes_valid;
alter table public.parties
  add constraint parties_reminder_minutes_valid
  check (public.valid_reminder_minutes(reminder_minutes));

comment on column public.parties.reminder_minutes is
  '이 파티 런의 몇 분 전에 알릴지. 빈 배열이면 알림 없음. 기본 {30}. 최대 5회.';

-- 2. 알림 문구가 오프셋을 받는다 ----------------------------------------------
-- `⏰ 30분 전` 이 함수 본문에 박혀 있었다. 회차가 여럿이 되면 머리말도 회차를 따라야 한다.
-- ⚠️ 인자 수가 달라지므로 `create or replace` 가 아니라 **drop 후 재생성**이다.
--    그냥 두면 4인자 옛 함수가 남아 호출자마다 다른 문구를 받는다.
drop function if exists public.format_run_notice(uuid, text, timestamptz, integer);

create or replace function public.format_run_notice(
  p_run_id         uuid,
  p_kind           text default 'plain',
  p_now            timestamptz default now(),
  p_max_names      integer default 4,
  p_offset_minutes integer default 30
)
returns text
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_boss    text;
  v_sched   timestamptz;
  v_week    text;
  v_party   uuid;
  v_when    text;
  v_no      smallint;
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

  v_names_s := public.run_participant_names(p_run_id, p_max_names);

  v_line := v_when || ' '
         || case when v_no is not null then v_no::text || '파티 ' else '' end
         || v_boss
         || ' (' || v_names_s || ')';

  v_line := case p_kind
    when 'created' then '📌 ' || v_line
    when 'remind'  then '⏰ ' || p_offset_minutes::text || '분 전' || chr(10) || v_line
    else v_line
  end;

  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$$;

comment on function public.format_run_notice(uuid, text, timestamptz, integer, integer) is
  '런 알림 한 줄(시각 포함). remind 일 때 p_offset_minutes 가 머리말의 분을 정한다.';

revoke all on function public.format_run_notice(uuid, text, timestamptz, integer, integer) from public;
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer, integer) from anon;
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer, integer) from authenticated;
grant execute on function public.format_run_notice(uuid, text, timestamptz, integer, integer) to service_role;

-- 3. 때가 된 알림을 적재한다 --------------------------------------------------
create or replace function public.enqueue_due_reminders(
  p_channel_id uuid default null,
  p_now        timestamptz default now()
)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  rec        record;
  v_reply    text;
  v_key      text;
  v_expires  timestamptz;
  v_inserted integer := 0;
  v_hit      integer;
begin
  for rec in
    select r.id            as run_id,
           r.scheduled_at,
           p.bot_channel_id as channel_id,
           m.minutes::integer as minutes
      from public.party_runs r
      join public.parties p on p.id = r.party_id
      cross join lateral unnest(p.reminder_minutes) as m(minutes)
     where p.bot_channel_id is not null
       and (p_channel_id is null or p.bot_channel_id = p_channel_id)
       and p.archived_at is null
       and r.scheduled_at is not null
       and r.cancelled_at is null
       and r.status in ('proposed', 'confirmed')
       and r.scheduled_at - make_interval(mins => m.minutes::integer) <= p_now
       and r.scheduled_at > p_now
  loop
    v_reply := public.format_run_notice(rec.run_id, 'remind', p_now, 4, rec.minutes);
    continue when v_reply is null;

    v_key := 'run_remind:' || rec.run_id::text || ':T-' || rec.minutes::text;

    -- 늦게 적재된 "30분 전"이 3분 전에 도착하면 거짓말이 된다. 제 시각 +10분까지만 유효.
    v_expires := least(
      rec.scheduled_at,
      rec.scheduled_at - make_interval(mins => rec.minutes) + interval '10 minutes'
    );
    continue when v_expires <= p_now;

    insert into public.bot_outbox (channel_id, dedupe_key, reply, expires_at, visible_after)
    values (rec.channel_id, v_key, v_reply, v_expires, p_now)
    on conflict (channel_id, dedupe_key) do nothing;

    get diagnostics v_hit = row_count;
    v_inserted := v_inserted + v_hit;
  end loop;

  return v_inserted;
end;
$$;

comment on function public.enqueue_due_reminders(uuid, timestamptz) is
  '때가 된 파티 런 알림을 아웃박스에 적재한다. 채널을 주면 그 방만, 없으면 전체. '
  'dedupe_key 에 오프셋이 들어가 회차마다 한 번씩만 나간다.';

revoke all on function public.enqueue_due_reminders(uuid, timestamptz) from public;
revoke all on function public.enqueue_due_reminders(uuid, timestamptz) from anon;
revoke all on function public.enqueue_due_reminders(uuid, timestamptz) from authenticated;
grant execute on function public.enqueue_due_reminders(uuid, timestamptz) to service_role;

-- 4. 옛 뷰는 30분 하드코딩이라 대체된다 ---------------------------------------
drop view if exists public.v_pending_run_reminders;

-- 5. 자체 검증 ----------------------------------------------------------------
do $$
begin
  if not public.valid_reminder_minutes('{30}'::smallint[]) then
    raise exception '기본값 {30} 이 유효하지 않습니다';
  end if;
  if not public.valid_reminder_minutes('{}'::smallint[]) then
    raise exception '빈 배열(알림 없음)이 유효해야 합니다';
  end if;
  if public.valid_reminder_minutes('{30,30}'::smallint[]) then
    raise exception '중복이 통과했습니다';
  end if;
  if public.valid_reminder_minutes('{0}'::smallint[]) then
    raise exception '0분이 통과했습니다';
  end if;
  if public.valid_reminder_minutes('{1441}'::smallint[]) then
    raise exception '1441분이 통과했습니다';
  end if;
  if public.valid_reminder_minutes('{1,2,3,4,5,6}'::smallint[]) then
    raise exception '6개가 통과했습니다';
  end if;
  if public.format_run_notice(
       (select id from public.party_runs where scheduled_at is not null limit 1),
       'remind', now(), 4, 10) not like '⏰ 10분 전%' then
    raise exception 'remind 머리말이 오프셋을 따르지 않습니다';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- ⚠️ `parties` 에 컬럼을 **추가**했다. 표 단위 GRANT 가 걸려 있었다면 새 컬럼이 조용히
--    딸려 나가는데, 그 경로가 정확히 share_bp 가 샜던 방식이다.
select public.assert_no_public_sensitive_columns();
