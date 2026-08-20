-- =============================================================================
-- 친구 기능 — 닉네임 검색 · 검색 거부 · 링크로 친구 추가
-- =============================================================================
--
-- 발주 지시(2026-08-20): *"친구기능 실제로 구현. 검색 신청 수락 목록. 전부 추가 하고 맨위에
-- 수익 옆에 친구 탭 만들어. 닉네임으로 검색 신청이 가능하지만 내 설정에 검색 거부도 있어야함.
-- 거부 시 링크로 친추 가능"*
--
-- `friendships` 테이블은 **처음부터 있었다**(마이그레이션 6). 그런데 읽는 코드가 한 곳
-- (`fetchPeople` 의 후보 목록)뿐이고 **쓰는 코드가 없어서** 행이 0건이었다 — 스키마에만
-- 존재하는 기능이었다. 이 마이그레이션은 그 위에 두 가지를 얹는다.
--
--   ① `app_users.friend_discoverable` — 닉네임 검색에 걸릴 것인가.
--   ② `friend_links` — 검색을 꺼 둔 사람에게 친구를 걸 수 있는 **개인 초대 링크**.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 링크가 필요한가
-- ─────────────────────────────────────────────────────────────────────────────
-- 검색 거부는 "아무나 나를 못 찾게" 하는 설정이다. 그런데 그것만 두면 **아는 사람도** 나를
-- 추가할 방법이 사라진다. 그래서 링크가 짝으로 온다 — 내가 건네준 사람만 나를 찾는다.
--
-- ★ 토큰 원문은 저장하지 않는다. SHA-256 해시만 보관하고 발급 순간에 **한 번만** 보여 준다
--   (`invite_links` · API 키와 같은 기조, §2.1). 다시 보고 싶으면 새로 만들면 되고, 새로
--   만들면 옛 링크는 그 자리에서 죽는다 — 유출된 링크를 되돌릴 방법이 그것뿐이다.
-- ★ **사람당 한 줄**이다(`user_id` 유니크). 링크를 여러 개 굴리면 "어느 것이 살아 있나"를
--   사람이 관리해야 하는데, 이 기능의 크기에 맞지 않는다.

-- -----------------------------------------------------------------------------
-- 30-1. 닉네임 검색 허용 여부
-- -----------------------------------------------------------------------------
alter table public.app_users
  add column if not exists friend_discoverable boolean not null default true;

comment on column public.app_users.friend_discoverable is
  '닉네임 검색으로 나를 찾을 수 있는가. false 면 검색 결과에서 제외되고, 친구 추가는 개인 링크(friend_links)로만 가능하다.';

-- -----------------------------------------------------------------------------
-- 30-2. 개인 친구 링크
-- -----------------------------------------------------------------------------
create table if not exists public.friend_links (
  user_id     uuid primary key references public.app_users(id) on delete cascade,
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  -- 만료를 두지 않는다. 이 링크가 주는 권한은 "나에게 친구 신청을 건다" 하나뿐이고,
  -- 그 신청은 **내가 수락해야** 관계가 된다. 시간으로 죽이는 것보다 새로 만들어 갈아치우는
  -- 쪽이 사람이 이해하기 쉽다.
  rotated_at  timestamptz
);

comment on table public.friend_links is
  '개인 친구 초대 링크. 토큰 원문은 저장하지 않고 SHA-256 해시만 보관한다. 사람당 한 줄이며 새로 만들면 옛 링크는 죽는다. anon/authenticated 전면 차단.';

-- -----------------------------------------------------------------------------
-- 30-3. 닉네임 검색 인덱스
-- -----------------------------------------------------------------------------
-- 검색은 **본캐 닉네임 앞부분 일치**다(§2.1 — 표시 신원이 본캐 닉네임이다).
-- `lower()` 표현식 인덱스라 대소문자를 가리지 않는다. `text_pattern_ops` 는 `like 'abc%'`
-- 를 인덱스로 태우기 위한 것이다 — 없으면 사용자가 늘수록 전체 스캔이 된다.
create index if not exists app_users_main_character_search_idx
  on public.app_users (lower(main_character_name) text_pattern_ops)
  where friend_discoverable and main_character_name is not null;

-- -----------------------------------------------------------------------------
-- 30-4. RLS — 새 테이블도 **전면 차단**이 기본이다
-- -----------------------------------------------------------------------------
-- 마이그레이션 9 의 비공개 테이블 루프와 **같은 모양**을 그대로 적용한다. 목록에 새 테이블을
-- 더하는 것이 아니라 여기서 같은 정책을 다시 쓰는 이유는, 그 루프가 이미 지나간 뒤이기
-- 때문이다. 정책 이름 규칙(`_no_public_access` · `_service_role_all`)은 맞춘다.
alter table public.friend_links enable row level security;

revoke all on table public.friend_links from anon;
revoke all on table public.friend_links from authenticated;
grant all  on table public.friend_links to service_role;

drop policy if exists friend_links_no_public_access on public.friend_links;
create policy friend_links_no_public_access on public.friend_links
  as permissive for all to anon, authenticated using (false) with check (false);

drop policy if exists friend_links_service_role_all on public.friend_links;
create policy friend_links_service_role_all on public.friend_links
  as permissive for all to service_role using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 30-5. 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_rls  boolean;
  v_anon boolean;
begin
  -- ① 새 테이블에 RLS 가 켜져 있는가.
  select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'friend_links';
  if not coalesce(v_rls, false) then
    raise exception '30-5: friend_links 에 RLS 가 꺼져 있습니다.';
  end if;

  -- ② anon 이 읽을 수 없는가. 토큰 해시가 공개면으로 나가면 링크가 통째로 새는 것과 같다.
  select has_table_privilege('anon', 'public.friend_links', 'select') into v_anon;
  if v_anon then
    raise exception '30-5: friend_links 를 anon 이 읽을 수 있습니다.';
  end if;

  -- ③ 새 컬럼의 기본값이 true 인가. 기존 사용자는 **지금까지처럼 검색되는 것**이 기본이며,
  --    끄는 것은 본인의 선택이어야 한다(조용히 전원을 숨기면 아무도 서로를 못 찾는다).
  if exists (select 1 from public.app_users where friend_discoverable is null) then
    raise exception '30-5: friend_discoverable 이 null 인 사용자가 있습니다.';
  end if;
end
$$;

-- 컬럼 유출 가드. `app_users` 에 컬럼을 더했으므로 반드시 다시 확인한다 — 테이블 GRANT 가
-- 나중에 추가된 컬럼을 조용히 삼키는 것이 `share_bp` 사고의 경로였다.
select public.assert_no_public_sensitive_columns();
