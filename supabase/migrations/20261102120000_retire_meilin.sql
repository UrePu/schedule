-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 시즌이 끝난 **메이린을 은퇴시킨다** — 기록은 남고, 새로 들어오지 않는다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-11-02): *"메이린 시즌 끝났어 버려."*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 지금인가
-- ───────────────────────────────────────────────────────────────────────────────
-- 입장은 2026-09-16 에 끝났는데 `released` 가 true 로 남아 있었다. 시간별 동기화의 건너뛰기
-- 예외(`nightly-sync.ts` 의 `selectCandidates`)는 "released 인 시즌 보스를 이번 주에 아직 안
-- 잡았으면 부른다" 이므로, 더는 잡을 수 없는 보스 때문에 **12칸 찬 캐릭터가 영원히 "메이린
-- 남음"이 되어 매시 호출을 태웠다.** 면제 메커니즘 자체는 옳다 — 끝났다고 말해 주지 않았을 뿐이다.
-- 그 예외의 주석이 이 마이그레이션을 예고해 두었다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 시즌 보스의 `released = false` 는 "끝났다"는 뜻이다
-- ───────────────────────────────────────────────────────────────────────────────
-- 이 열은 미출시와 폐지를 함께 담는다(`BossCatalogEntry.released`). 새 칸을 만들지 않고
-- **`cycle = 'season' and not released`** 를 은퇴로 읽는다. 앱은 `isRetiredBoss()` 가,
-- 여기서는 아래 3번 함수가 같은 식을 쓴다. 일반 보스의 false 는 여전히 미출시이고 배지도 그대로다.
--
-- ⚠️ 대가: 출시 전에 미리 넣어 둔 시즌 보스도 끝난 것으로 읽힌다. 목록에 안 보이고 넥슨 계획도
--    받아 적지 않다가, `released = true` 로 출시하면 나타난다.
--
-- ★ 다음 시즌 보스를 보낼 때 필요한 것: 이 파일의 1·2·4번과 같은 마이그레이션 +
--   `scripts/gen-boss-master/lib/parse.ts` 의 `MANIFEST_FILES`·파싱 블록 + `pnpm boss-master`.
--   매니페스트를 빠뜨리면 생성기가 거부해 빌드가 실패한다. 3번 함수는 식이 일반적이라 다시
--   손대지 않는다.
--
-- ⚠️ 알려진 틈: 계획 화면은 끝난 보스의 행을 빼지만(`boss-plan-repo.ts` `withoutRetiredBosses`),
--    서버의 소요 시간 추정(`schedule-repo.ts` `loadCharacterBossMinutes` · 봇 `fetchRemainingBosses`)은
--    표를 직접 읽어 모집단이 갈릴 수 있다. 메이린은 그 값이 전부 null 이라 영향이 0 이다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 건드리지 않는 것 — 지난 기록이 그대로 읽혀야 한다
-- ───────────────────────────────────────────────────────────────────────────────
--   · `boss_clears` · `boss_crystal_prices` · `boss_aliases` · `party_runs`
--   · `party_bosses` — 얼린 표다(`20261016140000_party_bundles.sql` 8절). 지금 누구도 읽지
--     않고 첫 묶음 편집 이후의 내용은 멈춘 과거이므로 손대지 않는다.
--   · 넥슨 매핑(`bosses.nexon_content_name`) — 넥슨은 아직 `시즌 보스 메이린` 을 응답에
--     싣는다(실측 2026-11-02: 최근 3일 48명 전원, 두 난이도 모두 `registered=false`).
--     매핑을 끊으면 `nexon_unmapped_contents` 에 "새 보스"로 쌓인다. 매핑은 살려 둔다.
--
-- 넥슨 API 호출 없음. **재실행 안전**(이 저장소의 불변식).

-- 자기 검증이 "그대로"를 비교할 기준값. 건드리지 않는다는 주장을 숫자로 확인한다.
drop table if exists _meilin_before;
create temp table _meilin_before as
select (select count(*) from public.boss_clears
         where boss_difficulty_id in ('meilin_normal', 'meilin_hard')) as clear_count,
       (select coalesce(sum(crystal_share_meso), 0) from public.boss_clears
         where boss_difficulty_id in ('meilin_normal', 'meilin_hard')) as clear_meso,
       (select count(*) from public.boss_crystal_prices
         where boss_difficulty_id in ('meilin_normal', 'meilin_hard')) as price_rows,
       (select count(*) from public.boss_difficulties
         where not released and boss_id <> 'meilin') as other_unreleased;

-- ── 1. 마스터 ─────────────────────────────────────────────────────────────────
-- ★ `update ... bd ... from (values ...)` 형태인 것은 **상수 생성기가 읽는 앵커**이기
--   때문이다(`scripts/gen-boss-master`, 벨로나 출시와 같은 모양).
update public.boss_difficulties bd
   set released = v.released
  from (values
    ('meilin_normal', false),
    ('meilin_hard',   false)
  ) as v(id, released)
 where bd.id = v.id;

-- ── 2. 계획 — 지우지 않고 **묘비**를 세운다 ───────────────────────────────────
-- `is_active := coalesce(manual_active, api_registered, false)` 이므로 수동 값이 이긴다.
-- `manual_active = false` 는 이 제품이 이미 쓰는 "동기화가 되살리지 못하는 끄기"다
-- (`boss-plan-repo.ts` 의 `setCharacterBossPlan` · `plan-conflict.ts`). 행을 지우면 인원·소요
-- 시간을 잃고, 넥슨이 true 를 말하는 날 새 행으로 되살아난다.
--
-- ★ 켜진 행만 고르지 않는다. `manual_active is null` + `api_registered = false` 로 꺼져 있는
--   행은 넥슨 값 하나에 다시 켜질 수 있는 상태라, 같은 상태로 모은다. 이미 묘비가 있는 행은
--   그 사람이 끈 시각(`manual_set_at`)을 덮지 않는다.
-- 실측 2026-11-02: 8행 중 켜짐 4 · 묘비 없음 5 · 이미 묘비 3.
-- 켜진 4행은 전부 `api_registered = true` 관측이 시즌 중에 멈춘 행이다 — 그 캐릭터의 동기화가
-- 더 돌지 않으면 저절로 꺼질 길이 없었다.
update public.character_boss_plans p
   set manual_active = false,
       manual_set_at = now()
 where p.boss_difficulty_id in ('meilin_normal', 'meilin_hard')
   and p.manual_active is distinct from false;

-- ── 3. 동기화 — 묘비가 없는 캐릭터에 **새 행이 켜진 채로 생기는 길**을 막는다 ─
-- 묘비는 행이 있어야 선다. 동기화(`sync-scheduler.ts`)는 `registered = true` 를 보면 행이
-- 없어도 넣으므로, 계획이 없던 캐릭터는 `manual_active = null` 인 **켜진** 행을 새로 얻는다.
-- 오늘 넥슨은 전원 false 라 당장 일어나지는 않지만, 응답에 콘텐츠가 남아 있는 한 막아 둔다.
-- 넥슨 값을 계속 받아 적어도 쓸 곳이 없으므로 끝난 보스는 통째로 건너뛴다.
--
-- ★ 조인이 아니라 `not exists` 다. 모르는 id 를 지금처럼 FK 오류로 두어야 다른 보스의 동작이
--   한 글자도 바뀌지 않는다. 바뀐 것은 이 조건 하나뿐이고 나머지 본문은 그대로다.
-- ⚠️ 단건 함수(`sync_character_boss_plan`)는 호출하는 코드가 없어 두었다. 다시 쓰게 되면
--    같은 조건을 넣을 것.
create or replace function public.sync_character_boss_plans(
  p_character_id uuid,
  p_entries      jsonb,
  p_observed_at  timestamptz default now()
)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer;
begin
  with input as (
    select e.value ->> 'id'                                   as boss_difficulty_id,
           public.nexon_flag_to_boolean(e.value ->> 'flag')    as registered
      from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as e(value)
  ),
  valid as (
    /*
      해석 안 되는 플래그는 **그 줄만 버린다.** 단건 함수는 여기서 예외를 던지지만,
      배치에서 같은 짓을 하면 한 줄 때문에 나머지 열아홉 줄이 함께 죽는다.
      호출부(TS)가 이미 null 을 걸러 보내므로 실제로 이 필터에 걸릴 일은 없다.
    */
    select * from input i
     where i.boss_difficulty_id is not null
       and i.registered is not null
       -- 시즌이 끝난 보스는 받아 적지 않는다. 앱의 `isRetiredBoss()` 와 같은 식이다.
       and not exists (
         select 1 from public.boss_difficulties bd
          where bd.id = i.boss_difficulty_id
            and bd.cycle = 'season'
            and not bd.released
       )
  ),
  upserted as (
    insert into public.character_boss_plans
      (character_id, boss_difficulty_id, api_registered, api_observed_at)
    select p_character_id, v.boss_difficulty_id, v.registered, p_observed_at
      from valid v
    on conflict (character_id, boss_difficulty_id) do update
      set api_registered  = excluded.api_registered,
          api_observed_at = excluded.api_observed_at
      -- 단건 함수와 같은 방어: 순서가 뒤집힌 관측이 최신 관측을 덮지 못하게 한다.
      where public.character_boss_plans.api_observed_at is null
         or public.character_boss_plans.api_observed_at <= excluded.api_observed_at
    returning 1
  )
  select count(*)::integer into v_count from upserted;

  return coalesce(v_count, 0);
end;
$function$;

comment on function public.sync_character_boss_plans(uuid, jsonb, timestamptz) is
  '한 캐릭터의 계획을 배열로 한 번에 upsert 한다. 뒤집힌 관측 방어는 단건 함수와 동일. '
  '시즌이 끝난 보스(cycle=season, released=false)는 건너뛴다 — 넥슨이 true 를 말해도 새 행이 생기지 않는다.';

-- ── 4. 묶음 — 일정 생성이 끝난 보스로 런을 만들지 못하게 ─────────────────────
-- 일정은 묶음의 보스로 만들어지므로(§1.1.1) 여기 남아 있으면 런이 계속 생긴다.
-- 실측 2026-11-02: 1행. 보관된 파티의 보관된 묶음 `카인` 이고 그 묶음의 유일한 보스다.
-- 그 묶음은 보스 0개가 되며, 보관 상태라 화면에 나오지 않는다. 기존 런은 0건이다.
drop table if exists _meilin_bundles;
create temp table _meilin_bundles as
select distinct bundle_id from public.party_bundle_bosses
 where boss_difficulty_id in ('meilin_normal', 'meilin_hard');

delete from public.party_bundle_bosses
 where boss_difficulty_id in ('meilin_normal', 'meilin_hard');

-- 남은 보스의 차례를 1부터 다시 매긴다. `set_party_bundle_bosses` 가 지키는 불변식이고,
-- 사이를 비워 두면 다음 사람이 빈 번호를 뜻 있는 값으로 읽는다. 순서 자체는 바뀌지 않는다.
update public.party_bundle_bosses t
   set sort_order = r.rn
  from (
    select id,
           (row_number() over (partition by bundle_id
                               order by sort_order, boss_difficulty_id))::integer as rn
      from public.party_bundle_bosses
     where bundle_id in (select bundle_id from _meilin_bundles)
  ) r
 where t.id = r.id
   and t.sort_order <> r.rn;

-- ★ 부모의 `updated_at` 을 민다. 묶음 이행의 백필 가드가 `updated_at = created_at` 을 "한 번도
--   편집되지 않음"으로 읽으므로, 안 밀면 그 파일을 다시 돌릴 때 얼린 `party_bosses` 에서 메이린이
--   이 묶음으로 되살아난다(`set_party_bundle_bosses` 와 같은 이유).
update public.party_bundles
   set updated_at = now()
 where id in (select bundle_id from _meilin_bundles);

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_before   record;
  v_count    bigint;
  v_meso     numeric;
  v_char     uuid;
  v_written  integer;
  v_id       text;
begin
  select * into v_before from _meilin_before;

  select count(*) into v_count from public.boss_difficulties
   where id in ('meilin_normal', 'meilin_hard') and not released;
  if v_count <> 2 then
    raise exception '메이린 released=false 가 %건입니다(2건이어야 함).', v_count;
  end if;

  -- 번지면 그 보스가 조용히 "미출시"가 된다.
  -- ★ 0 이 아니라 **적용 직전 값**과 비교한다. 나중에 다른 보스가 미출시로 들어온 뒤 이 파일을
  --   다시 돌려도 예외로 되돌아가지 않아야 재실행 안전이 참이다.
  select count(*) into v_count from public.boss_difficulties
   where not released and boss_id <> 'meilin';
  if v_count <> v_before.other_unreleased then
    raise exception '메이린 밖의 released=false 가 %건 → %건으로 움직였습니다.',
      v_before.other_unreleased, v_count;
  end if;

  select count(*) into v_count from public.character_boss_plans
   where boss_difficulty_id in ('meilin_normal', 'meilin_hard') and is_active;
  if v_count > 0 then
    raise exception '켜진 메이린 계획이 %건 남았습니다.', v_count;
  end if;

  select count(*) into v_count from public.character_boss_plans
   where boss_difficulty_id in ('meilin_normal', 'meilin_hard')
     and manual_active is distinct from false;
  if v_count > 0 then
    raise exception '묘비 없는 메이린 계획이 %건 남았습니다.', v_count;
  end if;

  select count(*) into v_count from public.party_bundle_bosses
   where boss_difficulty_id in ('meilin_normal', 'meilin_hard');
  if v_count > 0 then
    raise exception '메이린이 묶음에 %건 남았습니다.', v_count;
  end if;

  -- ★ 지난 기록은 한 건도 움직이면 안 된다. 적용 시점의 값과 비교한다.
  select count(*), coalesce(sum(crystal_share_meso), 0) into v_count, v_meso
    from public.boss_clears
   where boss_difficulty_id in ('meilin_normal', 'meilin_hard');
  if v_count <> v_before.clear_count or v_meso <> v_before.clear_meso then
    raise exception '메이린 클리어가 움직였습니다: %건 %메소 → %건 %메소',
      v_before.clear_count, v_before.clear_meso, v_count, v_meso;
  end if;

  select count(*) into v_count from public.boss_crystal_prices
   where boss_difficulty_id in ('meilin_normal', 'meilin_hard');
  if v_count <> v_before.price_rows then
    raise exception '메이린 시세 행이 %건 → %건으로 움직였습니다.', v_before.price_rows, v_count;
  end if;

  -- 넥슨 매핑이 끊기면 미매핑 표에 "새 보스"로 쌓인다.
  select public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'hard', 'bossWeekly') into v_id;
  if v_id is distinct from 'meilin_hard' then
    raise exception '하드 메이린 매핑이 끊겼습니다: %', coalesce(v_id, '(null)');
  end if;

  -- ★ 3번의 주장을 실제로 부른다. 조건이 안 걸렸으면 여기서 행이 쓰이고, 예외로 전부 되돌아간다.
  select id into v_char from public.characters limit 1;
  if v_char is not null then
    select public.sync_character_boss_plans(
             v_char,
             '[{"id":"meilin_hard","flag":"true"},{"id":"meilin_normal","flag":"true"}]'::jsonb,
             now()
           ) into v_written;
    if v_written <> 0 then
      raise exception '동기화 함수가 끝난 보스를 %건 받아 적었습니다.', v_written;
    end if;
  end if;

  raise notice '메이린 은퇴 완료 — 클리어 %건 %메소 그대로', v_before.clear_count, v_before.clear_meso;
end $$;

drop table if exists _meilin_before;
drop table if exists _meilin_bundles;

select public.assert_no_public_sensitive_columns();
