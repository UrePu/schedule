-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 캐릭터 **데이터 없는 날** 기록 — 봇 `!ㄼ` 가 같은 빈 날을 다시 찌르지 않게 한다
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 지휘 결정(2026-11-18, `!ㄼ` 교차 검증 D3).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 필요한가
-- ───────────────────────────────────────────────────────────────────────────────
-- `!ㄼ`(레벨업 날짜)는 넥슨 `/character/basic?date=D` 를 날짜별로 찔러 레벨이 처음 오른 날을 찾는다.
-- 넥슨 데이터는 캐릭터마다 **하한일(2023-12-21)보다 늦게 시작**하는 경우가 있다(실측: 새스링은
-- 2023-12-21 ~ 2024-02-01 이 200 이지만 값이 전부 null). 그런 날은 "데이터 없음"이라는 **확정된 답**인데,
-- 값 있는 날만 담는 `character_exp_daily` 에는 넣을 수 없어 인스턴스 메모리에만 남았고, 그래서 새
-- 인스턴스에서 다시 칠 때마다 같은 빈 날을 6~11콜씩 다시 찔렀다(교차 검증 실측). 여기 적어 두면
-- 다음 `!ㄼ` 는 이 표와 `character_exp_daily` 만으로 이어 찾는다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 `character_exp_daily` 를 고치지 않고 따로 두는가
-- ───────────────────────────────────────────────────────────────────────────────
-- 본 표의 `character_level` · `character_exp` · `exp_rate` 는 NOT NULL 이다. 빈 날을 담으려고 이를 null
-- 허용으로 바꾸면 그 표를 읽는 **모든 경로**(`!%` 의 7일 · 매시 :50 크론 채우기 · `!ㄼ` 표본)가 null 행을
-- 거르는 조건을 새로 가져야 하고, 하나라도 빠뜨리면 빈 날이 레벨 0 처럼 읽힌다. 빈 날은 `!ㄼ` 만 쓰는
-- 사실이라 그 명령이 따로 읽는 표로 둔다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 설계 규칙
-- ───────────────────────────────────────────────────────────────────────────────
--   · **기본키는 자체 uuid 다.** ocid 는 넥슨이 가변값이라고 적어 둔 값이라(CLAUDE.md §1.1) PK 로 쓰지
--     않는다. 조회 열쇠는 `(ocid, day)` 유니크다.
--   · `day` 는 **KST 기준일** = 넥슨 `date` 파라미터에 넘긴 값 그대로다.
--   · 담는 것: 빈 200 응답 · `invalid_parameter`(범위 밖 · 생성 전) · `invalid_id` 로 온 날 중
--     **어제보다 이른 날만.** `data_not_ready`(전날 기록이 아직 안 들어옴)와 어제는 담지 않는다 — 몇 시간
--     뒤 값이 생길 수 있다. 규칙은 쓰는 쪽(`exp-daily-store.saveEmptyDays`)이 강제한다(`now()` 는 불변
--     함수가 아니라 CHECK 로 막을 수 없다).
--   · `reason` 은 빈 까닭이다 — `before_creation`(넥슨이 날짜를 OPENAPI00004 로 거절: 캐릭터가 없던 날)과
--     `no_data`(빈 200 등). 봇이 "넥슨에 지난 기록이 아직 없어요"라고 말할 근거는 앞의 것뿐이다(교차 검증 R2-6:
--     최근 빈 날 묶음만 보고 그렇게 말하면 그 앞에 숨은 값 있는 날을 놓친다).
--   · 보존 기한은 두지 않았다. 캐릭터당 데이터가 시작하기 전의 날 몇 개(이분 탐색이 찌른 것)뿐이다. 대신 봇은
--     `checked_at` 이 30일보다 오래된 행을 믿지 않고 다시 찌른다(일시적인 빈 응답이 영구히 굳지 않게).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 권한 — **service_role 전용** (`character_exp_daily` 와 같은 모양)
-- ───────────────────────────────────────────────────────────────────────────────
-- 화면이 이 표를 읽을 일이 없고 ocid(가변 식별자)가 들어 있다. 읽기·쓰기 모두 서버(봇)만 한다. 그래서
-- **anon/authenticated 에는 어떤 GRANT 도 없고, 네 동작 모두 거부 정책을 명시한다.**
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. 표
-- #############################################################################

create table if not exists public.character_exp_empty_days (
  id          uuid primary key default gen_random_uuid(),
  ocid        text not null check (ocid <> ''),
  day         date not null,
  reason      text not null default 'no_data' check (reason in ('no_data', 'before_creation')),
  checked_at  timestamptz not null default now(),
  constraint character_exp_empty_days_ocid_day_key unique (ocid, day)
);

comment on table public.character_exp_empty_days is
  '넥슨 /character/basic?date=D 가 **데이터 없음**으로 답한 날(KST, 어제보다 이른 날만). '
  '봇 !ㄼ 가 같은 빈 날을 다시 찌르지 않게 하는 기록이며, 값 있는 날은 character_exp_daily 에 있다. '
  'service_role 전용(anon/authenticated 권한 없음).';
comment on column public.character_exp_empty_days.id is '자체 기본키. ocid 는 가변값이라 PK 로 쓰지 않는다(§1.1).';
comment on column public.character_exp_empty_days.ocid is
  '조회 열쇠(day 와 함께 유니크). 넥슨 가변값 — 식별자로 믿지 말 것.';
comment on column public.character_exp_empty_days.day is
  'KST 기준일 = 넥슨 date 파라미터. 어제 이상은 저장하지 않는다(쓰는 쪽이 강제).';
comment on column public.character_exp_empty_days.reason is
  'before_creation = 넥슨이 그 날짜를 유효하지 않은 파라미터(OPENAPI00004)로 거절 — 캐릭터가 없던 날. '
  'no_data = 빈 200 등. 봇은 before_creation 만을 "지난 기록 없음"의 근거로 쓴다(빈 응답은 중간 구멍일 수 있다).';
comment on column public.character_exp_empty_days.checked_at is
  '넥슨이 데이터 없음으로 답한 것을 마지막으로 적은 시각. 봇은 30일(EMPTY_DAY_TRUST_DAYS)보다 오래된 행을 믿지 않고 '
  '다시 찌른다 — 일시적인 빈 응답이 영구히 굳지 않게.';


-- #############################################################################
-- 2. RLS — service_role 전용, 공개 역할은 네 동작 모두 거부를 명시
-- #############################################################################

alter table public.character_exp_empty_days enable row level security;

/*
  Supabase 는 public 스키마의 새 표에 anon/authenticated 기본 권한을 준다. 그래서 **명시적으로
  걷는다.** 이 표는 화면이 읽지 않으므로 컬럼 단위 공개 목록도 없다.
*/
revoke all on table public.character_exp_empty_days from anon;
revoke all on table public.character_exp_empty_days from authenticated;
grant all on table public.character_exp_empty_days to service_role;

drop policy if exists character_exp_empty_days_no_public_select on public.character_exp_empty_days;
create policy character_exp_empty_days_no_public_select on public.character_exp_empty_days
  as permissive for select to anon, authenticated using (false);

drop policy if exists character_exp_empty_days_no_public_insert on public.character_exp_empty_days;
create policy character_exp_empty_days_no_public_insert on public.character_exp_empty_days
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists character_exp_empty_days_no_public_update on public.character_exp_empty_days;
create policy character_exp_empty_days_no_public_update on public.character_exp_empty_days
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists character_exp_empty_days_no_public_delete on public.character_exp_empty_days;
create policy character_exp_empty_days_no_public_delete on public.character_exp_empty_days
  as permissive for delete to anon, authenticated using (false);

drop policy if exists character_exp_empty_days_service_role_all on public.character_exp_empty_days;
create policy character_exp_empty_days_service_role_all on public.character_exp_empty_days
  as permissive for all to service_role using (true) with check (true);


-- #############################################################################
-- 3. 자기검증
-- #############################################################################

do $$
declare
  v_rls boolean;
begin
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.character_exp_empty_days'::regclass;
  if v_rls is not true then
    raise exception 'character_exp_empty_days 에 RLS 가 켜져 있지 않습니다.';
  end if;

  -- 공개 역할에는 읽기도 쓰기도 없어야 한다.
  if has_table_privilege('anon', 'public.character_exp_empty_days', 'SELECT')
     or has_table_privilege('authenticated', 'public.character_exp_empty_days', 'SELECT')
     or has_table_privilege('anon', 'public.character_exp_empty_days', 'INSERT')
     or has_table_privilege('authenticated', 'public.character_exp_empty_days', 'INSERT')
     or has_table_privilege('anon', 'public.character_exp_empty_days', 'UPDATE')
     or has_table_privilege('authenticated', 'public.character_exp_empty_days', 'UPDATE')
     or has_table_privilege('anon', 'public.character_exp_empty_days', 'DELETE')
     or has_table_privilege('authenticated', 'public.character_exp_empty_days', 'DELETE')
  then
    raise exception 'character_exp_empty_days 에 공개 권한이 남아 있습니다.';
  end if;

  -- 컬럼 단위로 열린 것도 없어야 한다(테이블 권한을 걷어도 컬럼 GRANT 는 따로 남는다).
  if has_column_privilege('anon', 'public.character_exp_empty_days', 'ocid', 'SELECT')
     or has_column_privilege('authenticated', 'public.character_exp_empty_days', 'ocid', 'SELECT')
  then
    raise exception 'character_exp_empty_days.ocid 가 공개 역할에 노출되었습니다.';
  end if;

  raise notice 'character_exp_empty_days 생성 완료 — service_role 전용';
end $$;

select public.assert_no_public_sensitive_columns();
