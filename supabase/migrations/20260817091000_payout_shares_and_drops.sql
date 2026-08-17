-- =============================================================================
-- M_Schedule · 10. 수익 분배(share) + 기타 드랍 수익
-- =============================================================================
-- 발주자 추가 요구사항:
--   "파티 인원수 제한은 넣는 대신에 분배 조절을 넣어줘. 100% 기준으로 33 : 67 이런식으로?"
--   "결정석도 있고 그 외에 드랍도 있음. 그런 것도 분배할 수 있게"
--
-- ── 게임 규칙과 우리 모델의 구분 (가장 중요) ─────────────────────────────────
--   * **게임 규칙**: 결정석은 입장 인원으로 1/n 균등 지급된다. 우리가 바꿀 수 없다.
--     파티 전체가 받는 총액(pot) = party_size × floor(base_price / party_size)
--   * **우리 모델**: 그 pot 을 파티원끼리 어떻게 **재분배**했는지 기록한다(버스 33:67 등).
--     게임 밖에서 벌어지는 메소 거래이므로 API 로는 절대 알 수 없고 전적으로 우리 데이터다.
--   → 즉 pot 은 게임이 정하고, 그 안의 배분은 사람이 정한다. 이 파일이 후자를 담당한다.
--
-- ⚠️ 기존 `check (crystal_share_meso = base_price_meso / party_size)` 는 **더 이상 불변식이
--    아니다.** 균등 분배는 이제 불변식이 아니라 *기본값*이다. 이 파일에서 완화한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 10-1. distribute_meso — 잔여 메소 배분 규칙 (단일 진실 공급원)
-- -----------------------------------------------------------------------------
-- **최대잉여법(largest remainder).**
--   1) 각자 floor(total × weight / Σweight) 를 먼저 받는다.
--   2) 남은 메소(total - Σfloor)를 **나머지가 큰 순서**로 1메소씩 나눠 준다.
--   3) 동률이면 weight 큰 순 → key(uuid) 오름차순. **완전 결정론적**이다.
-- 결과 합계는 항상 total 과 **정확히 일치**한다. 1메소도 새지 않는다.
--
-- **왜 DB 함수인가** (애플리케이션이 아니라):
--   * 웹 UI, 카톡 봇(`!결정석`), 주간 집계 뷰가 **모두 같은 값**을 내야 한다.
--     TS 에 두면 뷰가 그 로직을 호출할 수 없어 집계와 화면이 갈라진다.
--   * 순수 정수 산술이라 IMMUTABLE 로 선언할 수 있고 뷰에서 자유롭게 쓸 수 있다.
--   * 봇 응답은 3초 예산인데, 서버가 재계산하지 않고 뷰를 그대로 읽으면 된다.
--
-- **분모가 10000 이 아니라 Σweight 인 이유** (중요):
--   균등 분배를 basis point 로 표현하면 오차가 생긴다. 1/6 = 0.16666... 인데
--   bp 로는 1667/1666 으로 근사되어 6인 파티에서 1인당 수천 메소가 어긋난다.
--   → 균등 모드는 가중치를 전부 `1` 로 넘긴다(분모 = n). 그러면 pot 이 party_size 로
--     정확히 나누어떨어져 **게임 결과와 1메소도 다르지 않다.**
--   → 사용자 지정 모드는 가중치로 share_bp 를 넘긴다(분모 = 10000). 33:67 이 정확히 표현된다.
--   하나의 알고리즘으로 두 경우를 모두 정확히 처리한다.
create or replace function public.distribute_meso(
  p_total   bigint,
  p_keys    uuid[],
  p_weights integer[]
)
returns table (key uuid, weight integer, amount bigint)
language plpgsql
immutable
parallel safe
as $func$
declare
  v_n     integer;
  v_denom bigint;
begin
  if p_total is null or p_keys is null or p_weights is null then
    return;
  end if;

  v_n := array_length(p_keys, 1);
  if v_n is null or v_n = 0 then
    return;
  end if;

  if array_length(p_weights, 1) is distinct from v_n then
    raise exception 'distribute_meso: 키 개수(%)와 가중치 개수(%)가 다릅니다.',
      v_n, array_length(p_weights, 1) using errcode = 'data_exception';
  end if;

  if p_total < 0 then
    raise exception 'distribute_meso: 총액은 음수일 수 없습니다 (%).', p_total
      using errcode = 'data_exception';
  end if;

  if exists (select 1 from unnest(p_weights) w where w is null or w < 0) then
    raise exception 'distribute_meso: 가중치는 null 이거나 음수일 수 없습니다.'
      using errcode = 'data_exception';
  end if;

  select sum(w)::bigint into v_denom from unnest(p_weights) w;
  if v_denom is null or v_denom <= 0 then
    raise exception 'distribute_meso: 가중치 합이 0 이하입니다 (%). 분배할 수 없습니다.', v_denom
      using errcode = 'data_exception';
  end if;

  return query
  with input as (
    select k.k as ikey, w.w as iweight
    from unnest(p_keys)    with ordinality as k(k, ord)
    join unnest(p_weights) with ordinality as w(w, ord) on w.ord = k.ord
  ),
  base as (
    select i.ikey,
           i.iweight,
           (p_total * i.iweight) / v_denom as amount_floor,
           (p_total * i.iweight) % v_denom as remainder
    from input i
  ),
  ranked as (
    select b.ikey,
           b.iweight,
           b.amount_floor,
           (p_total - sum(b.amount_floor) over ())::bigint as leftover,
           row_number() over (
             order by b.remainder desc, b.iweight desc, b.ikey asc
           ) as rn
    from base b
  )
  select r.ikey,
         r.iweight,
         r.amount_floor + case when r.rn <= r.leftover then 1 else 0 end
  from ranked r;
end;
$func$;

comment on function public.distribute_meso(bigint, uuid[], integer[]) is
  '최대잉여법 메소 분배. 분모는 Σweight. 합계가 총액과 정확히 일치하며 결정론적이다. 웹·봇·집계뷰가 공유하는 유일한 구현.';

-- -----------------------------------------------------------------------------
-- 10-2. 분배 비율 컬럼
-- -----------------------------------------------------------------------------
-- share 를 **run_signups** 에 둔 이유:
--   결정석 pot 은 "그 보스에 실제로 같이 들어간 사람들"이 나눈다. 파티 멤버 전체가 아니다.
--   6인 파티에서 4명만 간 런이면 그 4명 사이에서 합이 10000 이어야 한다.
--   party_participants 에 두면 참석자 부분집합에 대해 합이 10000 이 되지 않아 성립하지 않는다.
alter table public.party_runs
  add column if not exists share_mode public.run_share_mode not null default 'auto_equal';

comment on column public.party_runs.share_mode is
  'auto_equal=참가자 변동 시 균등 재계산(게임과 동일한 결과) / manual=사용자 지정 비율 보존.';

alter table public.run_signups
  add column if not exists share_bp integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'run_signups_share_bp_range') then
    alter table public.run_signups
      add constraint run_signups_share_bp_range check (share_bp between 0 and 10000);
  end if;
  -- 불참자는 분배 대상이 아니다.
  if not exists (select 1 from pg_constraint where conname = 'run_signups_non_going_has_no_share') then
    alter table public.run_signups
      add constraint run_signups_non_going_has_no_share
      check (status = 'going' or share_bp = 0);
  end if;
end
$$;

comment on column public.run_signups.share_bp is
  '수익 분배 비율(basis point, 10000 = 100%). 한 런의 going 참가자 합계는 정확히 10000. 부동소수점을 쓰지 않아 33:67 이 정확히 표현된다.';

-- 게스트 참가자도 run_signups 를 통해 share 를 가진다. participant_id 가
-- party_participants(정규 사용자 + 게스트 공존)를 가리키므로 별도 처리가 필요 없고,
-- 승계 시 participant 행이 그대로 유지되어 share 가 자동으로 따라간다(10-7 에서 병합 케이스 처리).

-- -----------------------------------------------------------------------------
-- 10-2b. 참가자 번호 seat_no — 사람이 입으로 부르는 안정적 식별자
-- -----------------------------------------------------------------------------
-- 용도: 카톡 평문에서 긴 닉네임 대신 번호로 가리킨다. `!분배 1번 33` 처럼.
--       모집 순번이나 대기열이 아니라 **자리 지정용 식별자**다.
--
-- ★ **번호는 절대 재배열하지 않는다.**
--   3번이 나갔다고 4번이 3번이 되면, 그 순간 방에서 진행 중이던 대화가 전부 어긋난다
--   ("3번한테 33 줘" 라고 말한 사람과 들은 사람이 서로 다른 사람을 가리키게 된다).
--   → 빠진 번호는 **빈 채로 둔다.** 빈 번호를 재사용하지도 않는다(신규는 항상 max+1).
--   → 그래서 번호는 연속이 아닐 수 있다. 그게 정상이다.
alter table public.run_signups
  add column if not exists seat_no smallint;

-- 기존 행 백필(이관/재실행 대비). 이미 번호가 있는 행은 건드리지 않고 그 뒤에 이어 붙인다.
update public.run_signups s
   set seat_no = x.new_seat
  from (
    select r.id,
           (coalesce(m.max_seat, 0)
            + row_number() over (partition by r.run_id order by r.created_at, r.id))::smallint as new_seat
    from public.run_signups r
    left join (
      select run_id, max(seat_no) as max_seat
      from public.run_signups
      where seat_no is not null
      group by run_id
    ) m on m.run_id = r.run_id
    where r.seat_no is null
  ) x
 where s.id = x.id and s.seat_no is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'run_signups_seat_no_positive') then
    alter table public.run_signups
      add constraint run_signups_seat_no_positive check (seat_no is null or seat_no >= 1);
  end if;

  -- 같은 런 안에서 번호는 유일하다. 경쟁 조건이 뚫려도 여기서 반드시 막힌다.
  if not exists (select 1 from pg_constraint where conname = 'run_signups_seat_uniq') then
    alter table public.run_signups
      add constraint run_signups_seat_uniq unique (run_id, seat_no);
  end if;

  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'run_signups'
           and column_name = 'seat_no' and is_nullable = 'YES'
      )
     and not exists (select 1 from public.run_signups where seat_no is null) then
    alter table public.run_signups alter column seat_no set not null;
  end if;
end
$$;

comment on column public.run_signups.seat_no is
  '런 안에서 1부터 부여되는 참가자 번호. 봇에서 `!분배 1번 33` 처럼 사람을 가리키는 데 쓴다. **탈퇴해도 재배열하지 않으며 빈 번호를 재사용하지 않는다** — 대화 중 지칭이 어긋나면 안 되기 때문.';

-- **번호 부여를 애플리케이션이 아니라 트리거에 둔 이유**:
--   참가자를 만드는 경로가 최소 셋이다 — 웹 UI, 카톡 봇 `!등록`, 초대 링크 참가.
--   앱에 두면 세 경로가 전부 같은 규칙을 구현해야 하고, 한 곳만 빠뜨려도 번호가 겹치거나 빈다.
--   DB 에 두면 구현이 하나뿐이고 어떤 경로로 들어와도 규칙이 강제된다.
--
-- **경쟁 조건 대응**:
--   `max(seat_no)+1` 은 동시 INSERT 에 취약하다(둘 다 3을 읽고 둘 다 4를 쓴다).
--   → 같은 런에 대해 **트랜잭션 범위 advisory lock** 으로 번호 부여를 직렬화한다.
--     party_runs 행을 잠그지 않으므로 일정 수정과 경합하지 않고, 커밋/롤백 시 자동 해제된다.
--   → 그래도 unique 제약을 backstop 으로 남겨 둔다. 락을 우회하는 경로(직접 INSERT 등)에서도
--     중복 번호가 저장되는 일은 없다.
create or replace function public.run_signups_assign_seat_no()
returns trigger
language plpgsql
as $func$
declare
  v_next smallint;
begin
  -- 명시적으로 지정된 번호(복원·이관)는 존중한다.
  if new.seat_no is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('run_seat:' || new.run_id::text, 0));

  select (coalesce(max(seat_no), 0) + 1)::smallint
    into v_next
    from public.run_signups
   where run_id = new.run_id;

  new.seat_no := v_next;
  return new;
end;
$func$;

drop trigger if exists run_signups_assign_seat_no on public.run_signups;
create trigger run_signups_assign_seat_no
  before insert on public.run_signups
  for each row execute function public.run_signups_assign_seat_no();

-- -----------------------------------------------------------------------------
-- 10-3. 균등 분배 기본값 + 참가자 변동 재계산 정책
-- -----------------------------------------------------------------------------
-- **정책 (문서 DB-SCHEMA.md 와 동일):**
--   auto_equal (기본)
--     - 참가자 추가/삭제/불참전환 시 **항상 균등 재계산**.
--     - floor(10000/n) 씩 주고 나머지 (10000 mod n) 을 결정론적 순서(created_at, id)로 1씩 더한다.
--       예) 3명 → 3334/3333/3333 = 10000, 7명 → 1429×6 + 1426 형태로 정확히 10000.
--   manual (사용자가 한 번이라도 비율을 조절하면 전환)
--     - **추가**: 새 참가자는 share_bp = 0 으로 들어온다. 기존 비율이 그대로 보존되고 합도 10000 유지.
--       (새로 온 사람 몫은 사람이 직접 정해야 한다 — 임의로 남의 몫을 빼앗지 않는다.)
--     - **삭제/불참**: 떠난 사람의 몫을 남은 사람들에게 **기존 비율대로 비례 재분배**한다.
--       (그러지 않으면 합이 10000 미만이 되어 pot 일부가 증발한다.)
--     - 합이 이미 정확히 10000 이면 **절대 건드리지 않는다.**
create or replace function public.rebalance_run_shares(p_run_id uuid)
returns integer
language plpgsql
as $func$
declare
  v_mode  public.run_share_mode;
  v_n     integer;
  v_total integer;
  v_rows  integer := 0;
begin
  select r.share_mode into v_mode from public.party_runs r where r.id = p_run_id;
  if not found then
    return 0;   -- 런이 이미 삭제됨(cascade). 검사할 것이 없다.
  end if;

  -- 불참자는 분배 대상에서 제외한다.
  update public.run_signups
     set share_bp = 0
   where run_id = p_run_id and status <> 'going' and share_bp <> 0;

  select count(*), coalesce(sum(share_bp), 0)
    into v_n, v_total
    from public.run_signups
   where run_id = p_run_id and status = 'going';

  if v_n = 0 then
    return 0;   -- 참가자가 없으면 합계 0 이 정상이다.
  end if;

  if v_mode = 'manual' and v_total = 10000 then
    return 0;   -- 사용자가 정한 비율이 유효하다. 손대지 않는다.
  end if;

  if v_mode = 'auto_equal' or v_total = 0 then
    -- 균등 분배. 나머지는 **번호 순(= 등록 순)** 으로 앞에서부터 1씩. 완전 결정론적이다.
    with ordered as (
      select id, row_number() over (order by seat_no) as rn
        from public.run_signups
       where run_id = p_run_id and status = 'going'
    )
    update public.run_signups s
       set share_bp = (10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end
      from ordered o
     where s.id = o.id
       and s.share_bp is distinct from
           ((10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end);
    get diagnostics v_rows = row_count;
  else
    -- manual 인데 합이 10000 이 아니다(이탈 등).
    -- 남은 사람들의 기존 비율을 유지한 채 10000 으로 재정규화한다.
    -- 잔여 bp 배분도 distribute_meso 의 최대잉여법을 그대로 쓴다(규칙 일원화).
    with recipients as (
      select id, share_bp
        from public.run_signups
       where run_id = p_run_id and status = 'going'
    ),
    agg as (
      select array_agg(id order by id) as keys,
             array_agg(share_bp order by id) as weights
      from recipients
    ),
    dist as (
      select d.key, d.amount
      from agg, public.distribute_meso(10000, agg.keys, agg.weights) d
    )
    update public.run_signups s
       set share_bp = dist.amount::integer
      from dist
     where s.id = dist.key
       and s.share_bp is distinct from dist.amount::integer;
    get diagnostics v_rows = row_count;
  end if;

  return v_rows;
end;
$func$;

comment on function public.rebalance_run_shares(uuid) is
  '런의 분배 비율을 정책에 따라 재계산한다. auto_equal=균등 재계산, manual=기존 비율 보존 후 부족분만 비례 재정규화.';

create or replace function public.run_signups_sync_shares()
returns trigger
language plpgsql
as $func$
begin
  -- rebalance 가 같은 테이블을 update 하므로 재진입을 막는다.
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.rebalance_run_shares(coalesce(new.run_id, old.run_id));
  return null;
end;
$func$;

drop trigger if exists run_signups_sync_shares on public.run_signups;
create trigger run_signups_sync_shares
  after insert or delete or update of status on public.run_signups
  for each row execute function public.run_signups_sync_shares();

-- -----------------------------------------------------------------------------
-- 10-4. 합계 10000 강제 — 지연(DEFERRED) 제약 트리거
-- -----------------------------------------------------------------------------
-- **왜 CHECK 가 아니라 제약 트리거인가**:
--   합계는 **여러 행에 걸친 불변식**이라 단일 행 CHECK 로 표현할 수 없다.
-- **왜 즉시(IMMEDIATE)가 아니라 지연(DEFERRED)인가**:
--   참가자를 한 명 추가하거나 33:67 로 조정하는 순간 합계는 **반드시 일시적으로 깨진다.**
--   즉시 검사하면 어떤 정상적인 편집도 문장 순서를 곡예하지 않는 한 통과할 수 없다.
--   → 커밋 시점에 한 번만 본다. 트랜잭션 안에서 어떻게 고치든 자유롭고,
--     끝났을 때 반드시 맞아야 한다.
-- 허용 합계는 **10000(분배 확정) 또는 0(참가자 없음)** 두 가지다.
create or replace function public.assert_run_share_total()
returns trigger
language plpgsql
as $func$
declare
  v_run   uuid;
  v_total integer;
begin
  v_run := coalesce(new.run_id, old.run_id);
  if v_run is null then
    return null;
  end if;

  -- 런 자체가 삭제된 경우(cascade)에는 검사할 대상이 없다.
  if not exists (select 1 from public.party_runs where id = v_run) then
    return null;
  end if;

  select coalesce(sum(share_bp), 0) into v_total
    from public.run_signups
   where run_id = v_run;

  if v_total not in (0, 10000) then
    raise exception
      '일정(%)의 분배 비율 합계는 10000(=100%%) 이어야 합니다. 현재 %.', v_run, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$func$;

drop trigger if exists run_signups_share_total on public.run_signups;
create constraint trigger run_signups_share_total
  after insert or update or delete on public.run_signups
  deferrable initially deferred
  for each row execute function public.assert_run_share_total();

-- 사용자가 비율을 직접 지정하는 유일한 진입점.
-- 여기를 통과하면 share_mode 가 manual 로 바뀌고, 이후 균등 재계산이 비율을 덮어쓰지 않는다.
create or replace function public.set_run_shares(
  p_run_id         uuid,
  p_participant_ids uuid[],
  p_share_bps      integer[]
)
returns integer
language plpgsql
as $func$
declare
  v_total integer;
  v_rows  integer := 0;
begin
  if array_length(p_participant_ids, 1) is distinct from array_length(p_share_bps, 1) then
    raise exception 'set_run_shares: 참가자 수와 비율 수가 다릅니다.'
      using errcode = 'data_exception';
  end if;

  select sum(b)::integer into v_total from unnest(p_share_bps) b;
  if coalesce(v_total, 0) <> 10000 then
    raise exception '분배 비율 합계는 10000(=100%%) 이어야 합니다. 입력 합계 %.', coalesce(v_total, 0)
      using errcode = 'check_violation';
  end if;

  update public.party_runs set share_mode = 'manual' where id = p_run_id;

  update public.run_signups s
     set share_bp = x.bp
    from (
      select k.k as pid, b.b as bp
      from unnest(p_participant_ids) with ordinality as k(k, ord)
      join unnest(p_share_bps)       with ordinality as b(b, ord) on b.ord = k.ord
    ) x
   where s.run_id = p_run_id
     and s.participant_id = x.pid;
  get diagnostics v_rows = row_count;

  if v_rows <> array_length(p_participant_ids, 1) then
    raise exception '이 일정에 속하지 않은 참가자가 포함되어 있습니다.'
      using errcode = 'foreign_key_violation';
  end if;

  return v_rows;
end;
$func$;

comment on function public.set_run_shares(uuid, uuid[], integer[]) is
  '런의 분배 비율을 사용자 지정으로 설정한다. 합계 10000 을 강제하고 share_mode 를 manual 로 바꾼다.';

-- -----------------------------------------------------------------------------
-- 10-5. 기타 드랍 수익
-- -----------------------------------------------------------------------------
create table if not exists public.run_drops (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.party_runs(id) on delete cascade,

  item_name     text not null check (length(btrim(item_name)) between 1 and 100),

  -- **nullable = 아직 안 팔았다.** 0 이 아니다.
  -- 벨로나 미확인 가격과 같은 기조: 모르는 값을 0 으로 채우면 "0메소를 벌었다"는 거짓이 된다.
  -- 집계는 이런 건을 합계에서 빼고 unsold_drop_count 로 따로 보고한다.
  sale_amount_meso bigint check (sale_amount_meso is null or sale_amount_meso >= 0),
  sold_at       timestamptz,

  share_mode    public.drop_share_mode not null default 'party_default',
  -- share_mode = 'solo' 일 때 전부 가져가는 사람
  solo_participant_id uuid references public.party_participants(id) on delete set null,

  recorded_by_participant_id uuid references public.party_participants(id) on delete set null,

  -- 그 런이 속한 주차를 따라간다(트리거 관리). 결정석의 "클리어 주차 귀속"과 같은 기조로,
  -- 나중에 팔더라도 **그 보스에서 나온 수익**으로 묶어 본다.
  week_key      text not null default public.week_key(now())
                  check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),

  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint run_drops_solo_needs_participant check (
    share_mode <> 'solo' or solo_participant_id is not null
  ),
  -- 판매 금액과 판매 시각은 함께 있거나 함께 없다.
  constraint run_drops_sold_pair check (
    (sale_amount_meso is null) = (sold_at is null)
  )
);

comment on table public.run_drops is
  '보스 런에서 나온 결정석 외 드랍 수익. 금액 null = 미판매이며 집계에서 제외하고 별도로 센다.';
comment on column public.run_drops.sale_amount_meso is
  'null 은 0 이 아니라 **미판매**다. 수익 합계에서 제외되고 unsold_drop_count 로 보고된다.';
comment on column public.run_drops.share_mode is
  'party_default=런 기본 비율 / custom=이 건 전용 비율(run_drop_shares) / solo=1인 독식.';

create index if not exists run_drops_run_idx on public.run_drops (run_id);
create index if not exists run_drops_week_idx on public.run_drops (week_key);
-- 미판매 목록 조회
create index if not exists run_drops_unsold_idx
  on public.run_drops (run_id) where sale_amount_meso is null;

-- 주차 동기화 + 판매 시각 자동 기록
create or replace function public.run_drops_apply_state()
returns trigger
language plpgsql
as $func$
declare
  v_week text;
begin
  select r.week_key into v_week from public.party_runs r where r.id = new.run_id;
  if v_week is not null then
    new.week_key := v_week;
  end if;

  -- 금액이 처음 채워지면 판매 시각을 기록하고, 지워지면 되돌린다.
  if new.sale_amount_meso is not null and new.sold_at is null then
    new.sold_at := now();
  elsif new.sale_amount_meso is null then
    new.sold_at := null;
  end if;

  return new;
end;
$func$;

drop trigger if exists run_drops_apply_state on public.run_drops;
create trigger run_drops_apply_state
  before insert or update on public.run_drops
  for each row execute function public.run_drops_apply_state();

drop trigger if exists run_drops_set_updated_at on public.run_drops;
create trigger run_drops_set_updated_at
  before update on public.run_drops
  for each row execute function public.set_updated_at();

-- 드랍 1건 전용 비율 (share_mode = 'custom')
create table if not exists public.run_drop_shares (
  id             uuid primary key default gen_random_uuid(),
  drop_id        uuid not null references public.run_drops(id) on delete cascade,
  participant_id uuid not null references public.party_participants(id) on delete cascade,

  share_bp       integer not null default 0 check (share_bp between 0 and 10000),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint run_drop_shares_uniq unique (drop_id, participant_id)
);

comment on table public.run_drop_shares is
  '드랍 1건에만 적용되는 분배 비율. 합계는 정확히 10000(또는 참가자 없음 0). 지연 제약 트리거로 강제.';

create index if not exists run_drop_shares_drop_idx on public.run_drop_shares (drop_id);
create index if not exists run_drop_shares_participant_idx on public.run_drop_shares (participant_id);

drop trigger if exists run_drop_shares_set_updated_at on public.run_drop_shares;
create trigger run_drop_shares_set_updated_at
  before update on public.run_drop_shares
  for each row execute function public.set_updated_at();

-- run_signups 와 동일한 이유로 지연 제약 트리거를 쓴다.
create or replace function public.assert_drop_share_total()
returns trigger
language plpgsql
as $func$
declare
  v_drop  uuid;
  v_total integer;
begin
  v_drop := coalesce(new.drop_id, old.drop_id);
  if v_drop is null then
    return null;
  end if;

  if not exists (select 1 from public.run_drops where id = v_drop) then
    return null;
  end if;

  select coalesce(sum(share_bp), 0) into v_total
    from public.run_drop_shares where drop_id = v_drop;

  if v_total not in (0, 10000) then
    raise exception
      '드랍(%)의 분배 비율 합계는 10000(=100%%) 이어야 합니다. 현재 %.', v_drop, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$func$;

drop trigger if exists run_drop_shares_total on public.run_drop_shares;
create constraint trigger run_drop_shares_total
  after insert or update or delete on public.run_drop_shares
  deferrable initially deferred
  for each row execute function public.assert_drop_share_total();

-- -----------------------------------------------------------------------------
-- 10-6. 결정석에 분배 적용
-- -----------------------------------------------------------------------------
alter table public.boss_clears
  add column if not exists pot_meso bigint,
  add column if not exists share_bp integer;

comment on column public.boss_clears.pot_meso is
  '게임이 파티 전체에 지급한 총액 = party_size × floor(base_price / party_size). **게임 규칙이며 우리가 못 바꾼다.**';
comment on column public.boss_clears.share_bp is
  '이 사용자가 pot 에서 가져간 비율(bp). 균등이면 게임과 같은 결과, 조절하면 재분배가 반영된다.';

do $$
begin
  -- 1/n 강제 제약 제거. 균등 분배는 이제 불변식이 아니라 기본값이다.
  if exists (select 1 from pg_constraint where conname = 'boss_clears_share_is_floor_division') then
    alter table public.boss_clears drop constraint boss_clears_share_is_floor_division;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'boss_clears_pot_pair') then
    alter table public.boss_clears
      add constraint boss_clears_pot_pair
      check ((base_price_meso is null) = (pot_meso is null));
  end if;

  -- 개인 수령액은 0 이상이고 pot 을 넘을 수 없다.
  -- (참가자 전체 합계 = pot 인지는 v_run_crystal_settlement 가 검증한다 — 우리 DB 에
  --  행이 없는 참가자도 pot 을 나눠 갖기 때문에 단일 행 CHECK 로는 표현할 수 없다.)
  if not exists (select 1 from pg_constraint where conname = 'boss_clears_share_within_pot') then
    alter table public.boss_clears
      add constraint boss_clears_share_within_pot
      check (
        crystal_share_meso is null
        or (pot_meso is not null and crystal_share_meso between 0 and pot_meso)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'boss_clears_share_bp_range') then
    alter table public.boss_clears
      add constraint boss_clears_share_bp_range
      check (share_bp is null or share_bp between 0 and 10000);
  end if;
end
$$;

-- 이 사용자가 그 런에서 pot 중 얼마를 가져가는지 해석한다.
create or replace function public.resolve_crystal_payout(
  p_run_id     uuid,
  p_user_id    uuid,
  p_pot        bigint,
  p_party_size integer
)
returns table (share_bp integer, amount bigint)
language plpgsql
stable
as $func$
declare
  v_mode      public.run_share_mode;
  v_pid       uuid;
  v_use_equal boolean;
  v_size      integer := greatest(coalesce(p_party_size, 1), 1);
begin
  -- 런이 없거나(솔로 기록) 그 런에 참여 등록이 없으면 게임 기본값(균등)을 쓴다.
  -- pot 은 party_size 로 정확히 나누어떨어지므로 이 값이 곧 floor(base/party_size) 다.
  if p_run_id is null then
    return query select (10000 / v_size)::integer, (p_pot / v_size)::bigint;
    return;
  end if;

  select r.share_mode into v_mode from public.party_runs r where r.id = p_run_id;
  if not found then
    return query select (10000 / v_size)::integer, (p_pot / v_size)::bigint;
    return;
  end if;

  select pp.id into v_pid
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.run_id = p_run_id
     and s.status = 'going'
     and pp.user_id = p_user_id
   limit 1;

  if v_pid is null then
    return query select (10000 / v_size)::integer, (p_pot / v_size)::bigint;
    return;
  end if;

  -- 균등 모드이거나 비율이 아직 하나도 지정되지 않았으면 단위 가중치(=정확한 1/n)를 쓴다.
  select (v_mode = 'auto_equal')
         or coalesce(sum(s.share_bp), 0) = 0
    into v_use_equal
    from public.run_signups s
   where s.run_id = p_run_id and s.status = 'going';

  return query
  with recipients as (
    select s.participant_id,
           s.share_bp,
           case when v_use_equal then 1 else s.share_bp end as weight
      from public.run_signups s
     where s.run_id = p_run_id and s.status = 'going'
  ),
  agg as (
    select array_agg(participant_id order by participant_id) as keys,
           array_agg(weight order by participant_id)         as weights
    from recipients
  ),
  dist as (
    select d.key, d.amount
    from agg, public.distribute_meso(p_pot, agg.keys, agg.weights) d
  )
  select r.share_bp, d.amount
  from recipients r
  join dist d on d.key = r.participant_id
  where r.participant_id = v_pid;
end;
$func$;

comment on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) is
  '결정석 pot 중 해당 사용자의 몫을 해석한다. 런이 없거나 미등록이면 게임 기본 균등(1/n).';

-- boss_clears 상태 트리거 교체: pot 계산 + 분배 적용
create or replace function public.boss_clears_apply_state()
returns trigger
language plpgsql
as $func$
declare
  v_winner   text;
  v_cycle    public.boss_cycle;
  v_price_id uuid;
  v_base     bigint;
  v_pot      bigint;
  v_bp       integer;
  v_amount   bigint;
begin
  -- 0) 보스 엔트리 확인 (max_party 는 소프트 상한이라 검증하지 않는다 — CLAUDE.md §1.3 D5)
  select bd.cycle into v_cycle
    from public.boss_difficulties bd
   where bd.id = new.boss_difficulty_id;

  if not found then
    raise exception '알 수 없는 보스 엔트리입니다: %', new.boss_difficulty_id
      using errcode = 'foreign_key_violation';
  end if;

  -- 0 으로 나누는 사고 방지. CHECK 는 BEFORE 트리거보다 나중에 평가되므로 여기서 먼저 막는다.
  if new.party_size is null or new.party_size < 1 then
    raise exception '파티 인원(party_size)은 1 이상이어야 합니다 (입력: %).', new.party_size
      using errcode = 'check_violation';
  end if;

  if new.world_name is null and new.character_id is not null then
    select ch.world_name into new.world_name
      from public.characters ch where ch.id = new.character_id;
  end if;

  -- 1) 승자 판정 (관측 시각이 더 최신인 쪽. 동률이면 사람이 이긴다)
  if new.manual_cleared is null and new.api_cleared is null then
    v_winner := 'none';
  elsif new.manual_cleared is null then
    v_winner := 'api';
  elsif new.api_cleared is null then
    v_winner := 'manual';
  elsif coalesce(new.manual_set_at, '-infinity'::timestamptz)
        >= coalesce(new.api_observed_at, '-infinity'::timestamptz) then
    v_winner := 'manual';
  else
    v_winner := 'api';
  end if;

  new.effective_cleared := case v_winner
    when 'manual' then coalesce(new.manual_cleared, false)
    when 'api'    then coalesce(new.api_cleared, false)
    else false
  end;

  -- 2) 충돌 보존
  new.has_conflict := (
    new.manual_cleared is not null
    and new.api_cleared is not null
    and new.manual_cleared is distinct from new.api_cleared
  );

  -- 3) 클리어 시각 / 금액 스냅샷
  if new.effective_cleared then
    if new.cleared_at is null then
      new.cleared_at := coalesce(
        case v_winner when 'manual' then new.manual_set_at else new.api_observed_at end,
        now()
      );
    end if;

    if new.price_snapshotted_at is null then
      new.cycle := v_cycle;

      if new.manual_base_price_meso is not null then
        v_base := new.manual_base_price_meso;
        v_price_id := null;
      else
        select cp.price_id, cp.price_meso
          into v_price_id, v_base
          from public.current_crystal_price(new.boss_difficulty_id, new.cleared_at) cp;
      end if;

      new.crystal_price_id := v_price_id;
      new.base_price_meso  := v_base;

      if v_base is null then
        -- 가격 미확인. 0 으로 채우지 않는다.
        new.pot_meso           := null;
        new.share_bp           := null;
        new.crystal_share_meso := null;
      else
        -- 게임 규칙: 파티 전체가 받는 총액
        v_pot := new.party_size * (v_base / new.party_size);
        new.pot_meso := v_pot;

        -- 우리 모델: 그 총액을 파티원끼리 어떻게 나눴는가
        select p.share_bp, p.amount
          into v_bp, v_amount
          from public.resolve_crystal_payout(new.run_id, new.user_id, v_pot, new.party_size) p;

        new.share_bp           := v_bp;
        new.crystal_share_meso := v_amount;
      end if;

      new.price_snapshotted_at := now();
    end if;
  else
    new.cleared_at           := null;
    new.crystal_price_id     := null;
    new.base_price_meso      := null;
    new.pot_meso             := null;
    new.share_bp             := null;
    new.crystal_share_meso   := null;
    new.price_snapshotted_at := null;
    new.cycle                := v_cycle;
  end if;

  -- 4) 주차 버킷
  if new.cleared_at is not null then
    new.week_key := public.week_key(new.cleared_at);
  else
    new.week_key := coalesce(
      nullif(new.week_key, ''),
      public.week_key(coalesce(new.created_at, now()))
    );
  end if;

  return new;
end;
$func$;

-- 비율을 나중에 바꿨을 때 이미 기록된 결정석 금액을 다시 계산한다.
-- **가격(base_price_meso)은 절대 다시 조회하지 않는다** — R3 소급 변경 금지를 지키기 위해
-- 스냅샷된 pot 을 그대로 쓰고 분배만 다시 한다.
create or replace function public.recompute_run_crystal_shares(p_run_id uuid)
returns integer
language plpgsql
as $func$
declare
  r       record;
  v_bp    integer;
  v_amt   bigint;
  v_rows  integer := 0;
begin
  for r in
    select bc.id, bc.user_id, bc.pot_meso, bc.party_size
      from public.boss_clears bc
     where bc.run_id = p_run_id
       and bc.effective_cleared
       and bc.pot_meso is not null
  loop
    select p.share_bp, p.amount
      into v_bp, v_amt
      from public.resolve_crystal_payout(p_run_id, r.user_id, r.pot_meso, r.party_size) p;

    update public.boss_clears
       set share_bp = v_bp, crystal_share_meso = v_amt
     where id = r.id
       and (share_bp is distinct from v_bp or crystal_share_meso is distinct from v_amt);

    if found then
      v_rows := v_rows + 1;
    end if;
  end loop;

  return v_rows;
end;
$func$;

comment on function public.recompute_run_crystal_shares(uuid) is
  '분배 비율 변경 후 기록된 결정석 금액을 다시 나눈다. 가격 스냅샷은 건드리지 않아 소급 변경이 일어나지 않는다.';

-- -----------------------------------------------------------------------------
-- 10-7. 게스트 승계 시 share 보존
-- -----------------------------------------------------------------------------
-- 게스트 참가자 행이 그대로 user_id 로 전환되는 경우(moved)에는 share_bp 가 자동으로 따라온다.
-- 문제는 **병합(merged)** 이다 — 같은 런에 본인 행과 게스트 행이 둘 다 있으면 하나를 지워야 하고,
-- 그냥 지우면 합계가 10000 미만이 되어 pot 일부가 증발한다.
-- → 지우기 전에 **게스트의 몫을 본인 행에 합산**한다. 합계가 정확히 보존된다.
create or replace function public.claim_guest_profile(
  p_guest_id uuid,
  p_user_id  uuid
)
returns table (moved_participants integer, merged_participants integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_guest        public.guest_profiles%rowtype;
  v_display_name text;
  v_moved        integer := 0;
  v_merged       integer := 0;
  r              record;
begin
  select * into v_guest
    from public.guest_profiles
   where id = p_guest_id
     for update;

  if not found then
    raise exception '승계 대상 게스트(%)를 찾을 수 없습니다.', p_guest_id
      using errcode = 'no_data_found';
  end if;

  if v_guest.claimed_by_user_id is not null and v_guest.claimed_by_user_id <> p_user_id then
    raise exception '게스트(%)는 이미 다른 계정에 승계되었습니다.', p_guest_id
      using errcode = 'unique_violation';
  end if;

  select display_name into v_display_name
    from public.app_users
   where id = p_user_id and deleted_at is null;

  if not found then
    raise exception '승계 대상 사용자(%)를 찾을 수 없습니다.', p_user_id
      using errcode = 'no_data_found';
  end if;

  for r in
    select gp.id as guest_participant_id,
           up.id as user_participant_id
      from public.party_participants gp
      join public.party_participants up
        on up.party_id = gp.party_id
       and up.user_id = p_user_id
     where gp.guest_id = p_guest_id
  loop
    -- 가용시간: 본인 행에 같은 슬롯이 없을 때만 옮긴다.
    update public.availability_slots a
       set participant_id = r.user_participant_id
     where a.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.availability_slots b
          where b.participant_id = r.user_participant_id
            and b.slot_start = a.slot_start
       );
    delete from public.availability_slots
     where participant_id = r.guest_participant_id;

    -- ★ 분배 비율 보존: 같은 런에 양쪽 행이 있으면 게스트 몫을 본인 행에 **합산**한다.
    --   한 사람은 자리 하나이므로 본인 번호(seat_no)를 유지하고 게스트 번호는 빈 번호가 된다.
    --   빈 번호를 메우지 않는 것이 seat_no 의 규칙이다.
    update public.run_signups t
       set share_bp = t.share_bp + s.share_bp
      from public.run_signups s
     where s.participant_id = r.guest_participant_id
       and t.participant_id = r.user_participant_id
       and t.run_id = s.run_id;

    -- 본인 응답이 없는 런은 게스트 행을 그대로 옮긴다.
    -- 행 자체가 유지되므로 share_bp 와 **seat_no 가 그대로 따라간다.**
    update public.run_signups s
       set participant_id = r.user_participant_id
     where s.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.run_signups t
          where t.participant_id = r.user_participant_id
            and t.run_id = s.run_id
       );
    delete from public.run_signups
     where participant_id = r.guest_participant_id;

    -- ★ 드랍 전용 비율도 같은 규칙으로 합산 후 이관한다.
    update public.run_drop_shares t
       set share_bp = t.share_bp + s.share_bp
      from public.run_drop_shares s
     where s.participant_id = r.guest_participant_id
       and t.participant_id = r.user_participant_id
       and t.drop_id = s.drop_id;

    update public.run_drop_shares s
       set participant_id = r.user_participant_id
     where s.participant_id = r.guest_participant_id
       and not exists (
         select 1 from public.run_drop_shares t
          where t.participant_id = r.user_participant_id
            and t.drop_id = s.drop_id
       );
    delete from public.run_drop_shares
     where participant_id = r.guest_participant_id;

    -- 드랍 독식/기록자 참조도 본인 행으로 넘긴다.
    update public.run_drops
       set solo_participant_id = r.user_participant_id
     where solo_participant_id = r.guest_participant_id;
    update public.run_drops
       set recorded_by_participant_id = r.user_participant_id
     where recorded_by_participant_id = r.guest_participant_id;

    update public.party_runs
       set created_by_participant_id = r.user_participant_id
     where created_by_participant_id = r.guest_participant_id;

    delete from public.party_participants where id = r.guest_participant_id;
    v_merged := v_merged + 1;
  end loop;

  -- 남은 게스트 참가자 행 → 정식 사용자 행으로 전환 (share_bp 는 행에 그대로 남아 따라간다)
  update public.party_participants
     set user_id      = p_user_id,
         guest_id     = null,
         display_name = v_display_name
   where guest_id = p_guest_id;
  get diagnostics v_moved = row_count;

  update public.guest_profiles
     set claimed_by_user_id = p_user_id,
         claimed_at         = coalesce(claimed_at, now()),
         claim_token_hash   = null,
         last_seen_at       = now()
   where id = p_guest_id;

  insert into public.guest_claims (
    guest_id, user_id, moved_participant_count, merged_participant_count
  ) values (
    p_guest_id, p_user_id, v_moved, v_merged
  );

  return query select v_moved, v_merged;
end;
$func$;

comment on function public.claim_guest_profile(uuid, uuid) is
  '임시 참가자를 정식 계정으로 승계한다. 파티 중복 시 병합하며 분배 비율(share_bp)을 합산해 합계 10000 을 보존한다.';

-- -----------------------------------------------------------------------------
-- 10-8. 정산 / 집계 뷰
-- -----------------------------------------------------------------------------
-- 의존 순서 역순으로 내린다. cascade 는 재실행 시 파생 뷰가 남아 있어도 안전하게 하기 위함이다.
drop view if exists public.v_weekly_income cascade;
drop view if exists public.v_weekly_unsold_drops cascade;
drop view if exists public.v_weekly_drop_income cascade;
drop view if exists public.v_run_drop_settlement cascade;
drop view if exists public.v_run_drop_recipients cascade;
drop view if exists public.v_run_crystal_settlement cascade;
drop view if exists public.v_run_share_weights cascade;

-- 런별 유효 가중치(균등이면 1, 사용자 지정이면 share_bp).
create view public.v_run_share_weights
with (security_invoker = true) as
select
  s.run_id,
  s.participant_id,
  s.seat_no,
  pp.user_id,
  pp.guest_id,
  pp.display_name,
  s.share_bp,
  case
    when r.share_mode = 'auto_equal' then 1
    when coalesce(sum(s.share_bp) over (partition by s.run_id), 0) = 0 then 1
    else s.share_bp
  end as weight
from public.run_signups s
join public.party_runs r          on r.id = s.run_id
join public.party_participants pp on pp.id = s.participant_id
where s.status = 'going';

comment on view public.v_run_share_weights is
  '런별 분배 가중치. 균등 모드는 1(정확한 1/n), 사용자 지정 모드는 share_bp. 게스트도 포함된다.';

-- 결정석 정산: pot 을 실제 참가자들에게 나눈 결과. **합계가 pot 과 정확히 일치**한다.
create view public.v_run_crystal_settlement
with (security_invoker = true) as
with run_pot as (
  select bc.run_id,
         max(bc.pot_meso)  as pot_meso,
         max(bc.party_size) as party_size,
         min(bc.week_key)  as week_key
  from public.boss_clears bc
  where bc.run_id is not null
    and bc.effective_cleared
    and bc.pot_meso is not null
  group by bc.run_id
),
agg as (
  select w.run_id,
         array_agg(w.participant_id order by w.participant_id) as keys,
         array_agg(w.weight order by w.participant_id)         as weights
  from public.v_run_share_weights w
  group by w.run_id
)
select
  p.run_id,
  p.week_key,
  p.pot_meso,
  p.party_size,
  d.key    as participant_id,
  w.seat_no,
  w.user_id,
  w.display_name,
  w.share_bp,
  d.amount as amount_meso
from run_pot p
join agg a on a.run_id = p.run_id
cross join lateral public.distribute_meso(p.pot_meso, a.keys, a.weights) d
join public.v_run_share_weights w
  on w.run_id = p.run_id and w.participant_id = d.key;

comment on view public.v_run_crystal_settlement is
  '결정석 pot 의 참가자별 정산 결과. 게스트 포함 전원이 대상이라 amount_meso 합계가 pot 과 정확히 일치한다.';

-- 드랍 수익 수령자 해석 (3가지 분배 방식)
create view public.v_run_drop_recipients
with (security_invoker = true) as
-- party_default : 런 기본 비율을 그대로
select d.id as drop_id, w.participant_id, w.weight
from public.run_drops d
join public.v_run_share_weights w on w.run_id = d.run_id
where d.share_mode = 'party_default'
union all
-- custom : 이 드랍 전용 비율
select d.id, s.participant_id, s.share_bp
from public.run_drops d
join public.run_drop_shares s on s.drop_id = d.id
where d.share_mode = 'custom'
  and s.share_bp > 0
union all
-- solo : 1인 독식
select d.id, d.solo_participant_id, 1
from public.run_drops d
where d.share_mode = 'solo'
  and d.solo_participant_id is not null;

comment on view public.v_run_drop_recipients is
  '드랍 건별 수령자와 가중치. party_default/custom/solo 세 방식을 하나로 해석한다.';

-- 드랍 정산. **미판매(금액 null)는 여기 나타나지 않는다.**
create view public.v_run_drop_settlement
with (security_invoker = true) as
with agg as (
  select rc.drop_id,
         array_agg(rc.participant_id order by rc.participant_id) as keys,
         array_agg(rc.weight order by rc.participant_id)         as weights
  from public.v_run_drop_recipients rc
  group by rc.drop_id
)
select
  d.id       as drop_id,
  d.run_id,
  d.week_key,
  d.item_name,
  d.share_mode,
  d.sale_amount_meso,
  x.key      as participant_id,
  pp.user_id,
  pp.display_name,
  x.amount   as amount_meso
from public.run_drops d
join agg a on a.drop_id = d.id
cross join lateral public.distribute_meso(d.sale_amount_meso, a.keys, a.weights) x
join public.party_participants pp on pp.id = x.key
where d.sale_amount_meso is not null;

comment on view public.v_run_drop_settlement is
  '드랍 건별 참가자 정산. 미판매(금액 null)는 제외되며 합계는 판매 금액과 정확히 일치한다.';

-- 주간 드랍 수익 (사용자 × 주차). 게스트 몫은 어떤 사용자에게도 귀속되지 않는다.
create view public.v_weekly_drop_income
with (security_invoker = true) as
select
  s.user_id,
  s.week_key,
  sum(s.amount_meso)::bigint  as drop_income_meso,
  count(*)                    as drop_share_count,
  count(distinct s.drop_id)   as drop_count
from public.v_run_drop_settlement s
where s.user_id is not null
group by s.user_id, s.week_key;

comment on view public.v_weekly_drop_income is
  '사용자 × 주차 기타 드랍 수익. 결정석 12개 한도와 무관한 별도 계통이다.';

-- 미판매 드랍 개수. 금액을 모르니 수익에는 못 넣지만 "아직 안 판 게 3건 있다"는 보여줘야 한다.
-- 가격 미확인 결정석을 unknown_price_count 로 따로 보고하는 것과 같은 기조다.
create view public.v_weekly_unsold_drops
with (security_invoker = true) as
select
  pp.user_id,
  d.week_key,
  count(distinct d.id) as unsold_drop_count
from public.run_drops d
join public.run_signups s         on s.run_id = d.run_id and s.status = 'going'
join public.party_participants pp on pp.id = s.participant_id
where d.sale_amount_meso is null
  and pp.user_id is not null
group by pp.user_id, d.week_key;

comment on view public.v_weekly_unsold_drops is
  '아직 팔지 않은 드랍 건수(사용자 × 주차). 금액이 없어 수익에는 못 들어가지만 별도로 보고한다.';

-- 결정석 + 드랍 통합 주간 수익
create view public.v_weekly_income
with (security_invoker = true) as
with keys as (
  select user_id, week_key from public.v_weekly_crystal_income
  union
  select user_id, week_key from public.v_weekly_drop_income
  union
  select user_id, week_key from public.v_weekly_unsold_drops
)
select
  k.user_id,
  k.week_key,
  -- 결정석 계통 (주간 12개 한도가 적용되는 쪽)
  coalesce(c.income_meso, 0)             as crystal_income_meso,
  coalesce(c.clear_count, 0)             as clear_count,
  coalesce(c.weekly_clear_count, 0)      as weekly_clear_count,
  coalesce(c.unknown_price_count, 0)     as unknown_price_count,
  coalesce(c.weekly_over_limit_count, 0) as weekly_over_limit_count,
  -- 드랍 계통 (12개 한도와 무관)
  coalesce(d.drop_income_meso, 0)        as drop_income_meso,
  coalesce(d.drop_count, 0)              as drop_count,
  coalesce(u.unsold_drop_count, 0)       as unsold_drop_count,
  -- 합계
  (coalesce(c.income_meso, 0) + coalesce(d.drop_income_meso, 0))::bigint as total_income_meso
from keys k
left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
left join public.v_weekly_drop_income    d on d.user_id = k.user_id and d.week_key = k.week_key
left join public.v_weekly_unsold_drops   u on u.user_id = k.user_id and u.week_key = k.week_key;

comment on view public.v_weekly_income is
  '주간 총수익 = 결정석 분배 몫 + 드랍 분배 몫. 두 계통을 분리해 보여준다(12개 한도는 결정석에만 적용). 미판매 드랍은 금액이 아니라 건수로 보고한다.';

-- -----------------------------------------------------------------------------
-- 10-9. RLS — 신규 테이블/뷰
-- -----------------------------------------------------------------------------
-- 드랍 수익은 개인 금전 정보다. 공개 파티라 해도 노출하지 않는다.
do $$
declare
  t text;
  private_tables text[] := array['run_drops', 'run_drop_shares'];
begin
  foreach t in array private_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

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

do $$
declare
  v text;
  private_views text[] := array[
    'v_run_share_weights',
    'v_run_crystal_settlement',
    'v_run_drop_recipients',
    'v_run_drop_settlement',
    'v_weekly_drop_income',
    'v_weekly_unsold_drops',
    'v_weekly_income'
  ];
begin
  foreach v in array private_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;
end
$$;

-- 분배를 바꾸는 함수는 서버만 호출한다. anon 이 RPC 로 남의 파티 분배를 바꾸면 안 된다.
revoke all on function public.set_run_shares(uuid, uuid[], integer[]) from public;
revoke all on function public.set_run_shares(uuid, uuid[], integer[]) from anon;
revoke all on function public.set_run_shares(uuid, uuid[], integer[]) from authenticated;
grant execute on function public.set_run_shares(uuid, uuid[], integer[]) to service_role;

revoke all on function public.rebalance_run_shares(uuid) from public;
revoke all on function public.rebalance_run_shares(uuid) from anon;
revoke all on function public.rebalance_run_shares(uuid) from authenticated;
grant execute on function public.rebalance_run_shares(uuid) to service_role;

revoke all on function public.recompute_run_crystal_shares(uuid) from public;
revoke all on function public.recompute_run_crystal_shares(uuid) from anon;
revoke all on function public.recompute_run_crystal_shares(uuid) from authenticated;
grant execute on function public.recompute_run_crystal_shares(uuid) to service_role;

-- claim_guest_profile 은 재정의되었으므로 권한을 다시 잠근다(재정의 시 기본 PUBLIC 실행권이 붙는다).
revoke all on function public.claim_guest_profile(uuid, uuid) from public;
revoke all on function public.claim_guest_profile(uuid, uuid) from anon;
revoke all on function public.claim_guest_profile(uuid, uuid) from authenticated;
grant execute on function public.claim_guest_profile(uuid, uuid) to service_role;

-- distribute_meso / resolve_crystal_payout 은 순수 계산이며 인자로 받은 값만 다룬다.
-- 다만 resolve_crystal_payout 은 런 구성을 읽으므로 서버 전용으로 잠근다.
revoke all on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) from public;
revoke all on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) from anon;
revoke all on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) from authenticated;
grant execute on function public.resolve_crystal_payout(uuid, uuid, bigint, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 10-10. 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
  v_amounts bigint[];
begin
  -- 분배 정확성: 33:67 이 1메소도 새지 않아야 한다.
  select array_agg(amount order by amount)
    into v_amounts
    from public.distribute_meso(
      1000001,
      array['00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid],
      array[3300, 6700]
    );
  if (v_amounts[1] + v_amounts[2]) <> 1000001 then
    raise exception 'distribute_meso 33:67 합계 불일치: % + % <> 1000001', v_amounts[1], v_amounts[2];
  end if;

  -- 3분할(나누어떨어지지 않음)도 합계가 정확해야 한다.
  select array_agg(amount)
    into v_amounts
    from public.distribute_meso(
      100,
      array['00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000003'::uuid],
      array[1, 1, 1]
    );
  if (v_amounts[1] + v_amounts[2] + v_amounts[3]) <> 100 then
    raise exception 'distribute_meso 3등분 합계 불일치';
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into v_rls_off
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_rls_off is not null then
    raise exception 'RLS 가 비활성화된 테이블이 있습니다: %', v_rls_off;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if v_missing is not null then
    raise exception 'RLS 정책이 없는 테이블이 있습니다: %', v_missing;
  end if;

  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;
