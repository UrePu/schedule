-- =============================================================================
-- 34. 교대 표의 유니크 인덱스를 **부분 인덱스에서 전체 인덱스로**
-- =============================================================================
--
-- 마이그레이션 33 은 소유자 유니크를 `where user_id is not null` 부분 인덱스로 걸었다.
-- 표현으로는 정확하지만 **`ON CONFLICT` 의 중재자(arbiter)로 쓸 수 없다.** 부분 인덱스는
-- 문장이 같은 술어를 함께 적어야만 중재자로 뽑히는데, PostgREST 의 `upsert(onConflict:)`
-- 는 컬럼 목록만 보내므로 Postgres 가 이렇게 답한다:
--
--   there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- 실제로 실서버 검증에서 **주기 저장과 근무 배정이 둘 다 500** 이었다. 배포 전에 잡혔다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 전체 인덱스로 바꿔도 뜻이 약해지지 않는다
-- ─────────────────────────────────────────────────────────────────────────────
-- 유니크 인덱스는 기본이 NULLS DISTINCT 라, `user_id` 가 NULL 인 게스트 행끼리는 서로
-- 충돌하지 않는다. 즉 `unique (user_id)` 한 줄이 "계정마다 하나" 를 그대로 표현하면서
-- 게스트 행은 건드리지 않는다 — 부분 인덱스와 **효력이 같고** 중재자로도 쓸 수 있다.
--
-- 프리셋 이름 유니크(`shift_presets_*_name_uniq`)는 그대로 둔다. 거기엔 upsert 가 없고,
-- 필요 없는 변경을 얹지 않는다.

drop index if exists public.availability_cycles_user_uniq;
drop index if exists public.availability_cycles_guest_uniq;
create unique index if not exists availability_cycles_user_uniq
  on public.availability_cycles (user_id);
create unique index if not exists availability_cycles_guest_uniq
  on public.availability_cycles (guest_id);

drop index if exists public.shift_assignments_user_day_uniq;
drop index if exists public.shift_assignments_guest_day_uniq;
create unique index if not exists shift_assignments_user_day_uniq
  on public.shift_assignments (user_id, work_date);
create unique index if not exists shift_assignments_guest_day_uniq
  on public.shift_assignments (guest_id, work_date);

-- -----------------------------------------------------------------------------
-- 자기검증 — **실제로 upsert 를 두 번 해 본다**
-- -----------------------------------------------------------------------------
-- 인덱스가 부분인지 아닌지를 카탈로그로 확인하는 것만으로는 이 버그를 다시 못 잡는다.
-- 실패한 것은 `ON CONFLICT` 였으므로 검증도 `ON CONFLICT` 여야 한다.
do $$
declare
  v_user  uuid;
  v_preset uuid;
  v_days  smallint;
  v_count integer;
begin
  insert into public.app_users (display_name, friend_discoverable)
  values ('__mig34_check__', false) returning id into v_user;

  insert into public.availability_cycles (user_id, cycle_days, anchor_date)
  values (v_user, 6, date '2026-08-20')
  on conflict (user_id) do update set cycle_days = excluded.cycle_days;

  insert into public.availability_cycles (user_id, cycle_days, anchor_date)
  values (v_user, 8, date '2026-08-20')
  on conflict (user_id) do update set cycle_days = excluded.cycle_days;

  select cycle_days into v_days from public.availability_cycles where user_id = v_user;
  if v_days <> 8 then
    raise exception '34: 주기 upsert 가 덮어쓰지 않았습니다(%).', v_days;
  end if;

  insert into public.shift_presets (user_id, name, start_minute, end_minute)
  values (v_user, '야간', 1320, 1800) returning id into v_preset;

  insert into public.shift_assignments (user_id, work_date, preset_id)
  values (v_user, date '2026-08-20', v_preset)
  on conflict (user_id, work_date) do update set preset_id = excluded.preset_id;

  insert into public.shift_assignments (user_id, work_date, preset_id)
  values (v_user, date '2026-08-20', v_preset)
  on conflict (user_id, work_date) do update set preset_id = excluded.preset_id;

  select count(*) into v_count
    from public.shift_assignments where user_id = v_user;
  if v_count <> 1 then
    raise exception '34: 같은 날 배정이 %건이 됐습니다(1이어야 함).', v_count;
  end if;

  delete from public.app_users where id = v_user;
end
$$;

select public.assert_no_public_sensitive_columns();
