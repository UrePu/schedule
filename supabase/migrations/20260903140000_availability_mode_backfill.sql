-- =============================================================================
-- 37. 달력**만** 쓰던 사람을 shift 로 백필한다 — 36 이 놓친 모양 하나
-- =============================================================================
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 36 은 왜 백필하지 않기로 했나 (그 판단을 부정하지 않는다)
-- ─────────────────────────────────────────────────────────────────────────────
-- 36 의 근거는 두 줄이었다.
--   ① 해석기가 `coalesce(mode, 'weekly')` 로 읽으므로 **행이 없는 것과 'weekly' 행이
--      있는 것은 정확히 같은 뜻**이다. 뜻이 같은 상태를 굳이 행으로 만들면 나중에 둘이
--      갈라진다.
--   ② 기존 사용자는 요일 패턴을 갖고 있으니 weekly 로 시작해도 **잃는 것이 없다.**
-- ①은 지금도 그대로 옳다. 이 마이그레이션은 ①을 건드리지 않는다 — weekly 로 동작하면
-- 되는 사람에게는 여전히 행을 만들지 않는다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ②가 통하지 않는 사람이 실제로 있었다 — 요일 패턴이 **0줄**인 사람
-- ─────────────────────────────────────────────────────────────────────────────
-- 실측(2026-09-03, 운영 DB 전수):
--
--   이름            요일패턴  주기축  주기설정  달력지정  모드행
--   ───────────────────────────────────────────────────────────
--   더저                 7      0       0        0      없음
--   라온내일             8      0       0        0      없음
--   민동이당             2      0       0        0      없음
--   바이보라             5      0       0        0      없음
--   죠린                 7      0       0        0      없음
--   풍무고불빠따         0      0       0       28      없음   ← ②가 무너지는 자리
--
-- `풍무고불빠따` 는 요일 격자를 한 번도 쓰지 않고 **달력에만 28일**을 찍어 온 사람이다.
-- 36 이 적용된 순간 이 사람은 모드 행이 없으므로 weekly 로 해석되고, weekly 는
-- `shift_assignments` 를 **아예 읽지 않으므로** 실효 가능시간이 **0건**이 된다.
-- 즉 이 사람은 본인이 방식을 다시 고르기 전까지 **모든 파티의 겹쳐보기에서 통째로
-- 사라진다.** 자기가 사라진 줄도 모르고, 남들에게는 "아무 때도 안 되는 사람" 으로 보인다.
-- §1.4 의 기준으로 이건 가장 비싼 종류의 오류다 — 화면이 조용히 거짓을 말한다.
--
-- 그 사람에게 weekly 는 "가능시간 없음" 과 같은 말이다. 36 의 ② 는 "요일 패턴이 **있는**
-- 사람" 을 전제로 한 문장이었고, 전제가 성립하지 않는 사람에게까지 적용된 것이 구멍이다.
-- 그래서 여기서는 **그 전제가 깨진 사람에게만** 좁게 행을 만든다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 대상 조건 — 좁게, 그리고 정확히
-- ─────────────────────────────────────────────────────────────────────────────
--   · 요일축 패턴(`availability_patterns.weekday is not null`)이 **한 줄도 없다**, 그리고
--   · 달력 지정(`shift_assignments`) 또는 교대 주기(`availability_cycles`)가 **있다**, 그리고
--   · 모드 행이 **아직 없다**(`on conflict do nothing` — 이미 고른 사람의 선택을 덮지 않는다).
--
-- ★ 요일 패턴이 있는 사람은 **절대 건드리지 않는다.** 발주자가 "요일별 반복을 기본으로"
--   라고 정했고, 요일 패턴이 있으면 weekly 로 시작해도 잃는 것이 없다(=36 의 ②가 그대로
--   성립하는 사람들). 위 표의 나머지 5명은 이 마이그레이션 뒤에도 모드 행이 없다.
-- ★ 반대쪽 데이터는 여기서도 **한 줄도 지우지 않는다.** 36 의 보존 규칙 그대로다.
-- ★ 새 DB 객체가 없으므로 새 RLS 정책도 없다. `availability_modes` 의 정책은 36 이
--   이미 세웠고(service_role 전용), 이 파일은 그 표에 행만 넣는다.
--
-- 멱등하다. 두 번 돌려도 `on conflict do nothing` 이라 같은 결과이며, 자기검증 ② 는
-- **이번 실행이 실제로 만진 행**만 보므로 재실행에서도 통과한다.

do $$
declare
  v_touched uuid[] := '{}'::uuid[];
  v_guests  uuid[] := '{}'::uuid[];
  v_bad     integer;
begin
  -- ── 계정(app_users) ────────────────────────────────────────────────────
  with backfilled as (
    insert into public.availability_modes (user_id, mode)
    select u.id, 'shift'::public.availability_mode
      from public.app_users u
     where not exists (
             select 1
               from public.availability_patterns p
              where p.user_id = u.id
                and p.weekday is not null)
       and (
             exists (select 1 from public.shift_assignments a where a.user_id = u.id)
          or exists (select 1 from public.availability_cycles c where c.user_id = u.id)
           )
    on conflict (user_id) do nothing
    returning user_id
  )
  select coalesce(array_agg(user_id), '{}'::uuid[]) into v_touched from backfilled;

  -- ── 게스트(guest_profiles) ─────────────────────────────────────────────
  -- 게스트도 같은 표를 쓴다(36-2 의 널러블 FK 두 개). 지금 운영 DB 에는 해당자가 없지만,
  -- 한쪽만 처리하면 게스트가 달력을 쓰기 시작하는 날 같은 사고가 그대로 재현된다.
  with backfilled as (
    insert into public.availability_modes (guest_id, mode)
    select g.id, 'shift'::public.availability_mode
      from public.guest_profiles g
     where not exists (
             select 1
               from public.availability_patterns p
              where p.guest_id = g.id
                and p.weekday is not null)
       and (
             exists (select 1 from public.shift_assignments a where a.guest_id = g.id)
          or exists (select 1 from public.availability_cycles c where c.guest_id = g.id)
           )
    on conflict (guest_id) do nothing
    returning guest_id
  )
  select coalesce(array_agg(guest_id), '{}'::uuid[]) into v_guests from backfilled;

  v_touched := v_touched || v_guests;
  raise notice '37: shift 로 백필한 사람 %명', cardinality(v_touched);

  -- ── 자기검증 ① 사라지는 사람이 남아 있으면 안 된다 ──────────────────────
  -- 요일 패턴이 0줄 + 달력 지정 있음 + 모드 행 없음 = weekly 로 해석되어 실효 0건이 되는
  -- 정확히 그 모양. 백필 뒤에는 0명이어야 한다.
  select count(*) into v_bad
    from (
      select u.id as person_id from public.app_users u
      union all
      select g.id as person_id from public.guest_profiles g
    ) pe
   where not exists (
           select 1
             from public.availability_patterns p
            where coalesce(p.user_id, p.guest_id) = pe.person_id
              and p.weekday is not null)
     and exists (
           select 1
             from public.shift_assignments a
            where coalesce(a.user_id, a.guest_id) = pe.person_id)
     and not exists (
           select 1
             from public.availability_modes m
            where coalesce(m.user_id, m.guest_id) = pe.person_id);

  if v_bad > 0 then
    raise exception '37-①: 요일 패턴이 0줄인데 달력만 있고 모드 행이 없는 사람이 %명 남았습니다(0이어야 함 — 이 사람들은 겹쳐보기에서 통째로 사라집니다).', v_bad;
  end if;

  -- ── 자기검증 ② 요일 패턴이 있는 사람은 한 명도 건드리지 않았어야 한다 ────
  -- `v_touched` 는 **이번 실행이 실제로 삽입한** 사람뿐이다. 그 안에 요일축 패턴을 가진
  -- 사람이 섞여 있으면 백필이 너무 넓게 잡힌 것이고, 그건 발주자가 정한 "요일별 반복이
  -- 기본" 을 조용히 뒤집는 일이 된다.
  select count(*) into v_bad
    from public.availability_patterns p
   where p.weekday is not null
     and coalesce(p.user_id, p.guest_id) = any(v_touched);

  if v_bad > 0 then
    raise exception '37-②: 요일 패턴이 있는 사람을 shift 로 바꿨습니다(요일축 행 %건 — 백필 조건이 너무 넓습니다).', v_bad;
  end if;

  -- ── 자기검증 ③ 사람당 모드 행은 여전히 최대 하나 ────────────────────────
  -- 36 의 유니크 인덱스가 실제로 중재자로 뽑혔는지까지 함께 본다(34 의 교훈).
  select count(*) into v_bad
    from (
      select coalesce(user_id, guest_id) as person_id
        from public.availability_modes
      group by 1
      having count(*) > 1
    ) dup;

  if v_bad > 0 then
    raise exception '37-③: 모드 행이 둘 이상인 사람이 %명입니다(1이어야 함 — ON CONFLICT 중재자 실패).', v_bad;
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();
