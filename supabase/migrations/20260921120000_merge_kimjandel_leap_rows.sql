-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 월드 리프로 갈라진 **킴잔델 두 행을 하나로 병합** + 월간 보스 중복 2건 정리
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 보고(2026-09-21): *"킴잔아델 << 검마가 두번찍히는걸로 보임"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 무슨 일이 있었나
-- ───────────────────────────────────────────────────────────────────────────────
-- 킴잔델(Lv285 아델)이 **챌린저스 → 엘리시움**으로 월드 리프를 했다. 리프는 ocid 와
-- world_name 을 **둘 다** 바꾸므로 `syncCredentialInventory` 의 두 조회(① ocid,
-- ② (이름, 월드))가 **모두 빗나간다**. 그 결과 2026-09-14 06:59 에 새로고침이
--   · 엘리시움 행을 **새로** 만들고(07231fdb…, created_at 2026-09-14 06:59:01)
--   · 챌린저스 행에 `missing_since` 를 찍어 **유령**으로 남겼다(364f87b2…, 2026-08-20 생성)
-- — 즉 한 캐릭터가 **두 행**이 되었다.
--
-- 새 행에는 9월 검은 마법사 이력이 없었다(이력은 전부 유령 쪽에 있다). 화면이 "안 깼다"고
-- 말하니 사용자가 다시 체크했고, 그래서 **하드 검은 마법사가 2026-09 에 두 번 계상**됐다:
--   · 유령 행  black_mage_hard / 2026-W36 / 2026-09-07 10:13 KST  (원래 기록)
--   · 생존 행  black_mage_hard / 2026-W37 / 2026-09-14 15:59 KST  (다시 체크한 것)
-- 검은 마법사는 **월간** 보스라 한 달에 한 번뿐이다. 주차가 다르니 `boss_clears_week_uniq`
-- (user_id, character_id, boss_difficulty_id, week_key) 에도 걸리지 않았다 — 유니크 제약이
-- 주차 단위라 **월간 보스의 월 중복은 원리상 못 막는다.**
--
-- 앞으로 갈라지는 것은 오늘 `src/features/auth/server/account.ts` 의 `matchWorldLeaps`
-- 가 막는다(같은 (user, 이름, 직업) 이면서 목록에서 사라진 행의 ocid·월드를 **이어 쓴다**).
-- **이 마이그레이션은 이미 갈라진 과거 데이터를 되돌리는 일회성 복구다.**
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 왜 survivor 가 **엘리시움** 행인가 (07231fdb…)
-- ───────────────────────────────────────────────────────────────────────────────
-- 데이터는 유령(엣 챌린저스 행) 쪽에 더 많다 — 클리어 39건 대 23건. 그런데도 남기는 쪽은
-- 엘리시움 행이다. 이유는 셋이고, 전부 "행 수"보다 무겁다:
--   ① **지금 넥슨이 돌려주는 캐릭터가 엘리시움 행이다.** ocid 가 살아 있고
--      `missing_since` 가 null 이며 `is_tracked = true` 다. 챌린저스 행의 ocid 는
--      영원히 조회 실패하는 죽은 값이다. 유령을 남기면 매시 :50 크론이 죽은 ocid 를
--      계속 부르거나, 되살리려고 ocid·월드를 덮어써야 한다 — 그건 병합이 아니라 조작이다.
--   ② **사람이 방금 내린 판단이 엘리시움 행에 있다.** 2026-09-21 01:31 에 찍힌
--      `lotus_extreme` 수동 ON(파티 2인) · `lotus_hard` 수동 OFF 가 그것이다.
--      유령 행에는 `manual_active` 가 **한 건도 없다**(전부 넥슨 값뿐).
--   ③ **앞으로 쌓일 기록이 전부 엘리시움 행에 붙는다.** 과거를 미래 쪽으로 옮기는 편이
--      옮기는 양은 많아도 옮긴 뒤가 조용하다.
-- 그래서 방향은 **유령 → 생존**이고, 반대가 아니다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 왜 `boss_clears.world_name` 은 덮지 않는가
-- ───────────────────────────────────────────────────────────────────────────────
-- 옮기는 클리어 39건의 `world_name` 은 **챌린저스 그대로 둔다.** 그 클리어는 실제로
-- 챌린저스에서 일어났기 때문이다. `boss_clears` 는 원장이고, 원장은 **일어난 일**을 적는다
-- — "이 캐릭터가 지금 어느 월드에 있나"는 `characters.world_name` 이 답하는 다른 질문이다.
-- 덮어쓰면 "엘리시움에서 8월에 깼다"는 **없었던 사실**이 기록으로 남고, 월드별로 보는
-- 화면·집계가 조용히 거짓말을 시작한다. 리프는 캐릭터의 현재를 바꿀 뿐 과거를 바꾸지 않는다.
-- (같은 이유로 `cycle` · `base_price_meso` · `crystal_share_meso` 등 스냅샷 칸도 손대지
--  않는다. `boss_clears_apply_state()` 는 `price_snapshotted_at` 이 이미 찍힌 행을
--  재스냅샷 대상으로 보존하므로, character_id 만 바꾸는 UPDATE 는 금액을 다시 계산하지
--  않는다 — 그게 이 UPDATE 가 수익 원장에 안전한 이유다.)
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ `character_boss_plans` 충돌 11건을 푸는 규칙
-- ───────────────────────────────────────────────────────────────────────────────
-- 두 행이 같은 보스 난이도를 들고 있는 경우가 11건이다(유령 15 · 생존 14 · 합집합 18).
-- `character_boss_plans_uniq (character_id, boss_difficulty_id)` 때문에 그대로 옮길 수 없다.
-- **원칙 하나**: 사람이 손으로 정한 값은 한 건도 사라지면 안 된다. 넥슨이 준 값은 다음
-- 동기화가 다시 채워 주지만, 사람의 선택은 다시 채워 줄 곳이 없다.
-- 남기는 행은 **생존 행**이고, 칸별로 이렇게 고른다:
--
--   · `manual_active` / `manual_set_at` — **`manual_set_at` 이 더 늦은 쪽.** 둘 중 하나만
--     있으면 있는 쪽이 이긴다(없는 쪽은 "판단한 적 없음"이라 이길 자격이 없다). 값과 시각은
--     `character_boss_plans_manual_pair` 때문에 **반드시 짝으로** 옮긴다.
--     실측: 유령 쪽 manual_active 는 15건 전부 null 이므로 오늘은 생존 값이 그대로 남는다.
--     그래도 규칙을 "최신 우선"으로 쓴 이유는, 이 파일이 **나중에** 돌 수도 있어서다.
--   · `api_registered` / `api_observed_at` — **`api_observed_at` 이 더 최신인 쪽.**
--     이쪽은 사람의 의사가 아니라 관측이고, 관측은 최신이 옳다(테이블 주석의 규칙 그대로).
--     실측: 생존 2026-09-20 > 유령 2026-09-11 이라 생존 값이 남는다. 역시 짝으로 옮긴다.
--   · `default_party_size` — **생존이 1(컬럼 DEFAULT)이고 유령이 1이 아니면 유령 값.**
--     마이그레이션 25(`…_default_party_size_one.sql`)가 null 을 1 로 접어 버려서 "미설정"과
--     "솔로로 돈다"를 값으로는 구분할 수 없다. 그래서 1 은 "사람이 안 건드렸을 수 있는 값"으로
--     보고 양보하고, 1 이 아닌 값은 **사람이 고친 값**으로 보아 지키는 쪽을 택했다. 잘못 골라도
--     피해가 작은 방향이다(1/n 분배의 n 이고, 사용자가 화면에서 바로 고칠 수 있다).
--     실측: 유령 15건 전부 1 이라 오늘은 아무 것도 바뀌지 않는다.
--   · `note` — `coalesce(생존, 유령)`. 사람이 쓴 글은 버리지 않는다(오늘은 양쪽 다 null).
--   · `is_active` / `has_conflict` / `user_id` — 손대지 않는다. **트리거 계산값**이라
--     UPDATE 한 번이면 위에서 고른 값으로 알아서 다시 계산된다.
--   · `created_at` — **생존 행의 값 그대로 둔다.** 이 행은 2026-09-14 에 생긴 행이 맞고,
--     그게 사실이다. 유령의 8월 날짜를 끌어오면 "이 행이 8월부터 있었다"는 없던 사실이 된다.
--
-- 충돌하지 않는 유령 쪽 4건(first_adversary_easy · guardian_angel_slime_chaos ·
-- meilin_hard · will_hard)은 그대로 생존 행으로 옮긴다. 병합 후 18건이 된다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 월간 중복 2건 — **나중에 찍힌 쪽**을 지운다 (발주자 결정 2026-09-21)
-- ───────────────────────────────────────────────────────────────────────────────
-- (a) 킴잔델 생존 행 · `black_mage_hard` · **2026-W37** (2026-09-14 15:59 KST 클리어)
--     위에서 설명한 "화면이 안 깼다고 해서 다시 체크한" 그 행이다. 같은 달의 진짜 기록은
--     유령 쪽 2026-W36 이고, 그 행은 이 파일이 생존 행으로 옮겨 준다.
--
-- (b) 메검메(28fcdf5e…) · `black_mage_extreme` · **2026-W35** (2026-08-31 23:58 KST)
--     ★ 근거 — 이것은 리프와 무관한 **별개의 입력 사고**다. 2026-09-01 01:06 UTC 에
--       6개 캐릭터의 월간 검마를 **한꺼번에** 손으로 입력하면서 전부 같은 시각
--       (2026-08-31 23:58 KST)을 찍었다. 그 6명 중 **메검메만** 이미 넥슨이 2026-08-17 에
--       잡아 둔 8월 기록(2026-W33, source=nexon_api)을 갖고 있었다. 그래서 메검메만
--       2026-08 에 두 건이 됐다. **나머지 5건은 그 달의 유일한 기록이라 정상 입력이며,
--       이 파일은 그 5건을 건드리지 않는다.**
--     남기는 쪽이 W33 인 이유: 넥슨이 관측한 실제 클리어이고 시각도 앞선다. 지우는 쪽은
--     사람이 나중에 일괄로 찍은 W35 다(= "나중에 찍힌 쪽을 지운다"와 같은 결론).
--
-- ⚠️ 두 삭제 모두 `id` 가 아니라 **(character_id, boss_difficulty_id, week_key)** 조건으로
--    건다. 그 셋은 `boss_clears_week_uniq` 에 들어 있어 최대 1행을 가리키고, 운영이 아닌
--    환경에서는 그냥 **0건 삭제로 조용히 지나간다.**
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 안전 장치
-- ───────────────────────────────────────────────────────────────────────────────
--   · 전체가 **DO 블록 하나 = 단일 문장**이다. 중간에 죽으면 통째로 롤백되고, 반쯤 병합된
--     상태는 남지 않는다.
--   · 하드코딩한 UUID 가 없는 환경(로컬·브랜치)에서는 **아무 일도 일어나지 않는다.**
--   · **두 번 돌려도 안전하다.** 두 번째에는 유령 행이 이미 없어 병합 구간을 건너뛰고,
--     삭제 구간은 0건이 된다.
--     ⚠️ 단 하나의 예외: 사용자가 **나중에** 킴잔델의 2026-W37 하드 검마를 진짜로 다시
--       체크한 뒤에 이 파일을 재실행하면, 1절이 그 새 기록을 지운다. 마이그레이션은 한 번만
--       도는 것이 전제이므로 방치하지만, 손으로 재실행할 일이 생기면 1절을 빼고 돌려라.
--   · 실측과 어긋나면(같은 사용자가 아니다 / 유령이 유령이 아니다 / 옮기지 못한 클리어가
--     남는다) **예외를 던져 전부 되돌린다.** 수익 원장이 걸린 작업이라 "일부만 성공"이
--     제일 나쁜 결과다.
--   · 스키마는 한 줄도 바꾸지 않는다. 순수 데이터 마이그레이션이다.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  -- 운영 DB 실측값(2026-09-21). 이 세 개가 이 파일의 유일한 하드코딩이며,
  -- 없는 환경에서는 그대로 no-op 가 된다.
  c_survivor constant uuid := '07231fdb-e8e7-40e4-bfcb-5ce8ee13d15a';  -- 킴잔델 · 엘리시움
  c_ghost    constant uuid := '364f87b2-a842-4470-8f9f-a2dcc3961428';  -- 킴잔델 · 챌린저스(유령)
  c_megeom   constant uuid := '28fcdf5e-bae8-4b99-9354-aa70682cd6ba';  -- 메검메

  v_surv     public.characters%rowtype;
  v_ghost    public.characters%rowtype;

  n_del_a    integer := 0;   -- (a) 킴잔델 W37 검마
  n_del_b    integer := 0;   -- (b) 메검메 W35 검마
  n_clears   integer := 0;   -- 옮긴 클리어
  n_snaps    integer := 0;   -- 옮긴 스냅샷
  n_snap_dup integer := 0;   -- 같은 날짜가 겹쳐 버린 스냅샷
  n_plan_mv  integer := 0;   -- 그대로 옮긴 계획
  n_plan_mg  integer := 0;   -- 값을 합친 계획
  n_plan_rm  integer := 0;   -- 합친 뒤 지운 유령 계획
  n_left     integer := 0;
  n_before   integer := 0;
  n_after    integer := 0;
begin
  -- ###########################################################################
  -- 1. 월간 중복 2건 삭제 — 병합과 **독립**이다(메검메는 리프와 무관하므로 먼저 돈다)
  -- ###########################################################################
  --
  -- (a) 를 먼저 지우는 것이 순서상 중요하다: 아래 2절이 유령의 2026-W36 검마를 생존 행으로
  --     옮기는데, 같은 달 두 건이 생존 행에 함께 있는 중간 상태를 애초에 만들지 않는다.
  --     (주차가 달라 유니크 제약에는 안 걸리지만, 중간 상태를 안 만드는 편이 읽기 쉽다.)

  delete from public.boss_clears
   where character_id       = c_survivor
     and boss_difficulty_id = 'black_mage_hard'
     and week_key           = '2026-W37';
  get diagnostics n_del_a = row_count;

  delete from public.boss_clears
   where character_id       = c_megeom
     and boss_difficulty_id = 'black_mage_extreme'
     and week_key           = '2026-W35';
  get diagnostics n_del_b = row_count;

  raise notice '[1] 월간 중복 삭제 — 킴잔델 black_mage_hard/2026-W37 %건, 메검메 black_mage_extreme/2026-W35 %건',
    n_del_a, n_del_b;

  -- ###########################################################################
  -- 2. 병합 — 두 행이 실제로 존재하고 예상한 모습일 때만
  -- ###########################################################################

  select * into v_surv  from public.characters where id = c_survivor;
  if not found then
    raise notice '[2] 생존 행(%)이 없습니다. 이 환경에는 병합할 것이 없어 건너뜁니다.', c_survivor;
    return;
  end if;

  select * into v_ghost from public.characters where id = c_ghost;
  if not found then
    raise notice '[2] 유령 행(%)이 없습니다. 이미 병합되었거나 이 환경에는 없습니다 — 건너뜁니다.', c_ghost;
    return;
  end if;

  -- ── 2-0. 가드 ─────────────────────────────────────────────────────────────
  -- 여기까지 왔다는 건 두 UUID 가 **둘 다** 있다는 뜻이고, 그건 사실상 운영 DB 라는 뜻이다.
  -- 그런데 모습이 실측과 다르다면 우리가 아는 그 상황이 아니다. 추측으로 진행하지 않고 멈춘다
  -- — 잘못 이으면 남의 수익 기록이 엉뚱한 캐릭터에 붙는, 되돌릴 수 없는 종류의 사고가 된다.
  if v_surv.user_id is distinct from v_ghost.user_id then
    raise exception '병합 중단: 두 행의 소유자가 다릅니다 (% vs %).', v_surv.user_id, v_ghost.user_id;
  end if;
  if v_surv.character_name is distinct from v_ghost.character_name
     or v_surv.character_class is distinct from v_ghost.character_class then
    raise exception '병합 중단: 이름·직업이 다릅니다 (%/% vs %/%).',
      v_surv.character_name, v_surv.character_class, v_ghost.character_name, v_ghost.character_class;
  end if;
  if v_ghost.missing_since is null then
    raise exception '병합 중단: 유령이라던 행(%)이 넥슨 목록에 살아 있습니다.', c_ghost;
  end if;
  if v_surv.missing_since is not null then
    raise exception '병합 중단: 생존이라던 행(%)이 넥슨 목록에서 사라져 있습니다.', c_survivor;
  end if;

  select count(*) into n_before from public.boss_clears
   where character_id in (c_survivor, c_ghost);
  raise notice '[2] 병합 시작 — % · % → % · % (병합 전 클리어 합계 %건)',
    v_ghost.character_name, v_ghost.world_name, v_surv.character_name, v_surv.world_name, n_before;

  -- ── 2-1. 클리어 재귀속 ────────────────────────────────────────────────────
  -- world_name 이 비어 있는 행이 혹시 있다면, **옮기기 전에** 유령의 월드로 채워 둔다.
  -- 안 그러면 `boss_clears_apply_state()` 가 빈 칸을 생존 캐릭터의 월드(엘리시움)로 채워
  -- "엘리시움에서 일어난 일"이라는 없던 사실을 만든다. (실측 0건이라 오늘은 no-op.)
  update public.boss_clears
     set world_name = v_ghost.world_name
   where character_id = c_ghost
     and world_name is null;

  -- 충돌이 없는 행만 옮긴다. 실측 0건이지만 "오늘 0건"에 기대지 않는다 —
  -- `boss_clears_week_uniq` 는 (user_id, character_id, boss_difficulty_id, week_key) 다.
  update public.boss_clears g
     set character_id = c_survivor
   where g.character_id = c_ghost
     and not exists (
       select 1
         from public.boss_clears s
        where s.character_id       = c_survivor
          and s.user_id            = g.user_id
          and s.boss_difficulty_id = g.boss_difficulty_id
          and s.week_key           = g.week_key
     );
  get diagnostics n_clears = row_count;

  -- 옮기지 못한 클리어가 남았다면 멈춘다. 유령 행을 지우는 순간 FK 가 ON DELETE SET NULL 로
  -- 그 행들의 character_id 를 null 로 만들어 버리는데, `user_id` 는 그대로 남아 **캐릭터
  -- 없는 수익**이 되어 합계에 계속 잡힌다. 그건 지금 고치려는 중복 계상과 같은 종류의 버그다.
  select count(*) into n_left from public.boss_clears where character_id = c_ghost;
  if n_left > 0 then
    raise exception '병합 중단: 옮기지 못한 클리어가 %건 남았습니다(주차·보스가 양쪽에 겹침). 수동 확인이 필요합니다.', n_left;
  end if;

  raise notice '[2-1] 클리어 %건을 생존 행으로 옮김 (world_name 은 일부러 그대로 둠)', n_clears;

  -- ── 2-2. 넥슨 스냅샷 재귀속 ───────────────────────────────────────────────
  -- `character_scheduler_snapshots_uniq (character_id, snapshot_at)`.
  update public.character_scheduler_snapshots g
     set character_id = c_survivor
   where g.character_id = c_ghost
     and not exists (
       select 1
         from public.character_scheduler_snapshots s
        where s.character_id = c_survivor
          and s.snapshot_at  = g.snapshot_at
     );
  get diagnostics n_snaps = row_count;

  -- 같은 날짜가 양쪽에 있으면 **생존 쪽을 남기고 유령 쪽을 버린다.** 이 테이블은 넥슨 응답의
  -- 읽기 전용 미러이고 같은 날짜면 같은 캐릭터의 같은 하루를 말하므로, 둘 중 무엇을 남겨도
  -- 사용자 데이터가 사라지지 않는다. 캐스케이드에 맡기지 않고 여기서 **명시적으로** 지우는
  -- 이유는 몇 건이 버려졌는지 로그에 남기기 위해서다. (실측 0건.)
  delete from public.character_scheduler_snapshots where character_id = c_ghost;
  get diagnostics n_snap_dup = row_count;

  raise notice '[2-2] 스냅샷 %건 이동, 날짜 겹침 %건 폐기', n_snaps, n_snap_dup;

  -- ── 2-3. 보스 계획 병합 ───────────────────────────────────────────────────
  -- 먼저 **충돌하는 11건의 값을 생존 행에 합친다.** 순서가 중요하다: 합치기 전에 유령 행을
  -- 지우면 합칠 값이 사라지고, 먼저 옮기려 하면 유니크 제약에 걸린다.
  -- (칸별 선택 규칙과 근거는 이 파일 머리말의 "충돌 11건을 푸는 규칙" 절에 적혀 있다.)
  update public.character_boss_plans s
     set manual_active =
           case when g.manual_set_at is not null
                 and (s.manual_set_at is null or g.manual_set_at > s.manual_set_at)
                then g.manual_active else s.manual_active end,
         manual_set_at =
           case when g.manual_set_at is not null
                 and (s.manual_set_at is null or g.manual_set_at > s.manual_set_at)
                then g.manual_set_at else s.manual_set_at end,
         api_registered =
           case when g.api_observed_at is not null
                 and (s.api_observed_at is null or g.api_observed_at > s.api_observed_at)
                then g.api_registered else s.api_registered end,
         api_observed_at =
           case when g.api_observed_at is not null
                 and (s.api_observed_at is null or g.api_observed_at > s.api_observed_at)
                then g.api_observed_at else s.api_observed_at end,
         -- 1 = 컬럼 DEFAULT = "사람이 안 건드렸을 수 있음" → 1 이 아닌 쪽에 양보한다.
         default_party_size =
           case when s.default_party_size = 1 and g.default_party_size <> 1
                then g.default_party_size else s.default_party_size end,
         note = coalesce(s.note, g.note)
    from public.character_boss_plans g
   where s.character_id       = c_survivor
     and g.character_id       = c_ghost
     and g.boss_difficulty_id = s.boss_difficulty_id;
  get diagnostics n_plan_mg = row_count;

  -- 값을 뽑아낸 유령 계획 행을 지운다(= 충돌했던 것들).
  delete from public.character_boss_plans g
   where g.character_id = c_ghost
     and exists (
       select 1
         from public.character_boss_plans s
        where s.character_id       = c_survivor
          and s.boss_difficulty_id = g.boss_difficulty_id
     );
  get diagnostics n_plan_rm = row_count;

  -- 남은 것은 생존 행에 없는 보스뿐이다. 그대로 옮긴다.
  update public.character_boss_plans
     set character_id = c_survivor
   where character_id = c_ghost;
  get diagnostics n_plan_mv = row_count;

  select count(*) into n_left from public.character_boss_plans where character_id = c_ghost;
  if n_left > 0 then
    raise exception '병합 중단: 옮기지 못한 보스 계획이 %건 남았습니다.', n_left;
  end if;

  raise notice '[2-3] 계획 — 값 합침 %건, 유령 중복 삭제 %건, 그대로 이동 %건', n_plan_mg, n_plan_rm, n_plan_mv;

  -- ── 2-4. 나머지 참조가 없는지 확인한 뒤 유령 캐릭터 행 삭제 ───────────────
  -- `characters.id` 를 보는 테이블은 6개이고, 위에서 3개(boss_clears ·
  -- character_boss_plans · character_scheduler_snapshots)를 다뤘다. 남은 셋은
  -- ON DELETE SET NULL 이라 **조용히 끊긴다** — 실측 0건이지만 확인하고 넘어간다.
  select (select count(*) from public.run_signups        where character_id = c_ghost)
       + (select count(*) from public.party_participants where character_id = c_ghost)
       + (select count(*) from public.chore_completions  where character_id = c_ghost)
    into n_left;
  if n_left > 0 then
    raise exception '병합 중단: 유령 행을 참조하는 신청·파티원·숙제 기록이 %건 있습니다. 먼저 옮겨야 합니다.', n_left;
  end if;

  delete from public.characters where id = c_ghost;
  raise notice '[2-4] 유령 캐릭터 행 삭제 — % · %', v_ghost.character_name, v_ghost.world_name;

  -- ── 2-5. 생존 행은 추적 대상으로 유지 ─────────────────────────────────────
  -- 실측상 이미 is_tracked = true 다. 그래도 명시한다 — 병합 결과로 이 캐릭터의 한 달치
  -- 기록이 전부 이 행에 모였는데 추적이 꺼져 있으면 매시 크론이 이 캐릭터를 빼먹는다.
  update public.characters
     set is_tracked = true, missing_since = null
   where id = c_survivor
     and (is_tracked is distinct from true or missing_since is not null);

  -- ── 2-6. 결과 ─────────────────────────────────────────────────────────────
  -- n_before 는 1절(중복 삭제) **뒤에** 센 양쪽 합계다. 그러니 n_after 와 같아야 정상이고,
  -- 다르면 어딘가에서 행이 새거나 사라진 것이다 — 그 사실이 로그에 바로 보이게 나란히 찍는다.
  select count(*) into n_after from public.boss_clears where character_id = c_survivor;
  if n_after <> n_before then
    raise exception '병합 중단: 클리어 수가 맞지 않습니다 (병합 전 양쪽 합계 %건 → 생존 행 %건).', n_before, n_after;
  end if;
  raise notice '[2-6] 병합 완료 — 생존 행 클리어 %건(= 중복 삭제 후 양쪽 합계 %건), 계획 %건, 스냅샷 %건',
    n_after,
    n_before,
    (select count(*) from public.character_boss_plans where character_id = c_survivor),
    (select count(*) from public.character_scheduler_snapshots where character_id = c_survivor);
end $$;

-- §0.3 필수 — RLS 는 행을 거르지 테이블 단위 GRANT 가 삼킨 **컬럼**을 거르지 못한다.
-- 이 파일은 스키마를 바꾸지 않지만, 호출을 빼는 순간 "이 마이그레이션만 예외"가 생긴다.
select public.assert_no_public_sensitive_columns();
