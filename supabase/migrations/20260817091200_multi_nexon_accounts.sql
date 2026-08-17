-- =============================================================================
-- M_Schedule · 12. 다중 넥슨 계정 지원 (본계정 + 부계정)
-- =============================================================================
-- 발주자 요구:
--   "여러 개의 다른 계정의 캐릭터도 등록을 할 수 있어야 함. API 키 + 본캐 닉네임으로 저장하되
--    다른 계정의 캐릭터도 등록할 수 있게. API 추가등록 기능"
--   "깔끔하게 본캐 닉네임 기준 API 로그인을 기준으로 하고 연결되는 추가 API 키를 넣을 수 있게.
--    만약 연결된 api 키로 입력해서 로그인한다고 해도 가능하도록"
--
-- 근본 제약(CLAUDE.md §1.1): **넥슨 API 키는 그 키를 발급한 계정의 캐릭터만 읽는다.**
-- 따라서 부계정 캐릭터를 보려면 그 계정의 키를 추가로 등록하는 수밖에 없다.
--
-- ── 이미 있던 것 (다시 만들지 않는다) ────────────────────────────────────────
--   user_credentials.user_id 에 유니크가 없어 사용자당 다중 키가 이미 가능하다. label 도 있다.
--   user_nexon_accounts 도 사용자당 다중 행이 가능하다.
--   app_users.main_character_name/main_world_name 스냅샷과 characters.is_main 도 이미 있다.
--   characters_one_main_per_user 부분 유니크 인덱스도 이미 있다(사용자당 본캐 1개).
-- ── 이 마이그레이션이 채우는 것 ──────────────────────────────────────────────
--   1) 캐릭터가 "어느 넥슨 계정에서 왔는지" 모른다 → 출처 참조 추가
--   2) 키 ↔ 넥슨 계정 연결이 없다 (account_list 는 배열이므로 M:N) → 링크 테이블
--   3) 키 무효화 시 캐릭터 상태 표현
--   4) 로그인 해석 / 키 추가 규칙을 함수로 못박기
--   5) 주 자격증명(primary credential) 개념과 본캐 연동
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 12-1. 열거 타입
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t
                 join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'character_sync_state' and n.nspname = 'public') then
    -- syncable     : 이 캐릭터가 속한 넥슨 계정에 유효한 키가 있어 스케줄러 API 호출이 가능하다
    -- no_valid_key : 키가 없거나 전부 무효화됨 → **읽기는 계속 되지만 동기화만 멈춘다**
    create type public.character_sync_state as enum ('syncable', 'no_valid_key');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 12-2. 키 ↔ 넥슨 계정 링크 (M:N)
-- -----------------------------------------------------------------------------
-- ⚠️ `/character/list` 의 `account_list` 는 **배열**이다. 키 하나가 복수 계정을 돌려줄 수 있다
--    (그 조건은 미확인). 반대로 키를 재발급하면 새 credential 행이 생기지만 계정은 그대로이므로
--    한 계정에 여러 credential 이 붙는다. 양방향 다중이라 **링크 테이블**이 정답이다.
create table if not exists public.credential_nexon_accounts (
  id                uuid primary key default gen_random_uuid(),
  credential_id     uuid not null references public.user_credentials(id) on delete cascade,
  nexon_account_ref uuid not null references public.user_nexon_accounts(id) on delete cascade,

  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  constraint credential_nexon_accounts_uniq unique (credential_id, nexon_account_ref)
);

comment on table public.credential_nexon_accounts is
  'API 키 ↔ 넥슨 계정 링크. /character/list 의 account_list[] 가 배열이라 M:N 이다. 검증 시점에 채운다.';

create index if not exists credential_nexon_accounts_account_idx
  on public.credential_nexon_accounts (nexon_account_ref);

-- -----------------------------------------------------------------------------
-- 12-3. 주 자격증명 (primary credential)
-- -----------------------------------------------------------------------------
-- 본캐가 속한 계정의 키가 **주 키**, 나머지는 나중에 붙인 **연결 키**다.
-- ⚠️ 주 키는 "정체성의 출처"일 뿐이며 **로그인 자격과는 무관하다.**
--    연결 키로도 똑같이 로그인된다(§12-6). "로그인하려면 주 키여야 한다"는 규칙은 없다.
alter table public.user_credentials
  add column if not exists is_primary boolean not null default false;

comment on column public.user_credentials.is_primary is
  '본캐가 속한 계정의 키. 정체성의 출처일 뿐 로그인 자격과 무관하다 — 연결 키로도 로그인된다.';

-- 사용자당 주 키는 하나 (characters.is_main 과 같은 방식)
create unique index if not exists user_credentials_one_primary_per_user
  on public.user_credentials (user_id) where is_primary;

-- -----------------------------------------------------------------------------
-- 12-4. characters 출처 참조 + 동기화 상태
-- -----------------------------------------------------------------------------
-- **credential 이 아니라 넥슨 계정을 가리키는 이유**:
--   키는 재발급되면 SHA-256 해시가 바뀌어 credential 행이 새로 생긴다. credential 을 가리키면
--   키를 재발급할 때마다 모든 캐릭터의 출처가 끊긴다.
--   반면 **넥슨 계정(account_id)은 키를 바꿔도 그대로다.** 캐릭터가 실제로 속한 것도 계정이지 키가 아니다.
-- 호출에는 키가 필요하므로 **계정 → 현재 유효 키** 경로를 v_character_sync_source 로 제공한다.
alter table public.characters
  add column if not exists nexon_account_ref uuid
    references public.user_nexon_accounts(id) on delete set null;

alter table public.characters
  add column if not exists sync_state public.character_sync_state not null default 'no_valid_key';

comment on column public.characters.nexon_account_ref is
  '이 캐릭터가 속한 넥슨 계정. 키가 아니라 계정을 가리킨다 — 키는 재발급되지만 계정은 유지되기 때문.';
comment on column public.characters.sync_state is
  'no_valid_key = 그 계정에 유효한 키가 없어 동기화 불가. **읽기는 계속 된다** — 과거 클리어·파티 이력이 걸려 있으므로 캐릭터를 지우지 않는다.';

create index if not exists characters_account_idx
  on public.characters (nexon_account_ref) where nexon_account_ref is not null;

create index if not exists characters_stale_idx
  on public.characters (user_id) where sync_state = 'no_valid_key';

-- 캐릭터의 동기화 가능 여부를 계산한다(단일 정의).
create or replace function public.character_is_syncable(
  p_user_id uuid,
  p_account_ref uuid
)
returns boolean
language sql
stable
parallel safe
as $func$
  select p_account_ref is not null
     and exists (
       select 1
       from public.credential_nexon_accounts l
       join public.user_credentials c on c.id = l.credential_id
       where l.nexon_account_ref = p_account_ref
         and c.user_id = p_user_id
         and c.invalidated_at is null
     );
$func$;

comment on function public.character_is_syncable(uuid, uuid) is
  '그 계정에 유효한(무효화되지 않은) 키가 하나라도 있는지. sync_state 의 유일한 판정 근거.';

-- 캐릭터 자신이 쓰일 때 상태를 맞춘다(순수 계산, 다른 테이블에 쓰지 않는다).
create or replace function public.characters_apply_sync_state()
returns trigger
language plpgsql
as $func$
begin
  new.sync_state := case
    when public.character_is_syncable(new.user_id, new.nexon_account_ref) then 'syncable'
    else 'no_valid_key'
  end::public.character_sync_state;
  return new;
end;
$func$;

drop trigger if exists characters_apply_sync_state on public.characters;
create trigger characters_apply_sync_state
  before insert or update of user_id, nexon_account_ref on public.characters
  for each row execute function public.characters_apply_sync_state();

-- 키가 무효화/삭제/추가되면 영향받는 캐릭터의 상태를 다시 계산한다.
-- ★ 캐릭터를 지우지 않는다. 상태만 바꾼다.
create or replace function public.refresh_character_sync_state()
returns trigger
language plpgsql
as $func$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  update public.characters ch
     set sync_state = case
           when public.character_is_syncable(ch.user_id, ch.nexon_account_ref) then 'syncable'
           else 'no_valid_key'
         end::public.character_sync_state
   where ch.sync_state is distinct from case
           when public.character_is_syncable(ch.user_id, ch.nexon_account_ref) then 'syncable'
           else 'no_valid_key'
         end::public.character_sync_state;

  return null;
end;
$func$;

drop trigger if exists user_credentials_refresh_sync on public.user_credentials;
create trigger user_credentials_refresh_sync
  after insert or delete or update of invalidated_at, user_id on public.user_credentials
  for each statement execute function public.refresh_character_sync_state();

drop trigger if exists credential_nexon_accounts_refresh_sync on public.credential_nexon_accounts;
create trigger credential_nexon_accounts_refresh_sync
  after insert or delete or update on public.credential_nexon_accounts
  for each statement execute function public.refresh_character_sync_state();

-- 캐릭터 → 호출에 써야 할 키. 스케줄러 API 프록시가 이 뷰를 읽는다.
drop view if exists public.v_character_sync_source;
create view public.v_character_sync_source
with (security_invoker = true) as
select
  ch.id            as character_id,
  ch.user_id,
  ch.character_name,
  ch.world_name,
  ch.ocid,
  ch.is_main,
  ch.sync_state,
  ch.nexon_account_ref,
  na.nexon_account_id,
  cred.id          as credential_id,
  cred.label       as credential_label,
  cred.is_primary  as credential_is_primary,
  cred.allow_server_side_use
from public.characters ch
left join public.user_nexon_accounts na on na.id = ch.nexon_account_ref
left join lateral (
  -- 그 계정에 붙은 유효한 키 중 가장 최근에 검증된 것
  select c.id, c.label, c.is_primary, c.allow_server_side_use
  from public.credential_nexon_accounts l
  join public.user_credentials c on c.id = l.credential_id
  where l.nexon_account_ref = ch.nexon_account_ref
    and c.user_id = ch.user_id
    and c.invalidated_at is null
  order by c.last_validated_at desc nulls last, c.created_at
  limit 1
) cred on true;

comment on view public.v_character_sync_source is
  '캐릭터별로 스케줄러 API 호출에 써야 할 자격증명. credential_id 가 null 이면 동기화 불가(읽기는 가능).';

-- -----------------------------------------------------------------------------
-- 12-5. 본캐 ↔ 스냅샷 ↔ 주 키 연동
-- -----------------------------------------------------------------------------
-- **트리거로 한 이유** (앱이 아니라):
--   본캐가 정해지는 경로가 여러 개다 — 최초 가입 시 자동 지정, 웹에서 변경, 부계정 키 추가 후 변경.
--   세 경로가 전부 (a) app_users 스냅샷 갱신 (b) 주 키 이동 을 정확히 해야 하는데,
--   한 곳만 빠뜨리면 **화면에 뜨는 본캐 닉네임과 실제 본캐가 갈라진다.**
--   정체성이 갈라지는 건 조용한 치명상이라 DB 에서 한 번만 구현한다. seat_no 와 같은 판단이다.
create or replace function public.characters_sync_main_identity()
returns trigger
language plpgsql
as $func$
declare
  v_cred uuid;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  if not new.is_main then
    return null;
  end if;

  -- (a) 표시 정체성 스냅샷
  update public.app_users
     set main_character_name = new.character_name,
         main_world_name     = new.world_name
   where id = new.user_id
     and (main_character_name is distinct from new.character_name
       or main_world_name     is distinct from new.world_name);

  -- (b) 주 키를 본캐가 속한 계정의 키로 옮긴다.
  select c.id into v_cred
    from public.credential_nexon_accounts l
    join public.user_credentials c on c.id = l.credential_id
   where l.nexon_account_ref = new.nexon_account_ref
     and c.user_id = new.user_id
     and c.invalidated_at is null
   order by c.last_validated_at desc nulls last, c.created_at
   limit 1;

  if v_cred is not null then
    update public.user_credentials
       set is_primary = false
     where user_id = new.user_id and is_primary and id <> v_cred;

    update public.user_credentials
       set is_primary = true
     where id = v_cred and not is_primary;
  end if;

  return null;
end;
$func$;

drop trigger if exists characters_sync_main_identity on public.characters;
create trigger characters_sync_main_identity
  after insert or update of is_main, character_name, world_name, nexon_account_ref
  on public.characters
  for each row execute function public.characters_sync_main_identity();

-- -----------------------------------------------------------------------------
-- 12-6. 로그인 해석 — **어느 키로도 같은 사람**
-- -----------------------------------------------------------------------------
-- 이것이 이번 요구의 핵심이다.
--   `api_key_hash` 가 **전역 유니크**이므로 해시 하나는 반드시 사용자 한 명으로만 해석된다.
--   주 키든 연결 키든 결과는 같은 `user_id` 이고, 표시 정체성도 같은 본캐 닉네임이다.
--   새 기기에서, 세션 없이, 한참 뒤에 부계정 키만 들고 와도 동일 계정으로 들어온다.
--   **"로그인하려면 주 키여야 한다" 같은 제약은 두지 않는다.**
create or replace function public.resolve_login_by_key_hash(p_api_key_hash text)
returns table (
  user_id             uuid,
  main_character_name text,
  main_world_name     text,
  credential_id       uuid,
  credential_label    text,
  is_primary          boolean,
  is_invalidated      boolean,
  account_status      public.account_status
)
language sql
stable
parallel safe
as $func$
  select u.id,
         u.main_character_name,
         u.main_world_name,
         c.id,
         c.label,
         c.is_primary,
         (c.invalidated_at is not null),
         u.status
  from public.user_credentials c
  join public.app_users u on u.id = c.user_id
  where c.api_key_hash = p_api_key_hash
    and u.deleted_at is null;
$func$;

comment on function public.resolve_login_by_key_hash(text) is
  '키 해시로 로그인 해석. 주 키/연결 키 구분 없이 같은 사용자와 같은 본캐 정체성을 돌려준다.';

-- 키 추가는 **이미 로그인한 상태에서만** 가능하다(그래야 "이 키를 이 사람에게 붙인다"가 성립).
-- 이미 다른 사용자에게 묶인 키는 **거부**한다 — 조용히 소유자를 바꾸면 계정 탈취가 된다.
create or replace function public.attach_nexon_credential(
  p_user_id      uuid,
  p_api_key_hash text,
  p_label        text default null,
  p_make_primary boolean default false
)
returns uuid
language plpgsql
as $func$
declare
  v_owner uuid;
  v_id    uuid;
begin
  if p_user_id is null then
    raise exception '키 추가는 로그인한 상태에서만 가능합니다.' using errcode = 'invalid_authorization_specification';
  end if;

  select user_id into v_owner
    from public.user_credentials
   where api_key_hash = p_api_key_hash;

  if found and v_owner <> p_user_id then
    -- ★ 계정 탈취 방지. 소유자를 조용히 바꾸지 않는다.
    --   두 계정을 합치려면 별도의 명시적 병합 절차가 필요하다(현재 미구현 — DB-SCHEMA.md 참조).
    raise exception '이 API 키는 이미 다른 계정에 등록되어 있습니다. 계정 병합은 별도 절차가 필요합니다.'
      using errcode = 'unique_violation';
  end if;

  if found then
    update public.user_credentials
       set label = coalesce(p_label, label),
           invalidated_at = null,
           last_validated_at = now()
     where api_key_hash = p_api_key_hash
     returning id into v_id;
  else
    insert into public.user_credentials (user_id, api_key_hash, label, last_validated_at)
    values (p_user_id, p_api_key_hash, p_label, now())
    returning id into v_id;
  end if;

  if p_make_primary then
    update public.user_credentials set is_primary = false
     where user_id = p_user_id and is_primary and id <> v_id;
    update public.user_credentials set is_primary = true
     where id = v_id and not is_primary;
  end if;

  return v_id;
end;
$func$;

comment on function public.attach_nexon_credential(uuid, text, text, boolean) is
  '로그인 상태에서 부계정 키를 추가한다. 다른 사용자에게 이미 묶인 키는 거부한다(계정 탈취 방지).';

-- -----------------------------------------------------------------------------
-- 12-7. RLS — 신규 테이블/뷰
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  private_tables text[] := array['credential_nexon_accounts'];
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

revoke all on table public.v_character_sync_source from anon;
revoke all on table public.v_character_sync_source from authenticated;
grant all on table public.v_character_sync_source to service_role;

revoke all on function public.resolve_login_by_key_hash(text) from public;
revoke all on function public.resolve_login_by_key_hash(text) from anon;
revoke all on function public.resolve_login_by_key_hash(text) from authenticated;
grant execute on function public.resolve_login_by_key_hash(text) to service_role;

revoke all on function public.attach_nexon_credential(uuid, text, text, boolean) from public;
revoke all on function public.attach_nexon_credential(uuid, text, text, boolean) from anon;
revoke all on function public.attach_nexon_credential(uuid, text, text, boolean) from authenticated;
grant execute on function public.attach_nexon_credential(uuid, text, text, boolean) to service_role;

revoke all on function public.character_is_syncable(uuid, uuid) from public;
revoke all on function public.character_is_syncable(uuid, uuid) from anon;
revoke all on function public.character_is_syncable(uuid, uuid) from authenticated;
grant execute on function public.character_is_syncable(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  -- 민감 컬럼 가드 (11-A-2). 새 컬럼에도 반드시 적용된다.
  perform public.assert_no_public_sensitive_columns();

  -- 자격증명 관련 컬럼이 공개 역할에 노출되지 않았는지 직접 재확인
  if has_column_privilege('anon', 'public.user_credentials', 'api_key_hash', 'SELECT')
     or has_column_privilege('anon', 'public.user_credentials', 'encrypted_api_key', 'SELECT')
     or has_column_privilege('anon', 'public.user_nexon_accounts', 'nexon_account_id', 'SELECT')
     or has_column_privilege('anon', 'public.credential_nexon_accounts', 'credential_id', 'SELECT') then
    raise exception '자격증명 관련 컬럼이 anon 에게 노출되어 있습니다.';
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
