-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 계획의 클리어 판정을 **난이도가 아니라 보스로** 한다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-10-26): *"같은 보스의 다른 난이도를 도는 경우에도 그냥 클리어 처리
-- 해버려 설정 안한 사람 잘못이지"*
--
-- 예: 계획은 하드 카링인데 실제로 노멀 카링을 깼다. 지금까지 뷰는
--     `c.boss_difficulty_id = p.boss_difficulty_id` 로만 클리어를 찾아서, 하드 카링 계획이
--     주 내내 "미클리어"로 남았다 → `!숙제` 남은 보스·남은 금액·남은 시간, `/boss-status`
--     남은 목록, `/boss-plans` 체크리스트에 계속 떴다.
--
-- ── 도메인 근거 ────────────────────────────────────────────────────────────────
-- 주간·월간(·시즌) 보스는 **한 주기에 같은 보스의 한 난이도만** 깰 수 있다. 그러니
-- "같은 보스(`boss_id`) + **같은 주기(`cycle`)** 안의 아무 난이도 클리어"면 그 보스 계획은
-- 끝난 것이다.
--
-- ★ **주기도 같아야 한다.** 자쿰·매그너스·파풀라투스·피에르·반반·블러디퀸·벨룸은 한 보스
--   안에 일간 난이도와 주간 난이도가 섞여 있다(실측 7개 보스). 노멀 자쿰(일간)을 깼다고
--   카오스 자쿰(주간) 계획이 끝나지 않는다 — 인게임에서도 둘은 따로 들어간다.
-- ★ 시즌(메이린)은 자기 주기 하나뿐이라 노멀/하드끼리 그대로 묶인다. 초기화는 여전히
--   CASE 의 ELSE(주차)다 — 이 마이그레이션은 CASE 를 건드리지 않는다.
--
-- ── 고른 클리어 행 (계획 하나 → 클리어 하나) ─────────────────────────────────
-- 후보가 여럿이면 `effective_cleared` → **계획 난이도와 정확히 같은 것** → 최신 순.
-- 정확히 같은 클리어가 있으면 예전과 한 글자도 다르지 않은 행이 고른다.
--
-- ── 귀속 규칙 (클리어 하나 → 계획 **하나**) ───────────────────────────────────
-- 한 캐릭터가 같은 보스의 두 난이도를 다 계획해 두면(실측: 한 캐릭터의 림보·찬란한 흉성
-- 노멀+하드) 클리어 하나가 두 계획을 끝낸다. 둘 다 "완료"로 세면 완료 수·주간 현재 금액이
-- 이중이 된다. 그래서 **클리어 하나는 계획 하나에만 귀속한다.** 고르는 순서:
--
--     ① 활성 계획(`is_active`) 먼저 — 꺼 둔 계획이 귀속을 가져가면 켜 둔 계획이
--        "완료"로 세어지지 않는다
--     ② 클리어 난이도와 **정확히 같은** 계획
--     ③ 난이도가 높은 계획(`boss_difficulties.sort_order` 내림차순)
--     ④ `plan_id` (결정적 동점 처리)
--
-- 귀속받지 못한 같은 보스의 나머지 계획은 `cleared_by_sibling = true` — **"형제로 끝남"**:
--   · `is_cleared` 는 **true** 다 → 남은 목록·남은 금액·남은 시간에서 빠진다
--     (`NOT is_cleared` 로 거르는 기존 소비자가 그대로 맞다)
--   · 완료 수·현재 금액·12칸 격자의 체크로는 **세지 않는다**
--     (`is_cleared AND NOT cleared_by_sibling` — 진행 뷰도 이것을 쓴다)
--
-- ── 무엇이 바뀌지 않는가 ──────────────────────────────────────────────────────
-- · **수익.** 결정석 금액은 실제로 깬 난이도의 클리어 행(`boss_clears`)과 그 가격
--   스냅샷 그대로다. 이 뷰는 금액을 내지 않는다.
-- · **12칸 원장.** 실제 수익·12칸 카운터는 `boss_clears` 를 센다(계획을 세지 않는다).
-- · `planned_*` 는 여전히 **켜 둔 계획 수**다(13번째 켜기 가드가 그 숫자를 쓴다). 같은
--   보스를 두 난이도로 계획한 캐릭터는 `planned 2 · cleared 1 · remaining 0` 이 된다 —
--   두 번째 계획은 깰 수 없는 계획이므로 남은 것도, 한 것도 아니다.
--
-- ── 새 열 (맨 뒤에만 붙일 수 있다 — `create or replace view`) ───────────────────
--   `cleared_boss_difficulty_id` — 고른 클리어의 실제 난이도. "노멀로 완료" 표기 근거.
--   `cleared_by_sibling`         — 위 귀속 규칙에서 귀속받지 못했다.
-- 권한은 `create or replace` 가 보존한다(DROP 이 아니다) — 그래도 아래에서 다시 못박는다.
--
-- ── 같은 규칙을 쓰는 DB 함수 ──────────────────────────────────────────────────
-- `set_character_boss_plan_party_size` · `apply_plan_party_sizes_to_clears` 도 계획 인원을
-- 클리어에 적용할 때 정확한 난이도로만 맞췄다. 하드 카링 3인 계획에 노멀 카링 클리어가
-- 들어오면 1인으로 남아 수익이 3배가 된다. 같은 보스·같은 주기 계획으로 찾되 **정확한
-- 난이도 계획이 있으면 그것이 이긴다**(TS `loadPlanPartySizes` 와 같은 순서).
--
-- TS 쪽 같은 규칙: `src/lib/domain/same-boss-clear.ts` (보스 마스터 상수로 같은 판정).

create or replace view public.v_character_boss_plan_status as
 WITH base AS (
 SELECT p.id AS plan_id, p.user_id, p.character_id, ch.character_name, ch.world_name,
    p.boss_difficulty_id, bd.boss_id, bd.korean_name AS boss_display_name, bd.difficulty,
    bd.cycle, bd.max_party, bd.released, b.sort_order AS boss_sort_order,
    bd.sort_order AS difficulty_sort_order, p.is_active, p.manual_active, p.api_registered,
    p.api_observed_at, p.has_conflict, p.default_party_size,
        CASE
            WHEN p.manual_active IS NOT NULL AND p.api_registered IS NOT NULL THEN 'both'::text
            WHEN p.manual_active IS NOT NULL THEN 'manual'::text
            ELSE 'nexon_api'::text
        END AS origin,
    (bd.cycle = 'weekly'::boss_cycle AND bd.counts_toward_weekly_limit) AS counts_toward_weekly_limit,
    week_key(now()) AS week_key,
    COALESCE(bc.effective_cleared, false) AS is_cleared,
    bc.id AS clear_id, bc.cleared_at, bc.has_conflict AS clear_has_conflict,
    p.note, p.created_at, p.updated_at,
    bc.boss_difficulty_id AS cleared_boss_difficulty_id
   FROM character_boss_plans p
     JOIN characters ch ON ch.id = p.character_id
     JOIN boss_difficulties bd ON bd.id = p.boss_difficulty_id
     JOIN bosses b ON b.id = bd.boss_id
     LEFT JOIN LATERAL ( SELECT c.* FROM boss_clears c
          -- ★ 난이도가 아니라 **같은 보스 · 같은 주기**의 모든 난이도.
          JOIN boss_difficulties cd ON cd.id = c.boss_difficulty_id
          WHERE c.character_id = p.character_id
            AND cd.boss_id = bd.boss_id
            AND cd.cycle = bd.cycle
            AND CASE bd.cycle
                    WHEN 'monthly'::boss_cycle THEN date_trunc('month'::text, kst_date(c.cleared_at)::timestamp with time zone) = date_trunc('month'::text, kst_date(now())::timestamp with time zone)
                    WHEN 'daily'::boss_cycle THEN kst_date(c.cleared_at) = kst_date(now())
                    ELSE c.week_key = week_key(now())
                END
          ORDER BY c.effective_cleared DESC,
                   (c.boss_difficulty_id = p.boss_difficulty_id) DESC,
                   c.cleared_at DESC NULLS LAST
         LIMIT 1) bc ON true
 )
 SELECT plan_id, user_id, character_id, character_name, world_name,
    boss_difficulty_id, boss_id, boss_display_name, difficulty,
    cycle, max_party, released, boss_sort_order,
    difficulty_sort_order, is_active, manual_active, api_registered,
    api_observed_at, has_conflict, default_party_size, origin,
    counts_toward_weekly_limit, week_key, is_cleared,
    clear_id, cleared_at, clear_has_conflict,
    note, created_at, updated_at,
    cleared_boss_difficulty_id,
    /*
      ★ 귀속 규칙(머리말). 같은 클리어 행을 고른 계획끼리 순위를 매겨 1위만 그 클리어를
        "자기 완료"로 갖는다.
      ⚠️ PARTITION 에 `user_id` · `character_id` 를 넣은 것은 **성능 때문이다.** 창 함수가
         있는 하위 질의에는 PARTITION BY 에 든 열의 조건만 밀려 들어간다 — 화면은 언제나
         `user_id = …` 나 `character_id = …` 로 읽으므로 그 조건이 전체 계산 전에 걸린다.
         한 클리어는 한 캐릭터·한 사용자의 것이라 뜻은 `clear_id` 하나와 같다.
    */
    (is_cleared AND row_number() OVER (
        PARTITION BY user_id, character_id, clear_id
        ORDER BY is_active DESC,
                 (boss_difficulty_id = cleared_boss_difficulty_id) DESC,
                 difficulty_sort_order DESC,
                 plan_id
     ) > 1) AS cleared_by_sibling
   FROM base;

-- 원래부터 service_role 전용이다(마이그레이션 19-10). 다시 못박는다.
revoke all on public.v_character_boss_plan_status from anon, authenticated;

/*
  진행 뷰 — "완료" 는 **귀속받은 클리어만** 센다. 남은 것은 그대로 `NOT is_cleared`
  (형제로 끝난 계획은 남은 것도 아니다). 열 이름·순서는 그대로다.

  ★ **주간 칸 수는 보스 단위로 센다**(R4, 2026-10-26 재검증). 같은 보스를 노멀·하드 둘 다
    켜 두어도 게임은 한 주에 그 보스의 한 난이도만 들여보내므로 결정석 칸은 **1칸**이다.
    계획 수로 세면 12보스를 켠 캐릭터가 같은 보스 난이도 하나를 더 켰다고 `13/12` 초과
    경고가 뜨고, 13번째 켜기 가드는 칸을 하나도 더 먹지 않는 그 켜기를 막는다.
      · `planned_weekly` · `weekly_over_limit` · `weekly_slots_remaining` ·
        `remaining_weekly` · `planned_weekly_exempt` → `count(DISTINCT boss_id)`
      · `cleared_weekly` · `cleared_weekly_exempt` → 역시 `count(DISTINCT boss_id)`.
        귀속 규칙만으로는 보스당 1이 보장되지 않는다 — 원장에 같은 보스 클리어가 두 벌
        (노멀·하드 둘 다 켜짐)이면 두 계획이 각자 자기 클리어를 귀속받아 2로 세지고,
        `완료 + 남음 > 계획` 이 된다(F4). 보스 단위면 언제나 `완료 + 남음 = 계획`.
      · `*_total` 은 앱이 읽지 않는다(`boss-plan-repo` 가 계획 행에서 다시 센다) — 그대로.
    ⚠️ 남은 수: 같은 보스의 두 계획이 다 미클리어면 남은 1칸. 하나가 끝나면 다른 하나는
       형제로 끝나(`is_cleared = true`) 남은 0칸.
*/
create or replace view public.v_character_weekly_boss_progress as
 SELECT user_id, character_id, character_name, world_name, week_key,
    count(*) FILTER (WHERE is_active) AS planned_total,
    count(DISTINCT boss_id) FILTER (WHERE is_active AND counts_toward_weekly_limit) AS planned_weekly,
    count(*) FILTER (WHERE is_active AND cycle = 'daily'::boss_cycle) AS planned_daily,
    count(*) FILTER (WHERE is_active AND cycle = 'monthly'::boss_cycle) AS planned_monthly,
    count(*) FILTER (WHERE is_active AND is_cleared AND NOT cleared_by_sibling) AS cleared_total,
    count(DISTINCT boss_id) FILTER (WHERE is_active AND counts_toward_weekly_limit AND is_cleared AND NOT cleared_by_sibling) AS cleared_weekly,
    count(*) FILTER (WHERE is_active AND NOT is_cleared) AS remaining_total,
    count(DISTINCT boss_id) FILTER (WHERE is_active AND counts_toward_weekly_limit AND NOT is_cleared) AS remaining_weekly,
    count(*) FILTER (WHERE NOT is_active) AS inactive_total,
    count(*) FILTER (WHERE has_conflict) AS conflict_count,
    weekly_crystal_sell_limit() AS weekly_limit,
    count(DISTINCT boss_id) FILTER (WHERE is_active AND counts_toward_weekly_limit) > weekly_crystal_sell_limit() AS weekly_over_limit,
    GREATEST(weekly_crystal_sell_limit() - count(DISTINCT boss_id) FILTER (WHERE is_active AND counts_toward_weekly_limit), 0::bigint) AS weekly_slots_remaining,
    count(DISTINCT boss_id) FILTER (WHERE is_active AND cycle = 'season'::boss_cycle) AS planned_weekly_exempt,
    count(DISTINCT boss_id) FILTER (WHERE is_active AND cycle = 'season'::boss_cycle AND is_cleared AND NOT cleared_by_sibling) AS cleared_weekly_exempt
   FROM v_character_boss_plan_status s
  GROUP BY user_id, character_id, character_name, world_name, week_key;

revoke all on public.v_character_weekly_boss_progress from anon, authenticated;

-- ── 계획 인원 → 클리어 (같은 보스 · 같은 주기, 정확한 난이도 우선) ──────────────
/*
  계획 하나의 인원을 바꾸면 **그 계획이 인원을 정하는 이번 주 클리어**에 적용한다.
  예전: 정확한 난이도의 클리어만. 이제: 그것 + 같은 보스·같은 주기의 다른 난이도 클리어 중
  **그 난이도 자체의 계획이 없는 것**(정확한 난이도 계획이 있으면 그 계획이 이긴다 —
  TS `loadPlanPartySizes` 와 같은 순서). 나머지 조건(런 미연결 · 사람이 고친 인원 아님)은
  한 글자도 바꾸지 않았다.
*/
create or replace function public.set_character_boss_plan_party_size(p_character_id uuid, p_boss_difficulty_id text, p_party_size integer)
 returns uuid
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id   uuid;
  v_size integer;
begin
  v_size := coalesce(p_party_size, 1);

  if v_size < 1 or v_size > 24 then
    raise exception '파티 인원은 1명 이상 24명 이하여야 합니다 (입력: %).', p_party_size
      using errcode = 'check_violation';
  end if;

  update public.character_boss_plans
     set default_party_size = v_size
   where character_id       = p_character_id
     and boss_difficulty_id = p_boss_difficulty_id
  returning id into v_id;

  if v_id is null then
    raise exception '계획에 없는 보스입니다: % (캐릭터 %). 먼저 목록에 추가해 주세요.',
      p_boss_difficulty_id, p_character_id
      using errcode = 'no_data_found';
  end if;

  update public.boss_clears bc
     set party_size           = v_size,
         price_snapshotted_at = null
    from public.boss_difficulties cd, public.boss_difficulties pd
   where cd.id = bc.boss_difficulty_id
     and pd.id = p_boss_difficulty_id
     and bc.character_id = p_character_id
     and (
           bc.boss_difficulty_id = p_boss_difficulty_id
        or (    cd.boss_id = pd.boss_id
            and cd.cycle   = pd.cycle
            -- 그 난이도 자체의 계획이 있으면 그 계획의 인원이 이긴다.
            and not exists (select 1 from public.character_boss_plans q
                             where q.character_id = bc.character_id
                               and q.boss_difficulty_id = bc.boss_difficulty_id)
            -- 같은 보스 계획이 여럿이면 **한 계획만** 정한다(아래 apply 와 같은 순서).
            and p_boss_difficulty_id = (
                  select q.boss_difficulty_id
                    from public.character_boss_plans q
                    join public.boss_difficulties qd on qd.id = q.boss_difficulty_id
                   where q.character_id = bc.character_id
                     and qd.boss_id = cd.boss_id and qd.cycle = cd.cycle
                   order by q.is_active desc, qd.sort_order desc, q.id
                   limit 1)
           )
         )
     and bc.week_key           = public.week_key(now())
     and bc.run_id is null
     and not bc.party_size_manual
     and bc.party_size is distinct from v_size;

  return v_id;
end;
$function$;

create or replace function public.apply_plan_party_sizes_to_clears(p_character_id uuid, p_dry_run boolean default false)
 returns integer
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select bc.id as clear_id, pl.default_party_size as party_size
      from public.boss_clears bc
      join public.boss_difficulties cd on cd.id = bc.boss_difficulty_id
      -- ★ 같은 보스·같은 주기 계획 하나. 정확한 난이도 → 활성 → 높은 난이도 → id.
      join lateral (
             select p.default_party_size
               from public.character_boss_plans p
               join public.boss_difficulties pd on pd.id = p.boss_difficulty_id
              where p.character_id = bc.character_id
                and pd.boss_id = cd.boss_id
                and pd.cycle   = cd.cycle
              order by (p.boss_difficulty_id = bc.boss_difficulty_id) desc,
                       p.is_active desc, pd.sort_order desc, p.id
              limit 1
           ) pl on true
     where bc.character_id         = p_character_id
       and bc.run_id              is null          -- ② 런의 인원은 그 입장의 사실이다
       and bc.party_size_confirmed = false         -- ① 사람이 확인한 값은 이기지 못한다
       and pl.default_party_size  is not null      -- 미설정은 적용할 값이 없다
     order by bc.week_key, bc.boss_difficulty_id
  loop
    v_count := v_count + 1;
    if not coalesce(p_dry_run, false) then
      perform public.set_clear_party_size(r.clear_id, r.party_size);
    end if;
  end loop;

  return v_count;
end;
$function$;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_regress integer;
  v_cross   integer;
  v_double  integer;
  v_orphan  integer;
  v_balance integer;
begin
  /*
    ① 회귀 0 — 계획 난이도와 **정확히 같은** 이번 주기 클리어가 켜져 있는데 미클리어로
       나오는 계획이 있으면 안 된다. 그것이 예전 판정이고, 새 판정은 그 상위집합이다.
  */
  select count(*) into v_regress
    from public.v_character_boss_plan_status s
    join public.boss_clears c
      on c.character_id = s.character_id
     and c.boss_difficulty_id = s.boss_difficulty_id
     and c.effective_cleared
     and case s.cycle
           when 'monthly' then date_trunc('month', public.kst_date(c.cleared_at)::timestamptz)
                             = date_trunc('month', public.kst_date(now())::timestamptz)
           when 'daily'   then public.kst_date(c.cleared_at) = public.kst_date(now())
           else c.week_key = public.week_key(now())
         end
   where not s.is_cleared;
  if v_regress > 0 then
    raise exception '같은 난이도 클리어가 있는데 미클리어로 나오는 계획 %건 — 회귀입니다.', v_regress;
  end if;

  -- ② 다른 보스·다른 주기의 클리어로 끝난 계획이 있으면 안 된다.
  select count(*) into v_cross
    from public.v_character_boss_plan_status s
    join public.boss_difficulties cd on cd.id = s.cleared_boss_difficulty_id
   where s.is_cleared
     and (cd.cycle <> s.cycle or cd.boss_id <> s.boss_id);
  if v_cross > 0 then
    raise exception '다른 보스·다른 주기의 클리어로 끝난 계획 %건 — 매칭이 넓어졌습니다.', v_cross;
  end if;

  -- ③ 한 클리어가 **두 계획의 완료**로 세지면 안 된다(완료 수·현재 금액 이중).
  select count(*) into v_double from (
    select clear_id from public.v_character_boss_plan_status
     where is_cleared and not cleared_by_sibling
     group by clear_id having count(*) > 1
  ) d;
  if v_double > 0 then
    raise exception '두 계획에 동시에 귀속된 클리어 %건 — 귀속 규칙이 깨졌습니다.', v_double;
  end if;

  -- ④ 끝난 계획이 기대는 클리어에는 **반드시 귀속받은 계획이 하나** 있어야 한다.
  select count(*) into v_orphan from (
    select clear_id from public.v_character_boss_plan_status
     where is_cleared
     group by clear_id
    having count(*) filter (where not cleared_by_sibling) <> 1
  ) o;
  if v_orphan > 0 then
    raise exception '귀속받은 계획이 없는(또는 여럿인) 클리어 %건.', v_orphan;
  end if;

  /*
    ⑤ 주간 칸 셈이 맞물려야 한다 — 보스 단위로 `완료 + 남음 = 계획`(주간·시즌 각각).
       같은 보스의 계획들은 같은 클리어 후보를 보므로 한 보스가 완료이면서 남음일 수 없다.
  */
  select count(*) into v_balance
    from public.v_character_weekly_boss_progress p
    join (select character_id,
                 count(distinct boss_id) filter (where is_active and cycle = 'season' and not is_cleared) as remaining_season
            from public.v_character_boss_plan_status group by character_id) r
      on r.character_id = p.character_id
   where p.cleared_weekly + p.remaining_weekly <> p.planned_weekly
      or p.cleared_weekly_exempt + r.remaining_season <> p.planned_weekly_exempt;
  if v_balance > 0 then
    raise exception '완료 + 남음 ≠ 계획(주간)인 캐릭터 %명 — 칸 셈이 어긋났습니다.', v_balance;
  end if;

  raise notice '계획 클리어 판정 — 같은 보스·같은 주기의 아무 난이도, 클리어 하나는 계획 하나';
end $$;

select public.assert_no_public_sensitive_columns();
