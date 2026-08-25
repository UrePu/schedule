-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 수요일 밤 **10분 스윕** — 목요일 초기화에 쓸려 가기 전에 훑는다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-25): *"수요일은 11시부터 10분마다 강제로 돌게할수있음?"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 Vercel 이 아니라 여기인가
-- ───────────────────────────────────────────────────────────────────────────────
-- **Vercel Hobby 크론은 이 간격을 만들 수 없다.** 최소 간격이 **하루 1회**이고 정밀도가
-- **시간 단위**(공식 문서: `0 1 * * *` 는 1:00~1:59 사이 아무 때나 뜬다)라, `*/10` 자체가
-- 거절된다. 그래서 10분 간격은 **이미 24시간 켜져 있는 것**에 맡긴다 — Postgres 다.
--
-- ⚠️ `vercel.json` 의 `0 14 * * 3` 은 **지우지 않는다.** pg_cron 이 꺼져 있거나 vault 비밀이
--    비어 있어도 수요일에 최소 한 번은 돌게 하는 보험이다. 둘 다 같은 `preReset` 슬롯을
--    쓰므로 명목 시각(수 23:00 KST)이 갈리지 않는다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 시각 계산 — `*/10 14 * * 3` 은 UTC 다
-- ───────────────────────────────────────────────────────────────────────────────
-- pg_cron 은 `cron.timezone`(Supabase 기본 **UTC**)으로 해석한다.
--   14:00~14:50 UTC = **23:00~23:50 KST**, 그리고 14:00 UTC 수요일 = 23:00 KST 수요일이라
--   요일 필드 `3` 이 양쪽에서 같은 날을 가리킨다(14+9 = 23 < 24).
-- 마지막 회차 23:50 이 보는 넥슨 스냅샷은 ~15분 전이므로 **대략 23:35까지**를 덮는다.
-- 그 뒤는 런 종료 후 자동 동기화와 화면의 '클리어 확인' 버튼이 맡는다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 적용 뒤 **한 번은 사람이 해야 한다** — 비밀은 이 파일에 적을 수 없다
-- ───────────────────────────────────────────────────────────────────────────────
-- 이 마이그레이션은 배관만 깐다. 아래 두 값이 vault 에 없으면 함수는 **조용히 아무것도
-- 하지 않는다**(예외를 던지면 크론 로그만 매주 더럽힌다). Supabase SQL Editor 에서 1회:
--
--   select vault.create_secret('https://mapleschedule.vercel.app', 'app_base_url');
--   select vault.create_secret('<Vercel 의 CRON_SECRET 값>',       'cron_secret');
--
-- 값을 바꿀 때는 `vault.update_secret(id, new_secret)`. 이 파일에 값을 적으면 그 순간
-- 저장소에 평문 비밀이 커밋된다.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 웹 동기화 라우트를 두드리는 함수 ─────────────────────────────────────────
create or replace function public.trigger_web_sync(p_slot text default 'preReset')
returns bigint
language plpgsql
security definer
set search_path to 'public', 'net', 'vault', 'pg_temp'
as $function$
declare
  v_base    text;
  v_secret  text;
  v_request bigint;
begin
  /*
    슬롯 이름을 **화이트리스트로 잠근다.** 이 값은 그대로 URL 쿼리에 들어가므로, 자유
    문자열이면 이 함수가 임의 경로를 부르는 도구가 된다. 목록은 `nightly-sync.ts` 의
    `CRON_SLOTS` 와 같은 값이어야 한다.
  */
  if p_slot not in ('nightly', 'preReset') then
    raise exception '알 수 없는 크론 슬롯입니다: %', p_slot
      using errcode = 'invalid_parameter_value';
  end if;

  select decrypted_secret into v_base
    from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron_secret';

  -- 비밀이 아직 없다 = 설치가 안 끝났다. 실패가 아니라 **대기 상태**로 다룬다.
  if v_base is null or v_secret is null then
    raise notice 'trigger_web_sync: vault 에 app_base_url / cron_secret 이 없어 건너뜁니다.';
    return null;
  end if;

  /*
    pg_net 은 **비동기**다 — 요청을 큐에 넣고 즉시 id 를 돌려준다. 응답은
    `net._http_response` 에 남는다. 동기화 한 판이 실측 ~22초라 기본 5초 타임아웃으로는
    커넥션이 먼저 끊긴다. 끊겨도 Vercel 쪽 실행은 계속되지만, 그러면 로그에 남는 것이
    전부 타임아웃이라 **성공했는지 확인할 방법이 사라진다.**
  */
  select net.http_get(
           url := v_base || '/api/cron/sync?slot=' || p_slot,
           headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
           timeout_milliseconds := 55000
         )
    into v_request;

  return v_request;
end;
$function$;

comment on function public.trigger_web_sync(text) is
  'pg_cron 이 웹의 /api/cron/sync 를 두드린다. vault 의 app_base_url · cron_secret 을 쓴다. '
  '보안 정의자 함수이고 실행 권한은 postgres 에만 있다 — 누구나 부를 수 있으면 남의 '
  '넥슨 쿼터를 태우는 문이 된다.';

/*
  ★ Postgres 는 함수에 **기본으로 PUBLIC EXECUTE 를 준다.** 이 함수는 vault 비밀을 읽고
    외부로 HTTP 를 내보내므로, 회수하지 않으면 anon 키만 있어도 부를 수 있다.
*/
revoke all on function public.trigger_web_sync(text) from public;
revoke all on function public.trigger_web_sync(text) from anon, authenticated;

-- ── 스케줄 ───────────────────────────────────────────────────────────────────
-- 재적용이 안전해야 하므로 같은 이름이 있으면 먼저 내린다(cron.schedule 은 같은 이름을
-- 덮어쓰지만, 식이 바뀌었을 때의 동작을 버전에 맡기지 않는다).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pre-reset-sweep') then
    perform cron.unschedule('pre-reset-sweep');
  end if;
end $$;

select cron.schedule(
  'pre-reset-sweep',
  '*/10 14 * * 3',                      -- 수요일 23:00~23:50 KST, 10분 간격
  $cron$select public.trigger_web_sync('preReset');$cron$
);

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_schedule text;
begin
  select schedule into v_schedule from cron.job where jobname = 'pre-reset-sweep';
  if v_schedule is null then
    raise exception 'pre-reset-sweep 크론이 등록되지 않았습니다.';
  end if;
  if v_schedule <> '*/10 14 * * 3' then
    raise exception 'pre-reset-sweep 크론 식이 예상과 다릅니다: %', v_schedule;
  end if;

  -- 실행 권한이 남아 있으면 이 함수는 공개된 SSRF 창구다. 반드시 0 이어야 한다.
  if has_function_privilege('anon', 'public.trigger_web_sync(text)', 'execute')
     or has_function_privilege('authenticated', 'public.trigger_web_sync(text)', 'execute')
  then
    raise exception 'trigger_web_sync 실행 권한이 anon/authenticated 에 남아 있습니다.';
  end if;

  raise notice '수요일 10분 스윕 등록 완료 — vault 비밀(app_base_url · cron_secret)만 넣으면 동작합니다.';
end $$;

select public.assert_no_public_sensitive_columns();
