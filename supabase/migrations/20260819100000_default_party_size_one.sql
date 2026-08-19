-- =============================================================================
-- M_Schedule · 25. 파티 인원의 **기본값을 1인으로 확정**한다
-- =============================================================================
-- 발주자 지시(2026-08-19): *"그냥 1인을 기본으로 잡아 굳이 1이라고 설정안하게"*
--
-- ── 무엇이 바뀌는가 ─────────────────────────────────────────────────────────
-- 마이그레이션 21 은 **"미설정(null)"과 "1인으로 정함"을 다른 상태로** 두었다.
-- 그 구분이 화면에서 하는 일은 하나였다 — 인원을 한 번도 정하지 않은 클리어에
-- `party_size_confirmed = false` 를 물려주어 수익 화면이 **"⚠ 확인 필요"** 배지를 띄우는 것.
--
-- 발주자는 그 구분 자체를 없애기로 했다. 이제:
--
--     default_party_size is null  ──삭제──▶  default_party_size = 1 (NOT NULL DEFAULT 1)
--     "정하지 않음"               ──────▶  **"1인으로 확정"**
--
-- 아무것도 하지 않은 보스는 **1인 확정**으로 취급하며, 경고를 띄우지 않는다.
--
-- ── ⚠️ 이 결정이 감수하는 대가 (§1.3 D3) ────────────────────────────────────
-- **실제로는 파티로 도는 보스인데 인원을 설정하지 않으면, 아무 경고 없이 1인(솔로가)으로
-- 계산되어 결정석 수익이 최대 6배 과대 계상된다.** §1.3 D3 이 경고하던 바로 그 지점이고,
-- 마이그레이션 21 이 null 을 남겨 둔 이유가 정확히 이것이었다.
--
-- 그 위험을 **알고** 내린 발주자 결정이다. 경고 한 번 없이 틀린 숫자를 보는 쪽보다
-- 매번 "확인 필요"를 보는 쪽이 더 성가시다는 판단이며, 되돌리려면 이 파일을 되짚어
-- 컬럼을 다시 nullable 로 만들면 된다. 다시 논의하지 말 것 — 결정은 내려졌다.
--
-- ── 무엇을 건드리지 **않는가** ──────────────────────────────────────────────
--   · `run_id` 가 붙은 클리어. 그쪽 인원은 런의 `going` 신청 수에서 나오는 **별개 경로**이고
--     (§1.3 D3), 여기서 손대면 일정 기능이 조용히 깨진다.
--   · `party_size <> 1` 인데 `party_size_confirmed = false` 인 행. 그건 "기본값 1"과 무관한
--     별개 상태다 — 누군가 1 이 아닌 값을 넣었는데 확인 비트는 안 올라간 행이므로,
--     "1인 기본값 확정"의 근거로 확인됨 처리할 수 없다. (적용 시점 실측: 0건)
--   · INSERT 트리거 `boss_clears_apply_state()` 의 확인 비트 유도식. 넥슨 관측 클리어를
--     만드는 코드 경로는 `sync-scheduler.ts` **하나뿐**이고 그쪽이 이제 `true` 를 명시로
--     싣는다(트리거의 `coalesce(new.party_size_confirmed, false) or …` 첫 항이 존중한다).
--     트리거의 보수적 기본값을 남겨 두면 앞으로 다른 경로가 생겼을 때 신호가 살아 있다.
--
-- 넥슨 API 호출 없음. 재실행 안전(idempotent).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 25-1. character_boss_plans.default_party_size → NOT NULL DEFAULT 1
-- -----------------------------------------------------------------------------
-- 순서가 중요하다: 백필 → DEFAULT → NOT NULL. 순서를 바꾸면 기존 null 행에서 죽는다.

-- (a) 백필. 재실행 시 대상이 0건이라 무동작이다.
update public.character_boss_plans
   set default_party_size = 1
 where default_party_size is null;

-- (b) 기본값. 이제 계획 행이 생기는 순간부터 1인이다.
alter table public.character_boss_plans
  alter column default_party_size set default 1;

-- (c) NOT NULL. "미설정"이라는 상태를 **타입 수준에서** 없앤다 — 코드가 null 을 다시
--     만들 길이 없어야 화면·서버·봇이 같은 규칙을 쓴다.
alter table public.character_boss_plans
  alter column default_party_size set not null;

-- (d) 범위 CHECK 를 새 의미로 다시 만든다. 예전 식(`is null or between 1 and 24`)은
--     NOT NULL 아래에서 틀리지는 않지만, 이제 존재할 수 없는 상태를 허용한다고 적혀 있어
--     **문서가 코드와 어긋난다.** §1.3 D5 대로 `max_party` 는 여기서도 막지 않는다.
do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conname  = 'character_boss_plans_default_party_size_range'
       and conrelid = 'public.character_boss_plans'::regclass
  ) then
    alter table public.character_boss_plans
      drop constraint character_boss_plans_default_party_size_range;
  end if;

  alter table public.character_boss_plans
    add constraint character_boss_plans_default_party_size_range
    check (default_party_size between 1 and 24);
end
$$;

-- (e) COMMENT. 예전 문장은 "null = 미설정이고 1 과는 다른 상태"라고 말한다. 그 문장을
--     지우지 않으면 스키마 문서가 코드와 정확히 반대되는 말을 하게 된다.
comment on column public.character_boss_plans.default_party_size is
  '이 캐릭터가 이 보스를 몇 인으로 도는가. **이후 생기는 클리어의 party_size 기본값**이며 '
  '이미 있는 클리어·런은 건드리지 않는다(§1.3 D3). '
  'NOT NULL DEFAULT 1 — 아무것도 정하지 않은 보스는 "1인으로 확정"이다(발주자 지시 2026-08-19). '
  '⚠️ 그 대가로, 실제로는 파티로 도는 보스를 그대로 두면 경고 없이 결정석 수익이 과대 계상된다. '
  'max_party 는 소프트 상한이라 여기서 막지 않는다(§1.3 D5). 범위는 boss_clears.party_size 와 동일한 1~24.';


-- -----------------------------------------------------------------------------
-- 25-2. set_character_boss_plan_party_size() — null 입력을 1 로 접는다
-- -----------------------------------------------------------------------------
-- ★ **이 함수를 함께 고치지 않으면 25-1 이 런타임 에러를 만든다.** 예전 규약에서 `null` 은
--   "설정 해제"였고, 보스 계획 화면의 인원 입력칸을 **비우면** 그 null 이 그대로 내려온다.
--   컬럼에 NOT NULL 만 걸고 함수를 두면 사용자가 칸을 비우는 순간 23502 로 죽는다.
--
--   시그니처는 그대로 둔다(`integer` 는 계속 nullable). 호출부 세 곳(API 라우트 zod 스키마 ·
--   repo · 낙관적 갱신)이 여전히 `number | null` 을 보내며, 그 `null` 의 뜻만
--   "설정 해제" → **"기본값 1로 되돌리기"** 로 바뀐다. 입력칸을 비우는 UX 가 그대로 산다.
create or replace function public.set_character_boss_plan_party_size(
  p_character_id       uuid,
  p_boss_difficulty_id text,
  p_party_size         integer   -- null = **기본값 1로 되돌린다** (예전에는 "미설정 해제")
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_id   uuid;
  v_size integer;
begin
  -- ★ null 을 여기서 접는다. 컬럼이 NOT NULL 이므로 접지 않으면 23502 가 난다.
  --   0 이 아니라 1 이다 — 0 은 1/n 의 분모라 나눗셈 자체가 터진다.
  v_size := coalesce(p_party_size, 1);

  -- 범위는 boss_clears / party_runs 와 같은 1~24. max_party 는 막지 않는다(§1.3 D5).
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

  return v_id;
end;
$func$;

comment on function public.set_character_boss_plan_party_size(uuid, text, integer) is
  '계획 행의 기본 파티 인원수를 정한다. null 을 넘기면 **기본값 1로 되돌린다**(2026-08-19 — '
  '예전에는 "미설정으로 해제"였고, 이제 미설정이라는 상태가 없다). '
  'default_party_size 한 컬럼만 갱신하며 켜기/끄기·넥슨 값에 손대지 않는다. 계획에 없는 보스면 no_data_found. '
  '이미 쌓인 클리어는 바뀌지 않는다 — 소급 반영은 apply_plan_party_sizes_to_clears() 를 사람이 부른다.';


-- -----------------------------------------------------------------------------
-- 25-3. 기존 클리어 백필 — 기본값 1로 앉은 미확인 행을 확인됨으로 올린다
-- -----------------------------------------------------------------------------
-- 새 규칙("미설정 = 1인 확정")을 **이미 쌓인 행에도** 적용한다. 그러지 않으면 어제 동기화된
-- 클리어는 계속 "확인 필요"라고 말하고 오늘 것만 조용한, 설명할 수 없는 화면이 된다.
--
-- 대상은 셋을 **동시에** 만족하는 행뿐이다:
--   ① `run_id is null`            — 런에 걸린 클리어의 인원은 별개 경로다(§1.3 D3)
--   ② `party_size = 1`            — 기본값 그대로 앉은 행. 1 이 아닌 값은 누군가 넣은 값이다
--   ③ `party_size_confirmed = false` — 이미 확인된 행은 건드릴 것이 없다
--
-- 트리거 안전성: BEFORE UPDATE 는 `price_snapshotted_at is null` 일 때만 금액을 다시
-- 계산한다. 여기서는 그 컬럼을 건드리지 않으므로 스냅샷된 금액·주기·시세가 한 톨도
-- 움직이지 않는다. `set_clear_party_size()` 를 부르지 않는 이유도 같다 — 인원 **값**은
-- 바뀌지 않고 확인 비트만 올라가므로 재계산 경로를 탈 이유가 없다.
update public.boss_clears
   set party_size_confirmed = true
 where party_size_confirmed = false     -- 재실행 시 무동작
   and run_id              is null
   and party_size           = 1;


-- -----------------------------------------------------------------------------
-- 25-4. 자기검증 — 어긋나면 마이그레이션이 실패한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_user  uuid;
  v_char  uuid;
  v_size  integer;
  v_null  bigint;
  v_stale bigint;
begin
  -- (1) 계획 테이블에 null 이 한 행도 남지 않았다
  select count(*) into v_null
    from public.character_boss_plans
   where default_party_size is null;
  if v_null <> 0 then
    raise exception 'default_party_size 가 null 인 계획이 %건 남았습니다.', v_null;
  end if;

  -- (2) 기본값 1로 앉은 미확인 클리어(런 미연결)가 한 행도 남지 않았다
  select count(*) into v_stale
    from public.boss_clears
   where run_id is null and party_size = 1 and party_size_confirmed = false;
  if v_stale <> 0 then
    raise exception '기본값 1인 미확인 클리어가 %건 남았습니다.', v_stale;
  end if;

  insert into public.app_users (display_name) values ('__default_size_selftest__')
  returning id into v_user;

  insert into public.characters (user_id, character_name, world_name, character_level)
  values (v_user, '__default_size_selftest_char__', '스카니아', 285)
  returning id into v_char;

  perform public.set_character_boss_plan(v_char, 'lotus_hard', true);

  -- (3) **새 계획 행은 처음부터 1인이다.** 이것이 이번 마이그레이션의 핵심 주장이다.
  select default_party_size into v_size
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_size is distinct from 1 then
    raise exception '새 계획 행의 default_party_size 가 1 이 아닙니다 (%).', v_size;
  end if;

  -- (4) 값 설정은 그대로 동작한다
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 3);
  select default_party_size into v_size
    from public.v_character_boss_plan_status
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_size <> 3 then
    raise exception '뷰가 기본 인원수를 3 으로 내지 않았습니다 (%).', v_size;
  end if;

  -- (5) ★ **null 을 보내면 1 로 접힌다.** 예전에는 null 로 되돌아갔다.
  --     화면의 인원 입력칸을 비우는 조작이 이 경로를 탄다 — 여기서 죽으면 사용자가 본다.
  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', null);
  select default_party_size into v_size
    from public.character_boss_plans
   where character_id = v_char and boss_difficulty_id = 'lotus_hard';
  if v_size is distinct from 1 then
    raise exception 'null 입력이 1 로 접히지 않았습니다 (%).', v_size;
  end if;

  -- (6) 범위 밖은 여전히 거부한다
  begin
    perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 25);
    raise exception '25인이 허용되었습니다.';
  exception when check_violation then
    null;
  end;
  begin
    perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 0);
    raise exception '0인이 허용되었습니다.';
  exception when check_violation then
    null;
  end;

  -- (7) 컬럼에 null 을 직접 밀어 넣을 수 없다 (NOT NULL 이 실제로 걸려 있다)
  begin
    update public.character_boss_plans
       set default_party_size = null
     where character_id = v_char and boss_difficulty_id = 'lotus_hard';
    raise exception 'default_party_size 에 null 이 들어갔습니다.';
  exception when not_null_violation then
    null;
  end;

  delete from public.app_users where id = v_user;

  raise notice '25. default_party_size = 1 확정 자기검증 7항목 전부 통과';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 컬럼을 새로 만들지는 않았지만, 이 호출을 생략하지 않는 것이 규약이다 —
-- 테이블 단위 GRANT 가 조용히 넓어지지 않았는지 매 마이그레이션이 확인한다.
select public.assert_no_public_sensitive_columns();
