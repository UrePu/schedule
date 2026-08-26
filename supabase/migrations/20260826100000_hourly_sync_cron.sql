-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 동기화를 **매시 50분**으로 — 밤 크론과 수요일 스윕을 걷어낸다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-25): *"밤 11시 크론 없애고 그냥 매 시간 50분에 크론돌리는게
-- 낫지않나? 결국 아침에 돈사람들은 자동으로 !결정석 했을때 못보네"*
--
-- 정확한 지적이다. 밤에만 돌면 아침에 잡은 보스가 **그날 밤까지 어디에도 안 보인다** —
-- `!결정석`·수익 화면·체크리스트가 전부 하루 늦는다. 동기화는 "하루를 마감하는 일"이
-- 아니라 "따라가는 일"이라 주기가 짧을수록 맞다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 값이 싸다 — 실측 2026-08-26
-- ───────────────────────────────────────────────────────────────────────────────
-- · **저장 공간 0 증가.** `character_scheduler_snapshots.snapshot_at` 은 넥슨 관측일
--   (그날 00:00 KST)이라 `on conflict (character_id, snapshot_at)` 이 **하루 한 행을
--   덮어쓴다.** 실측으로 8/24~8/26 각 날짜의 `distinct snapshot_at` 이 1이고 행 수가
--   캐릭터 수와 같다. 24배로 돌려도 행은 그대로다.
-- · 넥슨 호출은 자격증명마다 `캐릭터 수 × 24`. 가장 큰 키가 6캐릭이라 144/일이고
--   개발 키 한도는 1,000/일이다. 12칸이 찬 캐릭터는 `selectCandidates` 가 건너뛴다.
-- · 실행 시간 회당 ~11초(배치 RPC 도입 후) → 하루 4~5분.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 걷어내는 것과 그 이유
-- ───────────────────────────────────────────────────────────────────────────────
-- · **수요일 10분 스윕**(`pre-reset-sweep`, `*/10 14 * * 3`) — 목요일 초기화 직전을
--   훑으려고 만든 것이다. 매시 도는 지금은 마지막 pre-reset 실행이 **수 23:50** 이고
--   그게 같은 일을 한다. 남겨 두면 수요일에만 두 스케줄이 겹쳐 돈다.
-- · **Vercel 크론 두 개**(`vercel.json`) — 같은 이유로 함께 걷어낸다.
--   ⚠️ 그 결과 **pg_cron 이 유일한 스케줄러**가 된다. pg_net 이 죽으면 동기화가 통째로
--      멈추고 아무도 알려 주지 않는다. 확인하려면 `net._http_response` 의 최근 행을 보면
--      된다(`status_code = 200` 이 매시 쌓여야 한다).
--
-- ★ 슬롯 화이트리스트를 `('nightly','hourly')` 로 바꾼다. `preReset` 은 예약된 곳이
--   없어지므로 뺀다 — 부를 수 없는 이름을 남겨 두면 다음 사람이 그게 도는 줄 안다.

create or replace function public.trigger_web_sync(p_slot text default 'hourly')
returns bigint
language plpgsql
security definer
set search_path to 'public', 'net', 'pg_temp'
as $function$
declare
  v_base    text;
  v_token   text;
  v_request bigint;
begin
  -- 이 값은 그대로 URL 쿼리에 들어간다. 자유 문자열이면 임의 경로를 부르는 도구가 된다.
  if p_slot not in ('nightly', 'hourly') then
    raise exception '알 수 없는 크론 슬롯입니다: %', p_slot
      using errcode = 'invalid_parameter_value';
  end if;

  select decrypted_secret into v_base
    from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'cron_secret';

  -- 비밀이 아직 없다 = 설치가 안 끝났다. 실패가 아니라 **대기 상태**로 다룬다.
  if v_base is null or v_token is null then
    raise notice 'trigger_web_sync: vault 비밀이 없어 건너뜁니다.';
    return null;
  end if;

  select net.http_get(
           url := v_base || '/api/cron/sync?slot=' || p_slot,
           headers := jsonb_build_object('Authorization', 'Bearer ' || v_token),
           timeout_milliseconds := 55000
         )
    into v_request;

  return v_request;
end;
$function$;

revoke all on function public.trigger_web_sync(text) from public;
revoke all on function public.trigger_web_sync(text) from anon, authenticated;

-- ── 스케줄 교체 ──────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pre-reset-sweep') then
    perform cron.unschedule('pre-reset-sweep');
  end if;
  if exists (select 1 from cron.job where jobname = 'hourly-sync') then
    perform cron.unschedule('hourly-sync');
  end if;
end $$;

/*
  `50 * * * *` — 매시 50분. KST 는 UTC+9 **정시 오프셋**이라 분이 같고, 그래서 한국
  기준으로도 매시 50분이다. 50분인 이유: 넥슨 데이터가 ~15분 늦으므로 정시에 돌면
  직전 45분을 못 본다. 50분에 돌면 그 시각 기준 ~35분까지가 잡힌다.
*/
select cron.schedule(
  'hourly-sync',
  '50 * * * *',
  $cron$select public.trigger_web_sync('hourly');$cron$
);

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_schedule text;
begin
  select schedule into v_schedule from cron.job where jobname = 'hourly-sync';
  if v_schedule is distinct from '50 * * * *' then
    raise exception 'hourly-sync 크론 식이 예상과 다릅니다: %', coalesce(v_schedule, '(없음)');
  end if;

  if exists (select 1 from cron.job where jobname = 'pre-reset-sweep') then
    raise exception '수요일 스윕이 아직 남아 있습니다 — 매시 크론과 겹쳐 돕니다.';
  end if;

  if has_function_privilege('anon', 'public.trigger_web_sync(text)', 'execute')
     or has_function_privilege('authenticated', 'public.trigger_web_sync(text)', 'execute')
  then
    raise exception 'trigger_web_sync 실행 권한이 anon/authenticated 에 남아 있습니다.';
  end if;

  raise notice '매시 50분 동기화로 교체 완료';
end $$;

select public.assert_no_public_sensitive_columns();
