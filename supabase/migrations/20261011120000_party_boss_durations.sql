-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 보스 소요 시간을 **파티 × 보스**에 저장한다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-10-11):
--   *"파티 보스 시간에대한 수정이 필요함. 일정 잡힐때도 한번 확인할수 있고 수정할수있어야
--     하고 한번 수정되면 저장되어 항상 이용되도록. 그리고 이 부분은 이미 잡혀있는 일정에서도
--     볼수있어야되고 수정할수있어야하며 파티관리에서도 확인 및 수정이 가능해야함"*
--
-- 그 전까지 보스별 소요 시간은 **저장소에 없었다.** 전역 상수 하나
-- (`src/lib/domain/run-grouping.ts` 의 `DEFAULT_RUN_MINUTES = 20`)가 전부였고,
-- `createPartyRuns` 가 i 번째 보스를 `시작 + 20분 × i` 에 놓았다. 하드 루시드와 노멀 자쿰이
-- 같은 20분이 걸린다는 뜻이 되는데, 그건 사실이 아니다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 `parties` 가 아니라 `party_bosses` 인가
-- ─────────────────────────────────────────────────────────────────────────────
-- 발주 지시가 "파티 **보스** 시간"이다. 파티에 한 값으로 두면 "이 파티는 보스당 40분"이
-- 되어, 익세 40분 · 노자쿰 10분을 함께 도는 묶음을 표현할 수 없다. 그리고 그 값은
-- **묶음 배치 간격**으로 쓰이므로(연달아 깔 때 i 번째 보스의 시작), 보스별 값이 아니면
-- 시간표에 그려지는 블록 길이가 계속 거짓말을 한다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★★ `null` = "정하지 않았다" 이며 **0 도 20 도 아니다** ★★
-- ─────────────────────────────────────────────────────────────────────────────
-- 0 이나 20 을 박아 넣으면 "기본값을 쓰는 중"과 "사용자가 20 을 골랐다"를 구분할 수 없게
-- 된다. 나중에 기본값을 25분으로 바꿀 때 전자는 따라와야 하고 후자는 따라오면 안 되는데,
-- 값으로는 그 둘이 같아서 어느 쪽인지 물어볼 데가 없다. §1.3 D4(*"null 은 모른다는 뜻이고
-- 0 이 아니다"*)와 같은 기조다. 코드 상수로 접는 자리는 TS 한 곳
-- (`DEFAULT_RUN_MINUTES`)이고, DB 는 "정해졌는가"만 기록한다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 상·하한은 `party_runs.duration_minutes` 와 **같은 값**이어야 한다
-- ─────────────────────────────────────────────────────────────────────────────
-- `party_runs_duration_minutes_check` 가 `between 5 and 600` 이다. 여기만 넓게 잡으면
-- **파티에는 저장되는데 그 값으로 런을 못 만드는 조합**이 생긴다 — 저장은 성공했다고 말한
-- 뒤 일정 등록이 거절되는, 사용자가 원인을 알 수 없는 실패다. 아래 자기검증이 두 표에
-- 601 을 넣어 보고 둘 다 거절하는지 실제로 확인한다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ 이 컬럼은 **의도적으로 비로그인에게 공개된다**
-- ─────────────────────────────────────────────────────────────────────────────
-- `party_bosses` 는 테이블 통째로 `grant select to anon, authenticated` 이므로
-- (마이그레이션 22 의 22-5), 새 컬럼은 **자동으로** 공개면에 올라간다. 그게 맞다:
-- 공개 파티의 시간표는 "이 묶음이 몇 시부터 몇 시까지인가"를 보여 주는 화면이고, 보스당
-- 소요 시간은 그 질문의 분모다. 민감값이 아니며(개인 수익·식별자·키가 아니다) 이름이
-- `assert_no_public_sensitive_columns()` 의 민감 패턴(share/meso/_bp/secret/hash/token/
-- api_key, 그리고 마이그레이션 13 이 더한 channel/room) 어디에도 걸리지 않는다 — 그래서 화이트리스트에 적을 것도 없다. §0.3 가 요구한
-- "의도된 노출임을 명시"가 이 문단이다. RLS 정책도 **새로 만들지 않는다**: 행 판정은
-- 마이그레이션 22 의 `party_bosses_public_select`(공개·비보관 파티만) 그대로이고, 새
-- 판정을 발명하면 공개 파티의 보스가 새거나 반대로 안 보인다.


-- -----------------------------------------------------------------------------
-- 1. 컬럼 + CHECK
-- -----------------------------------------------------------------------------
alter table public.party_bosses
  add column if not exists duration_minutes integer;

-- `add constraint if not exists` 가 없으므로 카탈로그를 직접 본다(재실행 가능해야 한다).
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'party_bosses'
       and c.conname = 'party_bosses_duration_minutes_check'
  ) then
    alter table public.party_bosses
      add constraint party_bosses_duration_minutes_check
      check (duration_minutes is null or (duration_minutes between 5 and 600));
  end if;
end
$$;

comment on column public.party_bosses.duration_minutes is
  '이 파티가 이 보스에 쓰는 시간(분). null = 정하지 않았다 — 0 도 20 도 아니며 앱이 코드 상수 '
  '(src/lib/domain/run-grouping.ts 의 DEFAULT_RUN_MINUTES)로 접는다. 그렇게 두는 이유는 '
  '"기본값을 쓰는 중"과 "사용자가 그 값을 골랐다"를 구분해야 나중에 기본값을 바꿀 때 전자만 '
  '따라오기 때문이다(§1.3 D4 와 같은 기조). 상·하한은 party_runs.duration_minutes 와 같은 '
  '5~600 이며, 다르면 파티에는 저장되는데 런을 못 만드는 조합이 생긴다.';


-- -----------------------------------------------------------------------------
-- 2. set_party_bosses — 서명이 바뀐다 (2-인자 → 3-인자)
-- -----------------------------------------------------------------------------
-- ★ 옛 2-인자 서명을 **떨어뜨린다.** 기본값 있는 3-인자와 공존하면 두 인자 호출이 두
--   후보에 모두 맞아 Postgres 가 `function is not unique` 로 거부한다. 떨어뜨리면 두 인자
--   호출(로스터 저장 경로)은 3-인자 + 기본값으로 그대로 간다 — 호출부를 고칠 필요가 없다.
--
-- ★★ `p_duration_minutes is null` = **기존 값을 보존한다** ★★
--   이게 이 마이그레이션의 핵심 동작이다. 보스 목록은 "전체 delete → insert" 로 교체되므로,
--   보존 장치가 없으면 **소요 시간을 담지 않은 저장 한 번**에 그 파티의 보스 시간이 통째로
--   null 로 돌아간다. 그리고 그런 저장은 **계약상 정상 입력**이다: `PUT /bosses` 는
--   `durationMinutes` 를 생략할 수 있고, 생략하는 호출자가 실재한다 — 보스 **목록**을
--   소유한 화면이 보스당 소요 시간까지 소유하지는 않기 때문이다(구성원 편집 창이 로스터와
--   보스 목록을 함께 저장한다는 사실이 `schedule-repo.setPartyBosses` 주석에 이미 적혀 있다).
--   그래서 delete **전에** `(boss_difficulty_id → duration_minutes)` 스냅샷을 떠서 insert
--   때 되돌린다. 목록에서 빠진 보스의 값은 함께 사라지고(그 보스를 안 도니까), 다시 넣으면
--   그때는 다시 null 에서 시작한다.
--
--   보존을 **DB 에 두는** 이유: delete→insert 사이를 버틸 수 있는 자리가 거기뿐이다.
--   호출자에게 "저장 전에 현재 값을 읽어 다시 실어 보내라"를 요구하면, 그 왕복을 빼먹은
--   경로가 조용히 값을 지운다 — 빼먹었는지는 아무 화면에도 나타나지 않는다.
--
-- ⚠️ **2026-10-11 정정 — 이 문단의 처음 근거는 틀린 코드 경로를 댔다.**
--   처음에는 *"로스터 저장 경로(`updatePartyRoster` → `writePartyBosses`)가 소요 시간을
--   모른다 / 보존하지 않으면 구성원 한 명 고칠 때마다 보스 시간이 전부 날아간다"* 고 적었다.
--   교차 검증 실측: **`updatePartyRoster` 는 `party_bosses` 를 한 번도 건드리지 않는다**
--   (정원·이름·`refreshPartyAutoName` 만 쓴다). `writePartyBosses` 의 호출부는
--   `setPartyBosses` 와 `createParty` 둘뿐이고, 후자는 새 파티라 보존할 값이 애초에 없다.
--   틀린 것은 **경로의 이름**이고, 값이 날아가는 사건 자체는 실재한다 — 날리는 주체가
--   `updatePartyRoster` 가 아니라 **같은 창이 따로 보내는 `PUT /bosses`** 다.
--   틀린 서술을 지우지 않고 남기는 이유: 다음 사람이 "보존은 쓸데없는 장치" 라고 판단하려
--   할 때 근거로 삼을 서술이 필요하다. 지우면 그 판단이 처음부터 다시 시작된다.
--
-- ★ 배열이 주어지면 **길이가 보스 배열과 같아야 한다.** 짧은 쪽을 조용히 맞추면 어느 보스의
--   시간인지 한 칸씩 어긋나고, 그 어긋남은 화면에 "익세 20분"처럼 그럴듯하게 그려져 아무도
--   알아채지 못한다. 그래서 예외다. 원소가 null 인 자리는 "그 보스는 정하지 않음"이다.
-- ★ 중복 id 는 여전히 **조용히 접는다.** 접힌 자리의 시간은 **첫 등장 자리의 값**을 쓴다 —
--   사용자가 같은 보스를 두 번 체크한 것이고, 뒤에 적은 값이 앞을 덮을 이유가 없다.
drop function if exists public.set_party_bosses(uuid, text[]);

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
     where d is not null and (d < 5 or d > 600);
    if v_bad is not null then
      raise exception '보스 소요 시간은 5분에서 600분 사이여야 합니다 (입력 %).', v_bad
        using errcode = 'check_violation';
    end if;
  end if;

  -- ★ 보존 스냅샷. **delete 보다 먼저** 떠야 한다(머리말).
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
  '기존 값을 지운다(생략과 정반대다). 권한 판정은 하지 않는다 — 호출 전에 앱이 파티 구성원임을 '
  '확인한다.';

revoke all on function public.set_party_bosses(uuid, text[], integer[]) from public;
revoke all on function public.set_party_bosses(uuid, text[], integer[]) from anon;
revoke all on function public.set_party_bosses(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_bosses(uuid, text[], integer[]) to service_role;


-- -----------------------------------------------------------------------------
-- 3. set_party_boss_durations — **소요 시간만** 쓰는 좁은 경로
-- -----------------------------------------------------------------------------
-- 발주 지시의 *"한번 수정되면 저장되어 항상 이용되도록"* 을 받는 자리다. 일정 등록 창이나
-- 일정 상세에서 소요 시간을 고치면 그 값이 파티에도 남아야 한다.
--
-- ★ 전체 교체 함수(`set_party_bosses`)를 부르지 않는다. 그 함수는 **목록**을 소유하므로,
--   시간만 고치려고 부르면 그 호출자가 보스 목록과 순서를 들고 있어야 한다. 일정 창은 들고
--   있지 않다 — 체크된 보스만 안다. 목록 교체로 둘러 가면 체크 안 한 보스가 조용히 지워진다.
-- ★ 그래서 이 함수는 **보스를 넣지도 지우지도, 순서를 바꾸지도 않는다.** 이미 그 파티에
--   등록된 보스의 `duration_minutes` 만 쓴다.
-- ★ 그 파티에 **없는 보스 id 는 조용히 무시한다.** `/boss-plans` 의 단건 등록은 파티 보스
--   목록에 없는 보스로도 런을 만들 수 있고(그 경로는 계획에서 보스를 직접 고른다), 그때
--   행을 새로 넣으면 **파티의 보스 목록과 자동 제목이 사용자가 하지 않은 변경으로 바뀐다.**
--   거절하지도 않는다 — 일정 등록은 성공해야 하고, 저장할 곳이 없다는 것은 실패가 아니다.
-- ★ 원소 null 은 **"정하지 않음으로 되돌린다"** 는 뜻이다(기본값 복귀). 앱은 사용자가
--   실제로 고른 값만 담아 보내므로, 이 경로로 모르는 값이 덮이는 일은 없다.
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
   where d is not null and (d < 5 or d > 600);
  if v_bad is not null then
    raise exception '보스 소요 시간은 5분에서 600분 사이여야 합니다 (입력 %).', v_bad
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
  '"정하지 않음으로 되돌린다". 배열 길이는 같아야 하며 다르면 예외다.';

revoke all on function public.set_party_boss_durations(uuid, text[], integer[]) from public;
revoke all on function public.set_party_boss_durations(uuid, text[], integer[]) from anon;
revoke all on function public.set_party_boss_durations(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_boss_durations(uuid, text[], integer[]) to service_role;


-- -----------------------------------------------------------------------------
-- 4. 자기검증 — 보존 규칙·길이 불일치·경계값·권한
-- -----------------------------------------------------------------------------
-- ⚠️ 마이그레이션 22 의 자기검증은 **옛 2-인자 서명**을 부른다. 그 파일은 이미 적용된
--    기록이라 고치지 않으므로(새 DB 에서는 3-인자 + 기본값으로 그대로 통한다), 바뀐 동작의
--    검증은 여기서 다시 한다.
do $$
declare
  v_user  uuid;
  v_party uuid;
  v_count integer;
  v_dur   integer;
  v_order text;
begin
  insert into public.app_users (display_name) values ('__migration_pbd_probe__')
    returning id into v_user;
  insert into public.parties (owner_user_id, name, visibility, default_capacity)
    values (v_user, '__migration_pbd_probe__', 'private', 2)
    returning id into v_party;

  -- (1) 서명이 하나뿐인가 (옛 2-인자가 남아 있으면 두 인자 호출이 모호해진다)
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_party_bosses';
  if v_count <> 1 then
    raise exception 'set_party_bosses 서명이 %개입니다 — 옛 2-인자가 남아 있으면 호출이 모호해집니다.', v_count;
  end if;

  -- (2) 권한: service_role 만
  if has_function_privilege('anon',
       'public.set_party_bosses(uuid,text[],integer[])', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.set_party_bosses(uuid,text[],integer[])', 'EXECUTE')
     or has_function_privilege('anon',
       'public.set_party_boss_durations(uuid,text[],integer[])', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.set_party_boss_durations(uuid,text[],integer[])', 'EXECUTE') then
    raise exception '보스 목록/시간 저장 함수가 공개 역할에 열려 있습니다.';
  end if;
  if not has_function_privilege('service_role',
       'public.set_party_bosses(uuid,text[],integer[])', 'EXECUTE')
     or not has_function_privilege('service_role',
       'public.set_party_boss_durations(uuid,text[],integer[])', 'EXECUTE') then
    raise exception 'service_role 에 실행 권한이 없습니다 — 앱의 쓰기 경로가 막힙니다.';
  end if;

  -- (3) 배열로 보스별 값을 넣는다
  perform * from public.set_party_bosses(
    v_party,
    array['seren_extreme', 'first_adversary_hard', 'kaling_hard'],
    array[40, 20, 30]
  );
  select string_agg(coalesce(duration_minutes::text, 'null'), ',' order by sort_order)
    into v_order
    from public.party_bosses where party_id = v_party;
  if v_order <> '40,20,30' then
    raise exception '보스별 소요 시간이 입력 순서대로 들어가지 않았습니다 (%).', v_order;
  end if;

  -- (4) ★ 핵심: `p_duration_minutes = null` 로 목록을 다시 교체해도 **값이 남는다**
  --     (로스터 저장 경로가 두 인자로 부르는 바로 그 호출이다)
  perform * from public.set_party_bosses(
    v_party,
    array['kaling_hard', 'seren_extreme', 'first_adversary_hard']
  );
  select string_agg(boss_difficulty_id || '=' || coalesce(duration_minutes::text, 'null'),
                    ' ' order by sort_order)
    into v_order
    from public.party_bosses where party_id = v_party;
  if v_order <> 'kaling_hard=30 seren_extreme=40 first_adversary_hard=20' then
    raise exception '두 인자 교체에서 소요 시간이 보존되지 않았습니다 (%).', v_order;
  end if;

  -- (5) 원소 null = 정하지 않음 (보존이 아니라 **지운다** — 배열을 줬다는 것은 전부 말했다는 뜻)
  perform * from public.set_party_bosses(
    v_party,
    array['kaling_hard', 'seren_extreme', 'first_adversary_hard'],
    array[30, null, 20]::integer[]
  );
  select duration_minutes into v_dur
    from public.party_bosses
   where party_id = v_party and boss_difficulty_id = 'seren_extreme';
  if v_dur is not null then
    raise exception '배열 원소 null 이 "정하지 않음"으로 들어가지 않았습니다 (%).', v_dur;
  end if;

  -- (6) 길이 불일치는 예외
  begin
    perform * from public.set_party_bosses(
      v_party, array['kaling_hard', 'seren_extreme'], array[30]::integer[]
    );
    raise exception '길이가 어긋난 입력이 통과했습니다 — 어느 보스의 시간인지 어긋납니다.';
  exception
    when check_violation then null;  -- 기대한 거절
  end;

  -- (7) 중복은 접히고, 접힌 자리는 **첫 등장**의 값
  perform * from public.set_party_bosses(
    v_party,
    array['kaling_hard', 'seren_extreme', 'kaling_hard'],
    array[35, 15, 55]::integer[]
  );
  select count(*) into v_count from public.party_bosses where party_id = v_party;
  select duration_minutes into v_dur
    from public.party_bosses
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';
  if v_count <> 2 or v_dur <> 35 then
    raise exception '중복 접기가 어긋났습니다 (행 %개, 하카 %분).', v_count, v_dur;
  end if;

  -- (8) 좁은 경로: 시간만 바뀌고 목록·순서는 그대로, 없는 보스는 무시
  perform * from public.set_party_boss_durations(
    v_party,
    array['seren_extreme', 'lotus_hard'],
    array[45, 90]::integer[]
  );
  select string_agg(boss_difficulty_id || '=' || coalesce(duration_minutes::text, 'null'),
                    ' ' order by sort_order)
    into v_order
    from public.party_bosses where party_id = v_party;
  if v_order <> 'kaling_hard=35 seren_extreme=45' then
    raise exception '좁은 경로가 목록을 건드렸거나 시간을 쓰지 못했습니다 (%).', v_order;
  end if;

  -- (9) 경계값: party_bosses 와 party_runs 의 상·하한이 **같아야 한다**
  begin
    update public.party_bosses set duration_minutes = 601
     where party_id = v_party and boss_difficulty_id = 'kaling_hard';
    raise exception 'party_bosses 가 601분을 받았습니다 — party_runs 상한(600)과 어긋납니다.';
  exception
    when check_violation then null;
  end;
  begin
    update public.party_bosses set duration_minutes = 4
     where party_id = v_party and boss_difficulty_id = 'kaling_hard';
    raise exception 'party_bosses 가 4분을 받았습니다 — party_runs 하한(5)과 어긋납니다.';
  exception
    when check_violation then null;
  end;
  update public.party_bosses set duration_minutes = 600
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';
  update public.party_bosses set duration_minutes = 5
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';
  update public.party_bosses set duration_minutes = null
   where party_id = v_party and boss_difficulty_id = 'kaling_hard';

  begin
    insert into public.party_runs (party_id, boss_difficulty_id, scheduled_at, duration_minutes)
    values (v_party, 'kaling_hard', now(), 601);
    raise exception 'party_runs 가 601분을 받았습니다 — 두 표의 상한이 어긋납니다.';
  exception
    when check_violation then null;
  end;

  delete from public.app_users where id = v_user;

  raise notice '보스별 소요 시간 자기검증 9항목 전부 통과';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- ⚠️ `party_bosses` 는 테이블 통째로 anon 에 select 가 열려 있어 **새 컬럼이 자동으로**
--    공개된다. 머리말에 적은 대로 그것이 의도이며, 이름이 민감 패턴에 걸리지 않으므로
--    화이트리스트 추가도 필요 없다. 그래도 호출을 생략하지 않는다 — 생략하는 습관이
--    붙으면 다음 컬럼에서 걸린다.
select public.assert_no_public_sensitive_columns();
