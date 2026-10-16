-- =============================================================================
-- M_Schedule · 보스 묶음(party_bundles)을 1급 개체로 — 1단계: 뼈대만
-- =============================================================================
-- 발주자 원문(2026-10-16):
--   "묶어서 돌먹을 하여도 분배는 그 1개의 묶음마다 달라질수 있다"
--   "묶음마다 누가 얼마를 먹는가도 중요하고. 결정석을 같이 가져가나도 선택할수있게.
--    분배비율 에 결정석 포함 설정을 넣어. 드랍만 비율로 거는사람도있어"
--
-- ── 무엇이 막혀 있었나 (실측, 2026-10-16 라이브) ─────────────────────────────
--   파티 66(활성 33 · 보관 33) · party_bosses 148 · party_participants 157 ·
--   party_runs 124. 같은 구성원인데 보스만 다른 활성 파티가 최대 6개.
--
--   `parties` 한 행이 **넷을 동시에** 들고 있었다: 이름 · 구성원 · 묶어서 도는 보스 ·
--   분배. 그래서 "같은 두 사람이 보스 묶음만 바꿔 도는" 평범한 쓰임이 파티를 새로
--   만들어야만 표현됐다. 막은 제약도 둘 다 실재한다:
--     · `party_bosses` 의 `unique (party_id, boss_difficulty_id)` → 같은 보스 두 번 금지
--     · `party_participants` 의 부분 `unique (party_id, user_id)` → 한 파티 한 사람 한 캐릭
--
--   묶음을 가르면 둘 다 자연히 풀린다. 같은 보스가 묶음 A·B 에 각각 한 번씩 들어가고,
--   같은 사람이 묶음마다 다른 캐릭터로 간다 — **파티를 늘리지 않고.**
--
-- ── 이 파일이 하는 일과 하지 않는 일 ─────────────────────────────────────────
--   한다:   표 4개 신설 · `party_runs.bundle_id` · 기존 데이터 전량 이행 ·
--           가중치 뷰를 결정석/드랍 두 열로 가르기 · 묶음축 쓰기 함수
--   안 한다: 파티 합치기(사용자 행동이다) · 화면 변경 · `party_participants.share_bp`
--           이동(파티에 그대로 둔다 — 그래야 과거 금액이 한 푼도 안 움직인다)
--
-- ── ★ 되돌리기 창 (중요) ─────────────────────────────────────────────────────
--   이 마이그레이션은 `party_bosses` 를 **지우지 않고 얼린다.** 적용 직후에는
--   `party_bosses` 와 `party_bundle_bosses` 의 내용이 완전히 같으므로, 되돌리려면
--   앱 코드를 되돌리고 `20261011130000_party_boss_duration_max_20.sql` 의 함수 블록을
--   다시 적용하면 된다.
--
--   ⚠️ **그 창은 "첫 묶음 편집" 까지다.** 사용자가 묶음의 보스를 한 번이라도 저장하면
--      `party_bundle_bosses` 만 바뀌고 `party_bosses` 는 그 시점에 멈춘 과거가 된다.
--      그 뒤에 되돌리면 그 편집이 조용히 사라진다. **양쪽에 쓰지 않는 것이 의도다** —
--      이중 쓰기는 반드시 갈라지고, 갈라진 뒤에는 어느 쪽이 진실인지 아무도 모른다.
--
-- ── 분배 해석 규칙 — 이 단계의 핵심 ─────────────────────────────────────────
--   실효 모드     = coalesce(party_bundles.share_mode, parties.share_mode)
--   실효 비율     = coalesce(party_bundle_shares.share_bp, party_participants.share_bp)
--   crystal_follows_share
--     true  → 결정석도 실효 비율로 나눈다 (= 적용 전 동작)
--     false → **결정석은 균등**(가중치 전부 1), 드랍만 실효 비율
--   근거(발주자): *"드랍만 비율로 거는 사람도 있어"*. 결정석은 각자 자기 캐릭터가 먹고
--   2인이면 각자 시세의 절반이라, 균등이 곧 "각자 자기 것"이다.
--
-- ── 뷰 사슬 6개를 cascade 로 다시 만든다 ────────────────────────────────────
--   v_run_share_weights
--     → v_run_crystal_settlement
--     → v_run_drop_recipients → v_run_drop_settlement → v_weekly_drop_income → v_weekly_income
--   `20260819200000_party_level_share_config.sql` 이 같은 사슬을 이미 한 번 재생성했고,
--   **그 파일은 새 뷰의 기본 grant 에 걸려 첫 적용이 실패했다.** 그래서 아래도 같은 순서를
--   따르고 `revoke` 블록을 빠뜨리지 않는다.
--
-- 넥슨 API 호출 없음. **재실행 안전**(이 저장소의 불변식).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. party_bundles — "이 파티가 묶어서 도는 한 덩이"
-- -----------------------------------------------------------------------------
-- ★ `bundle_no` 는 **관리 번호**다(§1.4). `member_no` / `run_no` 와 같은 성질이라
--   재사용·재배열하지 않는다 — 카톡 평문에서 "2묶음" 이 어제와 다른 것을 가리키면
--   진행 중인 대화가 조용히 무효가 된다.
-- ★ `share_mode` 가 **nullable** 인 것이 설계의 핵심이다. `null` = "파티 설정을 따른다".
--   not null + 기본값으로 두면 묶음을 만드는 순간 파티 설정과의 연결이 끊기고, 파티
--   분배를 바꿨는데 묶음이 안 따라오는 일이 생긴다.
create table if not exists public.party_bundles (
  id                    uuid primary key default gen_random_uuid(),
  party_id              uuid not null references public.parties(id) on delete cascade,

  bundle_no             smallint,

  name                  text not null,
  name_is_custom        boolean not null default false,

  sort_order            integer not null default 1,

  -- null = 파티 설정(`parties.share_mode`)을 따른다.
  share_mode            public.run_share_mode,

  -- true = 결정석도 비율대로 · false = 결정석만 균등(드랍은 비율대로).
  crystal_follows_share boolean not null default true,

  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- `add constraint if not exists` 는 PostgreSQL 에 없다. 재실행 안전을 위해 직접 본다.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundles_sort_order_range'
       and conrelid = 'public.party_bundles'::regclass
  ) then
    alter table public.party_bundles
      add constraint party_bundles_sort_order_range
      check (sort_order between 1 and 99);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundles_name_shape'
       and conrelid = 'public.party_bundles'::regclass
  ) then
    alter table public.party_bundles
      add constraint party_bundles_name_shape
      check (btrim(name) <> '' and length(name) <= 80);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundles_bundle_no_uniq'
       and conrelid = 'public.party_bundles'::regclass
  ) then
    alter table public.party_bundles
      add constraint party_bundles_bundle_no_uniq unique (party_id, bundle_no);
  end if;
end
$$;

comment on table public.party_bundles is
  '파티가 묶어서 도는 한 덩이. 같은 구성원이 보스 묶음·캐릭터·분배만 바꿔 여러 조합을 '
  '도는 쓰임을 파티를 늘리지 않고 표현한다(발주 지시 2026-10-16).';
comment on column public.party_bundles.bundle_no is
  '파티 안에서 묶음을 부르는 번호(1부터). **재배열/재사용 금지** — member_no 와 같은 성질의 '
  '관리 번호다(§1.4). 트리거 party_bundles_assign_bundle_no() 가 채운다.';
comment on column public.party_bundles.share_mode is
  'null = 파티 설정(parties.share_mode)을 따른다. 값이 있으면 이 묶음만 그 방식을 쓴다. '
  'nullable 인 것이 핵심이다 — 기본값으로 굳히면 파티 분배를 바꿔도 묶음이 안 따라온다.';
comment on column public.party_bundles.crystal_follows_share is
  'true = 결정석도 실효 비율대로 나눈다(적용 전 동작). false = 결정석은 균등(가중치 전부 1)이고 '
  '드랍만 비율대로. 발주 근거: "드랍만 비율로 거는사람도있어" — 결정석은 각자 자기 캐릭터가 '
  '먹으므로 균등이 곧 "각자 자기 것"이다.';

create index if not exists party_bundles_party_idx
  on public.party_bundles (party_id, sort_order, bundle_no);

-- `member_no` 와 **같은 패턴**이다(마이그레이션 14). 묶음을 만드는 경로가 웹·봇으로
-- 여럿이라 앱에 두면 한 곳만 빠뜨려도 번호가 겹치거나 빈다. 경쟁 조건은
-- advisory lock + unique 로 막는다.
create or replace function public.party_bundles_assign_bundle_no()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_next smallint;
begin
  if new.bundle_no is not null then
    return new;   -- 명시 지정(복원·이관)은 존중한다
  end if;

  perform pg_advisory_xact_lock(hashtextextended('party_bundle:' || new.party_id::text, 0));

  select (coalesce(max(bundle_no), 0) + 1)::smallint
    into v_next
    from public.party_bundles
   where party_id = new.party_id;

  new.bundle_no := v_next;
  return new;
end;
$func$;

comment on function public.party_bundles_assign_bundle_no() is
  '묶음 번호를 max+1 로 채운다. 명시 지정은 존중한다. 번호를 정하는 주체가 트리거 하나여야 '
  '웹·봇 어느 경로로 들어와도 §1.4(재배열·재사용 금지)가 똑같이 성립한다.';

drop trigger if exists party_bundles_assign_bundle_no on public.party_bundles;
create trigger party_bundles_assign_bundle_no
  before insert on public.party_bundles
  for each row execute function public.party_bundles_assign_bundle_no();

drop trigger if exists party_bundles_set_updated_at on public.party_bundles;
create trigger party_bundles_set_updated_at
  before update on public.party_bundles
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. party_bundle_bosses — 그 묶음이 연달아 도는 보스
-- -----------------------------------------------------------------------------
-- `party_bosses` 와 같은 모양이고, 축만 파티 → 묶음으로 옮겼다. 경계값도 같은 자리에서
-- 같은 값을 쓴다(소요 시간 5~20 = `party_runs.duration_minutes` 의 CHECK).
create table if not exists public.party_bundle_bosses (
  id                 uuid primary key default gen_random_uuid(),
  bundle_id          uuid not null references public.party_bundles(id) on delete cascade,
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete restrict,

  -- 표시·배치 순서. 1부터 촘촘하게(set_party_bundle_bosses 가 다시 매긴다).
  -- ⚠️ 관리 번호가 **아니다** — 사용자가 자유롭게 바꿔도 되고, 바꾸면 제목이 따라 바뀐다.
  sort_order         integer not null default 1,

  -- null = "이 묶음은 이 보스의 시간을 정하지 않았다". 0 도 20 도 아니다(§1.3 D4 기조).
  duration_minutes   integer,

  created_at         timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundle_bosses_uniq'
       and conrelid = 'public.party_bundle_bosses'::regclass
  ) then
    alter table public.party_bundle_bosses
      add constraint party_bundle_bosses_uniq unique (bundle_id, boss_difficulty_id);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundle_bosses_sort_order_range'
       and conrelid = 'public.party_bundle_bosses'::regclass
  ) then
    alter table public.party_bundle_bosses
      add constraint party_bundle_bosses_sort_order_range
      check (sort_order between 1 and 24);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundle_bosses_duration_minutes_check'
       and conrelid = 'public.party_bundle_bosses'::regclass
  ) then
    alter table public.party_bundle_bosses
      add constraint party_bundle_bosses_duration_minutes_check
      check (duration_minutes is null or (duration_minutes between 5 and 20));
  end if;
end
$$;

comment on table public.party_bundle_bosses is
  '묶음이 연달아 도는 보스 목록(계획). party_bosses 를 묶음축으로 옮긴 것이고, '
  '시각이 붙은 실행은 party_runs 다 — 역할이 겹치지 않는다.';
comment on column public.party_bundle_bosses.duration_minutes is
  '이 묶음이 이 보스에 쓰는 시간(분). null = 정하지 않았다(0 도 20 도 아니다 — 앱이 '
  'src/lib/domain/run-grouping.ts 의 DEFAULT_RUN_MINUTES 로 접는다). 상·하한 5~20 은 '
  'party_runs.duration_minutes 의 CHECK 와 **같은 경계**다. 다르면 묶음에는 저장되는데 '
  '런을 못 만드는 조합이 생긴다. 한 묶음의 길이는 이 값들의 합이다.';

create index if not exists party_bundle_bosses_bundle_idx
  on public.party_bundle_bosses (bundle_id, sort_order);
create index if not exists party_bundle_bosses_boss_idx
  on public.party_bundle_bosses (boss_difficulty_id);


-- -----------------------------------------------------------------------------
-- 3. party_bundle_characters — "이 묶음에서 이 사람은 이 캐릭으로"
-- -----------------------------------------------------------------------------
-- ★ `character_id` 는 `on delete set null` 이다 — 캐릭터가 지워지면 **행은 남고 값만
--   비는** 것이 옳다. 행을 지우면 "이 사람이 이 묶음에 있다"는 사실까지 사라진다.
-- ⚠️ **1단계에서 이 표는 거울이다.** 권위는 아직 `party_participants.character_id` 에
--    있고(그 컬럼을 읽는 자리가 SQL 함수 `run_participant_names` 를 포함해 여럿이다),
--    앱이 그 컬럼을 쓸 때 이 표도 함께 맞춘다. 2단계에서 권위가 묶음으로 넘어오면
--    그 동기화가 없어진다. 읽기 순서는 **묶음 → 파티**로 이미 고정했다.
create table if not exists public.party_bundle_characters (
  bundle_id      uuid not null references public.party_bundles(id) on delete cascade,
  participant_id uuid not null references public.party_participants(id) on delete cascade,
  character_id   uuid references public.characters(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (bundle_id, participant_id)
);

comment on table public.party_bundle_characters is
  '이 묶음에서 이 사람이 데려가는 캐릭터. 같은 사람이 묶음마다 다른 캐릭으로 가는 것이 '
  '이 표의 존재 이유다(party_participants 의 부분 unique(party_id, user_id) 가 파티 축에서는 '
  '그것을 막는다). 1단계에서는 party_participants.character_id 의 거울이며, 읽기는 '
  '묶음 → 파티 순으로 떨어진다.';

create index if not exists party_bundle_characters_participant_idx
  on public.party_bundle_characters (participant_id);
create index if not exists party_bundle_characters_character_idx
  on public.party_bundle_characters (character_id);

drop trigger if exists party_bundle_characters_set_updated_at on public.party_bundle_characters;
create trigger party_bundle_characters_set_updated_at
  before update on public.party_bundle_characters
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. party_bundle_shares — 묶음마다 다른 분배 비율
-- -----------------------------------------------------------------------------
-- ★ `share_bp` 가 **nullable** 이고 `null` = "파티 값을 따른다". 0 과 다르다 —
--   0 은 "이 사람은 안 받는다"이고 null 은 "아직 정하지 않았다"다(§1.3 D4 기조).
create table if not exists public.party_bundle_shares (
  bundle_id      uuid not null references public.party_bundles(id) on delete cascade,
  participant_id uuid not null references public.party_participants(id) on delete cascade,
  share_bp       integer,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (bundle_id, participant_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'party_bundle_shares_share_bp_range'
       and conrelid = 'public.party_bundle_shares'::regclass
  ) then
    alter table public.party_bundle_shares
      add constraint party_bundle_shares_share_bp_range
      check (share_bp is null or (share_bp >= 0 and share_bp <= 10000));
  end if;
end
$$;

comment on table public.party_bundle_shares is
  '이 묶음에서 이 사람의 분배 비율(basis point). null = party_participants.share_bp 를 따른다. '
  '발주 지시(2026-10-16): "묶어서 돌먹을 하여도 분배는 그 1개의 묶음마다 달라질수 있다".';
comment on column public.party_bundle_shares.share_bp is
  '만분율. null = 파티 값 상속이며 **0 과 다르다**(0 은 "안 받는다"). 실효 모드가 manual 일 때만 '
  '쓰인다. 정산 값이므로 anon/authenticated 에서 회수돼 있다.';

create index if not exists party_bundle_shares_participant_idx
  on public.party_bundle_shares (participant_id);

drop trigger if exists party_bundle_shares_set_updated_at on public.party_bundle_shares;
create trigger party_bundle_shares_set_updated_at
  before update on public.party_bundle_shares
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 5. party_runs.bundle_id — 이 런은 어느 묶음의 몇 번째인가
-- -----------------------------------------------------------------------------
-- ★ ═══════════════════════════════════════════════════════════════════════════
--   **`party_id` 는 반드시 남긴다.** 정산 사슬(`v_run_share_weights` → parties.share_mode)과
--   RLS 가 그것을 경유하고, 남겨야 과거가 안 깨진다. `bundle_id` 가 `set null` 인 것도
--   같은 이유다 — 묶음을 지웠다고 지난 런과 그 수익이 사라지면 안 된다.
--   ═══════════════════════════════════════════════════════════════════════════
alter table public.party_runs
  add column if not exists bundle_id uuid references public.party_bundles(id) on delete set null;

comment on column public.party_runs.bundle_id is
  '이 런이 속한 보스 묶음. null = 묶음이 지워진 과거 런(ON DELETE SET NULL). party_id 는 '
  '**남는다** — 정산과 RLS 가 그것을 경유하므로 묶음으로 갈음할 수 없다.';

create index if not exists party_runs_bundle_idx
  on public.party_runs (bundle_id);

-- ★ `bundle_id` 를 공개면에 열지 **않는다.** `party_runs` 는 마이그레이션 11-A-1 부터
--   컬럼 단위 GRANT 목록을 쓰므로 새 컬럼은 **아무것도 하지 않으면 닫혀 있다** — 그것이
--   그 설계의 요점이다. 비로그인 시간표는 `v_public_party_runs` 를 지나며 묶음 id 를
--   필요로 하지 않는다. 열어야 할 날이 오면 그 뷰에 명시적으로 넣을 것.


-- -----------------------------------------------------------------------------
-- 6. RLS — `party_bosses` 의 4정책을 그대로 복제한다
-- -----------------------------------------------------------------------------
-- 새 판정을 발명하면 공개 파티의 묶음이 새거나 반대로 안 보인다. 공개 범위를 정하는
-- 곳은 오직 `parties.visibility = 'public'` 한 군데다(마이그레이션 08 머리말).
-- visibility='link' 는 슬러그가 곧 비밀이라 RLS 로 표현할 수 없고, Route Handler 가
-- 토큰을 검증한 뒤 service role 로 서빙한다 — 그래서 여기 정책에도 등장하지 않는다.

-- ★ ═══════════════════════════════════════════════════════════════════════════
--   권한은 **컬럼 단위 GRANT 목록**으로 준다. 테이블 단위 grant 뒤에 컬럼을
--   revoke 하는 것은 PostgreSQL 에서 **아무 효과가 없다**(테이블 권한이 그대로 이긴다).
--   그보다 중요한 이유는 마이그레이션 11-A-1 이 적어 둔 것이다: 컬럼 목록은 **나중에
--   추가되는 컬럼을 자동으로 포함하지 않으므로** 기본값이 안전하다. 테이블 단위 grant 는
--   정반대이고, 그것이 `run_signups.share_bp` 유출 사고의 원인이었다.
--   (`party_bosses` 는 2026-08-18 에 테이블 단위로 받았고, 그래서 나중에 붙은
--    `duration_minutes` 가 자동으로 공개면에 열렸다 — 민감하지 않아 사고가 아니었을 뿐
--    구조는 바로 그 사고의 구조다. 새 표는 그 길을 따르지 않는다.)
--   ═══════════════════════════════════════════════════════════════════════════

-- 6-1. party_bundles
--      제외: share_mode · crystal_follows_share — 분배 약정은 돈 약정의 일부이며
--            공개면(비로그인 시간표)에 나갈 이유가 없다(`parties.share_mode` 와 같은 판단).
alter table public.party_bundles enable row level security;
revoke all on table public.party_bundles from anon;
revoke all on table public.party_bundles from authenticated;
grant select (
  id, party_id, bundle_no, name, name_is_custom, sort_order,
  archived_at, created_at, updated_at
) on table public.party_bundles to anon, authenticated;
grant all on table public.party_bundles to service_role;

drop policy if exists party_bundles_public_select on public.party_bundles;
create policy party_bundles_public_select on public.party_bundles
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = party_bundles.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists party_bundles_no_public_insert on public.party_bundles;
create policy party_bundles_no_public_insert on public.party_bundles
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_bundles_no_public_update on public.party_bundles;
create policy party_bundles_no_public_update on public.party_bundles
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_bundles_no_public_delete on public.party_bundles;
create policy party_bundles_no_public_delete on public.party_bundles
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_bundles_service_role_all on public.party_bundles;
create policy party_bundles_service_role_all on public.party_bundles
  as permissive for all to service_role using (true) with check (true);

-- 6-2. party_bundle_bosses — 묶음을 거쳐 파티 공개 여부를 본다
--      전 컬럼 공개다 — "이 공개 파티는 무엇을 묶어 도는가"가 안 보이면 공개할 이유가 없고,
--      소요 시간도 공개 시간표가 막대 길이로 이미 드러낸다. 그래도 **목록으로** 적는다
--      (나중에 붙는 컬럼이 자동으로 열리지 않게).
alter table public.party_bundle_bosses enable row level security;
revoke all on table public.party_bundle_bosses from anon;
revoke all on table public.party_bundle_bosses from authenticated;
grant select (
  id, bundle_id, boss_difficulty_id, sort_order, duration_minutes, created_at
) on table public.party_bundle_bosses to anon, authenticated;
grant all on table public.party_bundle_bosses to service_role;

drop policy if exists party_bundle_bosses_public_select on public.party_bundle_bosses;
create policy party_bundle_bosses_public_select on public.party_bundle_bosses
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1
        from public.party_bundles b
        join public.parties p on p.id = b.party_id
       where b.id = party_bundle_bosses.bundle_id
         and p.visibility = 'public'
         and p.archived_at is null
    )
  );

drop policy if exists party_bundle_bosses_no_public_insert on public.party_bundle_bosses;
create policy party_bundle_bosses_no_public_insert on public.party_bundle_bosses
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_bundle_bosses_no_public_update on public.party_bundle_bosses;
create policy party_bundle_bosses_no_public_update on public.party_bundle_bosses
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_bundle_bosses_no_public_delete on public.party_bundle_bosses;
create policy party_bundle_bosses_no_public_delete on public.party_bundle_bosses
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_bundle_bosses_service_role_all on public.party_bundle_bosses;
create policy party_bundle_bosses_service_role_all on public.party_bundle_bosses
  as permissive for all to service_role using (true) with check (true);

-- 6-3. party_bundle_characters
--      ★ `character_id` 는 `party_participants.character_id` 와 **같이** 비공개다
--        (어느 캐릭터로 가는지는 사적 정보이고, 그쪽도 컬럼 단위로 회수돼 있다).
alter table public.party_bundle_characters enable row level security;
revoke all on table public.party_bundle_characters from anon;
revoke all on table public.party_bundle_characters from authenticated;
grant select (
  bundle_id, participant_id, created_at, updated_at
) on table public.party_bundle_characters to anon, authenticated;
grant all on table public.party_bundle_characters to service_role;

drop policy if exists party_bundle_characters_public_select on public.party_bundle_characters;
create policy party_bundle_characters_public_select on public.party_bundle_characters
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1
        from public.party_bundles b
        join public.parties p on p.id = b.party_id
       where b.id = party_bundle_characters.bundle_id
         and p.visibility = 'public'
         and p.archived_at is null
    )
  );

drop policy if exists party_bundle_characters_no_public_insert on public.party_bundle_characters;
create policy party_bundle_characters_no_public_insert on public.party_bundle_characters
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_bundle_characters_no_public_update on public.party_bundle_characters;
create policy party_bundle_characters_no_public_update on public.party_bundle_characters
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_bundle_characters_no_public_delete on public.party_bundle_characters;
create policy party_bundle_characters_no_public_delete on public.party_bundle_characters
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_bundle_characters_service_role_all on public.party_bundle_characters;
create policy party_bundle_characters_service_role_all on public.party_bundle_characters
  as permissive for all to service_role using (true) with check (true);

-- 6-4. party_bundle_shares
--      ★ ═════════════════════════════════════════════════════════════════════
--        `share_bp` 는 `assert_no_public_sensitive_columns()` 의 `%_bp` 패턴에 **걸린다.**
--        회수하지 않으면 이 마이그레이션의 마지막 줄이 적용을 거절한다 — 그것이 정상이고
--        회수가 정답이다(`party_participants.share_bp` 가 2026-08-19 에 같은 길을 갔다).
--      ═════════════════════════════════════════════════════════════════════════
alter table public.party_bundle_shares enable row level security;
revoke all on table public.party_bundle_shares from anon;
revoke all on table public.party_bundle_shares from authenticated;
-- ★ anon/authenticated 에게 **한 컬럼도 주지 않는다.** 이 표의 존재 이유가 `share_bp` 이고,
--   "누가 이 묶음에 있는가"는 `party_participants` 가 이미 공개면에 내준다. 그러므로 여기서
--   공개면에 열 컬럼이 하나도 없다.
grant all on table public.party_bundle_shares to service_role;

-- ⚠️ 아래 SELECT 정책은 **지금은 닿지 않는다**(컬럼 grant 가 없으므로). 그래도 둔다 —
--    나중에 누가 컬럼 하나를 열더라도 행 필터가 이미 옳은 쪽으로 서 있게 하는 장치다.
--    정책 없는 테이블은 마이그레이션 13 의 자기검증이 거절하기도 한다.
drop policy if exists party_bundle_shares_public_select on public.party_bundle_shares;
create policy party_bundle_shares_public_select on public.party_bundle_shares
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1
        from public.party_bundles b
        join public.parties p on p.id = b.party_id
       where b.id = party_bundle_shares.bundle_id
         and p.visibility = 'public'
         and p.archived_at is null
    )
  );

drop policy if exists party_bundle_shares_no_public_insert on public.party_bundle_shares;
create policy party_bundle_shares_no_public_insert on public.party_bundle_shares
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_bundle_shares_no_public_update on public.party_bundle_shares;
create policy party_bundle_shares_no_public_update on public.party_bundle_shares
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_bundle_shares_no_public_delete on public.party_bundle_shares;
create policy party_bundle_shares_no_public_delete on public.party_bundle_shares
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_bundle_shares_service_role_all on public.party_bundle_shares;
create policy party_bundle_shares_service_role_all on public.party_bundle_shares
  as permissive for all to service_role using (true) with check (true);


-- -----------------------------------------------------------------------------
-- 7. 이행(백필) — 전량 결정적, 모호함 0
-- -----------------------------------------------------------------------------
-- ★ 파티마다 묶음 **1개**. 합치지 않는다 — 합치기는 사용자 행동이고 이 단계가 아니다.
-- ★ `share_mode = null`(파티 상속) · `crystal_follows_share = true`(적용 전 동작).
-- ★ `party_participants.share_bp` 는 **옮기지 않는다.** 파티에 그대로 두고 묶음은
--   null=상속이다. 그래야 과거 금액이 한 푼도 안 움직인다.
-- ★ 보관(archived) 파티도 포함한다 — 그 파티의 지난 런과 수익이 그대로 읽혀야 한다.
--
-- ★ ═══════════════════════════════════════════════════════════════════════════
--   **`archived_at` 은 복사하지 않는다 (null 로 둔다).**
--   ═══════════════════════════════════════════════════════════════════════════
--   처음에는 파티의 `archived_at` 을 묶음에도 복사했다. 그러면 읽기 경로가 "보관되지
--   않은 묶음"만 고르므로 **보관된 파티의 보스 목록이 조용히 빈 배열이 된다** — 적용
--   전에는 보였던 값이고, "화면이 한 픽셀도 바뀌지 않는다"는 이 단계의 조건을 깬다.
--   게다가 보관 상태가 두 곳에 생겨 **둘이 어긋날 수 있는 자리**가 늘어난다.
--   보관은 이미 `parties.archived_at` 한 곳이 정하고 그것이 모든 화면을 가린다.
--   `party_bundles.archived_at` 은 **"사용자가 이 묶음을 보관했다"** 만을 위해 비워 둔다
--   (2단계에서 쓰인다).
--
-- ── ★ 재실행 안전의 핵심: **손대지 않은 묶음에만 붓는다** ────────────────────
--   `on conflict do nothing` 만으로는 부족하다. 사용자가 묶음에서 보스 **하나를 지운**
--   뒤에 이 파일을 다시 돌리면, 지운 보스가 `party_bosses`(얼린 과거)에서 조용히
--   되살아난다. 그래서 대상을 `updated_at = created_at` 인 묶음 — 즉 **생성 이후 한 번도
--   편집되지 않은 묶음**으로 제한한다. 묶음축 쓰기 함수 셋(9-2·9-3·9-4)이 전부
--   `party_bundles.updated_at` 을 건드리므로 이 판정은 정확하다.
--   대상 묶음은 `bundle_no` 가 가장 작은 것이다(리터럴 1 이 아니다 — 1번이 지워진 뒤에도
--   맞는 답을 내야 한다).

-- 7-0. 이번 실행의 이행 대상. 아래 검증도 **같은 집합**을 본다.
drop table if exists _party_bundle_backfill;
create temp table _party_bundle_backfill (
  party_id  uuid primary key,
  bundle_id uuid not null
);

-- 7-1. 파티 → 묶음 1개
insert into public.party_bundles
       (party_id, bundle_no, name, name_is_custom, sort_order,
        share_mode, crystal_follows_share, archived_at)
select p.id, 1::smallint, p.name, p.name_is_custom, 1,
       null::public.run_share_mode, true, null::timestamptz
  from public.parties p
 where not exists (
   select 1 from public.party_bundles b where b.party_id = p.id
 );

insert into _party_bundle_backfill (party_id, bundle_id)
select distinct on (b.party_id) b.party_id, b.id
  from public.party_bundles b
 where b.updated_at = b.created_at   -- 생성 이후 한 번도 편집되지 않았다
 order by b.party_id, b.bundle_no;

-- 7-2. party_bosses → party_bundle_bosses (순서·소요 시간 그대로)
insert into public.party_bundle_bosses
       (bundle_id, boss_difficulty_id, sort_order, duration_minutes, created_at)
select t.bundle_id, pb.boss_difficulty_id, pb.sort_order, pb.duration_minutes, pb.created_at
  from public.party_bosses pb
  join _party_bundle_backfill t on t.party_id = pb.party_id
on conflict (bundle_id, boss_difficulty_id) do nothing;

-- 7-3. party_participants.character_id → party_bundle_characters
--      값이 없는 사람은 **행을 만들지 않는다.** 빈 행을 만들면 "정하지 않았다"를 값으로
--      굳히는 셈이고, 읽기 폴백(묶음 → 파티)이 파티 쪽을 못 보게 된다.
insert into public.party_bundle_characters (bundle_id, participant_id, character_id)
select t.bundle_id, pp.id, pp.character_id
  from public.party_participants pp
  join _party_bundle_backfill t on t.party_id = pp.party_id
 where pp.character_id is not null
on conflict (bundle_id, participant_id) do nothing;

-- 7-4. party_runs.bundle_id ← 그 파티의 묶음
--      ⚠️ 여기만 대상 제한이 없다. 묶음이 **편집됐든 아니든** 런은 그 파티의 묶음에
--         붙어야 하고(`bundle_id is null` 이 이미 "아직 안 붙었다"를 뜻한다), 이미 붙은
--         런은 건드리지 않으므로 사용자가 옮겨 둔 런을 되돌리지 않는다.
update public.party_runs r
   set bundle_id = x.bundle_id
  from (
    select distinct on (b.party_id) b.party_id, b.id as bundle_id
      from public.party_bundles b
     order by b.party_id, b.bundle_no
  ) x
 where x.party_id = r.party_id
   and r.bundle_id is null;


-- -----------------------------------------------------------------------------
-- 8. `party_bosses` 는 얼린다 — 지우지 않고, 더 이상 쓰지 않는다
-- -----------------------------------------------------------------------------
-- ⚠️ 쓰기 경로를 **둘 다 묶음 쪽으로 옮긴다.** 양쪽에 쓰면 반드시 갈라지고, 갈라진 뒤에는
--    어느 쪽이 진실인지 아무도 모른다. 그래서 옛 함수는 **떨어뜨린다** — 남겨 두면 옛
--    배포가 조용히 `party_bosses` 에만 쓰고, 그 편집이 화면에서 영영 보이지 않는다.
--    없으면 PostgREST 가 PGRST202 로 **큰 소리로** 실패하고, 그것이 옳은 실패 방식이다.
drop function if exists public.set_party_bosses(uuid, text[], integer[]);
drop function if exists public.set_party_bosses(uuid, text[]);
drop function if exists public.set_party_boss_durations(uuid, text[], integer[]);

comment on table public.party_bosses is
  '⚠️ **얼렸다**(2026-10-16). 읽기·쓰기 모두 party_bundle_bosses 로 옮겼다. 지우지 않은 '
  '이유는 되돌리기 창뿐이며, 그 창은 **첫 묶음 편집까지**다 — 그 뒤의 내용은 멈춘 과거다. '
  '양쪽에 쓰지 않는 것이 의도다(이중 쓰기는 반드시 갈라진다).';
comment on column public.party_bosses.duration_minutes is
  '⚠️ 더 이상 읽지 않는다. party_bundle_bosses.duration_minutes 가 갖는다(2026-10-16).';


-- -----------------------------------------------------------------------------
-- 9. 묶음축 쓰기 함수
-- -----------------------------------------------------------------------------
-- 권한 판정은 여기서 하지 않는다. 이 저장소의 쓰기는 전부 Route Handler(세션 확인)
-- → repo(파티 구성원 확인) → service_role 이고, DB 함수는 그 마지막 칸이다.

-- 9-1. ensure_party_bundle — 그 파티의 기본 묶음 id (없으면 만든다)
-- ★ 1단계에서 호출자는 "이 파티의 묶음" 하나만 알면 된다. 화면이 묶음을 고르게 되는
--   2단계가 오면 호출자가 id 를 직접 들고 오고, 이 함수는 그때부터 생성 경로만 남는다.
-- ★ 보관되지 않은 묶음 중 **번호가 가장 작은 것**을 고른다. `created_at` 이 아니라
--   번호로 고르는 이유는 번호가 관리 식별자라 사람이 말하는 "1묶음"과 일치해야 하기
--   때문이다(§1.4).
create or replace function public.ensure_party_bundle(p_party_id uuid)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_id   uuid;
  v_name text;
  v_cust boolean;
begin
  select b.id into v_id
    from public.party_bundles b
   where b.party_id = p_party_id
     and b.archived_at is null
   order by b.bundle_no
   limit 1;
  if v_id is not null then return v_id; end if;

  -- 전부 보관됐다면 보관된 것 중 가장 앞 번호를 되살리지 **않는다** — 보관은 사용자의
  -- 결정이다. 새 묶음을 만들고, 이름은 파티 이름에서 출발한다.
  select p.name, p.name_is_custom into v_name, v_cust
    from public.parties p where p.id = p_party_id;
  if v_name is null then
    raise exception '파티를 찾을 수 없습니다 (%).', p_party_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into public.party_bundles (party_id, name, name_is_custom, share_mode)
  values (p_party_id, v_name, coalesce(v_cust, false), null)
  returning id into v_id;

  return v_id;
end;
$func$;

comment on function public.ensure_party_bundle(uuid) is
  '그 파티의 기본 묶음 id. 보관되지 않은 묶음 중 bundle_no 가 가장 작은 것을 돌려주고, '
  '없으면 파티 이름으로 하나 만든다. 보관된 묶음은 되살리지 않는다 — 보관은 사용자의 결정이다.';

revoke all    on function public.ensure_party_bundle(uuid) from public;
revoke all    on function public.ensure_party_bundle(uuid) from anon;
revoke all    on function public.ensure_party_bundle(uuid) from authenticated;
grant execute on function public.ensure_party_bundle(uuid) to service_role;


-- 9-2. set_party_bundle_bosses — 목록 전체 교체 (원자적)
-- ⚠️ 보존 규칙·중복 접기·길이 검사·경계값은 옛 `set_party_bosses` 와 **완전히 같다.**
--    바뀐 것은 축(파티 → 묶음) 하나뿐이다. 동작이 같아야 이 마이그레이션이 "축 이동"
--    하나로 읽힌다.
-- ★ `p_duration_minutes` 가 null 이면 **기존 소요 시간을 보존한다.** 목록만 저장하는
--   호출이 계약상 정상이고(PUT /bosses 에서 durationMinutes 생략), 보존이 없으면 그
--   저장마다 보스 시간이 전부 날아간다. delete→insert 사이를 버틸 자리가 DB 뿐이라
--   여기서 스냅샷을 뜬다.
create or replace function public.set_party_bundle_bosses(
  p_bundle_id           uuid,
  p_boss_difficulty_ids text[],
  p_duration_minutes    integer[] default null
)
returns setof public.party_bundle_bosses
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_ids  text[]  := coalesce(p_boss_difficulty_ids, '{}'::text[]);
  v_len  integer := coalesce(array_length(v_ids, 1), 0);
  v_dlen integer := coalesce(array_length(p_duration_minutes, 1), 0);
  v_kept jsonb;
  v_bad  integer;
begin
  if v_len > 24 then
    raise exception '묶음에 등록할 수 있는 보스는 24개까지입니다 (입력 %개).', v_len
      using errcode = 'check_violation';
  end if;

  if p_duration_minutes is not null and v_dlen <> v_len then
    raise exception
      '보스 %개에 소요 시간 %개가 들어왔습니다 — 길이가 같아야 어느 보스의 시간인지 정해집니다.',
      v_len, v_dlen
      using errcode = 'check_violation';
  end if;

  if p_duration_minutes is not null then
    -- CHECK 가 어차피 막지만, 거기까지 내려가면 Postgres 영문 제약 위반이 되어 앱이 500 으로
    -- 접는다. 한국어로 말할 수 있는 자리에서 말한다.
    select min(d) into v_bad
      from unnest(p_duration_minutes) as t(d)
     where d is not null and (d < 5 or d > 20);
    if v_bad is not null then
      raise exception '보스 소요 시간은 5분에서 20분 사이여야 합니다 (입력 %).', v_bad
        using errcode = 'check_violation';
    end if;
  end if;

  -- ★ 보존 스냅샷. **delete 보다 먼저** 떠야 한다.
  select coalesce(jsonb_object_agg(boss_difficulty_id, duration_minutes), '{}'::jsonb)
    into v_kept
    from public.party_bundle_bosses
   where bundle_id = p_bundle_id
     and duration_minutes is not null;

  delete from public.party_bundle_bosses where bundle_id = p_bundle_id;

  if v_len > 0 then
    insert into public.party_bundle_bosses
           (bundle_id, boss_difficulty_id, sort_order, duration_minutes)
    select p_bundle_id,
           d.id,
           (row_number() over (order by d.ord))::integer,
           d.dur
      from (
        select i.id,
               min(i.ord)                           as ord,
               -- 중복이 접힌 자리는 **첫 등장**의 값. array_agg 는 null 도 자리를 지킨다.
               (array_agg(i.dur order by i.ord))[1] as dur
          from (
            select u.id,
                   u.ord,
                   case
                     -- 배열이 없으면 **보존**, 있으면 그 자리의 값(null 이면 정하지 않음).
                     when p_duration_minutes is null then (v_kept ->> u.id)::integer
                     else p_duration_minutes[u.ord::integer]
                   end as dur
              from unnest(v_ids) with ordinality as u(id, ord)
             where btrim(u.id) <> ''
          ) i
         group by i.id
      ) d;
  end if;

  -- ★ 부모의 `updated_at` 을 민다. 이 파일의 백필 가드가 "생성 이후 편집되지 않은 묶음"을
  --   `updated_at = created_at` 으로 판정하므로, 이 한 줄이 재실행 안전을 성립시킨다.
  update public.party_bundles set updated_at = now() where id = p_bundle_id;

  return query
    select pbb.*
      from public.party_bundle_bosses pbb
     where pbb.bundle_id = p_bundle_id
     order by pbb.sort_order, pbb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_bundle_bosses(uuid, text[], integer[]) is
  '묶음의 보스 목록을 배열 순서대로 통째로 교체한다(원자적). 중복은 접고 sort_order 는 1부터 '
  '다시 매긴다. p_duration_minutes 가 null 이면 **기존 소요 시간을 보존한다** — 목록만 저장하는 '
  '호출이 계약상 정상이고, 보존이 없으면 그 저장마다 보스 시간이 전부 날아간다. 배열이 주어지면 '
  '길이가 보스 배열과 같아야 하며, 다르면 예외다. 원소 null 은 "정하지 않음"이라 기존 값을 '
  '지운다(생략과 정반대다). 범위는 5~20 이며 party_runs 와 같은 경계다. 권한 판정은 하지 않는다.';

revoke all    on function public.set_party_bundle_bosses(uuid, text[], integer[]) from public;
revoke all    on function public.set_party_bundle_bosses(uuid, text[], integer[]) from anon;
revoke all    on function public.set_party_bundle_bosses(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_bundle_bosses(uuid, text[], integer[]) to service_role;


-- 9-3. set_party_bundle_boss_durations — 목록을 건드리지 않는 좁은 경로
-- ⚠️ 성질은 옛 `set_party_boss_durations` 와 **완전히 같다**: 없는 보스 id 는 조용히 무시,
--    원소 null 은 "정하지 않음으로 되돌린다", 길이 불일치는 예외.
create or replace function public.set_party_bundle_boss_durations(
  p_bundle_id           uuid,
  p_boss_difficulty_ids text[],
  p_duration_minutes    integer[]
)
returns setof public.party_bundle_bosses
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_ids  text[]  := coalesce(p_boss_difficulty_ids, '{}'::text[]);
  v_len  integer := coalesce(array_length(v_ids, 1), 0);
  v_dlen integer := coalesce(array_length(p_duration_minutes, 1), 0);
  v_bad  integer;
begin
  if v_dlen <> v_len then
    raise exception
      '보스 %개에 소요 시간 %개가 들어왔습니다 — 길이가 같아야 어느 보스의 시간인지 정해집니다.',
      v_len, v_dlen
      using errcode = 'check_violation';
  end if;

  if v_len = 0 then
    return query
      select pbb.* from public.party_bundle_bosses pbb
       where pbb.bundle_id = p_bundle_id
       order by pbb.sort_order, pbb.boss_difficulty_id;
    return;
  end if;

  select min(d) into v_bad
    from unnest(p_duration_minutes) as t(d)
   where d is not null and (d < 5 or d > 20);
  if v_bad is not null then
    raise exception '보스 소요 시간은 5분에서 20분 사이여야 합니다 (입력 %).', v_bad
      using errcode = 'check_violation';
  end if;

  update public.party_bundle_bosses pbb
     set duration_minutes = d.dur
    from (
      select i.id, (array_agg(i.dur order by i.ord))[1] as dur
        from (
          select u.id, u.ord, p_duration_minutes[u.ord::integer] as dur
            from unnest(v_ids) with ordinality as u(id, ord)
           where btrim(u.id) <> ''
        ) i
       group by i.id
    ) d
   where pbb.bundle_id = p_bundle_id
     and pbb.boss_difficulty_id = d.id;

  -- 백필 가드가 보는 비트(9-2 머리말).
  update public.party_bundles set updated_at = now() where id = p_bundle_id;

  return query
    select pbb.*
      from public.party_bundle_bosses pbb
     where pbb.bundle_id = p_bundle_id
     order by pbb.sort_order, pbb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) is
  '이미 그 묶음에 등록된 보스의 소요 시간만 쓴다. 보스를 넣거나 지우거나 순서를 바꾸지 않으며, '
  '그 묶음에 없는 보스 id 는 조용히 무시한다(일정 등록을 실패시키지 않기 위해서다). 원소 null 은 '
  '"정하지 않음으로 되돌린다". 배열 길이는 같아야 하며 다르면 예외다. 범위는 5~20 이다.';

revoke all    on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) from public;
revoke all    on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) from anon;
revoke all    on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) from authenticated;
grant execute on function public.set_party_bundle_boss_durations(uuid, text[], integer[]) to service_role;


-- 9-4. set_party_bundle_character — 묶음에서 이 사람이 데려가는 캐릭터
-- ★ `null` 을 쓰면 **행을 지운다.** 빈 행을 남기면 읽기 폴백(묶음 → 파티)이 파티 쪽을
--   못 보게 되어, "묶음에서는 안 정했으니 파티 기본값으로" 가 표현 불가능해진다.
create or replace function public.set_party_bundle_character(
  p_bundle_id      uuid,
  p_participant_id uuid,
  p_character_id   uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $func$
begin
  if p_character_id is null then
    delete from public.party_bundle_characters
     where bundle_id = p_bundle_id and participant_id = p_participant_id;
  else
    insert into public.party_bundle_characters (bundle_id, participant_id, character_id)
    values (p_bundle_id, p_participant_id, p_character_id)
    on conflict (bundle_id, participant_id)
    do update set character_id = excluded.character_id;
  end if;

  -- 백필 가드가 보는 비트(9-2 머리말).
  update public.party_bundles set updated_at = now() where id = p_bundle_id;
end;
$func$;

comment on function public.set_party_bundle_character(uuid, uuid, uuid) is
  '묶음에서 이 사람이 데려가는 캐릭터를 쓴다. null 이면 **행을 지운다** — "묶음에서는 정하지 '
  '않음"을 표현하려면 행이 없어야 하고, 그때 읽기는 party_participants.character_id 로 떨어진다.';

revoke all    on function public.set_party_bundle_character(uuid, uuid, uuid) from public;
revoke all    on function public.set_party_bundle_character(uuid, uuid, uuid) from anon;
revoke all    on function public.set_party_bundle_character(uuid, uuid, uuid) from authenticated;
grant execute on function public.set_party_bundle_character(uuid, uuid, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- 10. 가중치 뷰를 **결정석 / 드랍 두 열로 가른다**
-- -----------------------------------------------------------------------------
-- 지금까지 `weight` 한 열이 결정석 정산과 드랍 정산에 **같은 값**으로 쓰였다. 발주 요구는
-- 바로 그 둘을 가르는 것이다(*"드랍만 비율로 거는사람도있어"*). 열 하나를 남겨 두면 어느
-- 소비자가 어느 뜻으로 읽는지 알 수 없으므로 **`weight` 를 없애고** 두 열로 바꾼다 —
-- 그러면 모든 소비자가 뜻을 명시하게 되고, 빠뜨린 소비자는 컴파일/쿼리 단계에서 터진다.
--
-- ⚠️ 뷰 여섯 개가 사슬로 묶여 있어 전부 다시 만든다. 순서는
--    `20260819200000_party_level_share_config.sql` 과 **같다.**
drop view if exists public.v_weekly_income;
drop view if exists public.v_weekly_drop_income;
drop view if exists public.v_run_drop_settlement;
drop view if exists public.v_run_drop_recipients;
drop view if exists public.v_run_crystal_settlement;
drop view if exists public.v_run_share_weights;

create view public.v_run_share_weights
with (security_invoker = true) as
select s.run_id,
       s.participant_id,
       pp.member_no,
       pp.user_id,
       pp.guest_id,
       pp.display_name,
       -- 실효 비율: 묶음 값이 있으면 그것, 없으면 파티 값.
       coalesce(bs.share_bp, pp.share_bp) as share_bp,
       /*
         결정석 가중치.
         ① crystal_follows_share = false → **균등**(발주 요구의 핵심).
         ② 실효 모드가 auto_equal → 균등.
         ③ 아직 아무도 비율을 지정하지 않았으면(런 전체 합 0) → 균등.
         ④ 그 외 → 실효 비율.
         ★ 균등을 만분율로 표현하면 안 된다. 1/6 이 1667/1666 으로 근사되어 6인 파티에서
           1인당 수천 메소가 어긋난다(하드 스우 실측: 8,583,333 이어야 할 값이 8,585,049).
           가중치를 전부 1 로 두면 분모가 n 이라 pot 이 정확히 나누어떨어진다.
         ★ `coalesce(b.crystal_follows_share, true)` / `coalesce(b.share_mode, p.share_mode)`
           의 `coalesce` 가 묶음이 없는 런(bundle_id is null — 묶음이 지워진 과거)을
           **적용 전과 똑같이** 처리한다.
       */
       case
         when not coalesce(b.crystal_follows_share, true) then 1
         when coalesce(b.share_mode, p.share_mode) = 'auto_equal'::public.run_share_mode then 1
         when coalesce(
                sum(coalesce(bs.share_bp, pp.share_bp)) over (partition by s.run_id),
                0::bigint
              ) = 0 then 1
         else coalesce(bs.share_bp, pp.share_bp)
       end as crystal_weight,
       /* 드랍 가중치 — 결정석과 달리 `crystal_follows_share` 를 보지 않는다. */
       case
         when coalesce(b.share_mode, p.share_mode) = 'auto_equal'::public.run_share_mode then 1
         when coalesce(
                sum(coalesce(bs.share_bp, pp.share_bp)) over (partition by s.run_id),
                0::bigint
              ) = 0 then 1
         else coalesce(bs.share_bp, pp.share_bp)
       end as drop_weight
  from public.run_signups s
  join public.party_runs r on r.id = s.run_id
  join public.parties p on p.id = r.party_id
  join public.party_participants pp on pp.id = s.participant_id
  left join public.party_bundles b on b.id = r.bundle_id
  -- PK 가 (bundle_id, participant_id) 라 최대 1행이다. 합계 윈도가 부풀지 않는다.
  left join public.party_bundle_shares bs
    on bs.bundle_id = r.bundle_id and bs.participant_id = s.participant_id
 where s.status = 'going'::public.signup_status;

comment on view public.v_run_share_weights is
  '런 참가자의 분배 가중치. **열이 둘이다** — crystal_weight(결정석) · drop_weight(드랍). '
  '방식은 coalesce(party_bundles.share_mode, parties.share_mode), 비율은 '
  'coalesce(party_bundle_shares.share_bp, party_participants.share_bp). '
  'party_bundles.crystal_follows_share = false 면 결정석만 균등이 된다(발주 지시 2026-10-16: '
  '"드랍만 비율로 거는사람도있어"). 옛 단일 열 `weight` 는 **없앴다** — 남겨 두면 어느 소비자가 '
  '어느 뜻으로 읽는지 알 수 없다.';

create view public.v_run_crystal_settlement
with (security_invoker = true) as
with run_pot as (
  select bc.run_id, max(bc.pot_meso) as pot_meso, max(bc.party_size) as party_size,
         min(bc.week_key) as week_key
    from public.boss_clears bc
   where bc.run_id is not null and bc.effective_cleared and bc.pot_meso is not null
   group by bc.run_id
), agg as (
  select w_1.run_id,
         array_agg(w_1.participant_id order by w_1.participant_id) as keys,
         -- ★ 결정석이므로 `crystal_weight` 다.
         array_agg(w_1.crystal_weight order by w_1.participant_id) as weights
    from public.v_run_share_weights w_1
   group by w_1.run_id
)
select p.run_id, p.week_key, p.pot_meso, p.party_size, d.key as participant_id,
       w.member_no, w.user_id, w.display_name, w.share_bp, d.amount as amount_meso
  from run_pot p
  join agg a on a.run_id = p.run_id
  cross join lateral public.distribute_meso(p.pot_meso, a.keys, a.weights) d(key, weight, amount)
  join public.v_run_share_weights w on w.run_id = p.run_id and w.participant_id = d.key;

comment on view public.v_run_crystal_settlement is
  '런별 결정석 정산. 가중치는 v_run_share_weights.crystal_weight 를 쓴다 — 묶음이 '
  'crystal_follows_share = false 면 여기서만 균등이 된다.';

create view public.v_run_drop_recipients
with (security_invoker = true) as
-- ★ 드랍이므로 `drop_weight` 다.
select d.id as drop_id, w.participant_id, w.drop_weight as weight
  from public.run_drops d
  join public.v_run_share_weights w on w.run_id = d.run_id
 where d.share_mode = 'party_default'::public.drop_share_mode
union all
select d.id, s.participant_id, s.share_bp
  from public.run_drops d
  join public.run_drop_shares s on s.drop_id = d.id
 where d.share_mode = 'custom'::public.drop_share_mode and s.share_bp > 0
union all
select d.id, d.solo_participant_id, 1
  from public.run_drops d
 where d.share_mode = 'solo'::public.drop_share_mode and d.solo_participant_id is not null;

comment on view public.v_run_drop_recipients is
  '드랍 한 건을 나눠 갖는 사람과 가중치. party_default 는 v_run_share_weights.drop_weight 를 '
  '따르므로 crystal_follows_share 와 무관하다 — 드랍은 언제나 비율대로다.';

create view public.v_run_drop_settlement
with (security_invoker = true) as
with agg as (
  select rc.drop_id,
         array_agg(rc.participant_id order by rc.participant_id) as keys,
         array_agg(rc.weight order by rc.participant_id) as weights
    from public.v_run_drop_recipients rc
   group by rc.drop_id
)
select d.id as drop_id, d.run_id, d.week_key, d.item_name, d.share_mode,
       d.sale_amount_meso, x.key as participant_id,
       pp.member_no, pp.user_id, pp.display_name, x.amount as amount_meso
  from public.run_drops d
  join agg a on a.drop_id = d.id
  cross join lateral public.distribute_meso(d.sale_amount_meso, a.keys, a.weights) x(key, weight, amount)
  join public.party_participants pp on pp.id = x.key
 where d.sale_amount_meso is not null;

create view public.v_weekly_drop_income
with (security_invoker = true) as
select user_id, week_key,
       (sum(amount_meso))::bigint as drop_income_meso,
       count(*) as drop_share_count,
       count(distinct drop_id) as drop_count
  from public.v_run_drop_settlement s
 where user_id is not null
 group by user_id, week_key;

create view public.v_weekly_income
with (security_invoker = true) as
with keys as (
  select user_id, week_key from public.v_weekly_crystal_income
  union
  select user_id, week_key from public.v_weekly_drop_income
  union
  select user_id, week_key from public.v_weekly_unsold_drops
)
select k.user_id, k.week_key,
       coalesce(c.income_meso, 0::bigint) as crystal_income_meso,
       coalesce(c.clear_count, 0::numeric) as clear_count,
       coalesce(c.weekly_clear_count, 0::numeric) as weekly_clear_count,
       coalesce(c.unknown_price_count, 0::numeric) as unknown_price_count,
       coalesce(c.weekly_over_limit_count, 0::numeric) as weekly_over_limit_count,
       coalesce(d.drop_income_meso, 0::bigint) as drop_income_meso,
       coalesce(d.drop_count, 0::bigint) as drop_count,
       coalesce(u.unsold_drop_count, 0::bigint) as unsold_drop_count,
       (coalesce(c.income_meso, 0::bigint) + coalesce(d.drop_income_meso, 0::bigint))
         as total_income_meso,
       coalesce(c.monthly_clear_count, 0::numeric) as monthly_clear_count,
       coalesce(c.weekly_income_meso, 0::bigint) as weekly_crystal_income_meso,
       coalesce(c.monthly_income_meso, 0::bigint) as monthly_crystal_income_meso,
       coalesce(c.daily_income_meso, 0::bigint) as daily_crystal_income_meso,
       coalesce(c.weekly_unknown_price_count, 0::numeric) as weekly_unknown_price_count,
       coalesce(c.monthly_unknown_price_count, 0::numeric) as monthly_unknown_price_count
  from keys k
  left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
  left join public.v_weekly_drop_income d on d.user_id = k.user_id and d.week_key = k.week_key
  left join public.v_weekly_unsold_drops u on u.user_id = k.user_id and u.week_key = k.week_key;

-- 10-b. 새 뷰의 기본 권한을 회수한다
-- ⚠️ 이 블록이 없으면 마지막 줄의 `assert_no_public_sensitive_columns()` 가 적용을 거부한다.
--    `20260819200000` 의 첫 적용이 정확히 여기서 실패했고, 그 실패가 정산 금액 유출을 막았다.
revoke all on public.v_run_share_weights      from anon, authenticated;
revoke all on public.v_run_crystal_settlement from anon, authenticated;
revoke all on public.v_run_drop_recipients    from anon, authenticated;
revoke all on public.v_run_drop_settlement    from anon, authenticated;
revoke all on public.v_weekly_drop_income     from anon, authenticated;
revoke all on public.v_weekly_income          from anon, authenticated;

grant select on public.v_run_share_weights      to service_role;
grant select on public.v_run_crystal_settlement to service_role;
grant select on public.v_run_drop_recipients    to service_role;
grant select on public.v_run_drop_settlement    to service_role;
grant select on public.v_weekly_drop_income     to service_role;
grant select on public.v_weekly_income          to service_role;


-- -----------------------------------------------------------------------------
-- 11. 자기검증 — 이행 전량 · 분배 해석 규칙 4가지 · 권한
-- -----------------------------------------------------------------------------
-- ★ 끝에서 **일부러 예외를 던져 되감는** 블록을 따로 둔다(마이그레이션 23·24 패턴).
--   탐침 행이 남지 않으므로 몇 번이든 다시 실행할 수 있다.
do $$
declare
  v_n     integer;
  v_txt   text;
begin
  -- (1) 파티마다 묶음이 하나 이상 있는가
  select count(*) into v_n
    from public.parties p
   where not exists (select 1 from public.party_bundles b where b.party_id = p.id);
  if v_n > 0 then
    raise exception '묶음이 없는 파티가 % 건 남았습니다.', v_n;
  end if;

  -- (2) party_bosses 전량이 옮겨졌는가 (순서·소요 시간까지 일치).
  --     **이번 실행의 이행 대상만** 본다 — 사용자가 이미 편집한 묶음은 과거(party_bosses)와
  --     다른 것이 정상이고, 그것을 결함이라고 부르면 재실행이 영영 실패한다.
  select count(*) into v_n
    from public.party_bosses pb
    join _party_bundle_backfill t on t.party_id = pb.party_id
    left join public.party_bundle_bosses pbb
      on pbb.bundle_id = t.bundle_id and pbb.boss_difficulty_id = pb.boss_difficulty_id
   where pbb.bundle_id is null
      or pbb.sort_order is distinct from pb.sort_order
      or pbb.duration_minutes is distinct from pb.duration_minutes;
  if v_n > 0 then
    raise exception 'party_bosses → party_bundle_bosses 이행이 % 건 어긋납니다.', v_n;
  end if;

  -- (2-b) 반대 방향 — 이행 대상 묶음에 **없던 보스가 생기지 않았는가**
  select count(*) into v_n
    from public.party_bundle_bosses pbb
    join _party_bundle_backfill t on t.bundle_id = pbb.bundle_id
    left join public.party_bosses pb
      on pb.party_id = t.party_id and pb.boss_difficulty_id = pbb.boss_difficulty_id
   where pb.id is null;
  if v_n > 0 then
    raise exception '이행 대상 묶음에 party_bosses 에 없는 보스가 % 건 들어갔습니다.', v_n;
  end if;

  -- (3) 참가 캐릭터 전량
  select count(*) into v_n
    from public.party_participants pp
    join _party_bundle_backfill t on t.party_id = pp.party_id
    left join public.party_bundle_characters pbc
      on pbc.bundle_id = t.bundle_id and pbc.participant_id = pp.id
   where pp.character_id is not null
     and (pbc.bundle_id is null or pbc.character_id is distinct from pp.character_id);
  if v_n > 0 then
    raise exception 'party_participants.character_id → party_bundle_characters 이행이 % 건 어긋납니다.', v_n;
  end if;

  -- (4) 모든 런이 묶음에 붙었는가
  select count(*) into v_n from public.party_runs where bundle_id is null;
  if v_n > 0 then
    raise exception '묶음이 붙지 않은 런이 % 건 남았습니다.', v_n;
  end if;

  -- (5) 묶음 비율은 **만들지 않았다**. 묶음이 비율을 들고 있으면 금액이 움직인다.
  select count(*) into v_n
    from public.party_bundle_shares bs
    join _party_bundle_backfill t on t.bundle_id = bs.bundle_id;
  if v_n > 0 then
    raise exception '이행 대상 묶음에 분배 비율이 % 건 생겼습니다 — 비율은 파티에 그대로 둬야 합니다.', v_n;
  end if;

  -- (5-b) 묶음은 전부 파티 상속(share_mode null) + 결정석 포함(true) 으로 출발했는가
  select count(*) into v_n
    from public.party_bundles b
    join _party_bundle_backfill t on t.bundle_id = b.id
   where b.share_mode is not null or b.crystal_follows_share is not true;
  if v_n > 0 then
    raise exception '이행 대상 묶음 % 건이 파티 상속/결정석 포함 기본값에서 벗어났습니다.', v_n;
  end if;

  -- (5-c) 보관된 **파티**의 묶음이 같이 보관되지 않았는가.
  --       보관 상태의 소유자는 `parties.archived_at` 하나다(7-1 머리말). 묶음까지 보관되면
  --       읽기 경로가 그 파티의 보스 목록을 **빈 배열로** 떨어뜨린다 — 적용 전에는 보였다.
  select count(*) into v_n
    from public.party_bundles b
    join _party_bundle_backfill t on t.bundle_id = b.id
    join public.parties p on p.id = b.party_id
   where p.archived_at is not null and b.archived_at is not null;
  if v_n > 0 then
    raise exception
      '보관된 파티의 묶음 % 건이 같이 보관됐습니다 — 보스 목록이 조용히 비어 보입니다.', v_n;
  end if;

  select count(*) into v_n from public.party_participants where share_bp is not null;
  raise notice '묶음 이행 완료 — 파티 비율 % 건은 party_participants 에 그대로 있습니다.', v_n;

  -- (6) 민감 컬럼 — 가드가 보는 것과 같은 판정을 여기서 먼저 말한다
  select string_agg(format('%s.%s', t.tbl, t.col), ', ') into v_txt
    from (values
      ('party_bundle_shares',     'share_bp'),
      ('party_bundles',           'share_mode'),
      ('party_bundles',           'crystal_follows_share'),
      ('party_bundle_characters', 'character_id')
    ) t(tbl, col)
   where has_column_privilege('anon',          format('public.%I', t.tbl), t.col, 'SELECT')
      or has_column_privilege('authenticated', format('public.%I', t.tbl), t.col, 'SELECT');
  if v_txt is not null then
    raise exception '분배/캐릭터 컬럼이 공개면에 노출되어 있습니다: %', v_txt;
  end if;
end
$$;

-- 분배 해석 규칙 — **값을 바꿔 보고 되감는다.** 라이브 데이터를 건드리지 않기 위해
-- 블록 끝에서 일부러 예외를 던진다.
do $$
declare
  v_run    uuid;
  v_bundle uuid;
  v_party  uuid;
  v_first  uuid;
  v_n      integer;
  v_cw     bigint;
  v_dw     bigint;
begin
  -- going 참가자가 2명 이상인 런을 고른다. 1명이면 균등/비율이 구분되지 않는다.
  select r.id, r.bundle_id, r.party_id into v_run, v_bundle, v_party
    from public.party_runs r
    join public.run_signups s on s.run_id = r.id and s.status = 'going'
   where r.bundle_id is not null
   group by r.id, r.bundle_id, r.party_id
  having count(*) >= 2
   limit 1;
  if v_run is null then
    raise notice '검증용 런(going 2명 이상)이 없어 분배 규칙 검증을 건너뜁니다.';
    return;
  end if;

  select w.participant_id into v_first
    from public.v_run_share_weights w where w.run_id = v_run
   order by w.member_no limit 1;

  -- (A) 상속: 묶음 share_mode = null 이면 파티 값을 따른다
  update public.parties set share_mode = 'auto_equal' where id = v_party;
  update public.party_bundles set share_mode = null, crystal_follows_share = true
   where id = v_bundle;
  select count(*) into v_n from public.v_run_share_weights
   where run_id = v_run and (crystal_weight <> 1 or drop_weight <> 1);
  if v_n > 0 then
    raise exception '(A) 파티가 auto_equal 인데 가중치가 1 이 아닌 행 % 건', v_n;
  end if;

  update public.parties set share_mode = 'manual' where id = v_party;
  update public.party_participants set share_bp = 7000 where id = v_first;
  select count(*) into v_n from public.v_run_share_weights
   where run_id = v_run and participant_id = v_first
     and crystal_weight = 7000 and drop_weight = 7000;
  if v_n <> 1 then
    raise exception '(A) 묶음 share_mode = null 인데 파티 manual 비율이 반영되지 않았습니다.';
  end if;

  -- (B) 묶음이 파티를 덮는다
  update public.party_bundles set share_mode = 'auto_equal' where id = v_bundle;
  select count(*) into v_n from public.v_run_share_weights
   where run_id = v_run and (crystal_weight <> 1 or drop_weight <> 1);
  if v_n > 0 then
    raise exception '(B) 묶음 auto_equal 이 파티 manual 을 덮지 못했습니다 (% 건).', v_n;
  end if;

  -- (C) 묶음 비율이 파티 비율을 덮는다
  update public.party_bundles set share_mode = 'manual' where id = v_bundle;
  insert into public.party_bundle_shares (bundle_id, participant_id, share_bp)
  values (v_bundle, v_first, 2500)
  on conflict (bundle_id, participant_id) do update set share_bp = 2500;
  select count(*) into v_n from public.v_run_share_weights
   where run_id = v_run and participant_id = v_first
     and crystal_weight = 2500 and drop_weight = 2500 and share_bp = 2500;
  if v_n <> 1 then
    raise exception '(C) 묶음 비율이 파티 비율을 덮지 못했습니다.';
  end if;

  -- (D) crystal_follows_share = false → **결정석만 균등**, 드랍은 비율 그대로
  update public.party_bundles set crystal_follows_share = false where id = v_bundle;
  select count(*) into v_n from public.v_run_share_weights
   where run_id = v_run and crystal_weight <> 1;
  if v_n > 0 then
    raise exception '(D) crystal_follows_share = false 인데 결정석 가중치가 1 이 아닌 행 % 건', v_n;
  end if;
  select count(*) into v_n from public.v_run_share_weights
   where run_id = v_run and participant_id = v_first and drop_weight = 2500;
  if v_n <> 1 then
    raise exception '(D) crystal_follows_share = false 가 드랍 가중치까지 균등으로 만들었습니다.';
  end if;

  -- (E) 같은 행에서 두 열이 실제로 다른 값인가 — 가른 것이 의미가 있는가
  select crystal_weight, drop_weight into v_cw, v_dw
    from public.v_run_share_weights
   where run_id = v_run and participant_id = v_first;
  if v_cw is distinct from 1 or v_dw is distinct from 2500 then
    raise exception '(E) 한 행의 결정석/드랍 가중치가 (1, 2500) 이 아닙니다 (%, %).', v_cw, v_dw;
  end if;

  raise notice '분배 해석 규칙 5항목(A~E) 통과 — 되감습니다.';
  raise exception 'ROLLBACK_PROBE';
exception
  when others then
    if sqlerrm = 'ROLLBACK_PROBE' then
      return;
    end if;
    raise;
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
select public.assert_no_public_sensitive_columns();
