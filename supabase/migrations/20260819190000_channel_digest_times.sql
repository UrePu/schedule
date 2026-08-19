-- =============================================================================
-- 방 정기 알림 시각 — `!알림 09시` · `!알림 18시`
-- =============================================================================
--
-- 발주 지시(2026-08-19): *"!알림 09시 !알림 18시 이런것도 만들어줘."*
--
-- 앞서 만든 `parties.reminder_minutes` 와는 **다른 축**이다.
--
--   parties.reminder_minutes   런 **하나**에 대해 "몇 분 전"   → 런마다 발생
--   bot_channels.digest_minutes 방에 대해 "하루 중 몇 시"       → 하루에 정해진 횟수
--
-- 그래서 파티가 아니라 **방**에 붙는다. "아침 9시에 오늘 뭐 있는지 알려줘"는 특정 파티의
-- 성질이 아니라 그 방의 습관이고, 방에 파티가 여럿이면 한 번에 모아 보는 것이 맞다.
--
-- ★ 값은 **KST 자정 기준 분**이다(09:00 = 540). `time` 타입을 쓰지 않은 이유는
--   `availability_patterns` · `availability_exceptions` 가 이미 분 단위 정수를 쓰고 있어서다
--   — 시간 표현이 두 종류가 되면 변환이 곳곳에 생긴다.
-- =============================================================================

create or replace function public.valid_digest_minutes(p_minutes smallint[])
returns boolean
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $$
  select p_minutes is not null
     -- 빈 배열은 `array_ndims` 가 null 이다. 그 경우만 null 을 허용해 빈 배열을 통과시킨다.
     and array_ndims(p_minutes) is not distinct from
         (case when coalesce(cardinality(p_minutes), 0) = 0 then null else 1 end)
     and coalesce(cardinality(p_minutes), 0) <= 5
     and not exists (
       select 1 from unnest(p_minutes) m where m < 0 or m > 1439
     )
     and coalesce(cardinality(p_minutes), 0)
         = (select count(distinct m) from unnest(p_minutes) m);
$$;

comment on function public.valid_digest_minutes(smallint[]) is
  '정기 알림 시각 배열이 쓸 수 있는 값인가. 최대 5개, 각 0~1439(자정 기준 분), 중복 없음.';

alter table public.bot_channels
  add column if not exists digest_minutes smallint[] not null default '{}';

alter table public.bot_channels
  drop constraint if exists bot_channels_digest_minutes_valid;
alter table public.bot_channels
  add constraint bot_channels_digest_minutes_valid
  check (public.valid_digest_minutes(digest_minutes));

comment on column public.bot_channels.digest_minutes is
  'KST 자정 기준 분. 그 시각에 이 방의 그날 일정을 한 번 보낸다. 빈 배열이면 보내지 않음.';

-- -----------------------------------------------------------------------------
-- 자체 검증
-- -----------------------------------------------------------------------------
do $$
begin
  if not public.valid_digest_minutes('{}'::smallint[]) then
    raise exception '빈 배열이 유효해야 합니다';
  end if;
  if not public.valid_digest_minutes('{540,1080}'::smallint[]) then
    raise exception '09:00 / 18:00 이 유효해야 합니다';
  end if;
  if public.valid_digest_minutes('{1440}'::smallint[]) then
    raise exception '1440 이 통과했습니다';
  end if;
  if public.valid_digest_minutes('{540,540}'::smallint[]) then
    raise exception '중복이 통과했습니다';
  end if;
  if public.valid_digest_minutes('{-1}'::smallint[]) then
    raise exception '음수가 통과했습니다';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- ⚠️ `bot_channels` 에 컬럼을 **추가**했다. 이 표는 anon 에 절대 열리면 안 되는 값
--    (`secret_hash` · `room`)을 들고 있으므로 확인을 생략하지 않는다.
select public.assert_no_public_sensitive_columns();
