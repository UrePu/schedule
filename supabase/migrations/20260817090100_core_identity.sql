-- =============================================================================
-- M_Schedule · 01. 코어 신원 (사용자 / 자격증명 / 캐릭터)
-- =============================================================================
-- 설계 원칙:
--   * 공개 가능한 프로필 정보와 **절대 노출되면 안 되는 자격증명을 테이블 단위로 분리**한다.
--     app_users            → 표시용. 그래도 anon 직접 접근은 막는다(공개 시간표는 참가자
--                            스냅샷 이름으로 렌더링하므로 이 테이블을 읽을 필요가 없다).
--     user_credentials     → 넥슨 API 키 SHA-256 해시 / 암호화 원문. anon 전면 차단.
--     user_nexon_accounts  → account_id 보조 식별자. anon 전면 차단.
--   * 넥슨 API 키 **원문은 저장하지 않는다**(CLAUDE.md §2.1).
--     서버 대리호출/봇 알림에 동의한 사용자만 암호화본을 별도 컬럼에 보관한다.
--   * ocid 는 변경될 수 있다(스펙 명시) → **PK 로 쓰지 않는다.** 자체 UUID PK + 갱신 가능한
--     유니크 컬럼으로 둔다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app_users — 앱 사용자(계정)
-- -----------------------------------------------------------------------------
create table if not exists public.app_users (
  id                  uuid primary key default gen_random_uuid(),

  -- 표시용 이름. 초대 링크로 들어온 임시 참가자가 승계될 때 이 값으로 승격된다.
  display_name        text        not null check (length(btrim(display_name)) between 1 and 40),

  -- 대표 캐릭터 이름(표시용 스냅샷). 정규 참조는 characters.is_main 을 쓴다.
  main_character_name text,
  main_world_name     text,

  avatar_url          text,
  status              public.account_status not null default 'active',

  -- 향후 인증 모델 교체(커스텀 JWT / 익명 로그인)를 위한 확장 지점.
  -- 현재 모델(service role 전용 쓰기)에서는 항상 null 이다.
  -- auth.users 로의 FK 는 의도적으로 걸지 않는다 — 스키마 이식성과 로컬 검증 가능성을 위해서다.
  auth_user_id        uuid unique,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_login_at       timestamptz,
  deleted_at          timestamptz
);

comment on table public.app_users is
  '앱 사용자. 넥슨 API 키 해시로 식별되며 자격증명은 user_credentials 에 분리 보관한다.';
comment on column public.app_users.auth_user_id is
  '향후 Supabase Auth 연동 시 auth.users.id 를 담을 자리. 현행 모델에서는 미사용(null).';

create index if not exists app_users_active_idx
  on public.app_users (created_at desc)
  where deleted_at is null;

drop trigger if exists app_users_set_updated_at on public.app_users;
create trigger app_users_set_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- user_credentials — 넥슨 API 키 자격증명 (기밀)
-- -----------------------------------------------------------------------------
-- 키를 재발급하면 SHA-256 해시가 바뀐다. 기존 계정을 잃지 않도록 **행을 추가**하는
-- 구조로 만든다(1:N). 옛 해시는 invalidated_at 을 채워 비활성화한다.
create table if not exists public.user_credentials (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.app_users(id) on delete cascade,

  -- SHA-256 hex 64자. **원문 키는 어떤 경우에도 저장하지 않는다.**
  api_key_hash        text not null unique
                        check (api_key_hash ~ '^[0-9a-f]{64}$'),

  -- 서버 대리호출/봇 알림에 명시 동의한 사용자만 채워진다(CLAUDE.md §2.1).
  -- 애플리케이션 레벨 암호화(AEAD) 결과를 담는다. 평문 금지.
  encrypted_api_key   bytea,
  encryption_key_id   text,
  allow_server_side_use boolean not null default false,
  consent_at          timestamptz,

  label               text,
  last_validated_at   timestamptz,
  invalidated_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 서버 대리호출을 허용했다면 암호화된 키와 동의 시각이 반드시 있어야 한다.
  constraint user_credentials_server_use_requires_key check (
    allow_server_side_use = false
    or (encrypted_api_key is not null and encryption_key_id is not null and consent_at is not null)
  )
);

comment on table public.user_credentials is
  '넥슨 API 키 자격증명. 해시로만 식별하며, 서버 대리호출 동의자에 한해 암호화 원문을 보관한다. anon/authenticated 전면 차단.';

create index if not exists user_credentials_user_idx
  on public.user_credentials (user_id)
  where invalidated_at is null;

drop trigger if exists user_credentials_set_updated_at on public.user_credentials;
create trigger user_credentials_set_updated_at
  before update on public.user_credentials
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- user_nexon_accounts — 넥슨 계정 보조 식별자 (기밀)
-- -----------------------------------------------------------------------------
-- character/list 응답의 account_list[].account_id. 키 재발급으로 해시가 바뀌었을 때
-- 계정을 복구하는 경로다(research-NEXON-API "인증 모델에 미치는 영향").
create table if not exists public.user_nexon_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.app_users(id) on delete cascade,
  nexon_account_id text not null unique,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);

comment on table public.user_nexon_accounts is
  '넥슨 account_id 보조 식별자. API 키 재발급 시 계정 복구 경로. anon/authenticated 전면 차단.';

create index if not exists user_nexon_accounts_user_idx
  on public.user_nexon_accounts (user_id);

-- -----------------------------------------------------------------------------
-- characters — 사용자 소유 캐릭터
-- -----------------------------------------------------------------------------
create table if not exists public.characters (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.app_users(id) on delete cascade,

  -- ocid 는 "게임 콘텐츠 변경으로 변경될 수 있음"이 스펙에 명시되어 있다.
  -- 따라서 PK 가 아니라 **갱신 가능한 유니크 컬럼**이다. 미해석 상태를 위해 nullable.
  ocid              text,
  ocid_refreshed_at timestamptz,

  character_name    text not null check (length(btrim(character_name)) between 1 and 30),
  world_name        text,
  character_class   text,
  character_level   integer check (character_level between 1 and 500),
  guild_name        text,
  image_url         text,

  is_main           boolean not null default false,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint characters_user_name_world_uniq unique (user_id, character_name, world_name)
);

comment on table public.characters is
  '사용자 계정에 속한 메이플 캐릭터. ocid 는 변경 가능하므로 PK 가 아니라 갱신 가능 유니크 컬럼이다.';
comment on column public.characters.ocid is
  '넥슨 ocid. 스펙상 변경될 수 있으므로 PK 로 쓰지 않는다. 부분 유니크 인덱스로 중복만 막는다.';

-- ocid 는 값이 있을 때만 전역 유일해야 한다.
create unique index if not exists characters_ocid_uniq
  on public.characters (ocid)
  where ocid is not null;

-- 사용자당 대표 캐릭터는 하나.
create unique index if not exists characters_one_main_per_user
  on public.characters (user_id)
  where is_main;

create index if not exists characters_user_idx
  on public.characters (user_id);

drop trigger if exists characters_set_updated_at on public.characters;
create trigger characters_set_updated_at
  before update on public.characters
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- nexon_api_quota_usage — 넥슨 API 호출량 집계 (기밀)
-- -----------------------------------------------------------------------------
-- 개발 단계 키는 1,000건/일, 5건/초 제한이다(research-NEXON-API §제약사항 1).
-- 프록시가 예산을 넘기지 않도록 자격증명 × KST 일자 단위로 누적한다.
create table if not exists public.nexon_api_quota_usage (
  id            uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.user_credentials(id) on delete cascade,

  -- KST 일자 키. 넥슨의 일 허용량 리셋 기준이 KST 이므로 day_key 를 그대로 쓴다.
  day_key       text not null check (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),

  call_count    integer not null default 0 check (call_count >= 0),
  error_count   integer not null default 0 check (error_count >= 0),
  throttled_count integer not null default 0 check (throttled_count >= 0),
  last_called_at  timestamptz,
  updated_at    timestamptz not null default now(),

  constraint nexon_api_quota_usage_uniq unique (credential_id, day_key)
);

comment on table public.nexon_api_quota_usage is
  '넥슨 오픈 API 호출량 일별 집계(KST). 개발 단계 키 1,000건/일 예산 통제용. anon/authenticated 전면 차단.';

drop trigger if exists nexon_api_quota_usage_set_updated_at on public.nexon_api_quota_usage;
create trigger nexon_api_quota_usage_set_updated_at
  before update on public.nexon_api_quota_usage
  for each row execute function public.set_updated_at();
