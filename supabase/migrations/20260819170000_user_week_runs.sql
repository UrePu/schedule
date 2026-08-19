-- =============================================================================
-- `!일정` 은 **방이 아니라 사람**을 본다 — 내가 이번 주 가는 런
-- =============================================================================
--
-- 발주 지시(2026-08-19):
--   "그냥 깔끔하게 !일정 하면
--      ⏰ 8/19(수) 21:40 ~ 22:40 · 1파티
--      ㅡㅡㅡㅡㅡ
--      익세 하적 하카 : 무르겨르
--      노피 : 더저
--      ㅡㅡㅡㅡㅡ
--    이렇게 내 정보만 딱딱 깔끔하게 뜨는거지 파티방과 상관없이.
--    파티방 등록하는건 일정 30분전에 발생하는 알리미 (…) 필요할거같음."
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 무엇이 뒤집혔나
-- ─────────────────────────────────────────────────────────────────────────────
-- 그전까지 `!일정` 은 **이 방에 묶인 파티**의 런을 보여 주고 줄마다 참가자 명단을 달았다
-- (`보스 : 이름들`). 이제는 **발신자 본인의 런만** 보여 주고, 줄이 뒤집힌다
-- (`보스들 : 내 캐릭터`). 방 바인딩은 `!일정` 과 무관해지고 **알리미의 목적지**로만 남는다.
--
-- 그래서 필요한 것이 "이 사람이 이번 주에 going 으로 등록한 런" 하나이고, 이 함수다.
--
-- ★ **캐릭터 폴백을 여기서 끝낸다.** `run_signups.character_id` 가 비면
--   `party_participants.character_id` 로 떨어진다 — `run_participant_names` 와 **같은 규칙**
--   이고, 앱에서 다시 적으면 두 곳이 갈라진다.
-- ★ 보스 이름은 `short_name` 이다. 파티 제목·등록 폼 미리보기가 이미 같은 값을 쓰므로
--   세 화면의 어휘가 저절로 일치한다.
-- ★ `party_no` 는 방+주차에 매인 번호라 방에 안 묶인 파티에는 없다. `null` 이 정상이며
--   표시하는 쪽이 그때 번호를 빼면 된다.
-- =============================================================================

create or replace function public.user_week_runs(
  p_user_id  uuid,
  p_week_key text
)
returns table (
  run_id           uuid,
  party_id         uuid,
  scheduled_at     timestamptz,
  duration_minutes integer,
  party_no         smallint,
  short_name       text,
  character_name   text
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    r.id,
    r.party_id,
    r.scheduled_at,
    r.duration_minutes,
    n.party_no,
    bd.short_name,
    ch.character_name
  from public.run_signups s
  join public.party_participants pp
    on pp.id = s.participant_id
   and pp.user_id = p_user_id
   and pp.left_at is null
  join public.party_runs r
    on r.id = s.run_id
   and r.week_key = p_week_key
   and r.cancelled_at is null
   and r.status <> 'cancelled'
  join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
  left join public.characters ch
    on ch.id = coalesce(s.character_id, pp.character_id)
  left join lateral (
    select x.party_no
      from public.party_room_numbers x
     where x.party_id = r.party_id and x.week_key = r.week_key
     order by x.assigned_at
     limit 1
  ) n on true
  where s.status = 'going'
  order by r.scheduled_at nulls last, ch.character_name, bd.short_name;
$$;

comment on function public.user_week_runs(uuid, text) is
  '한 사람이 이번 주차에 going 으로 등록한 런. 방 바인딩과 무관하게 본인 것만 돌려준다. '
  '캐릭터는 run_signups → party_participants 순으로 떨어진다.';

revoke all on function public.user_week_runs(uuid, text) from public;
revoke all on function public.user_week_runs(uuid, text) from anon;
revoke all on function public.user_week_runs(uuid, text) from authenticated;
grant execute on function public.user_week_runs(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 자체 검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_user uuid;
  v_null integer;
begin
  select pp.user_id into v_user
    from public.party_participants pp
    join public.run_signups s on s.participant_id = pp.id and s.status = 'going'
   where pp.user_id is not null
   limit 1;
  if v_user is null then
    return; -- 검증할 데이터가 없으면 조용히 지나간다.
  end if;

  select count(*) filter (where short_name is null)
    into v_null
    from public.user_week_runs(v_user, public.week_key(now()));

  if v_null > 0 then
    raise exception 'short_name 이 비어 있는 행이 % 건 있습니다', v_null;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
select public.assert_no_public_sensitive_columns();
