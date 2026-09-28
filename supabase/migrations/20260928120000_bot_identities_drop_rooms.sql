-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 카톡 봇에서 **"방"을 걷어낸다** — 신원은 닉네임 하나로
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-09-28):
--   *"카톡의 방의 개념을 삭제. 닉네임으로 판별하여 연결하는거만 가능 !연결 ~~ 만 남기기.
--     !페어링 필요 x. 그거에따른 리마인더 삭제. 알림 삭제."*
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 방을 포기하는가 — **원리적으로 식별할 수 없다**
-- ─────────────────────────────────────────────────────────────────────────────
-- 카톡 런너(메신저봇R)가 방을 가리켜 주는 값은 **방 이름 문자열**뿐이고, 메시지 객체에
-- 방 고유 번호가 없다(API2 실측 2026-09-23:
--   `api2.chat keys = author,content,image,isDebugRoom,isGroupChat,isMention,
--    markAsRead,packageName,reply,room` — id 가 없다. API1 도 같다).
-- 게다가 런너를 실기 폰으로 옮긴 뒤 그 `room` 자리에 **말한 사람의 닉네임**이 실려 오기
-- 시작했다. 지문 대조로 확정했다 — `sha256('kakao:더저/새스링')` 이 그 방 채널의
-- `room_fingerprint` 와 정확히 일치했다(에뮬레이터 시절에는 `sha256('kakao:익검')`,
-- 즉 진짜 방 이름이었다).
--
-- 즉 **카톡 방 하나가 말한 사람 수만큼 서로 다른 채널로 갈라진다.** 채널이 갈라지면
-- `bot_channel_members(channel_id, sender_id)` 도 갈라져 이미 `!연결` 을 마친 사람이
-- "연결이 필요합니다" 를 받는다. 2026-09-23 에 폴백(같은 주인의 파티방까지 넓혀 읽기)으로
-- 한 번 메웠지만, 그것은 식별할 수 없는 값을 추측으로 메우는 일이었다. 이번에는 **그 값을
-- 아예 쓰지 않는다** — 신원의 축이 `(방, 발신자)` 에서 **`(플랫폼, 발신자)`** 로 내려간다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★★ 표는 지우지 않는다 ★★
-- ─────────────────────────────────────────────────────────────────────────────
-- `bot_channels` · `bot_channel_members` · `bot_outbox` · `bot_notification_prefs` ·
-- `bot_direct_grants` 는 **그대로 남긴다**(발주 결정: 화면·코드만 걷어낸다). 읽는 코드가
-- 사라지므로 이 표들은 이 마이그레이션 이후 **아무도 쓰지 않는 기록**이 된다. 지우는 것은
-- 되돌릴 수 없고, 되돌릴 수 없는 일을 "지금 안 쓴다"는 이유로 하지 않는다.
-- 이 파일이 실제로 끊는 것은 **동작하는 경로** 둘뿐이다:
--   1. 알림 크론(`bot-direct-notify`) — 봇이 먼저 말을 거는 유일한 경로였다.
--   2. `bot_command_log.channel_id` 의 NOT NULL — 방이 없으면 채울 값이 없다.
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. `bot_identities` — 신원의 새 축
-- #############################################################################

create table if not exists public.bot_identities (
  id           uuid primary key default gen_random_uuid(),

  /*
    메신저 종류. 런너 비종속 계약(CLAUDE.md §2.2)을 지키기 위한 칸이다 — 이 표의
    유일성은 `(platform, sender_id)` 이지 `sender_id` 혼자가 아니다. 텔레그램 런너가
    붙는 날 `kakao:더저` 와 `telegram:더저` 가 충돌하지 않아야 한다.
    ⚠️ `bot_channels.platform` 과 **같은 값 공간**을 쓴다(소문자 슬러그).
  */
  platform     text not null default 'kakao'
    check (platform ~ '^[a-z][a-z0-9_-]{1,29}$'),

  /*
    클라이언트가 고른 **안정적 발신자 식별자**. 카톡에서는 `kakao:<닉네임>` 이다.
    ⚠️ 닉네임이 바뀌면 다른 사람이 된다 — 카톡이 주는 것이 닉네임뿐이라 우리가 고를 수
       있는 것이 없다. 뒤집으면 **같은 닉네임을 쓰면 같은 사람으로 해석된다**는 뜻이고,
       이 표만으로는 그것을 가려낼 방법이 없다. 아래 선점 규칙은 그 구멍 중 **쓰기 쪽만**
       막는다(정확한 범위는 인덱스 정의의 ⚠️ 블록).
  */
  sender_id    text not null check (length(sender_id) between 1 and 200),

  user_id      uuid not null references public.app_users(id) on delete cascade,

  /** 표시용 스냅샷. **식별에 쓰지 않는다.** */
  display_name text,

  linked_at    timestamptz not null default now(),
  last_seen_at timestamptz
);

comment on table public.bot_identities is
  '봇 발신자 ↔ 계정 매핑. 방(bot_channels)과 무관하게 (platform, sender_id) 하나로 '
  '신원을 해석한다. bot_channel_members 를 대체하며, 그 표는 기록으로만 남는다.';
comment on column public.bot_identities.platform is
  '메신저 종류(소문자 슬러그). 유일성이 (platform, sender_id) 인 이유 — 런너가 늘어도 '
  '닉네임이 충돌하지 않아야 한다.';
comment on column public.bot_identities.sender_id is
  '클라이언트가 고른 안정적 발신자 식별자. 카톡은 kakao:<닉네임>. 서버는 뜻을 해석하지 않는다.';

/*
  ★ **한 발신자는 한 계정이다.** 이것이 선점 규칙의 근거다 — 같은 닉네임을 두 계정에 붙일
    수 있으면 `!연결` 의 의미 자체가 없어진다. `!연결` 은 이미 물려 있는 발신자를
    **거부한다**(덮어쓰지 않는다). DB 의 유일성이 그 규칙의 마지막 관문이다.

  ⚠️ ═══════════════════════════════════════════════════════════════════════════
     **이 인덱스가 막는 것과 막지 못하는 것 — 2026-09-28 교차 검증에서 바로잡음**
     ═══════════════════════════════════════════════════════════════════════════
    이 자리에는 *"없으면 오픈챗에서 남의 닉네임을 그대로 쓰는 것만으로 그 사람 데이터가
    읽힌다"* 고 적혀 있었다. **거꾸로 읽히는 거짓이었다** — 있어도 읽힌다.
      - 막는다: 남의 닉네임을 **내 계정에 물리는** 쓰기(`!연결 <내 코드>`).
      - 막지 못한다: **사칭, 즉 읽기.** 피해자와 같은 닉네임으로 이름만 바꾸면 조회
        (`bot_identities` SELECT)가 피해자 행을 그대로 내주고 `!결정석` `!숙제` `!일정` 이
        피해자 데이터를 답장한다. 연결이 아예 필요 없으므로 유일성이 닿지 않는다.
    범위도 넓어졌다 — 예전 축 `bot_channel_members(channel_id, sender_id)` 에서는 사칭이
    **그 방 안**에서만 통했고 방 주인이 구성원을 통제했다. 축이 `(platform, sender_id)` 로
    내려온 지금은 **런너가 붙어 있는 아무 방에서나** 통한다.
    이것은 "닉네임으로만 판별" 이라는 발주 결정의 대가이지 버그가 아니다. 고칠 수단은 런너가
    안정적 발신자 id 를 싣고 오는 것뿐이다. **막힌다고 적는 것만이 결함이다.**

  ⚠️ 쓰기 쪽에서도 이 인덱스는 **`upsert` 를 쓰는 순간 무력해진다.** supabase-js 의
     `upsert(..., { onConflict: ... })` 는 `ON CONFLICT DO UPDATE` 라 23505 를 던지지 않고
     남의 행의 `user_id` 를 조용히 덮어쓴다. `consumeMemberLinkCode` 가 실제로 그랬고
     2026-09-28 에 `INSERT` + 소유자 한정 `UPDATE` 두 갈래로 갈라 고쳤다.
     **이 표에 쓰는 코드는 `upsert` 를 쓰지 않는다.**
*/
create unique index if not exists bot_identities_sender_uniq
  on public.bot_identities (platform, sender_id);

/** 계정 → 내 신원 목록(웹 설정 화면이 읽는다). */
create index if not exists bot_identities_user_idx
  on public.bot_identities (user_id);

/*
  다른 bot_* 표와 **같은 규약**(마이그레이션 06): 봇 트래픽은 사용자 세션이 아니라
  런너 토큰 + HMAC 서명으로 인증되므로 RLS 로 보호되는 대상이 아니다. anon/authenticated
  는 통째로 막고 service_role 로만 접근한다.
  ⚠️ 이 표는 `sender_id`(닉네임 원문)를 들고 있다. 공개 시간표로 새면 누가 어느 방에서
     무슨 이름을 쓰는지가 드러나므로 열람은 서버 경로 하나로 묶는다.
*/
alter table public.bot_identities enable row level security;

drop policy if exists bot_identities_no_public_access on public.bot_identities;
create policy bot_identities_no_public_access
  on public.bot_identities for all to anon, authenticated
  using (false) with check (false);

drop policy if exists bot_identities_service_role_all on public.bot_identities;
create policy bot_identities_service_role_all
  on public.bot_identities for all to service_role
  using (true) with check (true);

revoke all on table public.bot_identities from anon, authenticated;
grant all on table public.bot_identities to service_role;


-- #############################################################################
-- 2. 백필 — `bot_channel_members` 12행을 사람 단위로 접는다
-- #############################################################################
--
-- 같은 `sender_id` 가 여러 방에 걸려 있으므로 행 수가 줄어든다. 두 계정에 걸린 경우는
-- **가장 먼저 연결된 행**(`linked_at` 최소)을 채택한다 — 나중 것을 채택하면 남의 닉네임을
-- 나중에 쓴 쪽이 이기는 구조가 되어 선점 규칙과 정반대가 된다.
--
-- 실측(2026-09-28, 운영 DB 읽기 전용): 매핑 **12행** · 서로 다른 발신자 **9명** ·
-- 두 계정에 걸린 발신자 **0명**. 즉 이 백필에서 버려지는 것은 같은 사람의 중복 방 행뿐이다.

do $$
declare
  v_source    integer;
  v_senders   integer;
  v_conflicts integer;
  v_inserted  integer;
begin
  select count(*), count(distinct sender_id) into v_source, v_senders
    from public.bot_channel_members;

  select count(*) into v_conflicts from (
    select sender_id
      from public.bot_channel_members
     group by sender_id
    having count(distinct user_id) > 1
  ) t;

  with ranked as (
    select m.sender_id,
           coalesce(ch.platform, 'kakao') as platform,
           m.user_id,
           m.display_name,
           m.linked_at,
           m.last_seen_at,
           row_number() over (
             partition by coalesce(ch.platform, 'kakao'), m.sender_id
             order by m.linked_at asc, m.id asc
           ) as rn
      from public.bot_channel_members m
      left join public.bot_channels ch on ch.id = m.channel_id
  )
  insert into public.bot_identities
    (platform, sender_id, user_id, display_name, linked_at, last_seen_at)
  select platform, sender_id, user_id, display_name, linked_at, last_seen_at
    from ranked
   where rn = 1
  on conflict (platform, sender_id) do nothing;

  get diagnostics v_inserted = row_count;

  raise notice
    'bot_identities 백필: 원본 %행(발신자 %명) -> %행 적재, %행 버림(중복 방 행). 계정 충돌 발신자 %명.',
    v_source, v_senders, v_inserted, v_source - v_inserted, v_conflicts;

  if v_conflicts > 0 then
    raise notice
      '⚠️ 발신자 %명이 두 계정 이상에 걸려 있었습니다. 가장 먼저 연결된 계정만 남았습니다 — '
      '나머지 사람은 방에서 !연결 을 다시 해야 합니다.', v_conflicts;
  end if;
end $$;


-- #############################################################################
-- 3. `bot_command_log` — 방이 없어지면 `channel_id` 에 넣을 값이 없다
-- #############################################################################

alter table public.bot_command_log
  alter column channel_id drop not null;

comment on column public.bot_command_log.channel_id is
  '(폐기) 방 개념을 걷어낸 2026-09-28 이후 새 행은 항상 null 이다. 과거 행은 그대로 둔다 — '
  '감사 로그를 나중에 고쳐 쓰면 그때 무슨 일이 있었는지가 사라진다.';

/*
  ★ ═══════════════════════════════════════════════════════════════════════════
    **리플레이 방지가 여기서 조용히 깨진다 — 반드시 인덱스를 하나 더 둔다**
    ═══════════════════════════════════════════════════════════════════════════
  기존 유일성은 `bot_command_log_nonce_uniq (channel_id, nonce)` 이고, Postgres 의
  유니크 인덱스에서 **NULL 은 서로 다른 값**이다. 즉 `channel_id` 가 null 인 새 행은
  같은 nonce 로 몇 번이든 들어간다 — `claimCommand` 의 "삽입이 곧 획득" 규약이
  **아무것도 막지 못하는 상태**가 된다. 같은 요청을 그대로 재생하면 두 번 실행되고,
  `!드랍` 처럼 원장에 쓰는 명령이 두 번 기록된다.

  그래서 `channel_id is null` 인 행에 대해 **nonce 단독 유일성**을 건다. 부분 인덱스라
  과거 행(channel_id 가 있는 행)은 건드리지 않으므로, 과거에 방마다 같은 nonce 가 있었다
  해도 이 인덱스는 만들어진다.
*/
create unique index if not exists bot_command_log_nonce_roomless_uniq
  on public.bot_command_log (nonce)
  where channel_id is null;

/*
  레이트리밋의 축이 **방 → 발신자**로 바뀐다(방이 없으므로 셀 수가 없다). 기존
  `bot_command_log_channel_idx (channel_id, created_at desc)` 는 새 행에서 전부 null 이라
  쓸모가 없으므로, 발신자 기준 인덱스를 둔다.
  ⚠️ `sender_id` 는 nullable 이라 부분 인덱스로 잡는다 — null 인 행은 셀 대상이 아니다.
*/
create index if not exists bot_command_log_sender_idx
  on public.bot_command_log (sender_id, created_at desc)
  where sender_id is not null;


-- #############################################################################
-- 4. 알림 크론을 **끈다** — 봇이 먼저 말을 거는 경로를 하나도 남기지 않는다
-- #############################################################################
--
-- ⚠️ 보스 동기화 크론(`web-sync`, 매시 50분)은 **건드리지 않는다.** 그것은 봇과 무관한
--    넥슨 동기화이고, 이 저장소에서 유일하게 살아 있어야 하는 pg_cron 잡이다.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'bot-direct-notify') then
    perform cron.unschedule('bot-direct-notify');
    raise notice 'cron.unschedule(bot-direct-notify) 완료 — 개인톡 알림 발송이 멈췄습니다.';
  else
    raise notice 'bot-direct-notify 크론이 이미 없습니다.';
  end if;
end $$;

/*
  발송을 **부를 수 있는 함수 자체**를 없앤다. 크론만 끄면 누가 손으로
  `select trigger_bot_notify();` 를 부르는 순간 알림이 되살아나고, 그때는 받는 라우트
  (`/api/bot/notify`)가 이미 없어 404 만 쌓인다 — 아무도 원인을 모르는 실패가 된다.

  ⚠️ `kst_wall_moment(date, integer)` 는 **남긴다.** 그것은 알림 전용이 아니라 KST 벽시계
     변환 일반 함수이고(§1 의 시간 규칙을 SQL 로 옮긴 것), 나중에 다른 자리에서 필요해진다.
*/
drop function if exists public.trigger_bot_notify(timestamptz);
drop function if exists public.bot_direct_notify_pending(timestamptz);
drop function if exists public.bot_direct_notify_targets(timestamptz);
drop function if exists public.bot_notify_tick_minutes();


-- #############################################################################
-- 5. 자체 검증
-- #############################################################################

do $$
declare
  v_count integer;
  v_user  uuid;
begin
  -- 없는 계정에는 신원을 달 수 없다(FK)
  begin
    insert into public.bot_identities (platform, sender_id, user_id)
    values ('selfcheck', 'selfcheck:noaccount', '00000000-0000-0000-0000-000000000000');
    raise exception '없는 계정으로 신원이 들어갔습니다(FK 가 없습니다)';
  exception
    when foreign_key_violation then null;  -- 기대한 거절
  end;

  /*
    ★ **선점 규칙의 마지막 관문**을 실제 계정으로 시험한다. 이것이 이 표에서 가장 중요한
      제약이다 — 없으면 `!연결` 이 남의 행을 덮어쓰고 먼저 연결한 사람을 밀어낼 수 있다.
      계정이 하나도 없는 새 DB 에서는 시험할 것이 없어 건너뛴다.
    ⚠️ 이 시험이 증명하는 것은 **쓰기 차단뿐**이다. 사칭(읽기)은 이 인덱스로 막히지 않는다 —
      위 인덱스 정의의 ⚠️ 블록을 보라. 여기가 통과했다고 "남의 데이터가 안 읽힌다" 로
      읽으면 안 된다.
  */
  select id into v_user from public.app_users limit 1;
  if v_user is not null then
    insert into public.bot_identities (platform, sender_id, user_id)
    values ('selfcheck', 'selfcheck:dup', v_user);

    begin
      insert into public.bot_identities (platform, sender_id, user_id)
      values ('selfcheck', 'selfcheck:dup', v_user);
      raise exception '같은 (platform, sender_id) 가 두 번 들어갔습니다 — 선점 규칙이 없습니다';
    exception
      when unique_violation then null;  -- 기대한 거절
    end;

    -- platform 형식 CHECK
    begin
      insert into public.bot_identities (platform, sender_id, user_id)
      values ('Kakao!', 'selfcheck:bad', v_user);
      raise exception 'platform 형식 검사가 통과했습니다';
    exception
      when check_violation then null;  -- 기대한 거절
    end;

    delete from public.bot_identities where platform = 'selfcheck';
  else
    raise notice '계정이 없어 선점 규칙 시험을 건너뜁니다(새 DB).';
  end if;

  -- 방 없는 명령 로그가 실제로 들어가는가 (channel_id NOT NULL 이 풀렸는지)
  insert into public.bot_command_log (channel_id, nonce, sender_id, command)
  values (null, 'selfcheck-nonce-roomless', 'selfcheck:sender', '!자체검사');

  -- 그리고 같은 nonce 는 거부되어야 한다 (리플레이 방지)
  begin
    insert into public.bot_command_log (channel_id, nonce, sender_id, command)
    values (null, 'selfcheck-nonce-roomless', 'selfcheck:sender', '!자체검사');
    raise exception '방 없는 로그에서 같은 nonce 가 두 번 들어갔습니다 — 리플레이 방지가 없습니다';
  exception
    when unique_violation then null;  -- 기대한 거절
  end;

  delete from public.bot_command_log where nonce = 'selfcheck-nonce-roomless';

  -- 알림 크론과 함수가 정말 사라졌는가
  select count(*) into v_count from cron.job where jobname = 'bot-direct-notify';
  if v_count <> 0 then
    raise exception 'bot-direct-notify 크론이 아직 남아 있습니다';
  end if;

  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('trigger_bot_notify', 'bot_direct_notify_pending',
                       'bot_direct_notify_targets', 'bot_notify_tick_minutes');
  if v_count <> 0 then
    raise exception '알림 발송 함수가 %개 남아 있습니다', v_count;
  end if;

  -- 동기화 크론은 **살아 있어야 한다**(매시 50분, `20260826100000_hourly_sync_cron.sql`)
  select count(*) into v_count from cron.job where jobname = 'hourly-sync';
  if v_count <> 1 then
    raise exception '보스 동기화 크론(hourly-sync)이 %개입니다 — 건드리면 안 되는 잡입니다', v_count;
  end if;

  raise notice '봇 신원 스키마 검증 통과';
end $$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- ⚠️ 새 표(`bot_identities`)가 닉네임 원문을 들고 있고, `bot_command_log` 의 컬럼 제약을
--    바꿨다. 둘 다 anon 에 열리면 안 되므로 확인을 생략하지 않는다.
select public.assert_no_public_sensitive_columns();
