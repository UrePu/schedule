-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 캐릭터 **지난날 경험치** 기록 — 봇 `!%` 를 1콜로 답하게 한다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-11-18): *"저장하는게 낫지 / 오래걸리잖아"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 저장하는가
-- ───────────────────────────────────────────────────────────────────────────────
-- `!%` 는 7일치 경험치를 보여 준다. 넥슨 `/character/basic?date=D` 는 **하루치만** 주므로
-- 지난 6일 + 오늘 = 7콜이고, 키당 250ms 간격(개발 키 5콜/초 안쪽)이라 답장까지 최소 1.5초가
-- 든다. 그런데 **지난 날짜(D ≤ 어제)의 값은 확정값이라 다시 바뀌지 않는다.** 한 번 받은 날은
-- 여기 적어 두고, 다음부터는 넥슨에 **최신 1콜**만 묻는다. 매시 :50 크론이 추적 캐릭터의
-- 어제 행을 미리 채우므로 처음 치는 `!%` 도 대개 1콜이다
-- (`src/features/characters/server/exp-daily-fill.ts`).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 설계 규칙
-- ───────────────────────────────────────────────────────────────────────────────
--   · **기본키는 자체 uuid 다.** ocid 는 넥슨이 가변값이라고 적어 둔 값이라(CLAUDE.md §1.1)
--     PK 로 쓰지 않는다. 조회 열쇠는 `(ocid, day)` 유니크다 — 넥슨이 ocid 를 바꾸면 새 ocid 로
--     새로 쌓일 뿐 옛 행이 틀린 값을 말하지는 않는다.
--   · `day` 는 **KST 기준일** = 넥슨 `date` 파라미터에 넘긴 값 그대로다.
--   · **오늘(KST) 이상의 날짜는 저장하지 않는다.** 아직 바뀌는 값이다. CHECK 로는 못 막는다
--     (`now()` 는 불변 함수가 아니다) — 쓰는 쪽(`exp-daily-store.ts`)이 강제한다.
--   · `exp_rate` 는 **넥슨이 준 문자열 그대로**(`"7.143"`). 답장이 그 문자열을 다시 찍지 않고
--     그대로 쓰므로 숫자로 바꿔 담으면 `7.14` 처럼 자릿수가 흔들린다.
--   · 보존 기한은 두지 않았다. 캐릭터당 하루 한 행이고 `!%` 는 7일보다 오래된 행을 읽지 않는다.
--     쌓인 양이 문제가 되면 `day` 기준으로 지우면 된다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 권한 — **service_role 전용**
-- ───────────────────────────────────────────────────────────────────────────────
-- 값 자체는 넥슨이 누구에게나 주는 공개 정보지만, 이 표에는 **ocid**(가변 식별자)가 들어 있고
-- 화면이 이 표를 읽을 일이 없다. 읽기·쓰기 모두 서버(봇 · 크론)만 한다. 그래서
-- `character_looks`(공개 읽기 6칸 · 쓰기 service_role)와 달리 **anon/authenticated 에는 어떤
-- GRANT 도 없고, 네 동작 모두 거부 정책을 명시한다.**
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. 표
-- #############################################################################

create table if not exists public.character_exp_daily (
  id              uuid primary key default gen_random_uuid(),
  ocid            text not null check (ocid <> ''),
  day             date not null,
  character_name  text,
  world_name      text,
  character_level int not null check (character_level >= 1),
  character_exp   bigint not null check (character_exp >= 0),
  exp_rate        text not null check (exp_rate ~ '^[0-9]+(\.[0-9]+)?$'),
  fetched_at      timestamptz not null default now(),
  constraint character_exp_daily_ocid_day_key unique (ocid, day)
);

comment on table public.character_exp_daily is
  '넥슨 /character/basic?date=D 로 받은 **지난날(KST, 어제까지)** 경험치. 확정값이라 다시 받지 않는다. '
  '봇 !% 가 7콜 대신 최신 1콜로 답하게 하는 저장소이며, 매시 :50 크론이 추적 캐릭터의 어제 행을 채운다. '
  'service_role 전용(anon/authenticated 권한 없음).';
comment on column public.character_exp_daily.id is '자체 기본키. ocid 는 가변값이라 PK 로 쓰지 않는다(§1.1).';
comment on column public.character_exp_daily.ocid is
  '조회 열쇠(day 와 함께 유니크). 넥슨 가변값 — 식별자로 믿지 말 것.';
comment on column public.character_exp_daily.day is
  'KST 기준일 = 넥슨 date 파라미터. 오늘 이상은 저장하지 않는다(쓰는 쪽이 강제).';
comment on column public.character_exp_daily.character_name is '그날 응답의 character_name(표시용).';
comment on column public.character_exp_daily.world_name is '그날 응답의 world_name(표시용).';
comment on column public.character_exp_daily.character_level is '그날 응답의 character_level.';
comment on column public.character_exp_daily.character_exp is '그날 응답의 character_exp(현재 레벨에서 보유한 경험치).';
comment on column public.character_exp_daily.exp_rate is
  '그날 응답의 character_exp_rate — 넥슨 문자열 그대로(예: 7.143). 숫자로 바꾸지 않는다.';
comment on column public.character_exp_daily.fetched_at is '넥슨에서 받아 적은 시각.';


-- #############################################################################
-- 2. RLS — service_role 전용, 공개 역할은 네 동작 모두 거부를 명시
-- #############################################################################

alter table public.character_exp_daily enable row level security;

/*
  Supabase 는 public 스키마의 새 표에 anon/authenticated 기본 권한을 준다. 그래서 **명시적으로
  걷는다.** 이 표는 화면이 읽지 않으므로 컬럼 단위 공개 목록도 없다.
*/
revoke all on table public.character_exp_daily from anon;
revoke all on table public.character_exp_daily from authenticated;
grant all on table public.character_exp_daily to service_role;

drop policy if exists character_exp_daily_no_public_select on public.character_exp_daily;
create policy character_exp_daily_no_public_select on public.character_exp_daily
  as permissive for select to anon, authenticated using (false);

drop policy if exists character_exp_daily_no_public_insert on public.character_exp_daily;
create policy character_exp_daily_no_public_insert on public.character_exp_daily
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists character_exp_daily_no_public_update on public.character_exp_daily;
create policy character_exp_daily_no_public_update on public.character_exp_daily
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists character_exp_daily_no_public_delete on public.character_exp_daily;
create policy character_exp_daily_no_public_delete on public.character_exp_daily
  as permissive for delete to anon, authenticated using (false);

drop policy if exists character_exp_daily_service_role_all on public.character_exp_daily;
create policy character_exp_daily_service_role_all on public.character_exp_daily
  as permissive for all to service_role using (true) with check (true);


-- #############################################################################
-- 3. 자기검증
-- #############################################################################

do $$
declare
  v_rls boolean;
begin
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.character_exp_daily'::regclass;
  if v_rls is not true then
    raise exception 'character_exp_daily 에 RLS 가 켜져 있지 않습니다.';
  end if;

  -- 공개 역할에는 읽기도 쓰기도 없어야 한다.
  if has_table_privilege('anon', 'public.character_exp_daily', 'SELECT')
     or has_table_privilege('authenticated', 'public.character_exp_daily', 'SELECT')
     or has_table_privilege('anon', 'public.character_exp_daily', 'INSERT')
     or has_table_privilege('authenticated', 'public.character_exp_daily', 'INSERT')
     or has_table_privilege('anon', 'public.character_exp_daily', 'UPDATE')
     or has_table_privilege('authenticated', 'public.character_exp_daily', 'UPDATE')
     or has_table_privilege('anon', 'public.character_exp_daily', 'DELETE')
     or has_table_privilege('authenticated', 'public.character_exp_daily', 'DELETE')
  then
    raise exception 'character_exp_daily 에 공개 권한이 남아 있습니다.';
  end if;

  -- 컬럼 단위로 열린 것도 없어야 한다(테이블 권한을 걷어도 컬럼 GRANT 는 따로 남는다).
  if has_column_privilege('anon', 'public.character_exp_daily', 'ocid', 'SELECT')
     or has_column_privilege('authenticated', 'public.character_exp_daily', 'ocid', 'SELECT')
  then
    raise exception 'character_exp_daily.ocid 가 공개 역할에 노출되었습니다.';
  end if;

  raise notice 'character_exp_daily 생성 완료 — service_role 전용';
end $$;

select public.assert_no_public_sensitive_columns();
