-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 수용 인원 확장 — 동기화 큐 인덱스 + 린트 경고 정리
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-27): *"ㅇㅇ 상한 버셀 수파베이스 싹다 해봐"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 1. 동기화 큐 인덱스 — 새로 생긴 **뜨거운 질의**를 받는다
-- ───────────────────────────────────────────────────────────────────────────────
-- 크론이 후보를 고르는 방식이 바뀌었다(`nightly-sync.ts`). 예전에는 정렬이 없어서
-- 상한에 걸리면 **누가 잘리는지가 정렬 운**이었고, 같은 캐릭터가 매번 잘려도 알 수
-- 없었다. 이제는 `last_synced_at` **오래된 순**으로 뽑아 밀린 쪽이 다음 회차 맨 앞에
-- 서게 한다.
--
--     where is_tracked and ocid is not null
--     order by last_synced_at asc nulls first
--
-- 지금은 832행이라 순차 스캔으로도 즉시 끝난다. 이 인덱스는 **그 뒤**를 위한 것이다 —
-- `characters` 는 추적 여부와 무관하게 계정의 **모든** 캐릭터를 담으므로(실측: 8명이
-- 832행, 사람당 ~104행) 300명이면 3만 행이 되고, 그때 매시 도는 정렬이 공짜가 아니다.
--
-- ★ **부분 인덱스**다. 조건이 질의와 같아서 인덱스가 후보 집합 그 자체이고, 추적하지
--   않는 대다수 행은 아예 들어오지 않는다 — 3만 행 중 실제 크기는 추적분(수백)뿐이다.
-- ★ `nulls first` 를 명시한다. 한 번도 안 부른 캐릭터(`null`)가 **가장 급한** 대상인데,
--   기본값(`nulls last`)이면 정확히 반대로 맨 뒤에 선다.
create index if not exists characters_sync_queue_idx
    on public.characters (last_synced_at asc nulls first)
 where is_tracked and ocid is not null;

comment on index public.characters_sync_queue_idx is
  '매시 크론의 후보 선별용. 조건과 정렬이 nightly-sync.selectCandidates() 와 한 쌍이다.';

-- ───────────────────────────────────────────────────────────────────────────────
-- 2. SECURITY DEFINER 함수의 공개 실행 권한 회수
-- ───────────────────────────────────────────────────────────────────────────────
-- 린터 경고 0028/0029. 두 함수 모두 **정의자 권한으로 도는데 anon 도 부를 수 있었다** —
-- PostgREST 는 `public` 스키마의 함수를 자동으로 `/rest/v1/rpc/…` 로 노출하고, 기본
-- GRANT 가 `public` 롤에 붙어 있기 때문이다. 둘 다 서버 전용이라 열려 있을 이유가 없다.
--
--   · `rls_auto_enable()` — 마이그레이션 보조. 코드 어디에서도 부르지 않는다(전수 검색).
--     RLS 를 만지는 함수가 로그인 없이 호출 가능한 것은 그 자체로 결함이다.
--   · `nexon_resolve_boss_difficulties(jsonb)` — 동기화가 넥슨 응답을 보스 마스터에
--     맞추는 함수. 호출부는 `sync-scheduler.ts` 한 곳뿐이고 service_role 로 돈다.
--
-- ⚠️ **service_role 은 건드리지 않는다.** 그쪽이 실제 호출 경로다. 회수 대상은
--    `public` · `anon` · `authenticated` 뿐이다.
revoke execute on function public.rls_auto_enable()
  from public, anon, authenticated;
revoke execute on function public.nexon_resolve_boss_difficulties(jsonb)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────────
-- 3. search_path 고정
-- ───────────────────────────────────────────────────────────────────────────────
-- 린터 경고 0011. 두 함수만 `proconfig` 가 비어 있어 **호출자의 search_path** 를 따랐다.
-- 둘 다 SECURITY INVOKER 라 권한 상승 경로는 아니지만, 검색 경로가 흔들리면 같은 이름의
-- 임시 객체에 가려질 수 있다. 나머지 함수들은 이미 고정돼 있으므로 **일관성 문제이기도**
-- 하다. 본문은 손대지 않는다.
alter function public.resolve_availability(uuid[], timestamptz, timestamptz)
  set search_path = public, pg_temp;
alter function public.shift_assignment_owner_matches_preset()
  set search_path = public, pg_temp;

-- ───────────────────────────────────────────────────────────────────────────────
-- 남겨 두는 경고 — 고치지 않는 이유를 적는다
-- ───────────────────────────────────────────────────────────────────────────────
-- · `extension_in_public: pg_net` — 확장을 옮기면 `net.http_get` 을 쓰는
--   `trigger_web_sync()` 와 이미 등록된 pg_cron 작업이 함께 깨진다. 얻는 것은 린트 한
--   줄이고 잃는 것은 동기화 전체라, **의도적으로 남긴다.** 함수는 이미
--   `search_path TO 'public','net','pg_temp'` 로 고정돼 있다.
-- · `unused_index` 다수 — 832행에서는 플래너가 순차 스캔을 고르기 때문이지 인덱스가
--   쓸모없어서가 아니다. 규모가 커지면 쓰인다. 지금 지우면 그때 다시 만들어야 한다.

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_idx  integer;
  v_open integer;
  v_path integer;
begin
  select count(*) into v_idx from pg_indexes
   where schemaname = 'public' and indexname = 'characters_sync_queue_idx';
  if v_idx <> 1 then
    raise exception '동기화 큐 인덱스가 만들어지지 않았습니다.';
  end if;

  -- anon/authenticated 가 아직 부를 수 있으면 회수가 안 먹은 것이다.
  select count(*) into v_open
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rls_auto_enable', 'nexon_resolve_boss_difficulties')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));
  if v_open > 0 then
    raise exception 'SECURITY DEFINER 함수 %건이 아직 공개 실행 가능합니다.', v_open;
  end if;

  -- ★ service_role 은 **살아 있어야** 한다. 같이 회수됐다면 동기화가 죽는다.
  if not has_function_privilege(
       'service_role',
       'public.nexon_resolve_boss_difficulties(jsonb)'::regprocedure,
       'execute') then
    raise exception 'service_role 의 실행 권한까지 회수됐습니다 — 동기화가 깨집니다.';
  end if;

  select count(*) into v_path
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('resolve_availability', 'shift_assignment_owner_matches_preset')
     and p.proconfig is null;
  if v_path > 0 then
    raise exception 'search_path 가 아직 비어 있는 함수가 %건 있습니다.', v_path;
  end if;

  raise notice '수용 인원 확장 마이그레이션 완료 — 인덱스 1, 권한 회수 2, search_path 2';
end $$;

select public.assert_no_public_sensitive_columns();
