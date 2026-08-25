-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 동기화 왕복 줄이기 — **한 캐릭터에 RPC 수십 번**을 두 번으로
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 질문(2026-08-25): *"다 병렬로 하면안돼? 왜 순서대로함"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 병렬은 이미 하고 있고, 병목도 거기가 아니다
-- ───────────────────────────────────────────────────────────────────────────────
-- 키(자격증명)끼리는 이미 `Promise.all` 로 동시에 돈다. 같은 키 안에서만 직렬인데, 그 이유는
-- 넥슨의 **초당 5콜 제한이 키마다 걸리기** 때문이다(§1.1). 그런데 실측해 보니 그건 병목이
-- 아니었다 — **캐릭터당 넥슨 호출은 정확히 1건**이고, 나머지 시간은 전부 우리 DB 왕복이다.
--
--   실측 2026-08-25: 24캐릭 41.5초. 가장 긴 키가 6캐릭이므로 캐릭터당 ≈6.9초.
--   그 6.9초 안에 넥슨은 1번, Supabase 왕복은 **25번쯤** 들어 있다.
--
-- 그중 압도적 다수가 이 둘이었다. 캐릭터 하나가 돌 때마다:
--   · `nexon_resolve_boss_difficulty` — 보스 엔트리 **하나당 한 번** (동시성 8 → 파도 ~10회)
--   · `sync_character_boss_plan`      — 계획 **하나당 한 번**       (동시성 8 → 파도 ~2회)
--
-- 여기서 캐릭터를 더 병렬로 돌리면 왕복 수는 그대로인 채 **동시 커넥션만 늘어난다.**
-- 이미 키 8개 × 동시성 8 = 64개가 풀을 밀고 있어서, 더 밀면 오히려 느려진다.
-- 그래서 답은 "더 병렬로"가 아니라 **"왕복을 없앤다"** 이다.
--
-- ⚠️ 판정 규칙은 **여기(SQL)에 그대로 둔다.** 별칭·난이도 매핑을 TS 로 옮기면 웹과 봇이
--    서로 다른 규칙을 갖게 된다. 옮기는 것은 규칙이 아니라 **호출 횟수**다.

-- ── 1. 보스 매핑을 배열로 한 번에 ────────────────────────────────────────────
-- 단건 함수(`nexon_resolve_boss_difficulty`)는 **지우지 않는다.** 봇·수동 경로가 쓰고 있고,
-- 이 함수는 그 규칙을 재현하는 것이 아니라 **같은 조회를 반복**할 뿐이다.
create or replace function public.nexon_resolve_boss_difficulties(p_entries jsonb)
returns table (idx integer, boss_difficulty_id text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
begin
  for r in
    select (e.ord - 1)::integer as idx,
           btrim(e.value ->> 'name')  as content_name,
           e.value ->> 'difficulty'   as difficulty,
           e.value ->> 'cycle'        as cycle
      from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb))
             with ordinality as e(value, ord)
  loop
    idx := r.idx;

    -- 단건 함수와 **같은 조회**다. tier 가 null 이면 등호가 성립하지 않아 자연히 미매핑이 된다.
    select bd.id into boss_difficulty_id
      from public.boss_difficulties bd
      join public.bosses b on b.id = bd.boss_id
     where b.nexon_content_name = r.content_name
       and bd.difficulty = public.nexon_difficulty_to_tier(r.difficulty);

    -- 미매핑 기록은 **이 배치에서도 유지한다.** 새 보스가 나왔을 때 그것을 알아채는
    -- 유일한 경로라, 속도를 위해 떨어뜨리면 새 보스가 조용히 사라진다.
    if boss_difficulty_id is null then
      perform public.nexon_record_unmapped_content(r.content_name, r.difficulty, r.cycle);
    end if;

    return next;
  end loop;
end;
$function$;

comment on function public.nexon_resolve_boss_difficulties(jsonb) is
  '넥슨 boss_contents 배열을 한 번에 boss_difficulty_id 로 매핑한다. 입력 순서를 idx 로 돌려주며 '
  '미매핑은 단건 함수와 똑같이 nexon_unmapped_contents 에 기록한다.';

-- ── 2. 계획 동기화를 배열로 한 번에 ──────────────────────────────────────────
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
    select * from input
     where boss_difficulty_id is not null and registered is not null
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
  '한 캐릭터의 계획을 배열로 한 번에 upsert 한다. 뒤집힌 관측 방어는 단건 함수와 동일.';

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_single text;
  v_batch  text;
begin
  -- 단건과 배치가 **같은 답**을 내야 한다. 다르면 화면과 봇이 다른 보스를 가리킨다.
  select public.nexon_resolve_boss_difficulty('스우', 'hard', 'bossWeekly') into v_single;
  select b.boss_difficulty_id into v_batch
    from public.nexon_resolve_boss_difficulties(
           '[{"name":"스우","difficulty":"hard","cycle":"bossWeekly"}]'::jsonb) b
   where b.idx = 0;

  if v_single is distinct from v_batch then
    raise exception '단건(%)과 배치(%)의 매핑이 다릅니다.', v_single, v_batch;
  end if;
  if v_batch is null then
    raise exception '하드 스우가 매핑되지 않았습니다 — 조회 자체가 깨졌습니다.';
  end if;

  -- 순서 보존. idx 가 어긋나면 TS 쪽에서 엉뚱한 보스에 클리어가 붙는다.
  if (select count(*) from public.nexon_resolve_boss_difficulties(
        '[{"name":"스우","difficulty":"hard"},{"name":"루시드","difficulty":"hard"}]'::jsonb)
      where idx in (0, 1)) <> 2
  then
    raise exception '배치 매핑이 입력 순서를 보존하지 않습니다.';
  end if;

  raise notice '배치 RPC 준비 완료 — 단건과 결과 일치 확인';
end $$;

select public.assert_no_public_sensitive_columns();
