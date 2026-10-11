-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 보스 **한 판**의 소요 시간 상한을 600분 → 20분으로 내린다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주자 정정(2026-10-11, 원문):
--   *"내말은 보스 하나당 최대시간이 20분이라고.. 한덩이는 각 보스의 플레이타임이 결정되면
--     그걸 계산하게 해야지. 기본값은 20으로 넣어두고 파티짤때 설정하고, 이미 설정했더라도
--     넣고 하라고"*
--
-- 직전 마이그레이션(`20261011120000_party_boss_durations.sql`)이 보스별 소요 시간을
-- `party_bosses.duration_minutes` 에 담으면서 범위를 **5~600** 으로 잡았다. 600 은
-- `party_runs` 가 2026-08-17 부터 써 온 값을 그대로 따라간 것이고, **도메인에 근거가 없다.**
-- 보스 한 판은 20분을 넘지 않는다. 600분이 허용되면 화면은 "익세 480분" 같은 입력을
-- 받아들이고, 그 값은 묶음 길이의 분모라 시간표가 하루를 통째로 덮는 블록을 그린다.
--
-- ⚠️ **합산 로직은 건드리지 않는다.** 묶음(한 덩이) 길이는 이미 보스별 값의 **합**으로
--    계산된다(`createPartyRuns` → 보스마다 한 행, `groupConsecutiveRuns` 가 이어 붙인다).
--    발주자가 말한 *"한덩이는 각 보스의 플레이타임이 결정되면 그걸 계산하게"* 는 이미
--    그렇게 동작하므로, 이 마이그레이션은 **경계값만** 옮긴다.
--
-- ⚠️ **기본값 20분은 그대로다**(발주 지시). 코드 쪽 주인은
--    `src/lib/domain/run-grouping.ts` 의 `DEFAULT_RUN_MINUTES = 20` 이고, 아래 3-1 이
--    고치는 것은 그것과 **다른 값** — `party_runs` 컬럼의 DB default 30 이다(사유는 거기).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 두 표를 **같이** 조인다
-- ─────────────────────────────────────────────────────────────────────────────
-- 직전 마이그레이션 머리말이 세운 규칙이다: `party_bosses` 와 `party_runs` 의 상·하한이
-- 다르면 **"파티에는 저장되는데 그 값으로 런을 못 만드는"** 조합이 생기고, 그 반대 방향
-- (파티엔 못 넣는데 런엔 들어가는)도 똑같이 사용자가 원인을 알 수 없는 실패다. 런 한 건은
-- 보스 한 판이므로 상한의 뜻도 같다 — 한쪽만 조이는 선택지는 없다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 하한 5분은 **그대로 둔다** — 그리고 그것이 만드는 한계를 적어 둔다
-- ─────────────────────────────────────────────────────────────────────────────
-- 발주 요청에 하한은 없었고, 내리면 `party_runs` 쪽 하한도 같이 내려야 한다(위 규칙).
-- ⚠️ 그래서 **"3분에 끝나는 보스"를 적을 수 없다.** 노멀 자쿰·이지 매그너스처럼 1~3분에
--    끝나는 보스가 실재하는데 최소 5분으로 올려 적어야 하고, 묶음 다섯 개면 합이 10분쯤
--    부풀어 시간표 블록이 실제보다 길게 그려진다. 금액에는 영향이 없다(결정석 시세는
--    시간과 무관하다). 바꾸려면 두 표를 함께 내리면 되고, 그 판단은 발주자 몫으로 남긴다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 기존 행은 하나도 위반하지 않는다 (라이브 실측 2026-10-11)
-- ─────────────────────────────────────────────────────────────────────────────
--   `party_runs`   100건 — 전부 `duration_minutes = 20` (min 20 / max 20), 20 초과 0건
--   `party_bosses` 149건 — `duration_minutes` 가 설정된 행 **0건**(전부 null)
-- 그래도 아래 1 이 **다시 센다.** 적용 시점은 실측 시점보다 뒤이고, 그 사이에 누가 40분을
-- 저장할 수 있다. 0 이 아니면 CHECK 를 붙이기 **전에** 한국어로 멈춘다 — 붙이고 나서
-- 터지면 Postgres 영문 제약 위반만 남아 어느 행이 걸렸는지 말해 주지 않는다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ 5~20 이 적힌 자리는 SQL 안에 **네 곳**이다 — 다음에 또 바꿀 사람을 위한 목록
-- ─────────────────────────────────────────────────────────────────────────────
--   ① `party_bosses_duration_minutes_check`      (아래 2-1)
--   ② `party_runs_duration_minutes_check`        (아래 2-2)
--   ③ `set_party_bosses` 의 범위 판정 + 한국어 문구        (아래 3-2)
--   ④ `set_party_boss_durations` 의 범위 판정 + 한국어 문구 (아래 3-3)
-- ③④ 를 빼먹으면 25분 입력이 함수 판정을 통과해 CHECK 까지 내려가고, 앱은 Postgres
-- 영문 제약 위반을 받아 **500** 으로 접는다. 그 회피가 애초에 그 판정이 존재하는 이유다.
-- TS 쪽 주인은 `src/lib/domain/run-grouping.ts` 의 `RUN_DURATION_MIN/MAX` **한 곳**이다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 재실행 가능하다 (발주자가 손으로 붙여 실행하는 파일이다)
-- ─────────────────────────────────────────────────────────────────────────────
-- CHECK 는 `drop constraint if exists` → `add` 이고, 함수는 `create or replace`(서명이
-- 바뀌지 않으므로 `drop function` 이 필요 없다), 자기검증은 끝에서 **일부러 예외를 던져
-- 되감는다**(migration 23·24 와 같은 패턴). 그래서 두 번 실행해도 결과가 같고, 중간에서
-- 실패해도 탐침 행이 남지 않는다.


-- -----------------------------------------------------------------------------
-- 1. 선검사 — 위반 행이 있으면 **CHECK 를 붙이기 전에** 한국어로 멈춘다
-- -----------------------------------------------------------------------------
do $$
declare
  v_runs   integer;
  v_bosses integer;
begin
  select count(*) into v_runs
    from public.party_runs
   where duration_minutes < 5 or duration_minutes > 20;

  select count(*) into v_bosses
    from public.party_bosses
   where duration_minutes is not null
     and (duration_minutes < 5 or duration_minutes > 20);

  if v_runs <> 0 or v_bosses <> 0 then
    raise exception
      '새 상한(20분)을 위반하는 행이 있습니다 — party_runs %건, party_bosses %건. '
      '먼저 그 행들을 5~20 으로 고친 뒤 다시 실행해 주세요 '
      '(조회: select id, duration_minutes from public.party_runs where duration_minutes > 20).',
      v_runs, v_bosses;
  end if;

  raise notice '선검사 통과 — 위반 행 0건 (party_runs 0 / party_bosses 0)';
end
$$;


-- -----------------------------------------------------------------------------
-- 2. CHECK 두 개를 5~20 으로
-- -----------------------------------------------------------------------------

-- 2-1. party_bosses — `null` 은 "정하지 않았다"라서 계속 통과해야 한다(0 도 20 도 아니다).
alter table public.party_bosses
  drop constraint if exists party_bosses_duration_minutes_check;
alter table public.party_bosses
  add constraint party_bosses_duration_minutes_check
  check (duration_minutes is null or (duration_minutes between 5 and 20));

comment on column public.party_bosses.duration_minutes is
  '이 파티가 이 보스에 쓰는 시간(분). null = 정하지 않았다 — 0 도 20 도 아니며 앱이 코드 상수 '
  '(src/lib/domain/run-grouping.ts 의 DEFAULT_RUN_MINUTES)로 접는다. 그렇게 두는 이유는 '
  '"기본값을 쓰는 중"과 "사용자가 그 값을 골랐다"를 구분해야 나중에 기본값을 바꿀 때 전자만 '
  '따라오기 때문이다(§1.3 D4 와 같은 기조). 상·하한은 party_runs.duration_minutes 와 같은 '
  '5~20 이며(2026-10-11 발주 정정 — 보스 한 판은 20분을 넘지 않는다), 다르면 파티에는 '
  '저장되는데 런을 못 만드는 조합이 생긴다. 한 묶음의 길이는 이 값들의 합이다.';

-- 2-2. party_runs — 런 한 건은 보스 한 판이므로 상한의 뜻이 같다.
--      ⚠️ 2026-08-17 부터 `between 5 and 600` 이었다. 그 600 은 "묶음 전체"가 아니라
--         처음부터 **한 행**의 상한이었고, 그 사실이 바뀌는 것은 아니다 — 상한의 값만
--         도메인에 맞춰 내린다.
alter table public.party_runs
  drop constraint if exists party_runs_duration_minutes_check;
alter table public.party_runs
  add constraint party_runs_duration_minutes_check
  check (duration_minutes between 5 and 20);

comment on column public.party_runs.duration_minutes is
  '이 런(= 보스 한 판)의 소요 시간(분). 5~20 이며 party_bosses.duration_minutes 와 같은 '
  '경계다(2026-10-11 발주 정정). 묶어 도는 한 덩이의 길이는 행 하나가 아니라 이어지는 '
  '행들의 합으로 계산된다 — 그래서 상한이 20 이어도 60분 묶음을 표현할 수 있다.';


-- -----------------------------------------------------------------------------
-- 3. 같은 경계를 쓰는 나머지 자리
-- -----------------------------------------------------------------------------

-- 3-1. ★ 컬럼 default 30 → 20. **이것을 빼면 위 CHECK 가 자기 default 를 거절한다.**
--      `party_runs.duration_minutes` 는 2026-08-17 부터 `not null default 30` 이었다.
--      30 은 새 상한 20 을 넘으므로, 이 컬럼을 생략한 insert 는 **전부 제약 위반**이 된다.
--      앱의 쓰기 경로는 지금 모두 값을 명시하므로 당장 터지는 자리는 없지만, "기본값이
--      자기 CHECK 를 위반하는 컬럼"은 다음 insert 를 기다리는 함정이다.
--      20 을 고른 근거: 발주자가 유지하라고 한 기본값(`DEFAULT_RUN_MINUTES = 20`)과 같은
--      값이어야 DB 와 앱이 "정하지 않았을 때 몇 분인가"에 같은 답을 한다. 30 이었던 쪽이
--      애초에 어긋나 있었다.
alter table public.party_runs
  alter column duration_minutes set default 20;

-- 3-2. set_party_bosses — 범위 판정과 한국어 문구만 5~20 으로 바뀐다
-- -----------------------------------------------------------------------------
-- ⚠️ 서명(3-인자)·보존 규칙·중복 접기·길이 검사는 `20261011120000` 과 **완전히 같다.**
--    바뀌는 것은 `d > 600` → `d > 20` 과 문구 한 줄뿐이다. 함수 본문은 부분 수정이
--    불가능해 전문을 다시 적는다 — 그 외의 줄을 "정리"하지 않는다. 동작이 같아야
--    이 마이그레이션이 경계값 변경 하나로 읽힌다.
-- ★ `drop function` 은 하지 않는다. 직전 마이그레이션이 옛 2-인자 서명을 이미 떨어뜨렸고,
--   서명이 바뀌지 않으므로 `create or replace` 로 충분하다.
create or replace function public.set_party_bosses(
  p_party_id            uuid,
  p_boss_difficulty_ids text[],
  p_duration_minutes    integer[] default null
)
returns setof public.party_bosses
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_ids  text[]  := coalesce(p_boss_difficulty_ids, '{}'::text[]);
  v_len  integer := coalesce(array_length(v_ids, 1), 0);
  v_dlen integer := coalesce(array_length(p_duration_minutes, 1), 0);
  v_kept jsonb;
  v_bad  integer;
begin
  if v_len > 24 then
    raise exception '파티에 등록할 수 있는 보스는 24개까지입니다 (입력 %개).', v_len
      using errcode = 'check_violation';
  end if;

  if p_duration_minutes is not null and v_dlen <> v_len then
    raise exception
      '보스 %개에 소요 시간 %개가 들어왔습니다 — 길이가 같아야 어느 보스의 시간인지 정해집니다.',
      v_len, v_dlen
      using errcode = 'check_violation';
  end if;

  if p_duration_minutes is not null then
    -- CHECK 가 어차피 막지만, 거기까지 내려가면 Postgres 영문 제약 위반이 되어 앱이 500 으로
    -- 접는다. 한국어로 말할 수 있는 자리에서 말한다.
    select min(d) into v_bad
      from unnest(p_duration_minutes) as t(d)
     where d is not null and (d < 5 or d > 20);
    if v_bad is not null then
      raise exception '보스 소요 시간은 5분에서 20분 사이여야 합니다 (입력 %).', v_bad
        using errcode = 'check_violation';
    end if;
  end if;

  -- ★ 보존 스냅샷. **delete 보다 먼저** 떠야 한다(`20261011120000` 머리말).
  select coalesce(jsonb_object_agg(boss_difficulty_id, duration_minutes), '{}'::jsonb)
    into v_kept
    from public.party_bosses
   where party_id = p_party_id
     and duration_minutes is not null;

  delete from public.party_bosses where party_id = p_party_id;

  if v_len > 0 then
    insert into public.party_bosses
           (party_id, boss_difficulty_id, sort_order, duration_minutes)
    select p_party_id,
           d.id,
           (row_number() over (order by d.ord))::integer,
           d.dur
      from (
        select i.id,
               min(i.ord)                           as ord,
               -- 중복이 접힌 자리는 **첫 등장**의 값. array_agg 는 null 도 자리를 지킨다.
               (array_agg(i.dur order by i.ord))[1] as dur
          from (
            select u.id,
                   u.ord,
                   case
                     -- 배열이 없으면 **보존**, 있으면 그 자리의 값(null 이면 정하지 않음).
                     when p_duration_minutes is null then (v_kept ->> u.id)::integer
                     else p_duration_minutes[u.ord::integer]
                   end as dur
              from unnest(v_ids) with ordinality as u(id, ord)
             where btrim(u.id) <> ''
          ) i
         group by i.id
      ) d;
  end if;

  return query
    select pb.*
      from public.party_bosses pb
     where pb.party_id = p_party_id
     order by pb.sort_order, pb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_bosses(uuid, text[], integer[]) is
  '파티의 보스 목록을 배열 순서대로 통째로 교체한다(원자적). 중복은 접고 sort_order 는 1부터 '
  '다시 매긴다. p_duration_minutes 가 null 이면 **기존 소요 시간을 보존한다** — 목록만 저장하는 '
  '호출(PUT /bosses 에서 durationMinutes 생략)이 계약상 정상이고, 보존이 없으면 그 저장마다 '
  '보스 시간이 전부 날아간다. delete→insert 사이를 버틸 자리가 DB 뿐이라 여기서 스냅샷을 뜬다. '
  '배열이 주어지면 길이가 보스 배열과 같아야 하며, 다르면 예외다. 원소 null 은 "정하지 않음"이라 '
  '기존 값을 지운다(생략과 정반대다). 소요 시간 범위는 5~20 이며(2026-10-11 발주 정정 — 보스 한 '
  '판은 20분을 넘지 않는다) party_runs 와 같은 경계다. 권한 판정은 하지 않는다 — 호출 전에 앱이 '
  '파티 구성원임을 확인한다.';

revoke all on function public.set_party_bosses(uuid, text[], integer[]) from public;
revoke all on function public.set_party_bosses(uuid, text[], integer[]) from anon;
revoke all on function public.set_party_bosses(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_bosses(uuid, text[], integer[]) to service_role;


-- 3-3. set_party_boss_durations — 같은 변경(범위 판정 + 문구)
-- -----------------------------------------------------------------------------
-- ⚠️ 목록을 건드리지 않는 좁은 경로다. 그 성질(없는 보스 id 는 조용히 무시, 원소 null 은
--    "정하지 않음으로 되돌린다")은 `20261011120000` 과 **완전히 같다.**
create or replace function public.set_party_boss_durations(
  p_party_id            uuid,
  p_boss_difficulty_ids text[],
  p_duration_minutes    integer[]
)
returns setof public.party_bosses
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_ids  text[]  := coalesce(p_boss_difficulty_ids, '{}'::text[]);
  v_len  integer := coalesce(array_length(v_ids, 1), 0);
  v_dlen integer := coalesce(array_length(p_duration_minutes, 1), 0);
  v_bad  integer;
begin
  -- 길이 불일치는 전체 교체 함수와 **같은 이유**로 예외다(어느 보스의 시간인지 어긋난다).
  if v_dlen <> v_len then
    raise exception
      '보스 %개에 소요 시간 %개가 들어왔습니다 — 길이가 같아야 어느 보스의 시간인지 정해집니다.',
      v_len, v_dlen
      using errcode = 'check_violation';
  end if;

  if v_len = 0 then
    return query
      select pb.* from public.party_bosses pb
       where pb.party_id = p_party_id
       order by pb.sort_order, pb.boss_difficulty_id;
    return;
  end if;

  select min(d) into v_bad
    from unnest(p_duration_minutes) as t(d)
   where d is not null and (d < 5 or d > 20);
  if v_bad is not null then
    raise exception '보스 소요 시간은 5분에서 20분 사이여야 합니다 (입력 %).', v_bad
      using errcode = 'check_violation';
  end if;

  update public.party_bosses pb
     set duration_minutes = d.dur
    from (
      select i.id, (array_agg(i.dur order by i.ord))[1] as dur
        from (
          select u.id, u.ord, p_duration_minutes[u.ord::integer] as dur
            from unnest(v_ids) with ordinality as u(id, ord)
           where btrim(u.id) <> ''
        ) i
       group by i.id
    ) d
   where pb.party_id = p_party_id
     and pb.boss_difficulty_id = d.id;

  return query
    select pb.*
      from public.party_bosses pb
     where pb.party_id = p_party_id
     order by pb.sort_order, pb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_boss_durations(uuid, text[], integer[]) is
  '이미 그 파티에 등록된 보스의 소요 시간만 쓴다. 보스를 넣거나 지우거나 순서를 바꾸지 않으며, '
  '그 파티에 없는 보스 id 는 조용히 무시한다(일정 등록을 실패시키지 않기 위해서다). 원소 null 은 '
  '"정하지 않음으로 되돌린다". 배열 길이는 같아야 하며 다르면 예외다. 범위는 5~20 이다 '
  '(2026-10-11 발주 정정).';

revoke all on function public.set_party_boss_durations(uuid, text[], integer[]) from public;
revoke all on function public.set_party_boss_durations(uuid, text[], integer[]) from anon;
revoke all on function public.set_party_boss_durations(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_boss_durations(uuid, text[], integer[]) to service_role;


-- -----------------------------------------------------------------------------
-- 4. 자기검증 — 새 경계값 · 두 표의 일치 · 함수가 한국어로 거절하는가
-- -----------------------------------------------------------------------------
-- ★ 끝에서 **일부러 예외를 던져 되감는다**(migration 23·24 패턴). 탐침 행이 남지 않으므로
--   이 블록은 몇 번이든 다시 실행할 수 있고, 중간에서 실패해도 흔적이 없다.
--   (직전 마이그레이션은 `delete from app_users` 로 치웠는데, 그 방식은 중간 실패 때
--    `__migration_*_probe__` 행이 남아 재실행을 막는다.)
do $$
declare
  v_user  uuid;
  v_party uuid;
  v_msg   text;
  v_dur   integer;
begin
  insert into public.app_users (display_name) values ('__migration_pbd20_probe__')
    returning id into v_user;
  insert into public.parties (owner_user_id, name, visibility, default_capacity)
    values (v_user, '__migration_pbd20_probe__', 'private', 2)
    returning id into v_party;

  perform * from public.set_party_bosses(
    v_party, array['seren_extreme', 'kaling_hard'], array[20, 5]
  );

  -- (1) party_bosses: 21 은 거절, 20·5 는 통과, null 도 통과
  begin
    update public.party_bosses set duration_minutes = 21
     where party_id = v_party and boss_difficulty_id = 'kaling_hard';
    raise exception 'party_bosses 가 21분을 받았습니다 — 상한 20 이 걸리지 않았습니다.';
  exception
    when check_violation then null;  -- 기대한 거절
  end;
  update public.party_bosses set duration_minutes = 20
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';
  update public.party_bosses set duration_minutes = 5
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';
  update public.party_bosses set duration_minutes = null
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';
  begin
    update public.party_bosses set duration_minutes = 4
     where party_id = v_party and boss_difficulty_id = 'kaling_hard';
    raise exception 'party_bosses 가 4분을 받았습니다 — 하한 5 가 사라졌습니다.';
  exception
    when check_violation then null;
  end;

  -- (2) party_runs: **같은 경계**여야 한다. 한쪽만 조이면 조합이 갈라진다.
  begin
    insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
    values (v_party, 'kaling_hard', now(), 21);
    raise exception 'party_runs 가 21분을 받았습니다 — 두 표의 상한이 어긋납니다.';
  exception
    when check_violation then null;
  end;
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
  values (v_party, 'kaling_hard', now(), 20);
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
  values (v_party, 'kaling_hard', now() + interval '1 hour', 5);
  begin
    insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
    values (v_party, 'kaling_hard', now() + interval '2 hour', 4);
    raise exception 'party_runs 가 4분을 받았습니다 — 하한 5 가 사라졌습니다.';
  exception
    when check_violation then null;
  end;

  -- (3) ★ 컬럼 default 가 자기 CHECK 를 통과하는가 (3-1 이 없으면 여기서 터진다)
  insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at)
  values (v_party, 'kaling_hard', now() + interval '3 hour')
  returning duration_minutes into v_dur;
  if v_dur <> 20 then
    raise exception 'party_runs.duration_minutes 의 default 가 %분입니다 — 20 이어야 합니다.', v_dur;
  end if;

  -- (4) set_party_bosses 가 21 을 **한국어로** 거절하는가
  --     (영문 제약 위반까지 내려가면 앱이 500 으로 접는다 — 그 판정이 존재하는 이유다)
  begin
    perform * from public.set_party_bosses(
      v_party, array['seren_extreme', 'kaling_hard'], array[20, 21]
    );
    raise exception 'set_party_bosses 가 21분을 통과시켰습니다.';
  exception
    when check_violation then
      v_msg := sqlerrm;
      if v_msg not like '%5분에서 20분%' then
        raise exception 'set_party_bosses 의 거절 문구가 새 범위를 말하지 않습니다 (%).', v_msg;
      end if;
  end;

  -- (5) 좁은 경로도 같은 문구로 거절하는가
  begin
    perform * from public.set_party_boss_durations(
      v_party, array['seren_extreme'], array[21]::integer[]
    );
    raise exception 'set_party_boss_durations 가 21분을 통과시켰습니다.';
  exception
    when check_violation then
      v_msg := sqlerrm;
      if v_msg not like '%5분에서 20분%' then
        raise exception
          'set_party_boss_durations 의 거절 문구가 새 범위를 말하지 않습니다 (%).', v_msg;
      end if;
  end;

  -- (6) 경계 안의 값은 두 함수 모두 받는다 (조이기가 과하게 걸리지 않았는가)
  perform * from public.set_party_bosses(
    v_party, array['seren_extreme', 'kaling_hard'], array[5, 20]
  );
  perform * from public.set_party_boss_durations(
    v_party, array['seren_extreme'], array[20]::integer[]
  );
  select duration_minutes into v_dur
    from public.party_bosses
   where party_id = v_party and boss_difficulty_id = 'seren_extreme';
  if v_dur <> 20 then
    raise exception '경계 안의 값(20)이 저장되지 않았습니다 (%).', v_dur;
  end if;

  -- (7) `null`(정하지 않음)은 여전히 정상 입력이다 — 기본값으로 접히는 자리가 그것이다
  perform * from public.set_party_boss_durations(
    v_party, array['seren_extreme'], array[null]::integer[]
  );
  select duration_minutes into v_dur
    from public.party_bosses
   where party_id = v_party and boss_difficulty_id = 'seren_extreme';
  if v_dur is not null then
    raise exception 'null(정하지 않음)이 저장되지 않았습니다 (%).', v_dur;
  end if;

  raise exception '__migration_probe_rollback__';
exception
  when others then
    if sqlerrm = '__migration_probe_rollback__' then
      raise notice '소요 시간 상한 20분 자기검증 7항목 전부 통과 (탐침 되감음)';
    else
      raise;
    end if;
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 이 마이그레이션은 컬럼을 **더하지 않는다**(경계값·default·함수 본문만 바꾼다). 그래서
-- 새로 노출되는 민감 컬럼이 있을 수 없다. 그래도 호출을 생략하지 않는다 — 생략하는 습관이
-- 붙으면 다음 컬럼에서 걸린다(§0.3 의 요구가 그 습관을 막는 것이다).
select public.assert_no_public_sensitive_columns();
