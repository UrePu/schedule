-- =============================================================================
-- M_Schedule · 06. 카카오톡 봇 연동
-- =============================================================================
-- 근거: Claude/research-KAKAO-BOT.md §3.7(최소 스키마), §2.9(연결 흐름),
--       §3.4(인증), §3.6(런너 비종속 금지 목록)
--
-- **런너 비종속 원칙** — 아래 금지 목록을 스키마 차원에서 지킨다.
--   ❌ 카톡 방 이름 / kakao chat_id / openlink_id 를 컬럼으로 저장하지 않는다.
--   ✅ `room` 은 **우리가 발급한 불투명 ID**다. 실제 방과의 매핑은 런너가 자기 로컬에 둔다.
--   ✅ 응답은 평문 문자열 하나(`reply`)가 1급 시민이고, 확장은 무시 가능한 선택 필드다.
--
-- 봇 트래픽은 사용자 세션이 아니라 **채널 시크릿**으로 인증된다. 즉 RLS 로 보호되는 대상이
-- 아니다 → 이 파일의 모든 테이블은 anon/authenticated 를 전면 차단하고,
-- Route Handler 가 HMAC 서명을 검증한 뒤에만 service role 로 접근한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bot_channels — 봇이 들어가 있는 방(채널)
-- -----------------------------------------------------------------------------
create table if not exists public.bot_channels (
  id                  uuid primary key default gen_random_uuid(),

  -- 우리가 발급한 불투명 채널 ID. 런너/API 가 주고받는 `room` 값.
  room                text not null unique check (room ~ '^ch_[A-Za-z0-9]{8,40}$'),

  -- 런너 종류가 아니라 "플랫폼". 텔레그램/디스코드 런너를 붙여도 스키마가 안 바뀐다.
  platform            text not null default 'kakao',

  -- 채널 시크릿은 해시로만 보관한다. 원문은 페어링 응답에서 단 1회만 노출한다.
  secret_hash         text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  secret_rotated_at   timestamptz,
  -- 회전 시 구 시크릿을 24시간 병행 검증한다(research-KAKAO-BOT §3.2).
  previous_secret_hash        text check (previous_secret_hash is null or previous_secret_hash ~ '^[0-9a-f]{64}$'),
  previous_secret_expires_at  timestamptz,

  owner_user_id       uuid references public.app_users(id) on delete set null,
  status              public.bot_channel_status not null default 'active',

  -- HMAC 서명을 쓰는 채널인지. 메신저봇R(Rhino)에서 HMAC 가능 여부가 미확인이라
  -- 서명 미사용 채널을 별도로 표시하고 아웃박스 권한을 제한한다(§3.4).
  signed              boolean not null default true,

  -- 런너가 계산한 방 지문 해시. **방 이름 원문이 아니다.**
  room_fingerprint    text check (room_fingerprint is null or room_fingerprint ~ '^[0-9a-f]{64}$'),
  -- 런너 문자열은 로그·통계 전용이며 분기 로직에 쓰지 않는다(§3.6).
  runner              text,

  signature_failure_count integer not null default 0 check (signature_failure_count >= 0),
  suspended_until     timestamptz,
  last_seen_at        timestamptz,
  last_polled_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint bot_channels_prev_secret_pair check (
    (previous_secret_hash is null) = (previous_secret_expires_at is null)
  )
);

comment on table public.bot_channels is
  '봇 채널. room 은 우리가 발급한 불투명 ID이며 카톡 방 이름/chat_id 는 저장하지 않는다. 시크릿은 해시만 보관.';
comment on column public.bot_channels.signed is
  'HMAC 서명 사용 여부. false 인 채널은 아웃박스(선제 발송) 권한을 제한한다.';

create index if not exists bot_channels_active_idx
  on public.bot_channels (last_seen_at desc)
  where status = 'active';

create index if not exists bot_channels_owner_idx
  on public.bot_channels (owner_user_id)
  where owner_user_id is not null;

drop trigger if exists bot_channels_set_updated_at on public.bot_channels;
create trigger bot_channels_set_updated_at
  before update on public.bot_channels
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- bot_channel_members — 방 발신자 ↔ 앱 계정 매핑
-- -----------------------------------------------------------------------------
-- 방에서 얻을 수 있는 발신자 정보는 닉네임뿐이고, 닉네임은 언제든 바뀌며 중복될 수 있다.
-- 따라서 **닉네임을 키로 쓰지 않는다.** `!연결 <코드>` 로 맺어진 sender_id ↔ user_id
-- 매핑만이 신원의 근거다(research-KAKAO-BOT §2.9).
create table if not exists public.bot_channel_members (
  id           uuid primary key default gen_random_uuid(),
  channel_id   uuid not null references public.bot_channels(id) on delete cascade,

  -- 런너가 고른 안정적 발신자 식별자(불투명). **서버는 이 값의 의미를 해석하지 않는다.**
  sender_id    text not null,

  user_id      uuid not null references public.app_users(id) on delete cascade,

  -- 표시용 닉네임 스냅샷. 식별에 쓰지 않는다.
  display_name text,

  linked_at    timestamptz not null default now(),
  last_seen_at timestamptz,

  constraint bot_channel_members_uniq unique (channel_id, sender_id)
);

comment on table public.bot_channel_members is
  '봇 채널 발신자 ↔ 앱 계정 매핑. sender_id 는 런너가 정한 불투명 값이며 서버는 해석하지 않는다.';
comment on column public.bot_channel_members.display_name is
  '표시용 닉네임 스냅샷. 가변이라 식별자로 쓰지 않는다.';

create index if not exists bot_channel_members_user_idx
  on public.bot_channel_members (user_id);

-- -----------------------------------------------------------------------------
-- bot_link_codes — 6자리 연결/페어링 코드
-- -----------------------------------------------------------------------------
-- channel_pair : 방 최초 페어링 (§3.2)
-- member_link  : 개인 계정 연결 `!연결 <코드>` (§2.9)
-- 코드 원문은 저장하지 않고 해시만 둔다. TTL 10분, 5회 오입력 시 폐기.
create table if not exists public.bot_link_codes (
  id              uuid primary key default gen_random_uuid(),
  kind            public.bot_link_code_kind not null,

  code_hash       text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),

  user_id         uuid references public.app_users(id) on delete cascade,
  channel_id      uuid references public.bot_channels(id) on delete cascade,

  attempt_count   integer not null default 0 check (attempt_count >= 0),
  max_attempts    integer not null default 5 check (max_attempts > 0),

  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  consumed_by_channel_id uuid references public.bot_channels(id) on delete set null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),

  -- 개인 연결 코드는 반드시 발급한 사용자가 있어야 한다.
  constraint bot_link_codes_member_needs_user check (
    kind <> 'member_link' or user_id is not null
  )
);

comment on table public.bot_link_codes is
  '봇 페어링/계정 연결용 6자리 코드. 원문은 저장하지 않고 SHA-256 해시만 보관한다. TTL 10분.';

create index if not exists bot_link_codes_user_idx
  on public.bot_link_codes (user_id, kind)
  where consumed_at is null and revoked_at is null;

create index if not exists bot_link_codes_expiry_idx
  on public.bot_link_codes (expires_at)
  where consumed_at is null;

-- -----------------------------------------------------------------------------
-- bot_outbox — 선제 알림 큐 (런너가 폴링해 가져간다)
-- -----------------------------------------------------------------------------
-- 봇 런너는 가정용 폰이거나 NAT 뒤 컨테이너라 서버가 부를 수 없다. 런너가 가져간다.
-- 중복 발송 3중 방어: (1) dedupe_key 유니크, (2) id 멱등 ack, (3) visible_after 리스.
create table if not exists public.bot_outbox (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references public.bot_channels(id) on delete cascade,

  -- 규약: {목적}:{엔티티ID}:{시점}  예) boss_remind:sch_9931:T-30
  -- 주차 표기는 반드시 KST 목 00:00 경계(week_key)를 쓴다. ISO 주차를 쓰면 수·목 알림이
  -- 두 주에 걸쳐 중복 생성된다.
  dedupe_key     text not null,

  -- 카카오톡 평문 문자열 하나. 마크다운/HTML 금지, 350자·12줄 예산.
  reply          text not null check (length(reply) between 1 and 2000),
  -- 여러 말풍선으로 나눌 때의 선택 필드. 미지원 런너는 무시해도 동작한다.
  extra          text[],

  state          public.bot_outbox_state not null default 'pending',

  -- 리스: 응답 시 now()+60s 로 밀어 두 런너가 같은 건을 집어가지 못하게 한다.
  visible_after  timestamptz not null default now(),
  -- 지난 알림은 가치가 음수다. 반드시 만료시킨다(리마인더 15분, 주간 요약 6시간).
  expires_at     timestamptz not null,

  attempts       integer not null default 0 check (attempts >= 0),
  max_attempts   integer not null default 5 check (max_attempts > 0),
  last_error     text,
  delivered_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint bot_outbox_dedupe_uniq unique (channel_id, dedupe_key)
);

comment on table public.bot_outbox is
  '봇 선제 알림 큐. 런너가 폴링해 가져가고 ack 한다. dedupe_key + 리스 + 멱등 ack 로 중복 발송을 막는다.';
comment on column public.bot_outbox.expires_at is
  '만료 시각. "30분 전 알림"이 보스 시간이 지나 도착하면 가치가 음수이므로 반드시 파기한다.';

-- 폴링 핵심 인덱스: 채널 × 가시성 × 만료
create index if not exists bot_outbox_pickup_idx
  on public.bot_outbox (channel_id, visible_after)
  where state in ('pending', 'delivering');

create index if not exists bot_outbox_expiry_idx
  on public.bot_outbox (expires_at)
  where state in ('pending', 'delivering');

drop trigger if exists bot_outbox_set_updated_at on public.bot_outbox;
create trigger bot_outbox_set_updated_at
  before update on public.bot_outbox
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- bot_command_log — 명령 감사 + 리플레이 방지
-- -----------------------------------------------------------------------------
-- ⚠️ 프라이버시(§R5): **`!` 로 시작하는 명령 원문만** 저장한다. 일반 대화는 서버에
--    도달하지도 않고 저장하지도 않는다.
create table if not exists public.bot_command_log (
  id           uuid primary key default gen_random_uuid(),
  channel_id   uuid not null references public.bot_channels(id) on delete cascade,

  -- 요청마다 유일한 UUID. 재사용되면 409(리플레이)로 거절한다.
  nonce        text not null,

  sender_id    text,
  user_id      uuid references public.app_users(id) on delete set null,

  -- 명령 원문. 반드시 '!' 로 시작해야 한다.
  command      text not null check (command like '!%'),

  result       text,
  status_code  integer,
  duration_ms  integer check (duration_ms is null or duration_ms >= 0),
  created_at   timestamptz not null default now(),

  constraint bot_command_log_nonce_uniq unique (channel_id, nonce)
);

comment on table public.bot_command_log is
  '봇 명령 감사 로그 + nonce 리플레이 방지. 명령 원문만 저장하며 일반 대화는 저장하지 않는다.';

-- nonce 캐시는 10분만 유효하므로 오래된 행을 걷어내는 배치가 이 인덱스를 쓴다.
create index if not exists bot_command_log_created_idx
  on public.bot_command_log (created_at);

create index if not exists bot_command_log_channel_idx
  on public.bot_command_log (channel_id, created_at desc);
