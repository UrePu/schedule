-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 보스 한 판 소요 시간의 **하한을 5분 → 1분**으로 내린다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 원문(2026-10-21):
--   *"노말 대적자 1인을 잡을수있으면 하드 진힐라는 거의 1~2분 걸림."*
--
-- 2026-10-11 상한 마이그레이션(`20261011130000_party_boss_duration_max_20.sql`)이 하한 5분을
-- **알고 남겼다** — "1~3분에 끝나는 보스를 5분으로 올려 적어야 한다". 그 한계가 실제
-- 불만이 됐다. 1~2분 보스에 5분을 적으면 묶음 다섯 개에서 합이 15분 넘게 부풀고, 시간표가
-- 그만큼 거짓말을 한다. 0 은 계속 거절한다(0분 런은 그릴 자리도, 묶음을 이을 끝도 없다).
--
-- ⚠️ **바뀌는 것은 하한 하나다.** 상한 20 · 컬럼 default 20 · 함수 서명 · 보존 규칙 ·
--    중복 접기 · 길이 검사는 전부 그대로다. 함수 본문은 부분 수정이 불가능해 전문을
--    다시 적지만, `5` → `1` 과 한국어 문구의 숫자 외에는 **한 글자도 고치지 않았다**
--    (라이브 `md5(prosrc)` 가 원본 마이그레이션 본문과 같음을 2026-10-21 에 확인한 뒤,
--    그 본문에서 두 문자열만 치환해 만들었다).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ 경계가 박힌 DB 자리 **전부** — 라이브 `pg_constraint` · `pg_proc` 로 센 목록(2026-10-21)
-- ─────────────────────────────────────────────────────────────────────────────
--   CHECK 넷
--     ① `party_runs_duration_minutes_check`                         (2-1)
--     ② `party_bundle_bosses_duration_minutes_check`                (2-2)
--     ③ `character_boss_plans_duration_minutes_range`               (2-3)
--     ④ `party_bosses_duration_minutes_check` — 얼린 옛 표           (2-4)
--   한국어 판정이 있는 함수 셋
--     ⑤ `set_party_bundle_bosses(uuid, text[], integer[])`          (3-1)
--     ⑥ `set_party_bundle_boss_durations(uuid, text[], integer[])`  (3-2)
--     ⑦ `set_character_boss_plan_duration(uuid, text, integer)`     (3-3)
--   ⚠️ 2026-10-11 목록에 있던 `set_party_bosses` · `set_party_boss_durations` 는
--      `20261016140000_party_bundles.sql` 8절이 **이미 떨어뜨렸다**(라이브에도 없다).
--      여기서 되살리지 않는다 — 되살리면 얼린 `party_bosses` 에 쓰는 길이 다시 열린다.
--   ⚠️ ④ 를 굳이 내리는 이유: 쓰는 경로가 없어 실해는 없지만, 같은 뜻의 컬럼 경계가
--      표마다 다르면 다음에 이 목록을 세는 사람이 "어느 쪽이 맞나"를 다시 조사해야 한다.
--      되돌리기로 그 표를 다시 쓰게 되더라도 지금 경계로 깨어난다.
--   TS 쪽 주인은 `src/lib/domain/run-grouping.ts` 의 `RUN_DURATION_MIN` **한 곳**이다.
--   ⑤⑥⑦ 을 빼먹으면 화면이 받은 1분이 함수 판정에서 "5분에서 20분" 으로 거절된다 —
--   화면과 DB 가 다른 범위를 말하는, 사용자가 원인을 알 수 없는 실패다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 기존 행 · 과거 기록은 한 줄도 움직이지 않는다
-- ─────────────────────────────────────────────────────────────────────────────
-- 경계를 **넓히는** 변경이라 기존 행(전부 5 이상)은 새 CHECK 를 그대로 만족한다.
-- `update` 는 하나도 없다 — 이미 잡힌 런의 길이·수익·클리어는 그대로다. 그래도 아래 1 이
-- 다시 센다. 세는 범위는 **새** 경계 1~20 이다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 재실행 가능하다
-- ─────────────────────────────────────────────────────────────────────────────
-- CHECK 는 `drop constraint if exists` → `add`, 함수는 `create or replace`(서명 불변),
-- 권한은 매번 다시 못박는다. 자기검증(4)은 **아무 행도 쓰지 않는다** — 제약은 정의문을,
-- 함수는 쓰기 전에 끝나는 판정만 찌른다. 그래서 두 번 실행해도 결과가 같다.


-- -----------------------------------------------------------------------------
-- 1. 선검사 — 새 경계(1~20)를 벗어난 행이 있으면 한국어로 멈춘다
-- -----------------------------------------------------------------------------
do $$
declare
  v_runs    integer;
  v_bundles integer;
  v_plans   integer;
  v_old     integer;
begin
  select count(*) into v_runs
    from public.party_runs
   where duration_minutes < 1 or duration_minutes > 20;

  select count(*) into v_bundles
    from public.party_bundle_bosses
   where duration_minutes is not null
     and (duration_minutes < 1 or duration_minutes > 20);

  select count(*) into v_plans
    from public.character_boss_plans
   where duration_minutes is not null
     and (duration_minutes < 1 or duration_minutes > 20);

  select count(*) into v_old
    from public.party_bosses
   where duration_minutes is not null
     and (duration_minutes < 1 or duration_minutes > 20);

  if v_runs <> 0 or v_bundles <> 0 or v_plans <> 0 or v_old <> 0 then
    raise exception
      '소요 시간 1~20분을 벗어난 행이 있습니다 — party_runs %건, party_bundle_bosses %건, '
      'character_boss_plans %건, party_bosses %건. 기존 CHECK(5~20)가 있는 한 생길 수 없는 '
      '상태이므로 누가 제약을 우회했는지 먼저 확인해 주세요. 이 마이그레이션은 아무것도 '
      '바꾸지 않고 멈췄습니다.',
      v_runs, v_bundles, v_plans, v_old;
  end if;

  raise notice '선검사 통과 — 1~20 밖 행 0건 (party_runs / party_bundle_bosses / character_boss_plans / party_bosses)';
end
$$;


-- -----------------------------------------------------------------------------
-- 2. CHECK 넷을 1~20 으로
-- -----------------------------------------------------------------------------

-- 2-1. party_runs — 런 한 건 = 보스 한 판. `not null` 이라 null 분기가 없다.
alter table public.party_runs
  drop constraint if exists party_runs_duration_minutes_check;
alter table public.party_runs
  add constraint party_runs_duration_minutes_check
  check (duration_minutes between 1 and 20);

comment on column public.party_runs.duration_minutes is
  '이 런(= 보스 한 판)의 소요 시간(분). 1~20 이며(2026-10-11 상한 600→20 · 2026-10-21 하한 '
  '5→1) party_bundle_bosses · character_boss_plans 의 duration_minutes 와 같은 경계다. 묶어 '
  '도는 한 덩이의 길이는 행 하나가 아니라 이어지는 행들의 합으로 계산된다.';

-- 2-2. party_bundle_bosses — null = 정하지 않았다(계속 통과).
alter table public.party_bundle_bosses
  drop constraint if exists party_bundle_bosses_duration_minutes_check;
alter table public.party_bundle_bosses
  add constraint party_bundle_bosses_duration_minutes_check
  check (duration_minutes is null or (duration_minutes between 1 and 20));

comment on column public.party_bundle_bosses.duration_minutes is
  '이 묶음이 이 보스에 쓰는 시간(분). null = 정하지 않았다(0 도 20 도 아니다 — 앱이 '
  'src/lib/domain/boss-duration-estimate.ts 의 우선순위로 접는다). 상·하한 1~20 은 '
  'party_runs.duration_minutes 의 CHECK 와 **같은 경계**다(2026-10-21 하한 5→1). 다르면 '
  '묶음에는 저장되는데 런을 못 만드는 조합이 생긴다. 한 묶음의 길이는 이 값들의 합이다.';

-- 2-3. character_boss_plans — null = 기본값을 따른다(계속 통과).
alter table public.character_boss_plans
  drop constraint if exists character_boss_plans_duration_minutes_range;
alter table public.character_boss_plans
  add constraint character_boss_plans_duration_minutes_range
  check (duration_minutes is null or duration_minutes between 1 and 20);

comment on column public.character_boss_plans.duration_minutes is
  '이 캐릭터가 이 보스를 한 판 도는 데 걸리는 분(사람이 고친 값). '
  'null = 기본값을 따른다 — 기본값은 코드(boss-duration-estimate.ts)가 계산하며 행에 박지 않는다. '
  '우선순위: 묶음 값(party_bundle_bosses) > 이 값 > 전역 기본값 > 20. 범위 1~20(party_runs 와 같음, '
  '2026-10-21 하한 5→1).';

-- 2-4. party_bosses — 얼린 옛 표(쓰는 경로 없음). 경계만 맞춰 둔다(머리말 ④).
alter table public.party_bosses
  drop constraint if exists party_bosses_duration_minutes_check;
alter table public.party_bosses
  add constraint party_bosses_duration_minutes_check
  check (duration_minutes is null or (duration_minutes between 1 and 20));


-- -----------------------------------------------------------------------------
-- 3. 한국어 판정이 있는 함수 셋 — 경계와 문구의 숫자만 바뀐다
-- -----------------------------------------------------------------------------
-- ⚠️ 아래 세 본문은 `20261016140000_party_bundles.sql`(3-1 · 3-2) ·
--    `20261021130000_character_boss_plan_durations.sql`(3-3) 의 본문을 그대로 가져와
--    `< 5` → `< 1` 과 문구의 `5분` → `1분` 만 바꾼 것이다. 다른 줄을 "정리"하지 않았다.

-- 3-1. set_party_bundle_bosses
create or replace function public.set_party_bundle_bosses(
  p_bundle_id           uuid,
  p_boss_difficulty_ids text[],
  p_duration_minutes    integer[] default null
)
returns setof public.party_bundle_bosses
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
    raise exception '묶음에 등록할 수 있는 보스는 24개까지입니다 (입력 %개).', v_len
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
     where d is not null and (d < 1 or d > 20);
    if v_bad is not null then
      raise exception '보스 소요 시간은 1분에서 20분 사이여야 합니다 (입력 %).', v_bad
        using errcode = 'check_violation';
    end if;
  end if;

  -- ★ 보존 스냅샷. **delete 보다 먼저** 떠야 한다.
  select coalesce(jsonb_object_agg(boss_difficulty_id, duration_minutes), '{}'::jsonb)
    into v_kept
    from public.party_bundle_bosses
   where bundle_id = p_bundle_id
     and duration_minutes is not null;

  delete from public.party_bundle_bosses where bundle_id = p_bundle_id;

  if v_len > 0 then
    insert into public.party_bundle_bosses
           (bundle_id, boss_difficulty_id, sort_order, duration_minutes)
    select p_bundle_id,
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

  -- ★ 부모의 `updated_at` 을 민다. 이 파일의 백필 가드가 "생성 이후 편집되지 않은 묶음"을
  --   `updated_at = created_at` 으로 판정하므로, 이 한 줄이 재실행 안전을 성립시킨다.
  update public.party_bundles set updated_at = now() where id = p_bundle_id;

  return query
    select pbb.*
      from public.party_bundle_bosses pbb
     where pbb.bundle_id = p_bundle_id
     order by pbb.sort_order, pbb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_bundle_bosses(uuid, text[], integer[]) is
  '묶음의 보스 목록을 배열 순서대로 통째로 교체한다(원자적). 중복은 접고 sort_order 는 1부터 '
  '다시 매긴다. p_duration_minutes 가 null 이면 **기존 소요 시간을 보존한다** — 목록만 저장하는 '
  '호출이 계약상 정상이고, 보존이 없으면 그 저장마다 보스 시간이 전부 날아간다. 배열이 주어지면 '
  '길이가 보스 배열과 같아야 하며, 다르면 예외다. 원소 null 은 "정하지 않음"이라 기존 값을 '
  '지운다(생략과 정반대다). 범위는 1~20 이며(2026-10-21 하한 5→1) party_runs 와 같은 경계다. '
  '권한 판정은 하지 않는다.';

revoke all    on function public.set_party_bundle_bosses(uuid, text[], integer[]) from public;
revoke all    on function public.set_party_bundle_bosses(uuid, text[], integer[]) from anon;
revoke all    on function public.set_party_bundle_bosses(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_bundle_bosses(uuid, text[], integer[]) to service_role;


-- 3-2. set_party_bundle_boss_durations
create or replace function public.set_party_bundle_boss_durations(
  p_bundle_id           uuid,
  p_boss_difficulty_ids text[],
  p_duration_minutes    integer[]
)
returns setof public.party_bundle_bosses
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_ids  text[]  := coalesce(p_boss_difficulty_ids, '{}'::text[]);
  v_len  integer := coalesce(array_length(v_ids, 1), 0);
  v_dlen integer := coalesce(array_length(p_duration_minutes, 1), 0);
  v_bad  integer;
begin
  if v_dlen <> v_len then
    raise exception
      '보스 %개에 소요 시간 %개가 들어왔습니다 — 길이가 같아야 어느 보스의 시간인지 정해집니다.',
      v_len, v_dlen
      using errcode = 'check_violation';
  end if;

  if v_len = 0 then
    return query
      select pbb.* from public.party_bundle_bosses pbb
       where pbb.bundle_id = p_bundle_id
       order by pbb.sort_order, pbb.boss_difficulty_id;
    return;
  end if;

  select min(d) into v_bad
    from unnest(p_duration_minutes) as t(d)
   where d is not null and (d < 1 or d > 20);
  if v_bad is not null then
    raise exception '보스 소요 시간은 1분에서 20분 사이여야 합니다 (입력 %).', v_bad
      using errcode = 'check_violation';
  end if;

  update public.party_bundle_bosses pbb
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
   where pbb.bundle_id = p_bundle_id
     and pbb.boss_difficulty_id = d.id;

  -- 백필 가드가 보는 비트(9-2 머리말).
  update public.party_bundles set updated_at = now() where id = p_bundle_id;

  return query
    select pbb.*
      from public.party_bundle_bosses pbb
     where pbb.bundle_id = p_bundle_id
     order by pbb.sort_order, pbb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) is
  '이미 그 묶음에 등록된 보스의 소요 시간만 쓴다. 보스를 넣거나 지우거나 순서를 바꾸지 않으며, '
  '그 묶음에 없는 보스 id 는 조용히 무시한다(일정 등록을 실패시키지 않기 위해서다). 원소 null 은 '
  '"정하지 않음으로 되돌린다". 배열 길이는 같아야 하며 다르면 예외다. 범위는 1~20 이다 '
  '(2026-10-21 하한 5→1).';

revoke all    on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) from public;
revoke all    on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) from anon;
revoke all    on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) to service_role;


-- 3-3. set_character_boss_plan_duration
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
     and (p_duration_minutes < 1 or p_duration_minutes > 20) then
    raise exception '소요 시간은 1분 이상 20분 이하여야 합니다 (입력: %).', p_duration_minutes
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
  '켜기/끄기·넥슨 값에 손대지 않는다. 계획에 없는 보스면 no_data_found, 범위(1~20) 밖이면 check_violation.';

revoke all on function public.set_character_boss_plan_duration(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.set_character_boss_plan_duration(uuid, text, integer)
  to service_role;


-- -----------------------------------------------------------------------------
-- 4. 자기검증 — 행을 하나도 쓰지 않는다
-- -----------------------------------------------------------------------------
-- 제약은 **정의문**으로 확인한다(탐침 행을 넣으려면 부모 행 여러 종을 만들어야 하고, 그
-- 흔적이 재실행을 막을 수 있다). 함수는 **쓰기 전에 끝나는 판정**만 찌른다:
--   · 0 · 21 → check_violation + 한국어 "1분" 문구
--   · 1 · 20 → 판정을 통과한다(없는 묶음 id 라 update 0행 / 없는 계획이라 no_data_found)
do $$
declare
  v_def   text;
  v_msg   text;
  v_n     integer;
  v_probe uuid := '00000000-0000-0000-0000-00000000f100';
begin
  -- (1) 제약 넷이 있고, 정의문이 1~20 이다
  select count(*) into v_n
    from pg_constraint c
   where (c.conrelid, c.conname) in (
           ('public.party_runs'::regclass,           'party_runs_duration_minutes_check'),
           ('public.party_bundle_bosses'::regclass,  'party_bundle_bosses_duration_minutes_check'),
           ('public.character_boss_plans'::regclass, 'character_boss_plans_duration_minutes_range'),
           ('public.party_bosses'::regclass,         'party_bosses_duration_minutes_check'));
  if v_n <> 4 then
    raise exception '소요 시간 CHECK 가 %개입니다 — 4개여야 합니다.', v_n;
  end if;

  for v_def in
    select pg_get_constraintdef(c.oid)
      from pg_constraint c
     where (c.conrelid, c.conname) in (
             ('public.party_runs'::regclass,           'party_runs_duration_minutes_check'),
             ('public.party_bundle_bosses'::regclass,  'party_bundle_bosses_duration_minutes_check'),
             ('public.character_boss_plans'::regclass, 'character_boss_plans_duration_minutes_range'),
             ('public.party_bosses'::regclass,         'party_bosses_duration_minutes_check'))
  loop
    if v_def not like '%duration_minutes >= 1)%' or v_def not like '%duration_minutes <= 20)%' then
      raise exception '소요 시간 CHECK 가 1~20 이 아닙니다: %', v_def;
    end if;
  end loop;

  -- (2) 남은 함수 어디에도 옛 하한(`< 5`) 판정이 없다
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc like '%duration%'
     and (p.prosrc like '%d < 5 %' or p.prosrc like '%p_duration_minutes < 5 %');
  if v_n <> 0 then
    raise exception '옛 하한 5분 판정이 남은 함수가 %개 있습니다.', v_n;
  end if;

  -- (3) 함수 셋이 0 과 21 을 **한국어로** 거절한다
  foreach v_n in array array[0, 21] loop
    begin
      perform * from public.set_party_bundle_bosses(v_probe, array['probe'], array[v_n]);
      raise exception 'set_party_bundle_bosses 가 %분을 통과시켰습니다.', v_n;
    exception when check_violation then
      v_msg := sqlerrm;
      if v_msg not like '%1분에서 20분%' then
        raise exception 'set_party_bundle_bosses 의 거절 문구가 새 범위를 말하지 않습니다 (%).', v_msg;
      end if;
    end;

    begin
      perform * from public.set_party_bundle_boss_durations(v_probe, array['probe'], array[v_n]);
      raise exception 'set_party_bundle_boss_durations 가 %분을 통과시켰습니다.', v_n;
    exception when check_violation then
      v_msg := sqlerrm;
      if v_msg not like '%1분에서 20분%' then
        raise exception 'set_party_bundle_boss_durations 의 거절 문구가 새 범위를 말하지 않습니다 (%).', v_msg;
      end if;
    end;

    begin
      perform public.set_character_boss_plan_duration(v_probe, 'probe', v_n);
      raise exception 'set_character_boss_plan_duration 이 %분을 통과시켰습니다.', v_n;
    exception when check_violation then
      v_msg := sqlerrm;
      if v_msg not like '%1분 이상 20분 이하%' then
        raise exception 'set_character_boss_plan_duration 의 거절 문구가 새 범위를 말하지 않습니다 (%).', v_msg;
      end if;
    end;
  end loop;

  -- (4) 1 과 20 은 판정을 통과한다
  foreach v_n in array array[1, 20] loop
    -- 없는 묶음 → update 0행, 예외 없음.
    perform * from public.set_party_bundle_boss_durations(v_probe, array['probe'], array[v_n]);

    -- 없는 계획 → 범위 판정을 지나 no_data_found 에서 멈춰야 한다(check_violation 이면 실패).
    begin
      perform public.set_character_boss_plan_duration(v_probe, 'probe', v_n);
      raise exception 'set_character_boss_plan_duration 이 없는 계획에 %분을 썼습니다.', v_n;
    exception
      when no_data_found then null;
      when check_violation then
        raise exception 'set_character_boss_plan_duration 이 %분을 범위 밖으로 거절했습니다.', v_n;
    end;
  end loop;

  raise notice '소요 시간 하한 1분 자기검증 통과 — CHECK 4 · 함수 3 (0·21 거절 / 1·20 통과)';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 컬럼을 더하지 않는다(경계값·주석·함수 본문만). 그래도 호출을 생략하지 않는다.
select public.assert_no_public_sensitive_columns();
