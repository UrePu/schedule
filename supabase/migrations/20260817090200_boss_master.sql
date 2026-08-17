-- =============================================================================
-- M_Schedule · 02. 보스 마스터 / 별칭 / 결정석 가격
-- =============================================================================
-- ⚠️ **이 파일은 구조만 만든다. 시드 데이터는 넣지 않는다.**
--    보스 78개 엔트리와 결정석 가격은 Claude/research-BOSS-DATA.md 에 정리되어 있으며,
--    시드 투입은 별도 작업 단위다. 추측값을 넣으면 수익이 조용히 틀어진다.
--
-- 2단 구조:
--   bosses            = 보스 본체("스우", "자쿰"). research 문서의 `baseName` 에 대응.
--   boss_difficulties = 난이도별 실제 도전 단위("하드 스우"). research 문서의 한 행 = 여기 한 행.
--                       결정석 가격·파티 상한·입장 레벨·주기가 전부 이 단위에 붙는다.
--
-- 왜 2단인가:
--   * `cycle` 이 난이도마다 다르다. 이지/노멀 자쿰은 daily 인데 카오스 자쿰은 weekly 다.
--   * `max_party` 도 난이도마다 다르다. 하드 스우는 6인인데 **익스트림 스우는 2인**이다.
--   * 봇이 `스우` 처럼 난이도 없는 별칭을 받으면 후보가 여러 개임을 알아야 되물을 수 있다.
--
-- PK 를 uuid 가 아니라 **영문 slug(text)** 로 잡은 이유:
--   research-BOSS-DATA.md 가 `id` 를 "DB에 저장되는 키. 한 번 정하면 바꾸지 말 것"으로
--   못박았고, 우리가 직접 통제하는 값이라 변할 위험이 없다. 클리어 원장에 'lotus_hard' 가
--   그대로 보이는 편이 디버깅·시드·감사 모두에 유리하다.
--   (넥슨 ocid 를 PK 로 쓰지 않는 것과는 성격이 정반대다. ocid 는 넥슨이 바꿀 수 있는 값이다.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bosses — 보스 본체
-- -----------------------------------------------------------------------------
create table if not exists public.bosses (
  -- 우리가 정한 안정적 slug. 예: 'lotus', 'zakum'. **변경 금지.**
  id                 text primary key check (id ~ '^[a-z0-9][a-z0-9_]{0,49}$'),

  korean_name        text not null unique,

  -- 파티 상한이 세대별로 갈린다(classic 6 / modern 3). 개별 상한은 엔트리의 max_party 가 정답이고,
  -- 이 컬럼은 분류·표시·신규 보스 기본값 판단용이다.
  generation         public.boss_generation not null default 'classic',

  -- 넥슨 스케줄러 API `boss_contents[].content_name` 원문. 실호출로 수집해 채운다.
  nexon_content_name text unique,

  sort_order         integer not null default 1000,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.bosses is
  '보스 본체(난이도 무관). research-BOSS-DATA.md 의 baseName 에 대응.';
comment on column public.bosses.id is
  'DB **영구 키**. 한 번 저장되면 변경 불가. 시드 투입 전에 영문 slug 를 확정할 것.';
comment on column public.bosses.generation is
  'classic=구세대 6인 / modern=김창섭 체제 신세대 3인 / event=챌린저스 월드 등 수익 계산 격리 대상.';

create index if not exists bosses_sort_idx on public.bosses (sort_order, korean_name);

drop trigger if exists bosses_set_updated_at on public.bosses;
create trigger bosses_set_updated_at
  before update on public.bosses
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- boss_difficulties — 보스 × 난이도 (실제 도전 단위, research 문서의 한 행)
-- -----------------------------------------------------------------------------
create table if not exists public.boss_difficulties (
  -- 예: 'lotus_hard', 'lotus_extreme'. research-BOSS-DATA.md 의 `id` 와 동일. **변경 금지.**
  id               text primary key check (id ~ '^[a-z0-9][a-z0-9_]{0,59}$'),
  boss_id          text not null references public.bosses(id) on delete restrict,

  -- 난이도를 포함한 한글 표기. 예: '하드 스우'. UI·봇 응답에 그대로 쓴다.
  korean_name      text not null,
  difficulty       public.boss_difficulty_tier not null,
  cycle            public.boss_cycle not null,

  -- 파티 인원 상한. **소프트 상한이다 (CLAUDE.md §1.3 D5).**
  -- 6인 값 대부분은 보스별 1차 출처가 아니라 세대 규칙에서 유도한 값이고(개별 확인 11건뿐),
  -- 실제 파티가 이 값을 넘는데 입력이 막히면 그게 더 나쁘다.
  -- → DB 는 막지 않는다. 초과는 애플리케이션이 **경고**로 처리한다.
  -- 익스트림 스우 2 / 신세대 3 은 개별 확인되어 신뢰도가 높다.
  max_party        integer not null default 6 check (max_party between 1 and 24),

  entry_level      integer check (entry_level between 1 and 500),

  -- 라이브 서버 출시 여부. 미출시(벨로나 3종)·난이도 통합으로 사라진 항목(cygnus_easy)은
  -- **행을 지우지 않고** false 로 내려 과거 기록을 보존한다.
  released         boolean not null default false,

  -- 넥슨 API `boss_contents[].difficulty` 원문(자유 문자열). 매핑 실패 감지에 쓴다.
  nexon_difficulty text,

  sort_order       integer not null default 1000,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint boss_difficulties_boss_difficulty_uniq unique (boss_id, difficulty),
  -- boss_aliases 가 (엔트리, 보스) 정합성을 복합 FK 로 검증할 수 있게 열어둔다.
  constraint boss_difficulties_id_boss_uniq unique (id, boss_id)
);

comment on table public.boss_difficulties is
  '보스 × 난이도. 결정석 가격·파티 상한·입장 레벨·초기화 주기가 붙는 실제 도전 단위. PK 는 영문 slug.';
comment on column public.boss_difficulties.max_party is
  '파티 인원 **소프트** 상한(CLAUDE.md §1.3 D5). 대부분 세대 규칙에서 유도한 값이라 DB 로 막지 않고 앱이 경고만 한다.';
comment on column public.boss_difficulties.id is
  'DB **영구 키**. 한 번 저장되면 변경 불가 — 시드 투입 전에 영문 slug 를 확정해야 한다(예: 찬란한 흉성은 radiant_malefic_star 가 실제 영문명).';
comment on column public.boss_difficulties.cycle is
  '초기화 주기. 패치로 바뀔 수 있다(2026-06-18 하드 힐라·카오스 핑크빈·노멀 시그너스 주간→일간).';
comment on column public.boss_difficulties.released is
  '미출시/폐지 엔트리는 행을 지우지 않고 false 로 둔다. 과거 클리어 기록을 보존하기 위해서다.';

create index if not exists boss_difficulties_boss_idx
  on public.boss_difficulties (boss_id, sort_order);

-- 등록 UI/봇이 쓰는 목록: 주기별 + 출시된 것만
create index if not exists boss_difficulties_cycle_idx
  on public.boss_difficulties (cycle, sort_order)
  where released;

drop trigger if exists boss_difficulties_set_updated_at on public.boss_difficulties;
create trigger boss_difficulties_set_updated_at
  before update on public.boss_difficulties
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- boss_aliases — 별칭 → 보스(+선택적 난이도)
-- -----------------------------------------------------------------------------
-- research-KAKAO-BOT §2.10: 별칭은 **코드에 하드코딩하지 않는다.**
-- boss_difficulty_id 가 null 이면 난이도 미지정 별칭('스우')이고, 봇은 후보가 2개 이상이면
-- 되묻는다. 채워져 있으면 곧바로 특정된다('하스우').
create table if not exists public.boss_aliases (
  id                 uuid primary key default gen_random_uuid(),
  boss_id            text not null references public.bosses(id) on delete cascade,
  boss_difficulty_id text,

  alias              text not null check (length(btrim(alias)) between 1 and 40),

  -- 매칭용 정규화 문자열(소문자·공백제거 등). 정규화 규칙은 앱 로직이고 바뀔 수 있어
  -- 생성 컬럼으로 굳히지 않는다.
  normalized_alias   text not null check (normalized_alias = lower(btrim(normalized_alias))),

  source             text not null default 'manual',
  created_at         timestamptz not null default now(),

  -- 엔트리가 지정되면 그 엔트리는 반드시 이 보스의 것이어야 한다.
  constraint boss_aliases_entry_belongs_to_boss
    foreign key (boss_difficulty_id, boss_id)
    references public.boss_difficulties (id, boss_id)
    on delete cascade
);

comment on table public.boss_aliases is
  '보스 별칭 → 보스(+선택 난이도) 매핑. 카톡 봇 파서가 사용하며 코드 하드코딩을 금지한다.';
comment on column public.boss_aliases.boss_difficulty_id is
  'null 이면 난이도 미지정 별칭. 봇은 후보가 여러 개면 되묻는다(research-KAKAO-BOT §2.4).';

-- 같은 별칭 문자열이 서로 다른 대상을 가리키면 조용히 엉뚱한 보스에 등록된다.
-- 난이도까지 특정된 별칭은 전역 유일해야 하고, 난이도 미지정 별칭도 보스별로 유일해야 한다.
create unique index if not exists boss_aliases_normalized_uniq
  on public.boss_aliases (normalized_alias)
  where boss_difficulty_id is not null;

create unique index if not exists boss_aliases_normalized_group_uniq
  on public.boss_aliases (normalized_alias, boss_id)
  where boss_difficulty_id is null;

create index if not exists boss_aliases_boss_idx on public.boss_aliases (boss_id);

-- -----------------------------------------------------------------------------
-- boss_crystal_prices — 결정석 기본가 (효력기간형)
-- -----------------------------------------------------------------------------
-- 가격은 **솔로(1인) 기준 기본가**다. 실제 수령액은 입장 파티 인원으로 나눈 값이며
-- 그 계산은 boss_clears 에서 한다(R1: floor(기본가 / 파티인원)).
--
-- research-BOSS-DATA.md 의 상수표를 그대로 담되 **효력기간형**으로 둔 이유:
--   가격은 패치로만 바뀌고(R6: 시세 변동 시스템은 2024-01-04부터 중단), 실제로
--   2026-06-18 패치에서 52개 항목이 조정됐다. 이력을 남겨야 "그 시점 가격"을 재구성할 수 있다.
--
-- ⚠️ price_meso 는 **nullable** 이다. `null` 은 0 이 아니라 **미확인**이다.
--    (노멀 벨로나처럼 출처가 엇갈려 확정하지 못한 값이 실제로 존재한다)
create table if not exists public.boss_crystal_prices (
  id                 uuid primary key default gen_random_uuid(),
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete cascade,

  -- 솔로 기준 기본가(메소). 부동소수점 금지. null = 미확인.
  price_meso         bigint check (price_meso is null or price_meso >= 0),

  effective_from     timestamptz not null default now(),

  -- 가격 근거 패치. 예: '1.2.202 (2026-06-18)'
  patch_label        text,
  note               text,
  created_at         timestamptz not null default now(),

  constraint boss_crystal_prices_uniq unique (boss_difficulty_id, effective_from)
);

comment on table public.boss_crystal_prices is
  '보스별 결정석 기본가(솔로 기준, 효력기간형). null 가격은 0 이 아니라 "미확인"이다. 과거 수익은 boss_clears 스냅샷을 쓰므로 여기 값이 바뀌어도 소급되지 않는다.';
comment on column public.boss_crystal_prices.price_meso is
  '솔로 1인 입장 기준 기본가. 실수령액은 floor(price_meso / party_size) 이며 boss_clears 에 스냅샷된다.';

create index if not exists boss_crystal_prices_lookup_idx
  on public.boss_crystal_prices (boss_difficulty_id, effective_from desc);

-- 특정 시점에 유효한 기본가 1건. 클리어 스냅샷 생성에 쓴다.
-- 행이 없거나 price_meso 가 null 이면 "미확인"이며, 호출부는 이를 0 과 구분해야 한다.
create or replace function public.current_crystal_price(
  p_boss_difficulty_id text,
  p_at timestamptz default now()
)
returns table (price_id uuid, price_meso bigint)
language sql
stable
parallel safe
as $func$
  select p.id, p.price_meso
  from public.boss_crystal_prices p
  where p.boss_difficulty_id = p_boss_difficulty_id
    and p.effective_from <= p_at
  order by p.effective_from desc
  limit 1;
$func$;

comment on function public.current_crystal_price(text, timestamptz) is
  '해당 시점에 유효한 결정석 기본가. 결과가 없거나 price_meso 가 null 이면 미확인이다.';

-- -----------------------------------------------------------------------------
-- 결정석 판매 제한 상수
-- -----------------------------------------------------------------------------
-- 숫자를 뷰·트리거에 흩뿌리지 않고 한 곳에 둔다. 패치로 바뀌면 여기만 고친다.
create or replace function public.weekly_crystal_sell_limit()
returns integer language sql immutable parallel safe as $func$ select 12 $func$;

comment on function public.weekly_crystal_sell_limit() is
  '주간 결정 판매 한도(캐릭터당 주 12개). 2025-08-21 패치로 13번째 주간 보스는 입장 자체가 차단되므로 실무상 절삭은 거의 발생하지 않는다 — 집계의 방어 상한으로 쓴다.';

create or replace function public.world_crystal_sell_limit()
returns integer language sql immutable parallel safe as $func$ select 90 $func$;

comment on function public.world_crystal_sell_limit() is
  '월드당 주간 결정 판매 총량(일간+주간+월간 합산 90개). 주체가 계정 단위인지 미확인이라 강제하지 않고 모니터링 지표로만 쓴다.';
