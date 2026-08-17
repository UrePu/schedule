-- =============================================================================
-- M_Schedule · 05. 친구 / 초대 링크 / 임시 참가자 승계(claim)
-- =============================================================================
-- 발주자 요구사항 원문:
--   "초대는 메일이 아니라 링크. 초대 링크로 들어와 이름을 적으면 그 사람에게도
--    바로 적용되는 임시 테이블이 필요하다."
--   → 아직 넥슨 키로 가입하지 않은 사람도 **이름만으로 파티 자리를 차지하고 일정에 나타나야**
--     하며, 나중에 정식 가입하면 그 임시 레코드가 실제 계정으로 **승계(claim)** 되어야 한다.
--
-- 승계 경로:
--   invite_links(토큰) → 이름 입력 → guest_profiles + party_participants(guest_id)
--   → 정식 가입(넥슨 키) → claim_guest_profile() → party_participants 가 user_id 로 전환
--   → 그 사람의 가용시간·참여의사·런 생성 이력이 전부 계정에 따라온다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- friendships — 친구 관계
-- -----------------------------------------------------------------------------
-- 두 사용자 사이에는 방향과 무관하게 **행이 하나만** 존재한다.
-- (A→B pending 과 B→A pending 이 동시에 생기면 수락 로직이 애매해진다)
create table if not exists public.friendships (
  id                 uuid primary key default gen_random_uuid(),
  requester_user_id  uuid not null references public.app_users(id) on delete cascade,
  addressee_user_id  uuid not null references public.app_users(id) on delete cascade,

  status             public.friendship_status not null default 'pending',

  -- 차단은 방향이 있다. 누가 차단했는지 남긴다.
  blocked_by_user_id uuid references public.app_users(id) on delete cascade,

  created_at         timestamptz not null default now(),
  responded_at       timestamptz,

  constraint friendships_not_self check (requester_user_id <> addressee_user_id),
  constraint friendships_blocked_has_actor check (
    (status = 'blocked') = (blocked_by_user_id is not null)
  )
);

comment on table public.friendships is
  '친구 관계. 두 사용자 쌍당 행 하나(방향 무관)만 존재한다.';

-- least/greatest 는 uuid 에 대해 IMMUTABLE 이므로 표현식 유니크 인덱스에 쓸 수 있다.
create unique index if not exists friendships_pair_uniq
  on public.friendships (
    least(requester_user_id, addressee_user_id),
    greatest(requester_user_id, addressee_user_id)
  );

-- 친구 목록 조회는 양방향이므로 두 방향 모두 인덱스가 필요하다.
create index if not exists friendships_requester_idx
  on public.friendships (requester_user_id, status);

create index if not exists friendships_addressee_idx
  on public.friendships (addressee_user_id, status);

-- -----------------------------------------------------------------------------
-- invite_links — 파티 초대 링크 (메일 아님, 링크)
-- -----------------------------------------------------------------------------
-- 토큰 원문은 저장하지 않는다. 발급 시 1회만 노출하고 서버는 SHA-256 해시만 보관한다
-- (CLAUDE.md §2.1 의 API 키 원칙과 같은 기조).
create table if not exists public.invite_links (
  id                 uuid primary key default gen_random_uuid(),
  party_id           uuid not null references public.parties(id) on delete cascade,

  token_hash         text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  created_by_user_id uuid references public.app_users(id) on delete set null,
  role_on_join       public.party_member_role not null default 'member',

  label              text,
  max_uses           integer check (max_uses is null or max_uses > 0),
  used_count         integer not null default 0 check (used_count >= 0),

  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),

  constraint invite_links_uses_within_max check (
    max_uses is null or used_count <= max_uses
  ),
  -- 링크 자체가 비밀이므로 소유자(owner)로 승격시키는 초대는 만들지 않는다.
  constraint invite_links_no_owner_grant check (role_on_join <> 'owner')
);

comment on table public.invite_links is
  '파티 초대 링크. 토큰 원문은 저장하지 않고 SHA-256 해시만 보관한다. anon/authenticated 전면 차단.';

create index if not exists invite_links_party_idx
  on public.invite_links (party_id)
  where revoked_at is null;

-- -----------------------------------------------------------------------------
-- guest_profiles — 임시 참가자 (넥슨 키 없이 이름만으로 존재하는 사람)
-- -----------------------------------------------------------------------------
create table if not exists public.guest_profiles (
  id                    uuid primary key default gen_random_uuid(),

  display_name          text not null check (length(btrim(display_name)) between 1 and 40),

  created_via_invite_id uuid references public.invite_links(id) on delete set null,

  -- 게스트가 다른 기기에서 돌아오거나 나중에 본인임을 증명할 때 쓰는 토큰의 해시.
  -- 원문은 브라우저(쿠키/localStorage)에만 있고 서버는 해시만 안다.
  -- 승계가 끝나면 null 로 비워 재사용을 막는다.
  claim_token_hash      text unique check (claim_token_hash ~ '^[0-9a-f]{64}$'),

  claimed_by_user_id    uuid references public.app_users(id) on delete set null,
  claimed_at            timestamptz,

  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  expires_at            timestamptz,

  constraint guest_profiles_claim_pair check (
    (claimed_by_user_id is null) = (claimed_at is null)
  )
);

comment on table public.guest_profiles is
  '초대 링크로 이름만 적고 들어온 임시 참가자. 정식 가입 시 claim_guest_profile() 로 계정에 승계된다.';
comment on column public.guest_profiles.claim_token_hash is
  '게스트 재방문/승계 증명 토큰의 SHA-256 해시. 원문은 서버에 없다. 승계 완료 시 null 로 만든다.';

create index if not exists guest_profiles_unclaimed_idx
  on public.guest_profiles (created_at)
  where claimed_by_user_id is null;

create index if not exists guest_profiles_claimed_by_idx
  on public.guest_profiles (claimed_by_user_id)
  where claimed_by_user_id is not null;

-- party_participants.guest_id 의 FK 는 여기서 붙인다(순환 참조 회피).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'party_participants_guest_fk') then
    alter table public.party_participants
      add constraint party_participants_guest_fk
      foreign key (guest_id) references public.guest_profiles(id) on delete cascade;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- invite_redemptions — 초대 링크 사용 이력
-- -----------------------------------------------------------------------------
create table if not exists public.invite_redemptions (
  id             uuid primary key default gen_random_uuid(),
  invite_id      uuid not null references public.invite_links(id) on delete cascade,

  guest_id       uuid references public.guest_profiles(id) on delete set null,
  user_id        uuid references public.app_users(id) on delete set null,
  participant_id uuid references public.party_participants(id) on delete set null,

  -- 남용 추적용. 원문 IP 는 저장하지 않는다.
  ip_hash        text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  redeemed_at    timestamptz not null default now()
);

comment on table public.invite_redemptions is
  '초대 링크 사용 이력. 남용 추적과 max_uses 감사용. anon/authenticated 전면 차단.';

create index if not exists invite_redemptions_invite_idx
  on public.invite_redemptions (invite_id, redeemed_at desc);

create index if not exists invite_redemptions_guest_idx
  on public.invite_redemptions (guest_id)
  where guest_id is not null;

-- -----------------------------------------------------------------------------
-- guest_claims — 승계 감사 로그
-- -----------------------------------------------------------------------------
-- 승계는 "남의 참가 이력을 내 계정으로 가져오는" 보안 민감 동작이다. 흔적을 남긴다.
create table if not exists public.guest_claims (
  id                       uuid primary key default gen_random_uuid(),
  guest_id                 uuid not null references public.guest_profiles(id) on delete cascade,
  user_id                  uuid not null references public.app_users(id) on delete cascade,

  moved_participant_count  integer not null default 0 check (moved_participant_count >= 0),
  merged_participant_count integer not null default 0 check (merged_participant_count >= 0),

  claim_method             text not null default 'claim_token',
  claimed_at               timestamptz not null default now()
);

comment on table public.guest_claims is
  '임시 참가자 → 정식 계정 승계 감사 로그. anon/authenticated 전면 차단.';

create index if not exists guest_claims_user_idx
  on public.guest_claims (user_id, claimed_at desc);

create index if not exists guest_claims_guest_idx
  on public.guest_claims (guest_id);

-- -----------------------------------------------------------------------------
-- claim_guest_profile — 승계 실행 함수
-- -----------------------------------------------------------------------------
-- 여러 테이블을 한 트랜잭션으로 옮겨야 하고, 중간 상태가 노출되면 안 되므로
-- SECURITY DEFINER 함수로 캡슐화한다. 실행 권한은 service_role 에만 준다(마이그레이션 08).
--
-- 병합 규칙:
--   * 같은 파티에 이미 본인 참가자 행이 있으면 → 게스트 행의 가용시간/참여의사를 본인 행으로
--     옮기고(충돌은 본인 것 우선) 게스트 행을 삭제한다. (merged)
--   * 그 외 게스트 행은 그대로 user_id 로 전환한다. (moved)
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

  -- 1) 같은 파티에 본인 행이 이미 있는 경우 → 병합
  for r in
    select gp.id as guest_participant_id,
           up.id as user_participant_id
      from public.party_participants gp
      join public.party_participants up
        on up.party_id = gp.party_id
       and up.user_id = p_user_id
     where gp.guest_id = p_guest_id
  loop
    -- 가용시간: 본인 행에 같은 슬롯이 없을 때만 옮기고, 나머지는 버린다.
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

    -- 참여 의사: 같은 런에 본인 응답이 없을 때만 옮긴다.
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

    -- 게스트가 만든 런의 작성자도 본인 행으로 넘긴다.
    update public.party_runs
       set created_by_participant_id = r.user_participant_id
     where created_by_participant_id = r.guest_participant_id;

    delete from public.party_participants where id = r.guest_participant_id;
    v_merged := v_merged + 1;
  end loop;

  -- 2) 남은 게스트 참가자 행 → 정식 사용자 행으로 전환
  --    이 시점부터 표시명은 계정 표시명을 따라간다(app_users 트리거가 동기화).
  update public.party_participants
     set user_id      = p_user_id,
         guest_id     = null,
         display_name = v_display_name
   where guest_id = p_guest_id;
  get diagnostics v_moved = row_count;

  -- 3) 게스트 프로필 승계 확정. 토큰은 폐기한다.
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
  '임시 참가자(guest_profiles)를 정식 계정으로 승계한다. 파티 중복 시 병합하며 감사 로그를 남긴다. 실행 권한은 service_role 전용.';
