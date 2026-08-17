-- =============================================================================
-- M_Schedule · 08. RLS 활성화 및 정책 (보안의 실질적 방어선)
-- =============================================================================
-- 채택한 인증 모델: **(c) 모든 쓰기를 Next.js Route Handler + service role 로만 수행하고,
-- RLS 는 anon/authenticated 를 전면 차단한다.** (근거는 Claude/DB-SCHEMA.md 난제 1)
--
-- 이 모델에서 RLS 는 장식이 아니라 **유일한 방어선**이다. 이유:
--   * 브라우저는 `sb_publishable_...` 키(= anon 역할)를 들고 있고, 이 키는 설계상 공개다.
--     즉 누구든 PostgREST 로 직접 쿼리를 날릴 수 있다.
--   * 우리는 Supabase Auth 세션을 쓰지 않으므로 `auth.uid()` 가 항상 null 이다.
--     따라서 "본인 행만" 류의 정책은 성립하지 않는다.
--   * 그래서 anon/authenticated 에게는 **공개 시간표 SELECT 이외의 모든 것을 거부**하고,
--     나머지는 서명·세션을 검증한 Route Handler 가 service role 로만 수행한다.
--
-- 이중 방어:
--   1) RLS 정책 — 모든 테이블에 명시적으로 작성한다(정책 없는 테이블 = 실패).
--   2) GRANT/REVOKE — Supabase 는 public 스키마 신규 테이블에 anon/authenticated 권한을
--      기본으로 부여한다. RLS 가 실수로 꺼져도 새지 않도록 권한 자체를 회수한다.
--
-- ⚠️ service_role 은 BYPASSRLS 속성을 가지므로 아래 service_role 정책은 실제로는 평가되지
--    않는다. 그래도 명시적으로 남긴다 — 의도를 스키마에 기록하고, 향후 bypassrls 가
--    제거되더라도 동작이 유지되게 하기 위해서다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 8-1. 비공개 테이블 (19개) — anon/authenticated 전면 차단
-- -----------------------------------------------------------------------------
-- 반복 정의는 실수가 나기 쉬우므로 테이블 목록을 한 곳에 두고 동일 정책을 적용한다.
-- 어떤 테이블이 여기 속하는지가 이 파일에서 가장 중요한 정보다.
do $$
declare
  t text;
  private_tables text[] := array[
    -- 신원 · 자격증명 (API 키 해시, 암호화 키, 넥슨 account_id)
    'app_users',
    'user_credentials',
    'user_nexon_accounts',
    'characters',
    'nexon_api_quota_usage',
    -- 결정석 원장 · 넥슨 미러 · 숙제 (개인 활동 기록)
    'boss_clears',
    'character_scheduler_snapshots',
    'chore_definitions',
    'chore_completions',
    -- 소셜 · 초대 (초대 토큰 해시, 게스트 승계 토큰 해시)
    'friendships',
    'invite_links',
    'guest_profiles',
    'invite_redemptions',
    'guest_claims',
    -- 봇 (채널 시크릿 해시, 발신자 식별자, 명령 로그)
    'bot_channels',
    'bot_channel_members',
    'bot_link_codes',
    'bot_outbox',
    'bot_command_log'
  ];
begin
  foreach t in array private_tables loop
    execute format('alter table public.%I enable row level security', t);

    -- 권한 자체를 회수한다(RLS 가 꺼지는 사고에 대한 2차 방어).
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    -- 명시적 전면 거부. "정책이 없어서 막힌다"가 아니라 "막으라고 썼다"로 남긴다.
    execute format('drop policy if exists %I on public.%I', t || '_no_public_access', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to anon, authenticated using (false) with check (false)$p$,
      t || '_no_public_access', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to service_role using (true) with check (true)$p$,
      t || '_service_role_all', t
    );
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 8-2. 공개 마스터 데이터 (4개) — 누구나 읽기, 아무도 쓰기 불가
-- -----------------------------------------------------------------------------
-- 보스 이름·난이도·별칭·결정석 시세는 게임 공개 정보이며 비로그인 화면이 필요로 한다.
-- 기밀 컬럼이 하나도 없으므로 전량 공개해도 안전하다.
do $$
declare
  t text;
  public_master_tables text[] := array[
    'bosses',
    'boss_difficulties',
    'boss_aliases',
    'boss_crystal_prices'
  ];
begin
  foreach t in array public_master_tables loop
    execute format('alter table public.%I enable row level security', t);

    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to anon', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    execute format('drop policy if exists %I on public.%I', t || '_public_select', t);
    execute format(
      $p$create policy %I on public.%I as permissive for select
         to anon, authenticated using (true)$p$,
      t || '_public_select', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_no_public_insert', t);
    execute format(
      $p$create policy %I on public.%I as permissive for insert
         to anon, authenticated with check (false)$p$,
      t || '_no_public_insert', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_no_public_update', t);
    execute format(
      $p$create policy %I on public.%I as permissive for update
         to anon, authenticated using (false) with check (false)$p$,
      t || '_no_public_update', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_no_public_delete', t);
    execute format(
      $p$create policy %I on public.%I as permissive for delete
         to anon, authenticated using (false)$p$,
      t || '_no_public_delete', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to service_role using (true) with check (true)$p$,
      t || '_service_role_all', t
    );
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 8-3. 공개 시간표 (5개) — 조건부 읽기. 조건이 테이블마다 다르므로 개별 작성한다.
-- -----------------------------------------------------------------------------
-- 공개 범위는 오직 `parties.visibility = 'public'` 한 곳에서 결정된다.
-- visibility = 'link' 는 슬러그가 곧 비밀이라 RLS 로 표현할 수 없다 →
-- anon 은 읽지 못하고, Route Handler 가 토큰을 검증한 뒤 service role 로 서빙한다.

-- ── parties ──────────────────────────────────────────────────────────────────
alter table public.parties enable row level security;
revoke all on table public.parties from anon;
revoke all on table public.parties from authenticated;
grant select on table public.parties to anon;
grant select on table public.parties to authenticated;
grant all on table public.parties to service_role;

drop policy if exists parties_public_select on public.parties;
create policy parties_public_select on public.parties
  as permissive for select to anon, authenticated
  using (visibility = 'public' and archived_at is null);

drop policy if exists parties_no_public_insert on public.parties;
create policy parties_no_public_insert on public.parties
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists parties_no_public_update on public.parties;
create policy parties_no_public_update on public.parties
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists parties_no_public_delete on public.parties;
create policy parties_no_public_delete on public.parties
  as permissive for delete to anon, authenticated using (false);

drop policy if exists parties_service_role_all on public.parties;
create policy parties_service_role_all on public.parties
  as permissive for all to service_role using (true) with check (true);

-- ── party_participants ───────────────────────────────────────────────────────
-- 공개 파티의 참가자만 노출된다. 노출되는 이름은 display_name 스냅샷이며
-- 이 테이블에는 기밀 컬럼이 없다(계정 정보는 app_users/user_credentials 에 있고 전면 차단).
alter table public.party_participants enable row level security;
revoke all on table public.party_participants from anon;
revoke all on table public.party_participants from authenticated;
grant select on table public.party_participants to anon;
grant select on table public.party_participants to authenticated;
grant all on table public.party_participants to service_role;

drop policy if exists party_participants_public_select on public.party_participants;
create policy party_participants_public_select on public.party_participants
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = party_participants.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists party_participants_no_public_insert on public.party_participants;
create policy party_participants_no_public_insert on public.party_participants
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_participants_no_public_update on public.party_participants;
create policy party_participants_no_public_update on public.party_participants
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_participants_no_public_delete on public.party_participants;
create policy party_participants_no_public_delete on public.party_participants
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_participants_service_role_all on public.party_participants;
create policy party_participants_service_role_all on public.party_participants
  as permissive for all to service_role using (true) with check (true);

-- ── party_runs ───────────────────────────────────────────────────────────────
alter table public.party_runs enable row level security;
revoke all on table public.party_runs from anon;
revoke all on table public.party_runs from authenticated;
grant select on table public.party_runs to anon;
grant select on table public.party_runs to authenticated;
grant all on table public.party_runs to service_role;

drop policy if exists party_runs_public_select on public.party_runs;
create policy party_runs_public_select on public.party_runs
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = party_runs.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists party_runs_no_public_insert on public.party_runs;
create policy party_runs_no_public_insert on public.party_runs
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_runs_no_public_update on public.party_runs;
create policy party_runs_no_public_update on public.party_runs
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_runs_no_public_delete on public.party_runs;
create policy party_runs_no_public_delete on public.party_runs
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_runs_service_role_all on public.party_runs;
create policy party_runs_service_role_all on public.party_runs
  as permissive for all to service_role using (true) with check (true);

-- ── run_signups ──────────────────────────────────────────────────────────────
alter table public.run_signups enable row level security;
revoke all on table public.run_signups from anon;
revoke all on table public.run_signups from authenticated;
grant select on table public.run_signups to anon;
grant select on table public.run_signups to authenticated;
grant all on table public.run_signups to service_role;

drop policy if exists run_signups_public_select on public.run_signups;
create policy run_signups_public_select on public.run_signups
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1
      from public.party_runs r
      join public.parties p on p.id = r.party_id
      where r.id = run_signups.run_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists run_signups_no_public_insert on public.run_signups;
create policy run_signups_no_public_insert on public.run_signups
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists run_signups_no_public_update on public.run_signups;
create policy run_signups_no_public_update on public.run_signups
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists run_signups_no_public_delete on public.run_signups;
create policy run_signups_no_public_delete on public.run_signups
  as permissive for delete to anon, authenticated using (false);

drop policy if exists run_signups_service_role_all on public.run_signups;
create policy run_signups_service_role_all on public.run_signups
  as permissive for all to service_role using (true) with check (true);

-- ── availability_slots ───────────────────────────────────────────────────────
-- party_id 가 비정규화되어 있어 정책이 parties 만 보면 된다(추가 조인 없음).
alter table public.availability_slots enable row level security;
revoke all on table public.availability_slots from anon;
revoke all on table public.availability_slots from authenticated;
grant select on table public.availability_slots to anon;
grant select on table public.availability_slots to authenticated;
grant all on table public.availability_slots to service_role;

drop policy if exists availability_slots_public_select on public.availability_slots;
create policy availability_slots_public_select on public.availability_slots
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = availability_slots.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists availability_slots_no_public_insert on public.availability_slots;
create policy availability_slots_no_public_insert on public.availability_slots
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists availability_slots_no_public_update on public.availability_slots;
create policy availability_slots_no_public_update on public.availability_slots
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists availability_slots_no_public_delete on public.availability_slots;
create policy availability_slots_no_public_delete on public.availability_slots
  as permissive for delete to anon, authenticated using (false);

drop policy if exists availability_slots_service_role_all on public.availability_slots;
create policy availability_slots_service_role_all on public.availability_slots
  as permissive for all to service_role using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 8-4. 뷰 권한
-- -----------------------------------------------------------------------------
-- 뷰는 security_invoker = true 이므로 기반 테이블 RLS 가 그대로 적용된다.
-- 그래도 "읽을 수 있는 뷰"를 권한 수준에서도 명시적으로 좁힌다.
do $$
declare
  v text;
  public_views text[] := array[
    -- 보스 카탈로그는 게임 공개 정보이며 비로그인 등록 화면이 필요로 한다.
    'v_boss_catalog',
    'v_public_party_board',
    'v_public_party_runs',
    'v_run_participation',
    'v_availability_overlay'
  ];
  private_views text[] := array[
    -- 개인 수익·활동 기록. anon 은 기반 테이블도 못 읽지만 권한도 함께 회수한다.
    'v_weekly_crystal_income',
    'v_weekly_crystal_income_by_character',
    'v_weekly_crystal_world_usage',
    'v_weekly_crystal_pending'
  ];
begin
  foreach v in array public_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant select on table public.%I to anon', v);
    execute format('grant select on table public.%I to authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;

  foreach v in array private_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 8-5. 함수 실행 권한
-- -----------------------------------------------------------------------------
-- ⚠️ 가장 위험한 항목. claim_guest_profile 은 SECURITY DEFINER 이고,
--    PostgreSQL 은 함수 EXECUTE 를 기본으로 PUBLIC 에 부여한다.
--    회수하지 않으면 anon 이 PostgREST RPC 로 남의 게스트 레코드를 자기 계정에 승계할 수 있다.
revoke all on function public.claim_guest_profile(uuid, uuid) from public;
revoke all on function public.claim_guest_profile(uuid, uuid) from anon;
revoke all on function public.claim_guest_profile(uuid, uuid) from authenticated;
grant execute on function public.claim_guest_profile(uuid, uuid) to service_role;

-- 시세 조회는 공개 정보를 읽을 뿐이고 SECURITY INVOKER 이므로 그대로 둔다.
-- 시간 함수(week_key 등)는 순수 산술이라 노출되어도 무해하다.

-- -----------------------------------------------------------------------------
-- 8-6. 자기검증 — 정책 없는 테이블이 하나라도 있으면 마이그레이션을 실패시킨다
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  -- (1) RLS 가 꺼진 public 스키마 테이블
  select string_agg(c.relname, ', ' order by c.relname)
    into v_rls_off
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if v_rls_off is not null then
    raise exception 'RLS 가 비활성화된 테이블이 있습니다: %', v_rls_off;
  end if;

  -- (2) 정책이 하나도 없는 테이블
  select string_agg(c.relname, ', ' order by c.relname)
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if v_missing is not null then
    raise exception 'RLS 정책이 없는 테이블이 있습니다: %', v_missing;
  end if;

  -- (3) anon 이 쓰기 권한을 가진 테이블이 남아 있으면 실패
  select string_agg(distinct table_name, ', ')
    into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');

  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;
