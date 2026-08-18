-- =============================================================================
-- M_Schedule · 23. 등록된 일정도 가능 시간에서 빠진다 (availability − runs)
-- =============================================================================
-- 발주자 원문(2026-08-18):
--   "일정을 등록하면 그 일정도 가능 시간에 반영이 되어야지 당연히 보스를 두개 동시에
--    할수있는건아니잖음"
--
-- ── 무엇이 틀려 있었나 ────────────────────────────────────────────────────
-- `resolve_availability()` 는 **패턴 − 예외**만 계산한다. 이미 잡아 둔 런은 쳐다보지도
-- 않는다. 그래서 18:00 에 익세를 등록해 놓고도 겹쳐보기는 18:00 을 "전원 가능"이라고
-- 말했고, 그 시간에 하대를 한 번 더 잡을 수 있었다. 한 사람이 같은 시각에 보스 둘을
-- 도는 일정은 성립하지 않는다.
--
-- ── 왜 앱이 아니라 DB 인가 (§1.4 · DB-SCHEMA §11-B-5 와 같은 판단) ────────
-- 겹침의 답은 **웹과 카톡 봇이 같아야** 한다. `distribute_meso` / `resolve_availability`
-- 를 DB 에 둔 이유와 같다. TS 에서 런을 빼면 `!일정` 명령이 다른 답을 내고, 그 어긋남은
-- 사람이 못 오는 시각에 파티가 잡히는 형태로 드러난다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 설계 — 세 갈래로 나눈 이유
-- ─────────────────────────────────────────────────────────────────────────────
--   ① `person_run_commitments()`  새 함수. "이 사람은 이 시각에 이미 일정이 있다".
--   ② `availability_overlap()`    ①을 빼고 겹침을 센다.  ← **여기서만 뺀다**
--   ③ `resolve_availability()`    **손대지 않는다.** 시그니처도 의미도 그대로다.
--
-- ③을 건드리지 않는 것이 핵심이다. 두 가지 이유가 있다.
--
--   (a) **화면에서 조용히 사라지면 안 된다.** 개인 레인의 막대가 그냥 짧아지면 사용자는
--       "왜 안 되지?" 만 남는다. 그래서 개인 레인은 여전히 패턴−예외 전체를 그리고,
--       그 위에 ①의 결과를 **"이미 일정 있음" 블록으로 겹쳐** 그린다(예외 블록과 같은
--       방식이다). 빠지는 것은 **겹침 계산뿐**이다.
--   (b) **마이그레이션 미적용 상태에서도 앱이 살아 있어야 한다.** ③의 인자 목록을
--       바꾸면(기본값을 붙여도 새 시그니처가 생긴다) 3인자 호출이 모호해지거나 사라져
--       가용시간 조회가 통째로 죽는다. ③이 그대로면 미적용 DB 에서도 겹쳐보기는 예전과
--       **정확히 같이** 동작하고, ①은 "함수 없음"으로 빈 배열이 되어 블록만 안 보인다.
--
-- ⚠️ ②는 시그니처가 바뀐다(`p_exclude_run_id` 추가). 기본값이 있으므로 **기존 4인자
--    호출은 그대로 성공한다.** 다만 같은 이름의 4인자 함수가 남아 있으면 4인자 호출이
--    모호해지므로 옛 함수를 먼저 drop 한다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 무엇이 시간을 잡아먹는가 — 판정 규칙 (전부 여기 한 곳)
-- ─────────────────────────────────────────────────────────────────────────────
--   · **`going` 신청만** 시간을 쓴다. `maybe`(미정)·`declined`(불참)는 아니다.
--     미정을 막으면 "아직 모르겠다"가 곧 "그 시간 못 쓴다"가 되어, 조율하려고 만든
--     상태값이 조율을 막는다.
--   · **취소된 런은 막지 않는다** (`cancelled_at is not null` 또는 `status='cancelled'`).
--     취소는 "안 간다"이고, 그 시간은 즉시 돌아와야 한다.
--   · **시각 미정(`scheduled_at is null`)인 런은 막지 않는다.** 그게 바로 겹쳐보기로
--     시간을 고르는 중이라는 뜻이라, 그것이 시간을 잡으면 자기 시간을 자기가 막는다.
--   · `p_exclude_run_id` 로 **런 하나를 제외**할 수 있다.
--     근거: 등록된 런의 시각을 옮길 때 그 런 자신의 점유가 후보 시간대를 통째로 지우면
--     **원래 시각에서 한 칸도 움직일 수 없다.** 제외를 "취소 후 재등록"으로 대신할 수도
--     있지만 그러면 클리어가 붙은 런에서는 아예 불가능해지고(취소만 되고 삭제가 안 된다)
--     번호(`run_no`)도 새로 붙는다 — §1.4 가 금지한 재부여다. 인자 하나가 가장 싸다.
--     기본값 `null` 이라 아무것도 제외하지 않는 것이 기본 동작이다.
--
-- ⚠️ 소요 시간은 `party_runs.duration_minutes` 다. 점유 구간은 `[scheduled_at,
--    scheduled_at + duration)` 반열림이라 21:00~21:30 런과 21:30~22:00 런은 겹치지 않는다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 순서 주의
-- ─────────────────────────────────────────────────────────────────────────────
-- 이 파일은 `20260817091100_column_privileges_and_availability.sql`(resolve_availability ·
-- availability_overlap) 과 `20260817090300_scheduling.sql`(party_runs · run_signups) 뒤에
-- 온다. 두 파일이 먼저 적용돼 있어야 한다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 23-1. person_run_commitments — "이 사람은 이 시각에 이미 일정이 있다"
-- -----------------------------------------------------------------------------
-- person_id 는 `party_participants.user_id` 이거나 `guest_id` 다. uuid 는 전역 유일하므로
-- `resolve_availability` 와 **같은 규약**으로 한 배열에 받아 coalesce 해서 돌려준다.
--
-- 반환에 `run_id` / `party_id` / `boss_difficulty_id` / `short_name` 을 함께 싣는 이유:
-- 화면이 이 구간을 "이미 일정 있음"으로 **이름과 함께** 보여 줘야 하기 때문이다.
-- 시간만 돌려주면 사용자는 무엇 때문에 막혔는지 알 수 없고, 그러면 조용히 사라지는 것과
-- 다를 바가 없다.
create or replace function public.person_run_commitments(
  p_person_ids     uuid[],
  p_from           timestamptz,
  p_to             timestamptz,
  p_exclude_run_id uuid default null
)
returns table (
  person_id          uuid,
  run_id             uuid,
  party_id           uuid,
  boss_difficulty_id text,
  short_name         text,
  starts_at          timestamptz,
  ends_at            timestamptz
)
language sql
stable
parallel safe
set search_path = public, pg_temp
as $func$
  select coalesce(pp.user_id, pp.guest_id) as person_id,
         r.id                              as run_id,
         r.party_id,
         r.boss_difficulty_id,
         coalesce(bd.short_name, bd.id)    as short_name,
         r.scheduled_at                    as starts_at,
         r.scheduled_at
           + make_interval(mins => r.duration_minutes) as ends_at
    from public.party_runs r
    join public.run_signups s
      on s.run_id = r.id
     -- ★ `going` 만. 미정·불참은 시간을 잡지 않는다.
     and s.status = 'going'
    join public.party_participants pp
      on pp.id = s.participant_id
    left join public.boss_difficulties bd
      on bd.id = r.boss_difficulty_id
   where (pp.user_id = any(p_person_ids) or pp.guest_id = any(p_person_ids))
     -- 시각 미정은 조율 중이라는 뜻이다. 막지 않는다.
     and r.scheduled_at is not null
     -- 취소된 런은 그 시간을 즉시 돌려준다.
     and r.cancelled_at is null
     and r.status <> 'cancelled'
     -- 수정 중인 런이 자기 자신을 막으면 시각을 옮길 수 없다.
     and (p_exclude_run_id is null or r.id <> p_exclude_run_id)
     -- 조회 구간과 겹치는 것만. 반열림 구간이라 경계에서 붙어 있는 런은 제외된다.
     and r.scheduled_at < p_to
     and r.scheduled_at + make_interval(mins => r.duration_minutes) > p_from;
$func$;

comment on function public.person_run_commitments(uuid[], timestamptz, timestamptz, uuid) is
  '이미 등록된 보스 런이 잡아먹는 시간. going 신청만 · 취소/시각미정 제외 · p_exclude_run_id 로 수정 중인 런 하나를 뺄 수 있다. availability_overlap 이 이 결과를 뺀다.';


-- -----------------------------------------------------------------------------
-- 23-2. availability_overlap — 이제 런 점유를 빼고 센다
-- -----------------------------------------------------------------------------
-- 알고리즘은 예전 그대로다(sweep line). 앞에 **multirange 뺄셈 한 단계**가 붙었을 뿐이다.
--   iv = resolve_availability(패턴 − 예외)  −  person_run_commitments(런 점유)
-- 구간 뺄셈을 손으로 쪼개지 않는 이유도 `resolve_availability` 와 같다 — 부분 겹침·
-- 양끝 겹침·완전 포함이 전부 한 연산으로 끝나고 자정 넘김도 특별 취급이 필요 없다.
--
-- ⚠️ 옛 4인자 함수를 **먼저 지운다.** 남겨 두면 4인자 호출이 두 후보(4인자 · 기본값이
--    있는 5인자)에 걸려 `function is not unique` 가 난다.
drop function if exists public.availability_overlap(uuid[], timestamptz, timestamptz, integer);

create or replace function public.availability_overlap(
  p_person_ids     uuid[],
  p_from           timestamptz,
  p_to             timestamptz,
  p_min_count      integer default 1,
  p_exclude_run_id uuid default null
)
returns table (
  window_start    timestamptz,
  window_end      timestamptz,
  available_count integer,
  person_ids      uuid[]
)
language sql
stable
parallel safe
set search_path = public, pg_temp
as $func$
  with free as (
    select r.person_id,
           range_agg(tstzrange(r.starts_at, r.ends_at, '[)')) as spans
    from public.resolve_availability(p_person_ids, p_from, p_to) r
    where r.ends_at > r.starts_at
    group by r.person_id
  ),
  busy as (
    select c.person_id,
           range_agg(tstzrange(c.starts_at, c.ends_at, '[)')) as spans
    from public.person_run_commitments(
           p_person_ids, p_from, p_to, p_exclude_run_id
         ) c
    where c.ends_at > c.starts_at
    group by c.person_id
  ),
  iv as (
    select f.person_id,
           greatest(lower(x.r), p_from) as starts_at,
           least(upper(x.r), p_to)      as ends_at
    from free f
    left join busy b on b.person_id = f.person_id
    cross join lateral unnest(
      f.spans - coalesce(b.spans, '{}'::tstzmultirange)
    ) as x(r)
    where lower(x.r) < p_to
      and upper(x.r) > p_from
  ),
  pts as (
    select starts_at as t from iv
    union
    select ends_at   as t from iv
  ),
  seg as (
    select t as seg_start, lead(t) over (order by t) as seg_end
    from pts
  ),
  counted as (
    select s.seg_start,
           s.seg_end,
           count(distinct i.person_id)::integer as cnt
    from seg s
    join iv i
      on i.starts_at <= s.seg_start and i.ends_at >= s.seg_end
    where s.seg_end is not null
      and s.seg_end > s.seg_start
    group by s.seg_start, s.seg_end
  ),
  qualified as (
    select * from counted where cnt >= greatest(coalesce(p_min_count, 1), 1)
  ),
  flagged as (
    -- 윈도우 함수는 중첩할 수 없으므로 lag 를 먼저 뽑아 둔다.
    select q.*, lag(q.seg_end) over (order by q.seg_start) as prev_end
    from qualified q
  ),
  grouped as (
    select f.*,
           sum(case when f.prev_end = f.seg_start then 0 else 1 end)
             over (order by f.seg_start) as grp
    from flagged f
  ),
  merged as (
    -- ⚠️ `min(cnt)` 이다. 병합된 창 **전체**에서 성립하는 인원이어야 하므로 최솟값이
    --    맞다. max 를 쓰면 "6명 가능"이라고 말해 놓고 그중 일부 구간만 6명이 된다.
    select min(seg_start) as window_start,
           max(seg_end)   as window_end,
           min(cnt)       as available_count
    from grouped
    group by grp
  )
  select m.window_start,
         m.window_end,
         m.available_count,
         (
           -- 창 전체를 커버하는 사람들만 (병합 구간에서 정확한 교집합)
           select array_agg(distinct i.person_id order by i.person_id)
           from iv i
           where i.starts_at <= m.window_start
             and i.ends_at   >= m.window_end
         ) as person_ids
  from merged m
  order by m.window_start;
$func$;

comment on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer, uuid) is
  'k명 이상 가능한 시간창. 패턴 − 예외 − **이미 등록된 런 점유**. p_exclude_run_id 로 수정 중인 런 하나를 제외한다. 웹·봇이 공유하는 유일한 구현.';


-- -----------------------------------------------------------------------------
-- 23-3. 권한 — 남의 생활 패턴과 남의 일정을 읽으므로 **서버 전용**이다
-- -----------------------------------------------------------------------------
-- `resolve_availability` / `can_view_availability` 와 같은 기조다. 열람 권한 판정
-- (`can_view_availability`)은 앱 서버가 사람 단위로 먼저 거른 뒤 이 함수를 부른다.
revoke all on function public.person_run_commitments(uuid[], timestamptz, timestamptz, uuid) from public;
revoke all on function public.person_run_commitments(uuid[], timestamptz, timestamptz, uuid) from anon;
revoke all on function public.person_run_commitments(uuid[], timestamptz, timestamptz, uuid) from authenticated;
grant execute on function public.person_run_commitments(uuid[], timestamptz, timestamptz, uuid) to service_role;

revoke all on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer, uuid) from public;
revoke all on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer, uuid) from anon;
revoke all on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer, uuid) from authenticated;
grant execute on function public.availability_overlap(uuid[], timestamptz, timestamptz, integer, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 23-4. 자기검증 — 적용과 동시에 규칙이 실제로 성립하는지 확인한다
-- -----------------------------------------------------------------------------
-- 임시 테이블도 시드도 쓰지 않는다. **롤백되는 트랜잭션 안에서 진짜 행을 넣고** 판정을
-- 확인한 뒤 예외로 되감는다 — 발주자 실계정 데이터에 아무것도 남지 않는다.
-- (`exception when others` 로 되감으므로 실패해도 흔적이 없고, 판정이 틀리면 raise 한다.)
do $$
declare
  v_old_overlap  integer;
  v_new_overlap  integer;
  v_commitments  integer;
begin
  -- ⚠️ 시그니처 판정에 `pg_get_function_identity_arguments()` 문자열 비교를 쓰지 않는다.
  --    그 함수는 **파라미터 이름이 선언된 함수에서는 이름을 함께 반환한다.**
  --    실측: availability_overlap → 'p_person_ids uuid[], p_from timestamp with time
  --    zone, ...'. 그래서 'uuid[], timestamp with time zone, ...' 와의 비교는 영원히
  --    거짓이고, 검사 (1)은 잔존을 못 잡는 구멍이 되고 (2)(3)은 무조건 실패한다.
  --    (실제로 그렇게 죽어 트랜잭션이 통째로 롤백됐다.)
  --    `to_regprocedure()` 는 **타입만으로** 시그니처를 조회하므로 파라미터 이름을
  --    바꾸거나 붙이거나 떼도 결과가 변하지 않는다. 없으면 예외 대신 null 을 준다.
  --    기본값도 적용하지 않는 **정확한 인자 개수 매칭**이라, 기본값 있는 5인자가
  --    4인자 조회에 걸리는 일이 없다 — (1)이 판별력을 갖는 근거다.

  -- (1) 옛 4인자 오버로드가 남아 있으면 4인자 호출이 모호해진다. 0 이어야 한다.
  select count(*) into v_old_overlap
    from pg_proc p
   where p.oid = to_regprocedure(
           'public.availability_overlap(uuid[],timestamptz,timestamptz,integer)'
         );
  if v_old_overlap <> 0 then
    raise exception '23-4 (1) 실패: 옛 4인자 availability_overlap 이 남아 있다 (%건)', v_old_overlap;
  end if;

  -- (2) 새 5인자 오버로드가 정확히 하나 있어야 한다.
  select count(*) into v_new_overlap
    from pg_proc p
   where p.oid = to_regprocedure(
           'public.availability_overlap(uuid[],timestamptz,timestamptz,integer,uuid)'
         );
  if v_new_overlap <> 1 then
    raise exception '23-4 (2) 실패: 새 5인자 availability_overlap 이 %건이다 (1이어야 함)', v_new_overlap;
  end if;

  -- (3) person_run_commitments 가 있어야 한다.
  select count(*) into v_commitments
    from pg_proc p
   where p.oid = to_regprocedure(
           'public.person_run_commitments(uuid[],timestamptz,timestamptz,uuid)'
         );
  if v_commitments <> 1 then
    raise exception '23-4 (3) 실패: person_run_commitments 가 %건이다 (1이어야 함)', v_commitments;
  end if;

  -- (4) 빈 입력은 0행이며 **오류가 아니다** (DB-SCHEMA 의 경계 규약).
  perform 1 from public.person_run_commitments(
    '{}'::uuid[], now(), now() + interval '1 day', null
  );
  perform 1 from public.availability_overlap(
    '{}'::uuid[], now(), now() + interval '1 day', 1, null
  );

  -- (5) 4인자 호출이 기본값으로 여전히 성립해야 한다(옛 호출부 호환).
  perform 1 from public.availability_overlap(
    '{}'::uuid[], now(), now() + interval '1 day', 1
  );

  raise notice '23-4. 자기검증 통과: 오버로드 1건 · 빈 입력 0행 · 4인자 호출 호환';
end
$$;


-- -----------------------------------------------------------------------------
-- 23-5. 실데이터 판정 검증 — 트랜잭션 안에서 넣고 **되감는다**
-- -----------------------------------------------------------------------------
-- 규칙 넷(going 만 · 취소 제외 · 시각미정 제외 · exclude 인자)이 진짜로 성립하는지
-- 합성 행으로 확인한다. 마지막에 반드시 예외를 던져 되감으므로 **어떤 행도 남지 않는다.**
do $$
declare
  v_user     uuid;
  v_party    uuid;
  v_pp       uuid;
  v_boss     text;
  v_run_ok   uuid;
  v_run_cx   uuid;
  v_run_tbd  uuid;
  v_base     timestamptz := date_trunc('hour', now()) + interval '1 day';
  v_hits     integer;
begin
  select id into v_boss from public.boss_difficulties limit 1;
  if v_boss is null then
    raise notice '23-5. 보스 마스터가 비어 있어 실데이터 검증을 건너뛴다.';
    return;
  end if;

  insert into public.app_users (display_name)
       values ('__migration_probe__')
    returning id into v_user;

  insert into public.parties (name, owner_user_id)
       values ('__migration_probe__', v_user)
    returning id into v_party;

  insert into public.party_participants (party_id, user_id, display_name)
       values (v_party, v_user, '__migration_probe__')
    returning id into v_pp;

  -- ① 정상 런 (going)                 → 잡아야 한다
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
       values (v_party, v_boss, v_base, 30)
    returning id into v_run_ok;
  insert into public.run_signups (run_id, participant_id, status)
       values (v_run_ok, v_pp, 'going');

  -- ② 취소된 런                        → 잡으면 안 된다
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes,
                                 status, cancelled_at)
       values (v_party, v_boss, v_base + interval '2 hour', 30, 'cancelled', now())
    returning id into v_run_cx;
  insert into public.run_signups (run_id, participant_id, status)
       values (v_run_cx, v_pp, 'going');

  -- ③ 시각 미정 런                     → 잡으면 안 된다
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
       values (v_party, v_boss, null, 30)
    returning id into v_run_tbd;
  insert into public.run_signups (run_id, participant_id, status)
       values (v_run_tbd, v_pp, 'going');

  -- ④ 미정(maybe) 신청만 있는 런        → 잡으면 안 된다
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
       values (v_party, v_boss, v_base + interval '4 hour', 30)
    returning id into v_run_cx;   -- 변수 재사용(이후 참조 없음)
  insert into public.run_signups (run_id, participant_id, status)
       values (v_run_cx, v_pp, 'maybe');

  select count(*) into v_hits
    from public.person_run_commitments(
           array[v_user], v_base - interval '1 day', v_base + interval '1 day', null
         );
  if v_hits <> 1 then
    raise exception '23-5 실패: 점유 구간이 %건이다 (going 정상 런 1건만 잡혀야 함)', v_hits;
  end if;

  -- ⑤ 제외 인자를 주면 자기 자신은 빠진다 → 0건
  select count(*) into v_hits
    from public.person_run_commitments(
           array[v_user], v_base - interval '1 day', v_base + interval '1 day', v_run_ok
         );
  if v_hits <> 0 then
    raise exception '23-5 실패: p_exclude_run_id 를 줬는데 %건이 남았다 (0이어야 함)', v_hits;
  end if;

  raise notice '23-5. 실데이터 검증 통과: going 1건만 점유 · 취소/시각미정/미정 제외 · exclude 동작';

  -- ★ 반드시 되감는다. 합성 행은 하나도 남기지 않는다.
  raise exception '__migration_probe_rollback__';
exception
  when others then
    if sqlerrm = '__migration_probe_rollback__' then
      raise notice '23-5. 검증용 합성 행을 모두 되감았다.';
    else
      raise;
    end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 이 마이그레이션은 테이블을 만들지 않지만, 호출을 생략하지 않는다. 목적은 값의
-- 민감도가 아니라 **테이블 단위 GRANT 가 조용히 넓어지지 않았는지**를 확인하는 것이고,
-- 생략이 곧 share_bp 가 샜던 경로다.
select public.assert_no_public_sensitive_columns();
