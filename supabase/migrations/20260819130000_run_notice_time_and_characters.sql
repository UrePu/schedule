-- =============================================================================
-- 알림 문구: 시각 표기 `21:00` + 참가자 `본캐(부캐)` + 묶음 목록용 한 줄
-- =============================================================================
--
-- 발주 요구(원문, 2026-08-19):
--   "이거좀 보기 편하게좀 해줘라 21:00 그리고 부캐일경우엔 더저(메검메) 로 나와야지
--    (…) 4개 보스를 선택하면 4개를 묶어서 하나의 보스 일정으로 바꿔줘 21:00 ~ 22:00"
--
-- 이 마이그레이션이 책임지는 것은 앞의 둘(시각 표기·참가자 이름)과, 묶음 목록이 쓸
-- **시간 없는 한 줄**(`format_run_entry`)까지다. 묶는 규칙 자체(어디서 끊을 것인가)는
-- 화면마다 다를 수 있으므로 앱이 갖는다 — DB 는 재료를 주고 배치는 하지 않는다.
--
-- -----------------------------------------------------------------------------
-- 왜 문구를 여전히 DB 가 만드는가
-- -----------------------------------------------------------------------------
-- 마이그레이션 13-4 가 정한 규칙 그대로다: 웹 미리보기와 봇 발송이 같은 문자열을 써야
-- 하고, 앱에서 다시 조립하는 순간 둘이 갈라진다. 그래서 시각 표기를 바꾸는 일도
-- `format_kst_when` **한 곳**에서 끝난다 — 이 함수를 고치면 봇·푸시·웹 미리보기가
-- 동시에 따라온다.
--
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 시각 표기 — `21시20분` → `21:20`
-- -----------------------------------------------------------------------------
-- `21시20분` 은 자릿수가 들쭉날쭉해서 세 줄만 쌓여도 눈이 정렬을 못 잡는다.
-- `HH24:MI` 는 폭이 항상 5글자라 가변폭 글꼴에서도 줄이 나란히 읽힌다
-- (research-KAKAO-BOT §1.4 는 공백 패딩 정렬을 금지하므로, 정렬은 **표기 폭**으로만
--  얻을 수 있다).
--
-- ⚠️ 분이 0 일 때도 `:00` 을 **생략하지 않는다.** `21` 과 `21:20` 이 섞이면 폭이 다시
--    깨지고, 무엇보다 `21` 은 시각으로 읽히지 않는다.
create or replace function public.format_kst_when(p_at timestamptz, p_ref timestamptz)
returns text
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $$
  with v as (
    select public.kst_date(p_at) as d,
           (floor((extract(epoch from (p_at - to_timestamp(0))) + 32400) / 60)::bigint % 1440) as mod
  )
  select case
           when p_ref is not null and v.d = public.kst_date(p_ref) then ''
           else extract(month from v.d)::int::text || '/'
             || extract(day   from v.d)::int::text || '('
             || (array['월','화','수','목','금','토','일'])[extract(isodow from v.d)::int] || ') '
         end
      || lpad((v.mod / 60)::int::text, 2, '0') || ':'
      || lpad((v.mod % 60)::int::text, 2, '0')
  from v;
$$;

comment on function public.format_kst_when(timestamptz, timestamptz) is
  'KST 시각 표기. 기준일과 같은 날이면 시각만(`21:00`), 다른 날이면 `8/20(목) 19:30`. '
  '분이 0 이어도 `:00` 을 생략하지 않는다 — 표기 폭이 일정해야 목록이 정렬돼 보인다.';

-- -----------------------------------------------------------------------------
-- 2. 참가자 이름 — `본캐(부캐)`
-- -----------------------------------------------------------------------------
-- ★ 이 규칙의 **원본은 `src/lib/domain/participant-label.ts`** 다. 거기 머리말에
--   발주 원문("본캐 말고 부캐로 추가되는경우도 있어야함 (…) 더저(메검메)")과 표가 있다.
--   여기는 그 규칙의 **SQL 거울**이며, 한쪽을 고치면 반드시 다른 쪽도 고쳐야 한다.
--   왜 한 벌로 못 두는가: 웹은 타입이 붙은 행을 받아 화면에서 조합하고(본캐/부캐를 다른
--   굵기로 그린다), 봇 문구는 DB 가 소유한다. 두 실행 환경이 달라 공유가 불가능하다.
--
-- | 경우                      | 표시           |
-- |---------------------------|----------------|
-- | 정식 계정 · 본캐로 참여   | `더저`         |
-- | 정식 계정 · 부캐로 참여   | `더저(메검메)` |
-- | 정식 계정 · 캐릭터 미지정 | `더저`         |
-- | 게스트(닉네임만)          | `콜라이제없어` |
--
-- ⚠️ 본캐일 때 `더저(더저)` 로 쓰지 않는다. 괄호가 정보를 하나도 더하지 않으면서 줄만
--    길어지고, 평문 답장은 350자 예산 안에서 산다.
create or replace function public.participant_label(
  p_display_name   text,
  p_is_guest       boolean,
  p_character_name text,
  p_is_main        boolean
)
returns text
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $$
  select case
    -- 게스트는 app_users 도 characters 도 없다. 닉네임이 곧 정체성이다.
    when coalesce(p_is_guest, false)             then p_display_name
    when p_character_name is null                then p_display_name
    when coalesce(p_is_main, false)              then p_display_name
    -- 표시명과 같은 이름이면 괄호가 길이만 늘린다.
    when p_character_name = p_display_name       then p_display_name
    else p_display_name || '(' || p_character_name || ')'
  end;
$$;

comment on function public.participant_label(text, boolean, text, boolean) is
  '참가자 표시 이름 `본캐(부캐)`. src/lib/domain/participant-label.ts 의 SQL 거울이며 '
  '두 곳을 항상 함께 고쳐야 한다.';

-- -----------------------------------------------------------------------------
-- 3. 참가자 이름 목록 — 두 함수가 같은 조인을 쓰므로 하나로 뽑는다
-- -----------------------------------------------------------------------------
-- ★ **캐릭터는 `run_signups.character_id` → 없으면 `party_participants.character_id`**
--   순으로 떨어진다. 파티엔 메검메로 들어가 있어도 이 런만 다른 캐릭으로 나갈 수 있어
--   두 컬럼이 따로 있고(마이그레이션 03), 런에 지정이 없다는 것은 "파티 기본 캐릭으로
--   간다"는 뜻이지 "캐릭터가 없다"는 뜻이 아니다. 폴백을 빼면 실제로 참가 캐릭터가
--   정해져 있는 사람이 이름만 덩그러니 나온다.
create or replace function public.run_participant_names(
  p_run_id     uuid,
  p_max_names  integer default 4
)
returns text
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_names text[];
  v_total integer;
begin
  select array_agg(
           public.participant_label(
             pp.display_name,
             pp.guest_id is not null,
             ch.character_name,
             coalesce(ch.is_main, false)
           )
           order by pp.member_no
         ),
         count(*)
    into v_names, v_total
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
    left join public.characters ch
           on ch.id = coalesce(s.character_id, pp.character_id)
   where s.run_id = p_run_id and s.status = 'going';

  v_total := coalesce(v_total, 0);

  if v_total = 0 then
    return '모집중';
  elsif v_total > p_max_names then
    return array_to_string(v_names[1:p_max_names], ', ')
        || ' …외 ' || (v_total - p_max_names)::text || '명';
  else
    return array_to_string(v_names, ', ');
  end if;
end;
$$;

comment on function public.run_participant_names(uuid, integer) is
  '런 참가자(going) 이름 목록. 캐릭터는 run_signups → party_participants 순으로 떨어진다.';

-- -----------------------------------------------------------------------------
-- 4. 단건 알림 문구 — 이름 조합만 위 함수로 옮긴다
-- -----------------------------------------------------------------------------
-- 푸시(`created` · `remind`)는 여전히 **한 줄에 시각이 들어가야** 한다. 알림은 목록이
-- 아니라 낱개로 도착하므로 묶음 헤더가 없기 때문이다. 그래서 이 함수의 모양은 그대로 두고
-- 이름 부분만 갈아 끼운다.
create or replace function public.format_run_notice(
  p_run_id     uuid,
  p_kind       text default 'plain',
  p_now        timestamptz default now(),
  p_max_names  integer default 4
)
returns text
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_boss    text;
  v_sched   timestamptz;
  v_week    text;
  v_party   uuid;
  v_when    text;
  v_no      smallint;
  v_names_s text;
  v_line    text;
begin
  select bd.korean_name, r.scheduled_at, r.week_key, r.party_id
    into v_boss, v_sched, v_week, v_party
    from public.party_runs r
    join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
   where r.id = p_run_id;

  if not found then
    return null;
  end if;

  v_when := case
    when v_sched is null then '시간미정'
    else public.format_kst_when(v_sched, p_now)
  end;

  select n.party_no into v_no
    from public.party_room_numbers n
   where n.party_id = v_party and n.week_key = v_week;

  v_names_s := public.run_participant_names(p_run_id, p_max_names);

  v_line := v_when || ' '
         || case when v_no is not null then v_no::text || '파티 ' else '' end
         || v_boss
         || ' (' || v_names_s || ')';

  v_line := case p_kind
    when 'created' then '📌 ' || v_line
    when 'remind'  then '⏰ 30분 전' || chr(10) || v_line
    else v_line
  end;

  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$$;

comment on function public.format_run_notice(uuid, text, timestamptz, integer) is
  '런 알림 한 줄(시각 포함). 낱개로 도착하는 푸시용. 목록에는 format_run_entry 를 쓴다.';

-- -----------------------------------------------------------------------------
-- 5. 묶음 목록용 한 줄 — 시각 없이 `보스 : 이름들`
-- -----------------------------------------------------------------------------
-- 묶음 목록에서는 시각이 **헤더로 한 번** 나오므로(`21:00 ~ 22:00`) 줄마다 시각을
-- 되풀이하면 폭만 먹고 읽히지 않는다. 파티 번호도 마찬가지로 헤더가 갖는다.
--
-- 이름 상한이 단건(4)보다 큰 6 인 이유: 묶음은 같은 파티의 연속 런이라 **명단이 줄마다
-- 거의 같다.** 여기서 잘리면 "누가 빠졌는지"를 보려고 결국 웹을 열게 되는데, 그건 이
-- 요구의 출발점("웹 왔다갔다 하는 게 복잡하다")과 정면으로 어긋난다.
create or replace function public.format_run_entry(
  p_run_id     uuid,
  p_max_names  integer default 6
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

  v_line := v_boss || ' : ' || public.run_participant_names(p_run_id, p_max_names);

  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$$;

comment on function public.format_run_entry(uuid, integer) is
  '묶음 목록용 한 줄 `보스 : 이름들`. 시각·파티번호는 묶음 헤더가 갖는다.';

-- -----------------------------------------------------------------------------
-- 권한 — 문구 함수는 service_role 전용(기존 format_run_notice 와 같은 기조)
-- -----------------------------------------------------------------------------
-- 이 함수들은 참가자 실명 스냅샷을 조인해 문자열로 굽는다. 공개면에 필요한 값은 이미
-- `v_public_party_*` 뷰가 컬럼 단위로 통제해 내보내고 있으므로, 문자열로 우회하는 입구를
-- 따로 열어 줄 이유가 없다.
revoke all on function public.participant_label(text, boolean, text, boolean) from public;
revoke all on function public.participant_label(text, boolean, text, boolean) from anon;
revoke all on function public.participant_label(text, boolean, text, boolean) from authenticated;
grant execute on function public.participant_label(text, boolean, text, boolean) to service_role;

revoke all on function public.run_participant_names(uuid, integer) from public;
revoke all on function public.run_participant_names(uuid, integer) from anon;
revoke all on function public.run_participant_names(uuid, integer) from authenticated;
grant execute on function public.run_participant_names(uuid, integer) to service_role;

revoke all on function public.format_run_entry(uuid, integer) from public;
revoke all on function public.format_run_entry(uuid, integer) from anon;
revoke all on function public.format_run_entry(uuid, integer) from authenticated;
grant execute on function public.format_run_entry(uuid, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 자체 검증 — 고치기 전에 깨지는지 확인한다
-- -----------------------------------------------------------------------------
do $$
begin
  -- 같은 날이면 시각만, 분 0 도 `:00` 을 붙인다.
  if public.format_kst_when(timestamptz '2026-08-20 19:00+09', timestamptz '2026-08-20 12:00+09') <> '19:00' then
    raise exception 'format_kst_when 같은날 표기가 어긋납니다: %',
      public.format_kst_when(timestamptz '2026-08-20 19:00+09', timestamptz '2026-08-20 12:00+09');
  end if;

  -- 다른 날이면 날짜가 앞에 붙는다.
  if public.format_kst_when(timestamptz '2026-08-20 19:30+09', timestamptz '2026-08-17 12:00+09') <> '8/20(목) 19:30' then
    raise exception 'format_kst_when 타일 표기가 어긋납니다: %',
      public.format_kst_when(timestamptz '2026-08-20 19:30+09', timestamptz '2026-08-17 12:00+09');
  end if;

  -- 한 자리 시각도 두 자리로 채운다(폭 고정이 이 변경의 목적이다).
  if public.format_kst_when(timestamptz '2026-08-20 09:05+09', timestamptz '2026-08-20 12:00+09') <> '09:05' then
    raise exception 'format_kst_when 자릿수 채움이 어긋납니다: %',
      public.format_kst_when(timestamptz '2026-08-20 09:05+09', timestamptz '2026-08-20 12:00+09');
  end if;

  -- 참가자 이름 규칙 — participant-label.ts 의 표와 같은 네 경우.
  if public.participant_label('더저', false, '메검메', false) <> '더저(메검메)' then
    raise exception '부캐 표기가 어긋납니다';
  end if;
  if public.participant_label('더저', false, '더저', true) <> '더저' then
    raise exception '본캐 표기가 어긋납니다';
  end if;
  if public.participant_label('더저', false, null, false) <> '더저' then
    raise exception '캐릭터 미지정 표기가 어긋납니다';
  end if;
  if public.participant_label('콜라이제없어', true, '무시됨', false) <> '콜라이제없어' then
    raise exception '게스트 표기가 어긋납니다';
  end if;
  -- 캐릭터명이 표시명과 같으면 본캐 플래그와 무관하게 괄호를 붙이지 않는다.
  if public.participant_label('라온내일', false, '라온내일', false) <> '라온내일' then
    raise exception '동명 캐릭터 표기가 어긋납니다';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 이 마이그레이션은 테이블을 만들지 않지만 호출을 생략하지 않는다. 목적은 값의 민감도가
-- 아니라 **테이블 단위 GRANT 가 조용히 넓어지지 않았는지** 확인하는 것이다.
select public.assert_no_public_sensitive_columns();
