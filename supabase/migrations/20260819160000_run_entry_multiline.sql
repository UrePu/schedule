-- =============================================================================
-- 묶음 목록의 보스 줄을 두 줄로 — 가독성
-- =============================================================================
--
-- 발주 지시(2026-08-19), 원하는 모양을 직접 그려 보내 왔다:
--
--   ⏰ 21:40 ~ 22:40 · 1파티
--   ···············
--   익스트림 선택받은 세렌 :
--   더저(무르겨르), 라온내일
--
--   하드 최초의 대적자 :
--   더저(무르겨르), 라온내일
--
-- 보스 이름과 명단이 한 줄에 붙어 있으면 가변폭 글꼴에서 어디가 경계인지 눈이 못 잡는다.
-- 줄을 나누면 왼쪽 끝이 보스 이름으로 정렬돼 훑기가 쉬워진다.
--
-- ★ **앱에서 `" : "` 를 잘라 쓰지 않는다.** 문자열을 만드는 규칙은 계속 DB 가 갖는다 —
--   앱이 구분자를 파싱하기 시작하면 보스 이름에 콜론이 들어오는 날 조용히 깨지고,
--   그때 웹 미리보기와 봇이 갈라진다(마이그레이션 13-4 가 정한 규칙).
--
-- ⚠️ 기존 2인자 함수는 **지우고** 3인자로 다시 만든다. `create or replace` 는 인자 수가
--    다르면 교체가 아니라 **과부하 추가**라, 놔두면 옛 함수가 남아 호출자마다 다른 문구를
--    받게 된다.
-- =============================================================================

drop function if exists public.format_run_entry(uuid, integer);

create or replace function public.format_run_entry(
  p_run_id     uuid,
  p_max_names  integer default 6,
  p_multiline  boolean default false
)
returns text
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_boss  text;
  v_line  text;
begin
  select bd.korean_name
    into v_boss
    from public.party_runs r
    join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
   where r.id = p_run_id;

  if not found then
    return null;
  end if;

  v_line := v_boss
         || case when coalesce(p_multiline, false) then ' :' || chr(10) else ' : ' end
         || public.run_participant_names(p_run_id, p_max_names);

  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$$;

comment on function public.format_run_entry(uuid, integer, boolean) is
  '묶음 목록용 `보스 : 이름들`. p_multiline 이면 보스와 명단을 두 줄로 나눈다. '
  '시각·파티번호는 묶음 헤더가 갖는다.';

revoke all on function public.format_run_entry(uuid, integer, boolean) from public;
revoke all on function public.format_run_entry(uuid, integer, boolean) from anon;
revoke all on function public.format_run_entry(uuid, integer, boolean) from authenticated;
grant execute on function public.format_run_entry(uuid, integer, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 자체 검증 — 두 모드가 **같은 내용**을 말하는지 확인한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_run uuid;
  v_one text;
  v_two text;
begin
  select id into v_run from public.party_runs
   where cancelled_at is null and status <> 'cancelled' limit 1;
  if v_run is null then
    return; -- 검증할 런이 없으면 조용히 지나간다(빈 DB 에서도 마이그레이션은 성공해야 한다).
  end if;

  v_one := public.format_run_entry(v_run, 6, false);
  v_two := public.format_run_entry(v_run, 6, true);

  if position(chr(10) in v_one) > 0 then
    raise exception '한 줄 모드에 개행이 들어갔습니다: %', v_one;
  end if;
  if position(chr(10) in v_two) = 0 then
    raise exception '두 줄 모드에 개행이 없습니다: %', v_two;
  end if;
  if replace(v_two, ' :' || chr(10), ' : ') <> v_one then
    raise exception '두 모드의 내용이 다릅니다: % / %', v_one, v_two;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
select public.assert_no_public_sensitive_columns();
