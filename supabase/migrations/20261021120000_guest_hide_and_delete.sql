-- ═══════════════════════════════════════════════════════════════════════════════
-- 게스트 숨기기 · 지우기 — ⚠️ **파일만 있다. 적용은 발주자가 한다** (2026-10-21)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시: *"그리고 삭제 할수있게도 해줘. 내 기준 게스트니까."*
--
-- 이 작업의 절반은 **지우면 안 되는 것을 지우지 못하게 막는 것**이다. 그래서 이 파일은
-- 기능 두 개(숨기기 · 지우기)보다 **막는 장치**가 더 길다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 기본이 "지우기"가 아니라 "숨기기"인가
-- ───────────────────────────────────────────────────────────────────────────────
-- `party_participants.guest_id` 는 **ON DELETE CASCADE** 이고, 그 참가자 행에 또
-- CASCADE 로 매달린 것이 있다: `run_signups` · `run_drop_shares` ·
-- `party_bundle_shares` · `party_bundle_characters`. SET NULL 로 매달린 것도 있다:
-- `party_runs.created_by_participant_id` · `run_drops.solo_participant_id` ·
-- `run_drops.recorded_by_participant_id`. 즉 게스트 한 행을 지우면 **그 사람이 간 일정과
-- 받은 몫이 함께 사라지고**, 남는 드랍 기록은 "누가 먹었는지"를 잃는다.
-- 실측(2026-10-21): 중복 `구름아이` 한쪽이 `run_signups` 4건을 지고 있다.
--
-- 그래서:
--   · **숨기기** = `hidden_at` 한 칸. 후보 목록에서만 빠지고, 지난 일정·수익·파티 명단은
--     `party_participants.display_name` 스냅샷으로 그려지므로 이름이 그대로 남는다.
--     언제든 되돌릴 수 있다.
--   · **지우기** = 진짜 DELETE. **기록이 0건일 때만** 된다. 그때는 잃을 것이 파티의
--     구성원 자리(번호)뿐이고, 번호는 아래 4절이 지킨다.
--   · **승계된 게스트**(`claimed_by_user_id is not null`)는 **둘 다 안 된다.** 그 사람은
--     이제 계정으로 산다. 실측 6행이 전부 이 경우이고 각자 `guest_claims` 1건을 지는데,
--     그 FK 도 CASCADE 라 지우면 "이 사람이 승계했다"는 기록이 사라진다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- "내가 만든 게스트" 를 어떻게 판정하는가 — 컬럼을 **만들지 않았다**
-- ───────────────────────────────────────────────────────────────────────────────
-- `guest_profiles` 에는 만든 사람 칸이 없다. 가까운 것은 `created_via_invite_id`
-- (→ `invite_links.created_by_user_id`)인데, 이름으로 넣은 게스트(`resolveGuestNames`)는
-- 이 칸이 **언제나 null** 이라 판정에 쓸 수 없다. 발주 지시대로 새 칸은 만들지 않았다.
--
-- 대신 **그 게스트가 들어 있는 파티 전부의 소유자**로 판정한다:
--     관리 가능 ⇔ 그 게스트의 `party_participants` 행이 **하나 이상** 있고,
--                그 행들의 파티가 **전부** `owner_user_id = 나` 다.
--   · 나간 행(`left_at`)과 보관된 파티(`archived_at`)도 센다. 한 번이라도 남의 파티에
--     들어갔던 게스트는 그 사람의 기록이기도 하다 — 좁게 보는 쪽이 안전하다.
--   · 남의 파티에 하나라도 있으면 **거절**한다. 숨김은 행 하나에 붙는 **전역** 칸이라,
--     내가 숨기면 그 파티 사람들의 후보에서도 빠진다. 그 결정을 내가 내릴 수 있는 것은
--     그 게스트를 볼 수 있는 사람이 **전부 내 파티 사람**일 때뿐이다.
--   · 초대 링크 발급(`invite-repo.assertCanInviteGuest`)은 "같은 파티면 된다" 로 더
--     넓다. 그 눈높이를 쓰지 않은 이유: 초대는 상대가 링크를 눌러야 완성되는 **되돌릴 수
--     있는** 일이고, 지우기는 아니다. 그 기준이면 아무 파티원이나 소유자가 만든 게스트를
--     지울 수 있다.
--   · 파티가 하나도 없는 게스트는 만든 사람을 알 수 없으므로 **아무도 못 건드린다.**
--     (후보 목록은 `party_participants` 를 지나 만들어지므로 화면에 나올 일도 없다.)
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 막는 장치가 **DB 에** 있는 이유
-- ───────────────────────────────────────────────────────────────────────────────
-- 판정은 함수(`guest_manage_states`)가 하고 앱은 그 답을 그대로 쓴다. 그러나 앱 밖에서
-- `delete from guest_profiles` 를 치는 사람(나중의 정리 스크립트, SQL 편집기)은 그 함수를
-- 지나지 않는다. 그래서 **BEFORE DELETE 트리거**가 같은 경계를 한 번 더 지킨다 —
-- 승계된 행이거나 기록이 있으면 어떤 경로로든 지워지지 않는다.
-- (정말로 지워야 하면 `alter table public.guest_profiles disable trigger
--  guest_profiles_guard_delete` 를 **의식적으로** 쳐야 한다. 그게 의도된 마찰이다.)
--
-- 재실행 가능하다: 칸·제약·인덱스는 `if not exists`, 함수는 `create or replace`,
-- 트리거는 `drop ... if exists` 후 생성.
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. 칸 — 숨김
-- #############################################################################

alter table public.guest_profiles
  add column if not exists hidden_at timestamptz;
alter table public.guest_profiles
  add column if not exists hidden_by_user_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'guest_profiles_hidden_by_user_fk'
  ) then
    -- 숨긴 사람이 탈퇴해도 숨김은 남는다(그 결정은 이미 내려졌다). 누가 했는지만 빈다.
    alter table public.guest_profiles
      add constraint guest_profiles_hidden_by_user_fk
      foreign key (hidden_by_user_id) references public.app_users(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'guest_profiles_hidden_by_requires_hidden_at'
  ) then
    -- 한 방향만 건다. 반대 방향(hidden_at 이 있으면 hidden_by 도)은 위 SET NULL 이 깬다.
    alter table public.guest_profiles
      add constraint guest_profiles_hidden_by_requires_hidden_at
      check (hidden_by_user_id is null or hidden_at is not null);
  end if;
end
$$;

comment on column public.guest_profiles.hidden_at is
  '후보 목록(사람 고르기)에서 숨긴 시각. null = 보인다. **기록을 지우지 않는다** — 지난 일정·'
  '수익·파티 명단은 party_participants.display_name 스냅샷으로 그려져 이름이 그대로 남는다. '
  '승계된 게스트는 숨길 수 없고, 승계되는 순간 이 칸은 비워진다(guest_profiles_guard_hidden).';
comment on column public.guest_profiles.hidden_by_user_id is
  '숨긴 사람. 감사용이며 판정에 쓰지 않는다(판정은 파티 소유 — guest_manage_states).';

-- FK 인덱스(20260817093000 이 세운 규약: FK 컬럼에는 인덱스).
create index if not exists guest_profiles_hidden_by_idx
  on public.guest_profiles (hidden_by_user_id)
  where hidden_by_user_id is not null;


-- #############################################################################
-- 2. 칸 — 번호 바닥 (§1.4: 빈 번호 재사용 금지)
-- #############################################################################
--
-- ★ 지우기가 번호를 깨는 경로가 하나 있다. `member_no` 는 트리거가 **그 파티 행들의
--   max + 1** 로 주는데, 지운 게스트가 그 파티의 **마지막 번호**였다면 그 번호가 max 에서
--   빠지고 **다음에 들어오는 사람이 같은 번호를 받는다.** 카톡에서 "5번" 이 어제와 오늘
--   다른 사람을 가리키게 되는 것 — §1.4 가 금지하는 바로 그것이다.
--
--   그래서 파티가 **"쓴 적 있는 가장 큰 번호"** 를 기억한다. 지우기 직전에 트리거가
--   그 값을 올려 두고, 번호 배정은 max 와 이 값 중 큰 쪽 + 1 을 준다.
--   보통의 파티는 이 값이 0 이라 배정 결과가 지금과 **한 글자도** 다르지 않다.

alter table public.parties
  add column if not exists member_no_floor smallint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'parties_member_no_floor_nonneg'
  ) then
    alter table public.parties
      add constraint parties_member_no_floor_nonneg check (member_no_floor >= 0);
  end if;
end
$$;

comment on column public.parties.member_no_floor is
  '이 파티에서 **지워진** 구성원 행이 쓰던 번호 중 가장 큰 값. 새 번호는 '
  'greatest(max(member_no), member_no_floor) + 1 이다. 행을 지워도 번호가 재사용되지 않게 '
  '하는 장치(§1.4). 0 = 지워진 행이 없다.';

/*
  ⚠️ 원본(`20260817091400_management_numbers.sql`)과 **바뀐 것은 max 계산 한 줄뿐**이다.
     명시 지정 존중 · advisory lock · smallint 는 그대로다. search_path 는
     `20260817093000` 이 모든 public 함수에 고정한 값을 여기서 함께 적는다 —
     `create or replace` 는 SET 절을 새로 쓰므로, 적지 않으면 그 고정이 풀린다.
*/
create or replace function public.party_participants_assign_member_no()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_next smallint;
begin
  if new.member_no is not null then
    return new;   -- 명시 지정(복원·이관)은 존중한다
  end if;

  perform pg_advisory_xact_lock(hashtextextended('party_member:' || new.party_id::text, 0));

  select (greatest(
            coalesce(max(pp.member_no), 0),
            coalesce((select p.member_no_floor from public.parties p where p.id = new.party_id), 0)
          ) + 1)::smallint
    into v_next
    from public.party_participants pp
   where pp.party_id = new.party_id;

  new.member_no := v_next;
  return new;
end;
$func$;


-- #############################################################################
-- 3. 판정 — 무엇이 사라지는가 / 누가 정리할 수 있는가
-- #############################################################################

/*
  한 게스트에 매달린 **기록**을 센다. 트리거(4절)와 판정 함수가 같은 숫자를 봐야 하므로
  한 곳에 둔다 — 두 벌이면 "화면은 지울 수 있다는데 DB 가 거절한다" 가 생긴다.

  · seats            — 파티 구성원 자리(나간 행 포함). **기록이 아니다**: 지우면 그 자리가
                       비고 번호는 2절이 지킨다.
  · signups          — 일정 참여(run_signups). CASCADE 로 함께 죽는다.
  · drop_shares      — 드랍 분배 몫(run_drop_shares). CASCADE.
  · drop_refs        — 드랍을 혼자 먹었거나 기록한 사람(run_drops). SET NULL 로 이름을 잃는다.
  · runs_authored    — 그 사람이 등록한 일정(party_runs.created_by_participant_id). SET NULL.
  · bundle_settings  — 묶음별 분배 비율·캐릭터(party_bundle_shares/characters). CASCADE.
                       사용자가 **일부러 정한 값**만 행이 있다(빈 행을 만들지 않는 규약).
  · claim_logs       — 승계 감사 로그(guest_claims). CASCADE.
  · invites          — 초대 링크 사용 이력(invite_redemptions). SET NULL.
  · availability     — 가능 시간 계열 6표(2026-09-28 에 화면은 없어졌지만 표와 행은 있다).
*/
create or replace function public.guest_history_counts(p_guest_id uuid)
returns table (
  seats           integer,
  signups         integer,
  drop_shares     integer,
  drop_refs       integer,
  runs_authored   integer,
  bundle_settings integer,
  claim_logs      integer,
  invites         integer,
  availability    integer
)
language sql
stable
set search_path = public, pg_temp
as $func$
  with pp as (
    select id from public.party_participants where guest_id = p_guest_id
  )
  select
    (select count(*) from pp)::integer,
    (select count(*) from public.run_signups s
      where s.participant_id in (select id from pp))::integer,
    (select count(*) from public.run_drop_shares d
      where d.participant_id in (select id from pp))::integer,
    (select count(*) from public.run_drops r
      where r.solo_participant_id in (select id from pp)
         or r.recorded_by_participant_id in (select id from pp))::integer,
    (select count(*) from public.party_runs r
      where r.created_by_participant_id in (select id from pp))::integer,
    ((select count(*) from public.party_bundle_shares b
       where b.participant_id in (select id from pp))
     + (select count(*) from public.party_bundle_characters c
       where c.participant_id in (select id from pp)))::integer,
    (select count(*) from public.guest_claims g where g.guest_id = p_guest_id)::integer,
    (select count(*) from public.invite_redemptions i where i.guest_id = p_guest_id)::integer,
    ((select count(*) from public.availability_patterns   a where a.guest_id = p_guest_id)
     + (select count(*) from public.availability_exceptions a where a.guest_id = p_guest_id)
     + (select count(*) from public.availability_cycles     a where a.guest_id = p_guest_id)
     + (select count(*) from public.availability_modes      a where a.guest_id = p_guest_id)
     + (select count(*) from public.shift_presets           a where a.guest_id = p_guest_id)
     + (select count(*) from public.shift_assignments       a where a.guest_id = p_guest_id)
    )::integer;
$func$;

comment on function public.guest_history_counts(uuid) is
  '게스트에 매달린 기록 수. seats 를 뺀 나머지가 하나라도 0 이 아니면 그 게스트는 지울 수 없다 '
  '(guest_profiles_guard_delete 와 guest_manage_states 가 같은 값을 본다).';

/*
  열람자 기준으로 게스트들의 상태를 돌려준다. 앱(`schedule-repo`)은 이 답을 **그대로**
  화면에 싣는다 — 버튼이 보이는 조건과 서버가 받아 주는 조건이 같은 함수에서 나온다.

  block_reason (먼저 걸리는 것 하나):
    'claimed'  — 승계됨. 숨기기·지우기 둘 다 불가.
    'no_party' — 어느 파티에도 없다. 만든 사람을 알 수 없어 불가.
    'not_mine' — 남의 파티에도 있다. 불가(머리말 — 숨김은 전역이다).
    'history'  — 기록이 있다. **숨기기만** 된다.
    null       — 둘 다 된다.
*/
create or replace function public.guest_manage_states(
  p_user_id   uuid,
  p_guest_ids uuid[]
)
returns table (
  guest_id            uuid,
  display_name        text,
  hidden_at           timestamptz,
  claimed             boolean,
  party_count         integer,
  foreign_party_count integer,
  seats               integer,
  signups             integer,
  drop_shares         integer,
  drop_refs           integer,
  runs_authored       integer,
  bundle_settings     integer,
  claim_logs          integer,
  invites             integer,
  availability        integer,
  history_total       integer,
  can_hide            boolean,
  can_delete          boolean,
  block_reason        text
)
language sql
stable
set search_path = public, pg_temp
as $func$
  select
    g.id,
    g.display_name,
    g.hidden_at,
    g.claimed_by_user_id is not null,
    o.party_count,
    o.foreign_party_count,
    h.seats,
    h.signups,
    h.drop_shares,
    h.drop_refs,
    h.runs_authored,
    h.bundle_settings,
    h.claim_logs,
    h.invites,
    h.availability,
    t.total,
    (g.claimed_by_user_id is null and o.party_count > 0 and o.foreign_party_count = 0),
    (g.claimed_by_user_id is null and o.party_count > 0 and o.foreign_party_count = 0
      and t.total = 0),
    case
      when g.claimed_by_user_id is not null then 'claimed'
      when o.party_count = 0 then 'no_party'
      when o.foreign_party_count > 0 then 'not_mine'
      when t.total > 0 then 'history'
      else null
    end
  from public.guest_profiles g
  cross join lateral (
    select
      count(distinct pp.party_id)::integer as party_count,
      (count(distinct pp.party_id)
         filter (where p.owner_user_id is distinct from p_user_id))::integer
        as foreign_party_count
    from public.party_participants pp
    join public.parties p on p.id = pp.party_id
    where pp.guest_id = g.id
  ) o
  cross join lateral public.guest_history_counts(g.id) h
  cross join lateral (
    select (h.signups + h.drop_shares + h.drop_refs + h.runs_authored
            + h.bundle_settings + h.claim_logs + h.invites + h.availability)::integer
           as total
  ) t
  where g.id = any (p_guest_ids)
    and p_user_id is not null;
$func$;

comment on function public.guest_manage_states(uuid, uuid[]) is
  '열람자 기준 게스트 정리 가능 여부. 관리 가능 = 그 게스트가 든 파티가 하나 이상이고 전부 '
  '열람자 소유. 지우기는 거기에 더해 기록(guest_history_counts 의 seats 제외 합)이 0.';


-- #############################################################################
-- 4. 막는 장치 — 트리거
-- #############################################################################

/*
  ★ 어떤 경로로 지우든(앱 · 스크립트 · SQL 편집기) 같은 경계를 지킨다.
  ★ 지워도 될 때는 **번호 바닥을 먼저 올린다**(2절). CASCADE 가 참가자 행을 데려가기
    전이라야 그 번호를 읽을 수 있다 — 그래서 BEFORE 다.
  ⚠️ 동시성: 다른 트랜잭션이 아직 커밋하지 않은 `run_signups` 는 여기서 보이지 않는다.
     지우기는 사람이 확인 창을 거쳐 누르는 드문 일이고, 그 사이에 같은 게스트로 일정이
     잡히는 경합은 밀리초 단위다. 그 창을 닫으려면 참가 쓰기 전부가 게스트 행을 잠가야
     하는데, 그 비용을 모든 일정 등록에 물리지 않았다.
*/
create or replace function public.guest_profiles_guard_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  h       record;
  v_total integer;
begin
  if old.claimed_by_user_id is not null then
    raise exception
      '승계된 게스트(%)는 지울 수 없습니다 — 그 사람은 이제 계정으로 삽니다.', old.id
      using errcode = 'restrict_violation';
  end if;

  select * into h from public.guest_history_counts(old.id);
  v_total := h.signups + h.drop_shares + h.drop_refs + h.runs_authored
           + h.bundle_settings + h.claim_logs + h.invites + h.availability;

  if v_total > 0 then
    raise exception
      '기록이 있는 게스트(%)는 지울 수 없습니다 — 일정 참여 %건 · 분배 %건 · 드랍 %건 · '
      '등록한 일정 %건 · 묶음 설정 %건 · 승계 %건 · 초대 %건 · 가능 시간 %건. 숨기기를 쓰세요.',
      old.id, h.signups, h.drop_shares, h.drop_refs, h.runs_authored,
      h.bundle_settings, h.claim_logs, h.invites, h.availability
      using errcode = 'restrict_violation';
  end if;

  -- §1.4 — 이 게스트가 쓰던 번호를 파티가 기억한다(2절).
  update public.parties p
     set member_no_floor = greatest(p.member_no_floor, pp.member_no)
    from public.party_participants pp
   where pp.guest_id = old.id
     and p.id = pp.party_id
     and pp.member_no > p.member_no_floor;

  return old;
end;
$func$;

drop trigger if exists guest_profiles_guard_delete on public.guest_profiles;
create trigger guest_profiles_guard_delete
  before delete on public.guest_profiles
  for each row execute function public.guest_profiles_guard_delete();

/*
  숨김과 승계가 만나는 자리.
  · 승계되는 순간 숨김을 **비운다.** 그 행은 이제 아무 목록에도 게스트로 나오지 않고
    (참가자 행이 계정으로 옮겨 간다), 남은 숨김 표시는 "왜 숨겨져 있지" 의 거짓 단서가 된다.
    ⚠️ 여기서 **막지 않는다** — CHECK 로 막으면 숨긴 게스트의 초대 링크 승계가 실패한다.
  · 이미 승계된 행을 **새로 숨기는 것**은 막는다.
*/
create or replace function public.guest_profiles_guard_hidden()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $func$
begin
  if new.claimed_by_user_id is not null then
    if old.claimed_by_user_id is null then
      new.hidden_at := null;
      new.hidden_by_user_id := null;
    elsif new.hidden_at is not null and old.hidden_at is null then
      raise exception
        '승계된 게스트(%)는 숨길 수 없습니다 — 그 사람은 이제 계정으로 삽니다.', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$func$;

drop trigger if exists guest_profiles_guard_hidden on public.guest_profiles;
create trigger guest_profiles_guard_hidden
  before update of hidden_at, hidden_by_user_id, claimed_by_user_id
  on public.guest_profiles
  for each row execute function public.guest_profiles_guard_hidden();


-- #############################################################################
-- 5. 쓰기 — 앱이 부르는 두 함수
-- #############################################################################
--
-- 둘 다 **게스트 행을 잠근 뒤** 판정한다. 판정과 쓰기 사이에 다른 요청이 같은 게스트를
-- 승계하거나 숨김을 뒤집지 못하게 하려는 것이다.
--
-- 오류 코드 — 앱(`schedule-repo`)이 이 코드로 화면 문구를 고른다(DB 문구를 그대로 내보내지
-- 않는다):
--   P0002 no_data_found          → 404 없는 게스트
--   42501 insufficient_privilege → 403 내 것이 아니다(남의 파티에도 있다 / 파티가 없다)
--   23001 restrict_violation     → 409 승계됨 / 기록이 있다

create or replace function public.set_guest_hidden(
  p_user_id  uuid,
  p_guest_id uuid,
  p_hidden   boolean
)
returns timestamptz
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  s        record;
  v_result timestamptz;
begin
  if p_user_id is null or p_guest_id is null or p_hidden is null then
    raise exception '인자가 비었습니다.' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.guest_profiles where id = p_guest_id for update;
  if not found then
    raise exception '게스트(%)를 찾을 수 없습니다.', p_guest_id using errcode = 'no_data_found';
  end if;

  select * into s from public.guest_manage_states(p_user_id, array[p_guest_id]);

  if s.claimed then
    raise exception '승계된 게스트(%)는 숨기거나 되돌릴 수 없습니다.', p_guest_id
      using errcode = 'restrict_violation';
  end if;
  if not s.can_hide then
    raise exception '게스트(%)를 정리할 권한이 없습니다(사유: %).', p_guest_id, s.block_reason
      using errcode = 'insufficient_privilege';
  end if;

  if p_hidden then
    -- 이미 숨겨져 있으면 처음 숨긴 시각·사람을 그대로 둔다(멱등).
    update public.guest_profiles
       set hidden_at = coalesce(hidden_at, now()),
           hidden_by_user_id = case when hidden_at is null then p_user_id
                                    else hidden_by_user_id end
     where id = p_guest_id
     returning hidden_at into v_result;
  else
    update public.guest_profiles
       set hidden_at = null,
           hidden_by_user_id = null
     where id = p_guest_id
     returning hidden_at into v_result;
  end if;

  return v_result;
end;
$func$;

comment on function public.set_guest_hidden(uuid, uuid, boolean) is
  '게스트를 후보 목록에서 숨기거나 되돌린다. 열람자가 그 게스트가 든 파티 전부의 소유자일 때만. '
  '기록은 건드리지 않는다.';

create or replace function public.delete_guest_profile(
  p_user_id  uuid,
  p_guest_id uuid
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  s record;
begin
  if p_user_id is null or p_guest_id is null then
    raise exception '인자가 비었습니다.' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.guest_profiles where id = p_guest_id for update;
  if not found then
    raise exception '게스트(%)를 찾을 수 없습니다.', p_guest_id using errcode = 'no_data_found';
  end if;

  select * into s from public.guest_manage_states(p_user_id, array[p_guest_id]);

  if s.claimed then
    raise exception '승계된 게스트(%)는 지울 수 없습니다.', p_guest_id
      using errcode = 'restrict_violation';
  end if;
  if not s.can_hide then
    raise exception '게스트(%)를 정리할 권한이 없습니다(사유: %).', p_guest_id, s.block_reason
      using errcode = 'insufficient_privilege';
  end if;
  if not s.can_delete then
    raise exception '기록이 %건 있는 게스트(%)는 지울 수 없습니다 — 숨기기를 쓰세요.',
      s.history_total, p_guest_id
      using errcode = 'restrict_violation';
  end if;

  -- 트리거(4절)가 같은 경계를 한 번 더 보고, 번호 바닥을 올린 뒤 지운다.
  delete from public.guest_profiles where id = p_guest_id;

  return s.seats;
end;
$func$;

comment on function public.delete_guest_profile(uuid, uuid) is
  '게스트를 지운다. 열람자 소유 + 미승계 + 기록 0건일 때만. 돌려주는 값은 함께 사라진 '
  '파티 구성원 자리 수(번호는 parties.member_no_floor 가 지킨다). 되돌릴 수 없다.';


-- #############################################################################
-- 6. 권한 — 함수는 service_role 전용
-- #############################################################################
--
-- 표 쪽은 아무것도 바꾸지 않는다. `guest_profiles` · `parties` 는 08 이 정한 규약 그대로다
-- (guest_profiles 는 비공개 19표 — anon/authenticated 권한 0, parties 는 공개 행만 RLS 로
-- 읽힌다). 새 칸은 테이블 단위 GRANT 에 자동으로 들어가지만, anon/authenticated 에게는
-- guest_profiles 권한이 애초에 없고 parties 는 아래 자기검증이 직접 확인한다.
--
-- 함수는 다르다: Postgres 는 새 함수에 **PUBLIC EXECUTE 를 기본으로 준다.** 열람자 id 를
-- 인자로 받는 함수를 anon 이 부를 수 있으면 "아무 id 로나 남의 게스트를 지운다" 가 된다.

do $$
declare
  f text;
  fns text[] := array[
    'public.guest_history_counts(uuid)',
    'public.guest_manage_states(uuid, uuid[])',
    'public.set_guest_hidden(uuid, uuid, boolean)',
    'public.delete_guest_profile(uuid, uuid)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;


-- #############################################################################
-- 7. 자기검증 — 확인하지 않은 가정은 남기지 않는다
-- #############################################################################

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'guest_profiles'
       and column_name = 'hidden_at'
  ) then
    raise exception 'guest_profiles.hidden_at 가 만들어지지 않았습니다.';
  end if;

  if has_column_privilege('anon', 'public.guest_profiles', 'hidden_at', 'SELECT')
     or has_column_privilege('authenticated', 'public.guest_profiles', 'hidden_at', 'SELECT')
     or has_column_privilege('anon', 'public.guest_profiles', 'hidden_by_user_id', 'SELECT')
     or has_column_privilege('authenticated', 'public.guest_profiles', 'hidden_by_user_id', 'SELECT')
  then
    raise exception 'guest_profiles 의 숨김 칸이 anon/authenticated 에게 노출되었습니다.';
  end if;

  if has_column_privilege('anon', 'public.parties', 'member_no_floor', 'UPDATE')
     or has_column_privilege('authenticated', 'public.parties', 'member_no_floor', 'UPDATE')
  then
    raise exception 'parties.member_no_floor 를 anon/authenticated 가 쓸 수 있습니다.';
  end if;

  if not has_column_privilege('service_role', 'public.guest_profiles', 'hidden_at', 'UPDATE') then
    raise exception 'service_role 이 guest_profiles.hidden_at 을 쓸 수 없습니다.';
  end if;

  if has_function_privilege('anon', 'public.delete_guest_profile(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.delete_guest_profile(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_guest_hidden(uuid, uuid, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.set_guest_hidden(uuid, uuid, boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.guest_manage_states(uuid, uuid[])', 'EXECUTE')
  then
    raise exception '게스트 정리 함수가 anon/authenticated 에게 열려 있습니다.';
  end if;

  if (select relrowsecurity from pg_class where oid = 'public.guest_profiles'::regclass) is not true
  then
    raise exception 'guest_profiles 에 RLS 가 켜져 있지 않습니다.';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'guest_profiles_guard_delete'
       and tgrelid = 'public.guest_profiles'::regclass
       and not tgisinternal
  ) then
    raise exception 'guest_profiles_guard_delete 트리거가 없습니다.';
  end if;

  raise notice '게스트 숨기기·지우기 준비 완료 — 함수 4개 service_role 전용, 지우기 경계 트리거 설치';
end
$$;

select public.assert_no_public_sensitive_columns();
