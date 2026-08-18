-- =============================================================================
-- M_Schedule · 24. availability_board — 겹쳐보기 4종을 **왕복 한 번**에 묶는다
-- =============================================================================
-- 발주자 요구(2026-08-18): "화면 전환 시간을 더 줄인다. 직렬 DB 왕복을 줄이는 것이
-- 유일한 지렛대."  실측: 원격 Supabase 왕복 1회 ≈ 78ms, `/schedule` RSC 탐색 1.07s.
--
-- ── 무엇이 느렸나 ─────────────────────────────────────────────────────────
-- `/schedule` 첫 진입은 **같은 사람 집합 · 같은 시간 구간**에 대해 네 가지를 물었다.
--   ① resolve_availability      (개인 레인)
--   ② availability_overlap      (겹침 창)
--   ③ availability_exceptions   (제외 자국)
--   ④ person_run_commitments    ("이미 일정 있음" 블록)
-- 게다가 넷 **각각**이 앞서 `can_view_availability` 를 사람 수만큼 돌렸다. 병렬로
-- 띄워도 왕복 깊이는 2단이고, 요청 개수는 4 × (사람수 + 1) 이다. 6인 파티면 28건.
--
-- ── 왜 앱이 아니라 DB 인가 (§1.4) ─────────────────────────────────────────
-- **겹쳐보기 로직은 정확히 한 곳에 있어야 한다.** 웹과 카톡 봇이 같은 답을 내야 하기
-- 때문이다. 그래서 이 함수는 **계산을 하지 않는다.** ①②③④를 그대로 호출해 결과를
-- 한 jsonb 로 싣는 **묶음(fan-in) 함수**일 뿐이다. sweep line 도, multirange 뺄셈도,
-- 열람 권한 판정도 여기에 복제되지 않았다 — 한 줄이라도 복제하면 그 순간 두 벌이 된다.
--
-- ── 기존 함수를 지우지 않는 이유 ──────────────────────────────────────────
--   · 카톡 봇과 `/api/schedule/availability?kind=…` 는 개별 함수를 계속 쓴다.
--   · 특이사항 편집기는 **다른 구간**(오늘부터 8주)을 다른 사람 집합으로 묻는다.
--     묶음 함수 하나로 강제하면 필요 없는 세 계산이 매번 따라붙는다.
--   · 이 파일이 적용되지 않은 DB 에서도 앱이 그대로 동작해야 한다(폴백 = 옛 4종 호출).
-- 그래서 ①②③④는 **시그니처도 의미도 한 글자도 바뀌지 않는다.**
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 적용 순서 주의
-- ─────────────────────────────────────────────────────────────────────────────
-- `20260817091100_column_privileges_and_availability.sql` (resolve_availability ·
-- can_view_availability) 와 `20260818130000_availability_minus_runs.sql`
-- (person_run_commitments · 5인자 availability_overlap) 뒤에 온다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 24-1. availability_board — 열람 필터 + 4종 조회를 한 번에
-- -----------------------------------------------------------------------------
-- 반환은 **jsonb 한 값**이다. 서로 열 수가 다른 네 결과를 한 `returns table` 로 묶으면
-- null 채우기가 생기고 호출부가 그걸 다시 갈라야 한다 — 그게 바로 로직이 앱으로 새는
-- 자리다. jsonb 는 네 배열을 **원래 모양 그대로** 실어 나른다.
--
-- ⚠️ 키 이름은 각 원천 함수의 **반환 컬럼명 그대로**다(`window_start`, `person_id`, …).
--    이름을 예쁘게 고치면 원천과의 대응이 끊기고, 컬럼이 바뀌었을 때 조용히 어긋난다.
--
-- ★ `visible_person_ids` 를 함께 돌려준다. 앱이 `can_view_availability` 를 사람마다
--   따로 부르던 왕복이 여기 흡수됐고, 호출부는 "누가 걸러졌는가"를 그대로 볼 수 있다.
create or replace function public.availability_board(
  p_viewer_user_id uuid,
  p_person_ids     uuid[],
  p_from           timestamptz,
  p_to             timestamptz,
  p_min_count      integer default 1,
  p_exclude_run_id uuid default null
)
returns jsonb
language sql
stable
parallel safe
set search_path = public, pg_temp
as $func$
  with allowed as (
    -- 열람 판정은 `can_view_availability` 가 **유일한 출처**다. 규칙을 여기에 다시
    -- 적지 않는다 — 적는 순간 화면과 봇의 공개 범위가 갈라진다.
    select distinct pid
    from unnest(coalesce(p_person_ids, '{}'::uuid[])) as pid
    where public.can_view_availability(p_viewer_user_id, pid)
  ),
  ids as (
    -- 이후 모든 조회가 쓰는 **한 벌의 배열**. 정렬은 결과 안정성용이다.
    select coalesce(array_agg(pid order by pid), '{}'::uuid[]) as arr from allowed
  ),
  intervals as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'person_id', r.person_id,
                 'starts_at', r.starts_at,
                 'ends_at',   r.ends_at
               )
               order by r.person_id, r.starts_at
             ),
             '[]'::jsonb
           ) as j
    from ids, lateral public.resolve_availability(ids.arr, p_from, p_to) r
  ),
  overlap as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'window_start',    o.window_start,
                 'window_end',      o.window_end,
                 'available_count', o.available_count,
                 'person_ids',      to_jsonb(coalesce(o.person_ids, '{}'::uuid[]))
               )
               order by o.window_start
             ),
             '[]'::jsonb
           ) as j
    from ids,
         lateral public.availability_overlap(
           ids.arr, p_from, p_to, p_min_count, p_exclude_run_id
         ) o
  ),
  commitments as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'person_id',          c.person_id,
                 'run_id',             c.run_id,
                 'party_id',           c.party_id,
                 'boss_difficulty_id', c.boss_difficulty_id,
                 'short_name',         c.short_name,
                 'starts_at',          c.starts_at,
                 'ends_at',            c.ends_at
               )
               order by c.starts_at, c.run_id, c.person_id
             ),
             '[]'::jsonb
           ) as j
    from ids,
         lateral public.person_run_commitments(
           ids.arr, p_from, p_to, p_exclude_run_id
         ) c
  ),
  exceptions as (
    -- ⚠️ 앱이 하던 조회와 **경계가 같아야 한다**: KST 날짜 키로 from~to **양끝 포함**.
    --    `public.kst_date()` 는 `resolve_availability` 가 쓰는 그 함수이며, TS 의
    --    `kstDayKey()` 와 같은 값을 낸다. 여기서 UTC 날짜를 쓰면 자정 근처 하루가
    --    통째로 사라지거나 더 붙는다.
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'id',             e.id,
                 'user_id',        e.user_id,
                 'guest_id',       e.guest_id,
                 'exception_date', e.exception_date,
                 'start_minute',   e.start_minute,
                 'end_minute',     e.end_minute,
                 'note',           e.note
               )
               order by e.exception_date, e.id
             ),
             '[]'::jsonb
           ) as j
    from ids
    join public.availability_exceptions e
      on (e.user_id = any(ids.arr) or e.guest_id = any(ids.arr))
     and e.exception_date between public.kst_date(p_from) and public.kst_date(p_to)
  )
  select jsonb_build_object(
           'visible_person_ids', (select to_jsonb(i.arr) from ids i),
           'intervals',          (select j from intervals),
           'overlap',            (select j from overlap),
           'exceptions',         coalesce((select j from exceptions), '[]'::jsonb),
           'commitments',        (select j from commitments)
         );
$func$;

comment on function public.availability_board(uuid, uuid[], timestamptz, timestamptz, integer, uuid) is
  '겹쳐보기 화면 한 벌(개인구간·겹침창·예외·런점유)을 왕복 한 번에. 계산은 전부 원천 함수(resolve_availability · availability_overlap · person_run_commitments · can_view_availability)에 있고 이 함수는 묶기만 한다.';


-- -----------------------------------------------------------------------------
-- 24-2. 권한 — 남의 생활 패턴과 남의 일정을 읽으므로 **서버 전용**이다
-- -----------------------------------------------------------------------------
-- 원천 함수 넷과 **정확히 같은 기조**다. 묶음 함수가 더 넓은 권한을 갖는 순간 그것이
-- 우회로가 된다.
revoke all on function public.availability_board(uuid, uuid[], timestamptz, timestamptz, integer, uuid) from public;
revoke all on function public.availability_board(uuid, uuid[], timestamptz, timestamptz, integer, uuid) from anon;
revoke all on function public.availability_board(uuid, uuid[], timestamptz, timestamptz, integer, uuid) from authenticated;
grant execute on function public.availability_board(uuid, uuid[], timestamptz, timestamptz, integer, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 24-3. 자기검증 (구조) — 시그니처와 경계 규약
-- -----------------------------------------------------------------------------
do $$
declare
  v_board integer;
  v_json  jsonb;
begin
  -- (1) 6인자 시그니처가 정확히 하나. `to_regprocedure` 는 파라미터 **이름**에
  --     영향받지 않으므로 이름을 바꿔도 이 검사는 그대로 성립한다(23-4의 교훈).
  select count(*) into v_board
    from pg_proc p
   where p.oid = to_regprocedure(
           'public.availability_board(uuid,uuid[],timestamptz,timestamptz,integer,uuid)'
         );
  if v_board <> 1 then
    raise exception '24-3 (1) 실패: availability_board 가 %건이다 (1이어야 함)', v_board;
  end if;

  -- (2) 원천 함수 넷은 **그대로 남아 있어야 한다.** 이 파일은 아무것도 대체하지 않는다.
  if to_regprocedure('public.resolve_availability(uuid[],timestamptz,timestamptz)') is null
     or to_regprocedure('public.availability_overlap(uuid[],timestamptz,timestamptz,integer,uuid)') is null
     or to_regprocedure('public.person_run_commitments(uuid[],timestamptz,timestamptz,uuid)') is null
     or to_regprocedure('public.can_view_availability(uuid,uuid)') is null then
    raise exception '24-3 (2) 실패: 원천 함수 중 하나가 사라졌다. 묶음 함수는 어떤 것도 대체하지 않는다.';
  end if;

  -- (3) **빈 입력은 오류가 아니다.** 비로그인(viewer null)·사람 0명은 정상 상태이며
  --     네 배열이 모두 빈 배열이어야 한다. 여기서 null 이 나오면 화면이 오류를 그린다.
  v_json := public.availability_board(
              null, '{}'::uuid[], now(), now() + interval '1 day', 1, null
            );
  if v_json -> 'intervals'   <> '[]'::jsonb
     or v_json -> 'overlap'     <> '[]'::jsonb
     or v_json -> 'exceptions'  <> '[]'::jsonb
     or v_json -> 'commitments' <> '[]'::jsonb
     or v_json -> 'visible_person_ids' <> '[]'::jsonb then
    raise exception '24-3 (3) 실패: 빈 입력의 답이 빈 배열 넷이 아니다 → %', v_json;
  end if;

  raise notice '24-3. 자기검증 통과: 시그니처 1건 · 원천 함수 4종 잔존 · 빈 입력 = 빈 배열 넷';
end
$$;


-- -----------------------------------------------------------------------------
-- 24-4. 동등성 검증 — **묶어 부른 답 = 따로 부른 답**
-- -----------------------------------------------------------------------------
-- 이 파일의 존재 이유가 "왕복만 줄이고 답은 그대로"이므로, 그 주장을 마이그레이션이
-- 스스로 증명한다. 합성 행을 넣고 두 경로를 비교한 뒤 **반드시 되감는다**
-- (23-5 와 같은 방식 — 발주자 실계정 데이터에 아무것도 남지 않는다).
--
-- 검증 대상은 겹쳐보기가 실제로 어려워하는 두 가지다.
--   · **자정 넘김**  — 화요일 22:00~다음날 02:00 패턴
--   · **「이미 일정 있음」 차감** — 그 구간 안에 going 런 하나
do $$
declare
  v_user     uuid;
  v_party    uuid;
  v_pp       uuid;
  v_boss     text;
  v_run      uuid;
  -- 검증 구간: 오늘 KST 00:00 부터 7일. 실제 화면과 같은 폭이다.
  v_from     timestamptz := public.kst_moment(public.kst_date(now()), 0);
  v_to       timestamptz := public.kst_moment(public.kst_date(now()) + 7, 0);
  v_board    jsonb;
  v_a        jsonb;
  v_b        jsonb;
  v_weekday  smallint;
begin
  select id into v_boss from public.boss_difficulties limit 1;
  if v_boss is null then
    raise notice '24-4. 보스 마스터가 비어 있어 동등성 검증을 건너뛴다.';
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

  -- ── 자정 넘김 패턴: **모든 요일** 22:00~26:00(=다음날 02:00) ──────────────
  --    요일을 하나만 깔면 7일 구간 안에서 예외·런이 그 요일에 안 걸릴 수 있다.
  for v_weekday in 1..7 loop
    insert into public.availability_patterns (user_id, weekday, start_minute, end_minute)
         values (v_user, v_weekday, 22 * 60, 26 * 60);
  end loop;

  -- ── 예외(제외): 이틀 뒤 하루 전체 ────────────────────────────────────────
  insert into public.availability_exceptions (user_id, exception_date, start_minute, end_minute)
       values (v_user, public.kst_date(now()) + 2, 0, 1440);

  -- ── 이미 등록된 런: 내일 23:00 부터 60분 (자정 넘김 구간 한가운데) ────────
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
       values (
         v_party, v_boss,
         public.kst_moment(public.kst_date(now()) + 1, 23 * 60),
         60
       )
    returning id into v_run;
  insert into public.run_signups (run_id, participant_id, status)
       values (v_run, v_pp, 'going');

  v_board := public.availability_board(
               v_user, array[v_user], v_from, v_to, 1, null
             );

  -- (1) 개인 구간 = resolve_availability
  select coalesce(
           jsonb_agg(
             jsonb_build_object('person_id', r.person_id,
                                'starts_at', r.starts_at,
                                'ends_at',   r.ends_at)
             order by r.person_id, r.starts_at),
           '[]'::jsonb)
    into v_a
    from public.resolve_availability(array[v_user], v_from, v_to) r;
  v_b := v_board -> 'intervals';
  if v_a <> v_b then
    raise exception '24-4 (1) 실패: 개인 구간이 다르다.%  따로=%  묶음=%', chr(10), v_a, v_b;
  end if;

  -- (2) 겹침 창 = availability_overlap  ← 자정 넘김 + 런 차감이 여기서 드러난다
  select coalesce(
           jsonb_agg(
             jsonb_build_object('window_start',    o.window_start,
                                'window_end',      o.window_end,
                                'available_count', o.available_count,
                                'person_ids',      to_jsonb(coalesce(o.person_ids, '{}'::uuid[])))
             order by o.window_start),
           '[]'::jsonb)
    into v_a
    from public.availability_overlap(array[v_user], v_from, v_to, 1, null) o;
  v_b := v_board -> 'overlap';
  if v_a <> v_b then
    raise exception '24-4 (2) 실패: 겹침 창이 다르다.%  따로=%  묶음=%', chr(10), v_a, v_b;
  end if;

  -- (3) 런 점유 = person_run_commitments
  select coalesce(
           jsonb_agg(
             jsonb_build_object('person_id',          c.person_id,
                                'run_id',             c.run_id,
                                'party_id',           c.party_id,
                                'boss_difficulty_id', c.boss_difficulty_id,
                                'short_name',         c.short_name,
                                'starts_at',          c.starts_at,
                                'ends_at',            c.ends_at)
             order by c.starts_at, c.run_id, c.person_id),
           '[]'::jsonb)
    into v_a
    from public.person_run_commitments(array[v_user], v_from, v_to, null) c;
  v_b := v_board -> 'commitments';
  if v_a <> v_b then
    raise exception '24-4 (3) 실패: 런 점유가 다르다.%  따로=%  묶음=%', chr(10), v_a, v_b;
  end if;

  -- (4) 예외 = 앱이 하던 그 조회(KST 날짜 키, 양끝 포함)
  select coalesce(
           jsonb_agg(
             jsonb_build_object('id',             e.id,
                                'user_id',        e.user_id,
                                'guest_id',       e.guest_id,
                                'exception_date', e.exception_date,
                                'start_minute',   e.start_minute,
                                'end_minute',     e.end_minute,
                                'note',           e.note)
             order by e.exception_date, e.id),
           '[]'::jsonb)
    into v_a
    from public.availability_exceptions e
   where (e.user_id = v_user or e.guest_id = v_user)
     and e.exception_date between public.kst_date(v_from) and public.kst_date(v_to);
  v_b := v_board -> 'exceptions';
  if v_a <> v_b then
    raise exception '24-4 (4) 실패: 예외 목록이 다르다.%  따로=%  묶음=%', chr(10), v_a, v_b;
  end if;

  -- (5) **차감이 실제로 일어났는지**를 못 박는다. 넷이 모두 비어 있으면 (1)~(4)는
  --     "빈 것끼리 같다"가 되어 아무것도 증명하지 못한다.
  if jsonb_array_length(v_board -> 'commitments') <> 1 then
    raise exception '24-4 (5) 실패: 런 점유가 1건이어야 하는데 %건이다 (검증 자체가 무의미해진다)',
      jsonb_array_length(v_board -> 'commitments');
  end if;
  if jsonb_array_length(v_board -> 'overlap') < 1 then
    raise exception '24-4 (5) 실패: 겹침 창이 0건이다 (자정 넘김 패턴이 살아 있어야 한다)';
  end if;
  if jsonb_array_length(v_board -> 'exceptions') <> 1 then
    raise exception '24-4 (5) 실패: 예외가 1건이어야 하는데 %건이다',
      jsonb_array_length(v_board -> 'exceptions');
  end if;

  -- (6) **열람 권한이 실제로 걸러 내는지.** 남의 uuid 는 통째로 빠져야 한다.
  if public.availability_board(
       null, array[v_user], v_from, v_to, 1, null
     ) -> 'visible_person_ids' <> '[]'::jsonb then
    raise exception '24-4 (6) 실패: 비로그인에게 사람이 보인다. can_view_availability 우회다.';
  end if;

  raise notice '24-4. 동등성 검증 통과: 네 결과가 따로 부른 값과 **정확히 일치** (자정 넘김 · 런 차감 · 예외 포함)';

  -- ★ 반드시 되감는다. 합성 행은 하나도 남기지 않는다.
  raise exception '__migration_probe_rollback__';
exception
  when others then
    if sqlerrm = '__migration_probe_rollback__' then
      raise notice '24-4. 검증용 합성 행을 모두 되감았다.';
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
