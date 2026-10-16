-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · **참가 기록의 캐릭터를 되살리고, 떠 있던 클리어를 그 일정에 붙인다**
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 신고(2026-10-16): *"일정표의 10/15 19:00 블록(익세·하대·하카, 파티 세대카무고)을
-- 게임에서 클리어했는데 클리어 판정이 안 된다."*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 무슨 일이 있었나 — 라이브 확인된 사실만
-- ───────────────────────────────────────────────────────────────────────────────
-- 넥슨 스냅샷에는 그 세 보스가 `cleared: true` 로 들어와 있었고, `boss_clears` 에도
-- `effective_cleared = true` · `party_size = 2` · 분배액까지 **정상으로 기록돼 있었다.**
-- 수익은 들어갔다. 어긋난 것은 하나뿐이다 — 그 세 건 모두 **`run_id` 가 null** 이었다.
--
-- 왜 안 붙었나: 그 런의 **`run_signups.character_id` 가 null** 이었다. 클리어를 일정에
-- 붙이는 두 경로가 **그 컬럼만** 읽는다.
--   · `sync-scheduler.loadRunLinks` — `(캐릭터, 보스, 주차)` 로 런을 찾는다.
--   · `income-repo.setRunClear`     — 캐릭터 없는 참가는 아예 거절한다.
-- 그런데 **화면은 `coalesce(런 지정, 파티 기본값)` 으로 떨어뜨려 캐릭터를 보여 준다.**
-- 그래서 사용자 눈에는 "내 캐릭터: 무르겨르" 가 멀쩡히 적혀 있는데 클리어 판정만
-- 조용히, 영원히 실패했다.
--
-- 값이 없었던 것도 아니다. 파티 `세대카무고` 의 `party_participants.character_id` 에
-- `무르겨르` 가 이미 들어 있었다. **런을 만들 때 그 값이 참가 기록으로 복사되지 않았을
-- 뿐이다** — 등록자 본인 행만 채우고 나머지는 null 로 두는 규칙이었다.
--
-- 뿌리는 오늘 `schedule-repo.createPartyRuns` 가 막았다(파티 기본 캐릭터를 모든 `going`
-- 참가 기록에 복사한다). **이 파일은 이미 쌓인 과거를 되살리는 일회성 복구다.**
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 범위 — 라이브 실측 (2026-10-16, 읽기만)
-- ───────────────────────────────────────────────────────────────────────────────
--   `status = 'going'` 참가 **282건** 중 캐릭터 없음 **158건**
--     ├ **138건 = 앱 사용자가 아닌 참가자**(이름만 적어 넣은 사람 · 게스트)
--     │   → 넥슨을 읽을 수 없으니 캐릭터가 없는 것이 **정상이다. 손대지 않는다.**
--     └ **20건 = 앱 사용자인데 캐릭터가 없음** ← 이 결함
--       (발주 브리프의 278/156 은 작성 시점 값이다. 여기 숫자는 2026-10-16 재측정값이고,
--        20 / 138 은 그대로다 — 늘어난 4건은 전부 캐릭터가 들어간 정상 참가다.)
--          ├ 되살릴 수 있음 **15건** (파티 기본 캐릭터가 있다)
--          │    세대카무고/더저 6 · 부데나 익흉 2인/더저 4 ·
--          │    엔버 익세하적하카 2인/풍무고불빠따 3 · 같은 파티/바이보라 1 · 같은 파티/더저 1
--          └ 되살릴 수 없음 **5건** (파티 기본 캐릭터 자체가 없다 → 복사할 값이 없다)
--               발벨3인/라온내일 4 · 익칼 2인/바이보라 1
--               ⚠️ 이 5건은 **파티 관리에서 캐릭터를 고르는 수밖에 없다.** 여기서
--                  지어내지 않는다 — 틀린 캐릭터에 12칸 상한이 쌓인다(§1 · §1.3 D4 기조).
--
-- 그 결과로 런에 붙는 클리어: **9건** (= 1절의 복사로 새로 붙는 8건 + 1절과 무관하게
-- 예전부터 떠 있던 1건 `익검3`/핏자/검은 마법사). **2건은 애매해서 건너뛴다**(3절).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 수익을 다시 계산하지 않는다 — 그것을 **보장하는 장치**가 무엇인가
-- ───────────────────────────────────────────────────────────────────────────────
-- `boss_clears_apply_state()` 의 금액 블록은 `if new.price_snapshotted_at is null` 안에만
-- 있다. 즉 **이미 스냅샷이 찍힌 행은 UPDATE 를 해도 금액 계산을 다시 하지 않는다.**
-- 그래서 3절은 `price_snapshotted_at is not null and effective_cleared` 인 행만 고른다 —
-- 그 조건이 "바뀌는 것은 `run_id` 하나뿐"을 **트리거 수준에서** 보장한다.
-- (실측: `run_id is null` 인 클리어 3,824건 전부가 그 조건을 만족한다. 그래도 조건을
--  적는다 — 만족하지 않는 행이 생기면 그 행은 붙이지 않고 건너뛰는 쪽이 옳다.)
--
-- `run_signups` 쪽도 마찬가지다. `run_signups_sync_shares` 트리거는
-- `after insert or delete or update **of status**` 라 `character_id` UPDATE 로는 **발화하지
-- 않는다.** 분배 비율은 손대지 않는다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 재실행 가능 — 두 번 돌려도 같은 상태
-- ───────────────────────────────────────────────────────────────────────────────
-- 1절은 `character_id is null` 인 행만, 3절은 `run_id is null` 인 행만 고른다. 한 번
-- 돌면 그 조건이 거짓이 되므로 두 번째 실행은 **0건을 바꾸고 같은 notice 를 0 으로 찍는다.**
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 되돌리는 SQL — 이 파일이 바꾼 것만 정확히 되돌린다
-- ───────────────────────────────────────────────────────────────────────────────
-- 아래 두 문장을 **그 순서로** 실행하면 된다. 되돌릴 대상을 "이 마이그레이션이 만졌을
-- 만한 행"으로 추정하지 않기 위해, 먼저 바뀐 행을 적어 두는 임시 표를 쓰는 편이 안전하다.
-- 임시 표 없이 되돌려야 한다면 아래 조건이 그 근사다(복구 직후에만 유효하다 —
-- 그 뒤에 사용자가 직접 지정한 캐릭터·연결까지 같은 조건에 걸린다).
--
--   -- (가) 붙인 클리어를 떼어 낸다. `updated_at` 창을 함께 걸어 범위를 좁힌다.
--   -- update public.boss_clears c
--   --    set run_id = null
--   --  where c.run_id is not null
--   --    and c.updated_at >= '<이 마이그레이션을 돌린 시각>'::timestamptz;
--
--   -- (나) 복사한 캐릭터를 비운다. 파티 기본값과 **같은 값**인 행만 — 그 사이 사용자가
--   --      직접 다른 캐릭터로 바꾼 행은 남긴다.
--   -- update public.run_signups s
--   --    set character_id = null
--   --   from public.party_participants pp
--   --  where pp.id = s.participant_id
--   --    and s.character_id is not null
--   --    and s.character_id = pp.character_id
--   --    and s.updated_at >= '<이 마이그레이션을 돌린 시각>'::timestamptz;
--
-- ⚠️ 순서가 중요하다. (나)를 먼저 하면 (가)의 `run_id` 가 캐릭터 없는 참가에 매달린
--    상태로 남아, 다음 동기화가 같은 판을 다시 해석한다.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  n_app_user_missing   integer;
  n_name_only_missing  integer;
  n_recoverable        integer;
  n_unrecoverable      integer;
  n_filled             integer;
  n_clears_before      integer;
  n_clears_after       integer;
  n_linked             integer;
  n_ambiguous          integer;
begin
  -- ── 0. 손대기 전 사진 ───────────────────────────────────────────────────────
  -- 이 숫자들이 로그에 남아야 "무엇을 왜 바꿨는지"가 설명된다. 특히 138건(이름만 있는
  -- 참가자)은 **고칠 대상이 아니라는 사실 자체가** 기록되어야 한다 — 다음 사람이 같은
  -- 쿼리를 보고 "156건이 깨져 있다"고 오해하지 않도록.
  select
      count(*) filter (where pp.user_id is not null),
      count(*) filter (where pp.user_id is null),
      count(*) filter (where pp.user_id is not null and pp.character_id is not null),
      count(*) filter (where pp.user_id is not null and pp.character_id is null)
    into n_app_user_missing, n_name_only_missing, n_recoverable, n_unrecoverable
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.character_id is null
     and s.status = 'going';

  raise notice '[0] 캐릭터 없는 going 참가 — 앱 사용자 %건 / 이름만 있는 참가자 %건(정상, 손대지 않는다)',
    n_app_user_missing, n_name_only_missing;
  raise notice '[0] 그중 되살릴 수 있음 %건(파티 기본 캐릭터 있음) · 되살릴 수 없음 %건(파티에서 캐릭터를 골라야 한다)',
    n_recoverable, n_unrecoverable;

  select count(*) into n_clears_before from public.boss_clears;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 1절. 참가 기록에 **파티 기본 캐릭터**를 복사한다
  -- ════════════════════════════════════════════════════════════════════════════
  -- 조건 넷, 전부 이유가 있다.
  --   ① `s.character_id is null`      — 이미 정해진 값은 절대 덮지 않는다(재실행 안전).
  --   ② `s.status = 'going'`          — 안 가는 사람에게는 클리어가 생기지 않으므로
  --                                     캐릭터를 정할 이유도 없다. 범위를 넓히지 않는다.
  --   ③ `pp.user_id is not null`      — **앱 사용자만.** 이름만 적어 넣은 참가자 138건은
  --                                     넥슨 계정이 없어 캐릭터가 없는 것이 정상이다.
  --   ④ `pp.character_id is not null` — 복사할 값이 있을 때만. 없으면 null 로 남긴다
  --                                     (거짓 값을 지어내지 않는다 — 머리말).
  --
  -- ⚠️ 런의 취소 여부로 거르지 **않는다.** 이 컬럼이 말하는 것은 "이 사람이 이 일정에
  --    어느 캐릭터로 가는가" 하나이고, 그 사실은 런이 취소됐든 아니든 같다. 취소 여부가
  --    실제로 중요한 곳은 **3절(클리어 연결)** 이고 거기서 엄격하게 거른다.
  update public.run_signups s
     set character_id = pp.character_id
    from public.party_participants pp
   where pp.id = s.participant_id
     and s.character_id is null
     and s.status = 'going'
     and pp.user_id is not null
     and pp.character_id is not null;

  get diagnostics n_filled = row_count;
  raise notice '[1] 참가 기록에 파티 기본 캐릭터를 복사 — %건', n_filled;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 2절. 애매한 클리어를 **먼저 세어 둔다** (붙이기 전에)
  -- ════════════════════════════════════════════════════════════════════════════
  -- 같은 주에 같은 보스를 두 번 잡을 수는 없다. 그런데도 한 클리어에 런이 둘 이상
  -- 매칭되는 경우가 실제로 있다 — **같은 주차에 같은 보스 일정을 두 번 잡아 둔 것**이다
  -- (실측: `부데나 익흉 2인` 의 10-12 / 10-14 두 벌, 2026-W41 로터스·래디언트).
  --
  -- 발주 지시: *"애매하면 연결하지 마라. (…) 규칙이 하나로 정하지 못하는 건은 건너뛰고
  -- 몇 건인지 알려라."* → 시각이 이른 쪽을 고르는 것은 `loadRunLinks` 의 규칙이지만,
  -- 그쪽은 **살아 있는 동기화**이고 이쪽은 **과거의 일회성 정정**이다. 둘의 실패 비용이
  -- 다르다: 동기화가 틀리면 다음 동기화가 같은 판정을 다시 내리는 반복적 근사인데,
  -- 여기서 틀리면 **잘못된 일정에 수익이 영구히 귀속된 채 아무도 다시 보지 않는다.**
  -- 그래서 여기서는 추측하지 않고 건너뛰고, 몇 건인지만 말한다.
  with pairs as (
    select distinct c.id as clear_id, r.id as run_id
      from public.boss_clears c
      join public.run_signups s
        on s.character_id = c.character_id
       and s.status = 'going'
      join public.party_participants pp
        on pp.id = s.participant_id
       and pp.user_id = c.user_id
      join public.party_runs r
        on r.id = s.run_id
       and r.boss_difficulty_id = c.boss_difficulty_id
       and r.week_key = c.week_key
       and r.cancelled_at is null
       and r.status <> 'cancelled'
     where c.run_id is null
       and c.character_id is not null
       and c.effective_cleared
       and c.price_snapshotted_at is not null
  )
  select count(*) into n_ambiguous
    from (select clear_id from pairs group by clear_id having count(*) > 1) q;

  if n_ambiguous > 0 then
    raise notice '[2] 건너뜀 — 런이 둘 이상 매칭되는 클리어 %건. 같은 주차·같은 보스 일정이 두 벌이라 어느 쪽인지 정할 수 없다. 중복 일정을 지운 뒤 다시 돌리면 붙는다.',
      n_ambiguous;
  else
    raise notice '[2] 애매한 클리어 없음';
  end if;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 3절. 떠 있던 클리어를 **그 런에 붙인다** — `run_id` 만 채운다
  -- ════════════════════════════════════════════════════════════════════════════
  -- 매칭 규칙은 **(캐릭터, 보스, 주차)** 다. `sync-scheduler.loadRunLinks` 가 쓰는 그
  -- 조건과 **같은 세 개**이고, 거기에 이 파일만의 안전장치를 얹는다.
  --
  --   · `pp.user_id = c.user_id`              — 그 참가가 **그 클리어의 주인**의 것인지.
  --                                             캐릭터 id 로도 사실상 갈리지만, 원장의
  --                                             소유자를 명시로 맞춘다.
  --   · 취소된 런 제외                        — `setRunClear` 도 취소된 일정을 거절한다.
  --   · `effective_cleared` + 스냅샷 있음     — 금액 재계산을 트리거 수준에서 봉인한다(머리말).
  --   · 그 런에 같은 사람의 클리어가 없을 때   — 한 사람이 한 런에 두 건 매달리는 것을 막는다.
  --   · **런이 정확히 하나일 때만**            — 2절에서 센 애매한 건은 여기서 빠진다.
  --
  -- ⚠️ **새 클리어를 만들지 않는다.** INSERT 가 한 줄도 없고, 아래 4절이 개수로 확인한다.
  with pairs as (
    select distinct c.id as clear_id, r.id as run_id
      from public.boss_clears c
      join public.run_signups s
        on s.character_id = c.character_id
       and s.status = 'going'
      join public.party_participants pp
        on pp.id = s.participant_id
       and pp.user_id = c.user_id
      join public.party_runs r
        on r.id = s.run_id
       and r.boss_difficulty_id = c.boss_difficulty_id
       and r.week_key = c.week_key
       and r.cancelled_at is null
       and r.status <> 'cancelled'
     where c.run_id is null
       and c.character_id is not null
       and c.effective_cleared
       and c.price_snapshotted_at is not null
       and not exists (
         select 1
           from public.boss_clears other
          where other.run_id = r.id
            and other.user_id = c.user_id
       )
  ), decided as (
    -- `(array_agg(...))[1]` 은 **단 하나뿐일 때만** 쓰이므로 "무엇을 고를까"의 규칙이
    -- 아니다. 둘 이상이면 `having count(*) = 1` 에서 아예 떨어진다.
    -- ⚠️ `min(run_id)` 를 쓰지 않는다 — Postgres 에 **`min(uuid)` 집계가 없다**
    --    (`42883`, 라이브에서 확인). 조용히 안 되는 것이 아니라 바로 죽는다.
    select clear_id, (array_agg(run_id))[1] as run_id
      from pairs
     group by clear_id
    having count(*) = 1
  )
  update public.boss_clears c
     set run_id = d.run_id
    from decided d
   where d.clear_id = c.id;

  get diagnostics n_linked = row_count;
  raise notice '[3] 떠 있던 클리어를 일정에 연결 — %건 (run_id 만 채웠다. 금액·인원·시각은 그대로)',
    n_linked;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 4절. 원장이 늘지 않았는지 확인한다
  -- ════════════════════════════════════════════════════════════════════════════
  -- 발주 지시: *"새 클리어를 만들지 마라. 수익을 다시 계산하지 마라."* 전자는 개수로
  -- 증명할 수 있으므로 증명한다. 어긋나면 **롤백한다** — 원장이 늘어난 복구는 복구가 아니다.
  select count(*) into n_clears_after from public.boss_clears;
  if n_clears_after <> n_clears_before then
    raise exception '복구 중단: boss_clears 행 수가 바뀌었습니다 (%건 → %건). 이 마이그레이션은 run_id 만 채워야 합니다.',
      n_clears_before, n_clears_after;
  end if;
  raise notice '[4] boss_clears 행 수 %건 — 변화 없음(새 클리어 0건)', n_clears_after;

  -- ── 5. 남은 일 ──────────────────────────────────────────────────────────────
  -- 복사할 값이 없어 못 고친 참가는 **사람이 파티에서 캐릭터를 골라야** 한다. 그 사실을
  -- 로그에 남긴다 — 이 복구가 "전부 고쳤다"로 읽히면 그 몇 건이 영원히 방치된다.
  select count(*) into n_unrecoverable
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.character_id is null
     and s.status = 'going'
     and pp.user_id is not null;

  if n_unrecoverable > 0 then
    raise notice '[5] 아직 캐릭터 없는 앱 사용자 참가 %건 — 파티 관리에서 그 사람의 캐릭터를 정해야 고쳐진다(여기서 지어내지 않는다).',
      n_unrecoverable;
  else
    raise notice '[5] 캐릭터 없는 앱 사용자 참가 0건';
  end if;
end $$;

-- §0.3 필수 — RLS 는 행을 거르지, 테이블 단위 GRANT 가 삼킨 **컬럼**을 거르지 못한다.
-- 이 파일은 스키마를 바꾸지 않지만, 호출을 빼는 순간 "이 마이그레이션만 예외"가 생긴다.
select public.assert_no_public_sensitive_columns();
