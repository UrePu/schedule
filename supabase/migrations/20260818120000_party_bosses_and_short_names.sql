-- =============================================================================
-- M_Schedule · 22. 파티가 보스 목록을 갖는다 (party_bosses) + 보스 줄임말(short_name)
-- =============================================================================
-- 발주자 원문(2026-08-18):
--   "애초에 파티 생성을할때 보스를 정해두고 하니. 파티 정보 자체에 보스가 등록된다.
--    같은 파티에 보스가 여러개 있을수도있고 추가될수도있고 삭제될수도있다. 보통 묶어서
--    가니 파티안에 보스를 여러개 등록 하고 시간 등록할때 등록된 보스를 체크해서 시간대를
--    등록하게 만들어. 그다음 한번 생성된 묶음은 보스 이미지, 이름 줄임말(앞글자
--    익스트림세렌 = 익세 ) 로 줄여서 만약 익스 세렌 , 하드대적자 , 하드 카링을 2명이서
--    하면 묶음 제목이 익세 하대 하카 2인 이 되는거임."
--
-- ── 무엇이 없어서 이 마이그레이션이 필요한가 ───────────────────────────────
--   · `parties` 에는 보스 목록이 없다(마이그레이션 03). 이름·설명·공개범위·world_name·
--     default_capacity 뿐이다. → 새 테이블 `party_bosses` 가 필요하다.
--   · `party_runs` 는 **보스 1개 + 시각**이다. 묶음으로 등록하면 런이 N개 생긴다.
--     그건 옳다 — 겹쳐보기 화면의 막대는 "언제 무엇을"이므로 익세 21:00 / 하대 21:30 /
--     하카 22:00 이 각각 한 줄이어야 한다. `party_bosses` 는 **계획(무엇을 묶어서 도는가)**,
--     `party_runs` 는 **실행(언제 그것을 도는가)** 이고 역할이 겹치지 않는다.
--   · 줄임말이 어디에도 없다. → `boss_difficulties.short_name`.
--
-- ── 줄임말을 **컬럼으로** 두는 이유 (런타임 규칙 추론 금지) ────────────────
-- 대부분은 "난이도 첫 글자 + 보스 이름 마지막 단어 첫 글자"로 맞는다
-- (익스트림 선택받은 **세**렌 → 익세 · 하드 최초의 **대**적자 → 하대 · 하드 **카**링 → 하카).
-- 하지만 규칙 자체가 안전하지 않다:
--   ① `검은 마법사` 는 규칙대로면 `익마` 인데 실제로는 `익검마`/`검마` 라고 부른다.
--   ② `하드 진 힐라` 와 `하드 힐라` 가 둘 다 `하힐` 로 **충돌한다.**
--   ③ `노멀 벨룸` 과 `노멀 벨로나`, `노멀 카웅` 과 `노멀 카링` 도 같은 충돌이다.
-- 런타임에 규칙으로 추측하면 이 예외들을 고칠 방법이 영영 없다. 그래서 규칙은 **시드
-- 초기값을 만드는 데만** 쓰고, 안 맞는 것은 아래 시드에서 개별 교정한다(주석 ★ 표시).
--
-- ★ 별칭(`boss_aliases`)에서 파생시키지 않았다. 별칭은 **다대일**이고 표시용 정식
--   줄임말과 다르다. "가장 짧은 별칭"을 고르면 `하드 최초의 대적자` 는 `하적자` 가 나와
--   원하는 `하대` 가 되지 않는다.
--
-- ── 제목 자동 생성은 **앱(TS)** 이 한다 ────────────────────────────────────
-- `src/lib/domain/party-title.ts` 한 곳이 `줄임말 join(' ') + 정원 + '인'` 을 만든다.
-- SQL 에도 같은 함수를 두면 구현이 두 벌이 되고, 카톡 봇도 결국 우리 TS 서버
-- (`POST /api/bot/command`, CLAUDE.md §2.2)를 지나므로 SQL 판이 필요해지지 않는다.
-- DB 는 **재료**(short_name, party_bosses, default_capacity)만 갖는다.
--
-- ── 사용자가 고친 제목을 자동 생성이 덮지 않게 ─────────────────────────────
-- `parties.name_is_custom` 이 그 한 비트다. false 면 보스/정원이 바뀔 때 제목이 따라
-- 바뀌고, true 면 앱이 이름에 손대지 않는다. **기존 파티는 전부 true 로 백필한다** —
-- 이미 지어진 이름을 이 마이그레이션이 조용히 갈아치우면 안 된다.
--
-- 넥슨 API 호출 없음. 추가(additive)만 하며 기존 컬럼·데이터를 바꾸지 않는다.
-- `20260818110000_boss_plan_party_size.sql` 과 **독립**이다 — 그 파일이 만든 객체를
-- 하나도 참조하지 않으므로 적용 순서가 어느 쪽이어도 된다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 22-1. boss_difficulties.short_name — 표시용 정식 줄임말
-- -----------------------------------------------------------------------------
alter table public.boss_difficulties
  add column if not exists short_name text;

-- `add constraint if not exists` 는 PostgreSQL 에 없다. 이 저장소의 모든 마이그레이션은
-- **재실행 안전**이 불변식이므로 pg_constraint 를 직접 본다.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname  = 'boss_difficulties_short_name_shape'
       and conrelid = 'public.boss_difficulties'::regclass
  ) then
    alter table public.boss_difficulties
      add constraint boss_difficulties_short_name_shape
      check (
        short_name is null
        or (short_name = btrim(short_name) and length(short_name) between 1 and 12)
      );
  end if;
end
$$;

comment on column public.boss_difficulties.short_name is
  '표시용 정식 줄임말(익세 · 하대 · 하카). 파티 묶음 제목·목록 칩·카톡 평문에 쓴다. '
  '규칙(난이도 첫 글자 + 보스명 마지막 단어 첫 글자)은 시드 초기값을 만드는 데만 쓰였고 '
  '충돌·관용 표기는 시드에서 개별 교정했다. **런타임에 규칙으로 추론하지 말 것.** '
  'null 은 미지정이며 앱은 korean_name 전체를 대신 보여 준다(0/빈 문자열이 아니다).';

-- 줄임말은 화면에서 보스를 **가리키는 이름**이라 겹치면 안 된다.
-- 값이 있는 행만 대상으로 하는 부분 유니크 인덱스.
create unique index if not exists boss_difficulties_short_name_uniq
  on public.boss_difficulties (short_name)
  where short_name is not null;


-- -----------------------------------------------------------------------------
-- 22-2. 줄임말 시드 (78 = 일간 24 · 주간 52 · 월간 2)
-- -----------------------------------------------------------------------------
-- 규칙: **난이도 첫 글자 + 보스 이름 마지막 단어 첫 글자.**
--   이지 → 이 · 노멀 → 노 · 카오스 → 카 · 하드 → 하 · 익스트림 → 익
--   선택받은 세렌 → 세 · 최초의 대적자 → 대 · 감시자 칼로스 → 칼 · 진 힐라 → 힐
--   가디언 엔젤 슬라임 → 슬 · 찬란한 흉성 → 흉 · 반 레온 → 레
--
-- ★ 로 표시한 6건은 규칙 결과가 충돌하거나 관용 표기와 달라 **개별 교정**했다.
--   충돌 해소 원칙: 이 앱의 무대는 주간·월간이므로 **주간 쪽이 짧은 정식형을 갖고**
--   일간 쪽을 늘린다. 단 `진 힐라` 는 반대다 — `하힐` 을 진힐라에 주면 플레이어가
--   일간 하드 힐라로 읽는다. 관용 표기(`하진힐`)가 이미 명확하므로 그것을 쓴다.
update public.boss_difficulties bd
   set short_name = v.short_name
  from (values
    -- ── 일간 24 ───────────────────────────────────────────────────────────
    ('zakum_easy',                    '이자'),
    ('zakum_normal',                  '노자'),
    ('papulatus_easy',                '이파'),
    ('magnus_easy',                   '이매'),
    ('hilla_normal',                  '노힐'),
    ('horntail_easy',                 '이혼'),
    ('bloody_queen_normal',           '노블'),
    ('von_bon_normal',                '노반'),
    ('pierre_normal',                 '노피'),
    ('vellum_normal',                 '노벨룸'),   -- ★ 규칙은 `노벨`. 노멀 벨로나(주간)와 충돌해 일간 쪽을 늘렸다.
    ('horntail_normal',               '노혼'),
    ('von_leon_easy',                 '이레'),
    ('arkarium_easy',                 '이아'),
    ('kaung_normal',                  '노카웅'),   -- ★ 규칙은 `노카`. 노멀 카링(주간)과 충돌해 일간 쪽을 늘렸다.
    ('horntail_chaos',                '카혼'),
    ('pink_bean_normal',              '노핑'),
    ('von_leon_normal',               '노레'),
    ('von_leon_hard',                 '하레'),
    ('arkarium_normal',               '노아'),
    ('magnus_normal',                 '노매'),
    ('papulatus_normal',              '노파'),
    ('hilla_hard',                    '하힐'),
    ('pink_bean_chaos',               '카핑'),
    ('cygnus_normal',                 '노시'),

    -- ── 주간 52 ───────────────────────────────────────────────────────────
    ('zakum_chaos',                   '카자'),
    ('bloody_queen_chaos',            '카블'),
    ('von_bon_chaos',                 '카반'),
    ('pierre_chaos',                  '카피'),
    ('magnus_hard',                   '하매'),
    ('vellum_chaos',                  '카벨'),
    ('papulatus_chaos',               '카파'),
    ('lotus_normal',                  '노스'),
    ('damien_normal',                 '노데'),
    ('guardian_angel_slime_normal',   '노슬'),
    ('lucid_easy',                    '이루'),
    ('will_easy',                     '이윌'),
    ('lucid_normal',                  '노루'),
    ('will_normal',                   '노윌'),
    ('dusk_normal',                   '노더'),
    ('dunkel_normal',                 '노듄'),
    ('damien_hard',                   '하데'),
    ('lotus_hard',                    '하스'),
    ('lucid_hard',                    '하루'),
    ('dusk_chaos',                    '카더'),
    ('verus_hilla_normal',            '노진힐'),   -- ★ 규칙은 `노힐`. 노멀 힐라(일간)와 충돌 + 관용 표기가 `진힐`.
    ('guardian_angel_slime_chaos',    '카슬'),
    ('will_hard',                     '하윌'),
    ('dunkel_hard',                   '하듄'),
    ('verus_hilla_hard',              '하진힐'),   -- ★ 규칙은 `하힐`. 하드 힐라(일간)와 충돌 + 관용 표기가 `하진힐`.
    ('seren_normal',                  '노세'),
    ('kalos_easy',                    '이칼'),
    ('first_adversary_easy',          '이대'),
    ('seren_hard',                    '하세'),
    ('kaling_easy',                   '이카'),
    ('bellona_easy',                  '이벨'),
    ('kalos_normal',                  '노칼'),
    ('first_adversary_normal',        '노대'),
    ('lotus_extreme',                 '익스'),
    ('radiant_malefic_star_normal',   '노흉'),
    ('kaling_normal',                 '노카'),
    ('bellona_normal',                '노벨'),
    ('limbo_normal',                  '노림'),
    ('kalos_chaos',                   '카칼'),
    ('baldrix_normal',                '노발'),
    ('first_adversary_hard',          '하대'),
    ('jupiter_normal',                '노유'),
    ('kaling_hard',                   '하카'),
    ('limbo_hard',                    '하림'),
    ('radiant_malefic_star_hard',     '하흉'),
    ('seren_extreme',                 '익세'),
    ('bellona_hard',                  '하벨'),
    ('baldrix_hard',                  '하발'),
    ('kalos_extreme',                 '익칼'),
    ('first_adversary_extreme',       '익대'),
    ('jupiter_hard',                  '하유'),
    ('kaling_extreme',                '익카'),

    -- ── 월간 2 ────────────────────────────────────────────────────────────
    ('black_mage_hard',               '하검마'),   -- ★ 규칙은 `하마`. 실제 호칭은 `검마` 계열이다.
    ('black_mage_extreme',            '익검마')    -- ★ 규칙은 `익마`. 실제 호칭은 `익검마`.
  ) as v(id, short_name)
 where bd.id = v.id
   and bd.short_name is distinct from v.short_name;


-- -----------------------------------------------------------------------------
-- 22-3. parties.name_is_custom — 사람이 정한 제목인가
-- -----------------------------------------------------------------------------
-- false = 자동 제목(보스 줄임말 + 정원). 보스/정원이 바뀌면 앱이 다시 만든다.
-- true  = 사람이 직접 적은 제목. **앱이 절대 덮지 않는다.**
--
-- 컬럼 추가와 백필을 한 do 블록에 묶은 이유: 백필을 따로 두면 재실행 시 방금 자동
-- 제목으로 만들어진 파티까지 custom 으로 뒤집는다. "컬럼이 없을 때 한 번만" 이어야 한다.
do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'parties'
       and column_name  = 'name_is_custom'
  ) then
    alter table public.parties
      add column name_is_custom boolean not null default false;

    -- 이미 존재하는 파티의 이름은 전부 "사람이 정한 것"으로 본다.
    -- 이 마이그레이션이 남의 파티 이름을 조용히 갈아치우는 일은 없어야 한다.
    update public.parties set name_is_custom = true;
  end if;
end
$$;

comment on column public.parties.name_is_custom is
  'true = 사람이 직접 적은 제목이라 자동 생성이 덮지 않는다. false = 보스 줄임말+정원으로 만든 '
  '자동 제목이라 보스 목록·정원이 바뀌면 따라 바뀐다. 제목 조합 규칙의 주인은 '
  'src/lib/domain/party-title.ts 하나다.';


-- -----------------------------------------------------------------------------
-- 22-4. party_bosses — 파티에 등록된 보스 목록
-- -----------------------------------------------------------------------------
-- ★ 순서를 갖는다. `익세 하대 하카` 가 매번 다른 차례로 나오면 제목이 흔들리고,
--   연달아 도는 순서(= 런 배치 순서)도 여기서 나온다.
-- ★ `on delete restrict` 는 보스 마스터를 지우지 못하게 한다 — party_runs 와 같은 정책.
create table if not exists public.party_bosses (
  id                 uuid primary key default gen_random_uuid(),
  party_id           uuid not null references public.parties(id) on delete cascade,
  boss_difficulty_id text not null references public.boss_difficulties(id) on delete restrict,

  -- 표시·배치 순서. 1부터 촘촘하게 매긴다(set_party_bosses 가 다시 매긴다).
  -- ⚠️ 이것은 `member_no` / `run_no` 같은 **관리 번호가 아니다**(§1.4). 관리 번호는
  --    대화에서 사람을 가리키는 이름이라 재배열 금지지만, 보스 순서는 표시용이라
  --    사용자가 자유롭게 바꿔도 된다. 대신 **바꾸면 제목이 따라 바뀐다** —
  --    화면이 그 사실을 말해 준다.
  sort_order         integer not null default 1 check (sort_order between 1 and 24),

  created_at         timestamptz not null default now(),

  -- 같은 보스를 한 파티에 두 번 등록할 수 없다.
  constraint party_bosses_uniq unique (party_id, boss_difficulty_id)
);

comment on table public.party_bosses is
  '파티에 등록된 보스 목록(계획). "이 묶음은 익세→하대→하카를 연달아 돈다"를 표현한다. '
  '시각이 붙은 실행은 party_runs 이며 역할이 겹치지 않는다.';
comment on column public.party_bosses.sort_order is
  '표시·연속 배치 순서(1부터). 관리 번호가 아니라 표시 순서이므로 재배열해도 된다 — '
  '다만 파티 제목이 이 순서를 따라간다.';

-- 파티 상세: 파티 × 순서
create index if not exists party_bosses_party_idx
  on public.party_bosses (party_id, sort_order);

-- FK 인덱스(마이그레이션 15 의 규칙과 같은 이유 — 보스 마스터 삭제 검사·역방향 조회).
create index if not exists party_bosses_boss_idx
  on public.party_bosses (boss_difficulty_id);


-- -----------------------------------------------------------------------------
-- 22-5. RLS — **party_runs 와 똑같은 판정**을 쓴다
-- -----------------------------------------------------------------------------
-- 새 판정을 발명하면 공개 파티의 보스가 새거나 반대로 안 보인다. 공개 범위를 정하는
-- 곳은 오직 `parties.visibility = 'public'` 한 군데다(마이그레이션 08 머리말).
-- visibility='link' 는 슬러그가 곧 비밀이라 RLS 로 표현할 수 없고, Route Handler 가
-- 토큰을 검증한 뒤 service role 로 서빙한다 — 그래서 여기 정책에도 등장하지 않는다.
alter table public.party_bosses enable row level security;
revoke all on table public.party_bosses from anon;
revoke all on table public.party_bosses from authenticated;
grant select on table public.party_bosses to anon;
grant select on table public.party_bosses to authenticated;
grant all on table public.party_bosses to service_role;

drop policy if exists party_bosses_public_select on public.party_bosses;
create policy party_bosses_public_select on public.party_bosses
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.parties p
      where p.id = party_bosses.party_id
        and p.visibility = 'public'
        and p.archived_at is null
    )
  );

drop policy if exists party_bosses_no_public_insert on public.party_bosses;
create policy party_bosses_no_public_insert on public.party_bosses
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists party_bosses_no_public_update on public.party_bosses;
create policy party_bosses_no_public_update on public.party_bosses
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists party_bosses_no_public_delete on public.party_bosses;
create policy party_bosses_no_public_delete on public.party_bosses
  as permissive for delete to anon, authenticated using (false);

drop policy if exists party_bosses_service_role_all on public.party_bosses;
create policy party_bosses_service_role_all on public.party_bosses
  as permissive for all to service_role using (true) with check (true);


-- -----------------------------------------------------------------------------
-- 22-6. set_party_bosses — 목록 전체 교체 (원자적)
-- -----------------------------------------------------------------------------
-- 앱에서 delete → insert 두 번 왕복하면 그 사이에 실패했을 때 **파티의 보스가 통째로
-- 사라진다.** 한 함수 안에서 하면 트랜잭션이 그것을 막아 준다.
--
-- ★ 권한 판정은 여기서 하지 않는다. 이 저장소의 쓰기는 전부 Route Handler(세션 확인)
--   → repo(파티 구성원 확인) → service_role 이고, DB 함수는 그 마지막 칸이다.
--   그래서 anon/authenticated 에게서 실행 권한을 회수한다(아래 grant 블록).
-- ★ 중복 입력은 **조용히 접는다.** 같은 보스를 두 번 체크한 것은 사용자의 실수이지
--   거절할 사건이 아니고, unique 제약이 어차피 막는다.
-- ★ 없는 보스 id 는 INSERT 의 FK 가 잡는다(foreign_key_violation) — 앱이 400 으로 접는다.
create or replace function public.set_party_bosses(
  p_party_id           uuid,
  p_boss_difficulty_ids text[]
)
returns setof public.party_bosses
language plpgsql
set search_path = public, pg_temp
as $func$
declare
  v_ids text[] := coalesce(p_boss_difficulty_ids, '{}'::text[]);
  v_len integer := coalesce(array_length(v_ids, 1), 0);
begin
  if v_len > 24 then
    raise exception '파티에 등록할 수 있는 보스는 24개까지입니다 (입력 %개).', v_len
      using errcode = 'check_violation';
  end if;

  delete from public.party_bosses where party_id = p_party_id;

  if v_len > 0 then
    insert into public.party_bosses (party_id, boss_difficulty_id, sort_order)
    select p_party_id,
           d.id,
           (row_number() over (order by d.ord))::integer
      from (
        select u.id, min(u.ord) as ord
          from unnest(v_ids) with ordinality as u(id, ord)
         where btrim(u.id) <> ''
         group by u.id
      ) d;
  end if;

  return query
    select pb.*
      from public.party_bosses pb
     where pb.party_id = p_party_id
     order by pb.sort_order, pb.boss_difficulty_id;
end;
$func$;

comment on function public.set_party_bosses(uuid, text[]) is
  '파티의 보스 목록을 배열 순서대로 통째로 교체한다(원자적). 중복은 접고 sort_order 는 1부터 '
  '다시 매긴다. 권한 판정은 하지 않는다 — 호출 전에 앱이 파티 구성원임을 확인한다.';

revoke all on function public.set_party_bosses(uuid, text[]) from public;
revoke all on function public.set_party_bosses(uuid, text[]) from anon;
revoke all on function public.set_party_bosses(uuid, text[]) from authenticated;
grant execute on function public.set_party_bosses(uuid, text[]) to service_role;


-- -----------------------------------------------------------------------------
-- 22-7. 자기검증 — 시드 전수 + 중복 + 테이블 동작
-- -----------------------------------------------------------------------------
-- 줄임말은 화면에서 보스를 가리키는 이름이라 **빠짐이나 중복이 있으면 사고**다.
-- 부분 유니크 인덱스가 중복을 막지만, "전부 채워졌는가"는 인덱스가 답하지 않는다.
do $$
declare
  v_missing text;
  v_dup     text;
  v_user    uuid;
  v_party   uuid;
  v_rows    integer;
  v_order   text;
begin
  -- (1) 주간·월간 54개에 줄임말이 전부 붙었는가 (앱의 무대)
  select string_agg(id, ', ' order by id) into v_missing
    from public.boss_difficulties
   where cycle in ('weekly', 'monthly')
     and short_name is null;
  if v_missing is not null then
    raise exception '주간/월간 보스에 줄임말이 없습니다: %', v_missing;
  end if;

  -- (2) 일간까지 포함해 78개 전부 (파티가 일간 보스를 넣는 것을 막지 않으므로)
  --
  -- ⚠️ 여기는 **exception 이 아니라 warning** 이다. 앱의 무대는 (1) 이 이미 강제했고,
  --    나중에 패치로 보스 엔트리가 하나 늘었을 때 이 마이그레이션이 통째로 실패하면
  --    그 시점에 아무 관련 없는 배포가 막힌다. 줄임말이 없으면 앱은 보스 전체 이름으로
  --    떨어질 뿐 죽지 않는다(`schedule-repo.toBossEntry`).
  select string_agg(id, ', ' order by id) into v_missing
    from public.boss_difficulties
   where short_name is null;
  if v_missing is not null then
    raise warning '줄임말이 비어 있는 보스가 있습니다(전체 이름으로 표시됩니다): %', v_missing;
  end if;

  -- (3) 중복 없음
  select string_agg(short_name, ', ' order by short_name) into v_dup
    from (
      select short_name
        from public.boss_difficulties
       where short_name is not null
       group by short_name
      having count(*) > 1
    ) x;
  if v_dup is not null then
    raise exception '줄임말이 중복됩니다: %', v_dup;
  end if;

  -- (4) 발주자 예시가 실제로 나오는가
  if (select short_name from public.boss_difficulties where id = 'seren_extreme') <> '익세' then
    raise exception '익스트림 선택받은 세렌의 줄임말이 익세가 아닙니다.';
  end if;
  if (select short_name from public.boss_difficulties where id = 'first_adversary_hard') <> '하대' then
    raise exception '하드 최초의 대적자의 줄임말이 하대가 아닙니다.';
  end if;
  if (select short_name from public.boss_difficulties where id = 'kaling_hard') <> '하카' then
    raise exception '하드 카링의 줄임말이 하카가 아닙니다.';
  end if;

  -- (5) party_bosses 왕복 — 교체·중복접기·순서 재부여
  insert into public.app_users (display_name) values ('__migration22_probe__')
    returning id into v_user;
  insert into public.parties (owner_user_id, name, visibility, default_capacity)
    values (v_user, '__migration22_probe__', 'private', 2)
    returning id into v_party;

  -- 집합 반환 함수는 `perform ... from` 형태로 부른다(select 목록에 두는 형태보다 안전).
  perform *
     from public.set_party_bosses(
            v_party,
            array['seren_extreme', 'first_adversary_hard', 'kaling_hard', 'seren_extreme']
          );

  select count(*) into v_rows from public.party_bosses where party_id = v_party;
  if v_rows <> 3 then
    raise exception '중복이 접히지 않았습니다 (행 %개).', v_rows;
  end if;

  select string_agg(bd.short_name, ' ' order by pb.sort_order) into v_order
    from public.party_bosses pb
    join public.boss_difficulties bd on bd.id = pb.boss_difficulty_id
   where pb.party_id = v_party;
  if v_order <> '익세 하대 하카' then
    raise exception '보스 순서가 입력 순서를 따르지 않습니다 (%).', v_order;
  end if;

  -- 빈 배열이면 전부 지워진다
  perform * from public.set_party_bosses(v_party, array[]::text[]);
  select count(*) into v_rows from public.party_bosses where party_id = v_party;
  if v_rows <> 0 then
    raise exception '빈 배열 교체 후에도 행이 남았습니다 (%개).', v_rows;
  end if;

  -- 새 파티는 name_is_custom 이 false 로 태어난다(자동 제목 대상)
  if (select name_is_custom from public.parties where id = v_party) then
    raise exception '새 파티의 name_is_custom 이 true 입니다.';
  end if;

  delete from public.app_users where id = v_user;

  raise notice '22. party_bosses + short_name 자기검증 6항목 전부 통과';
end
$$;


-- -----------------------------------------------------------------------------
-- 22-8. 최초의 대적자 별칭 보강 — `대` 계열 · `쌀` 계열
-- -----------------------------------------------------------------------------
-- 발주자 원문(2026-08-18): "하드 대적자 줄임말에 하대 하쌀 이런것도 넣어줘"
--
-- ── 22-2 에서 `하대` 를 넣었는데 왜 또 필요한가 ────────────────────────────
-- 22-2 의 `short_name` 은 **표시용 이름**이지 검색어가 아니다. 검색이 훑는 건초더미는
-- 화면마다 다르고(`matchesBoss`), 보스 계획 화면은 `short_name` 을 아예 보지 않는다.
-- 카톡 봇의 별칭 해석(§2.2)은 처음부터 `boss_aliases` 만 본다. 검색어로 쓰이려면
-- **별칭 테이블에 있어야 한다.**
--
-- ── 하드만 넣지 않는 이유 ──────────────────────────────────────────────────
-- 발주자는 하드를 예로 들었지만 같은 축약이 4난이도에 그대로 적용된다. 하드만 넣으면
-- 익스트림을 도는 주에 `익대`·`익쌀` 이 검색되지 않아 같은 불편이 그대로 재발한다.
--
-- ── `쌀` 은 넣고 `대` 는 넣지 않는다 (난이도 무관 별칭) ────────────────────
-- `쌀`  ✅ — 보스 이름 어디에도 없는 글자라 별칭이 없으면 **영영 검색되지 않는다.**
--            32개 보스의 이름·별칭 어느 것과도 겹치지 않아 충돌면이 0이다.
--            발주자가 실제로 쓰는 표기(원문 `하쌀`)이므로 지어낸 말도 아니다.
-- `대`  ❌ — `노벨`/`노반` 을 뺀 것과 같은 판단이다.
--            ① 화면 검색은 **부분 문자열** 매칭이라 `대` 는 이미 보스 이름
--               `최초의 대적자` 에 걸린다. 별칭으로 넣어도 결과가 한 건도 늘지 않는다.
--            ② 카톡 봇은 정규화 문자열 **완전 일치**로 푼다. 한 글자 토큰은 오타·조각과
--               부딪힐 여지가 가장 큰 키이고, 기존 그룹 별칭은 전부 2글자 이상이다.
--            ③ `적자`·`최적자` 가 이미 난이도 무관 별칭이라 빈자리도 아니다.
--
-- ── 재실행 안전 ────────────────────────────────────────────────────────────
-- `on conflict do nothing`. 시드(17-4)와 **다른 source** 를 쓰는 이유는 17-4 가
-- `delete ... where source = 'seed:research-BOSS-DATA'` 로 제 몫만 지우고 다시 넣기
-- 때문이다. 같은 source 를 쓰면 17 을 단독 재적용할 때 이 9행이 조용히 사라진다.
insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id,
       v.entry_id,
       v.alias,
       -- 17-4 와 **똑같은 정규화**. CHECK(normalized_alias = lower(btrim(...))) 가 강제한다.
       lower(btrim(replace(v.alias, ' ', ''))),
       'seed:first-adversary-shorthand'
from (values
  -- 난이도 무관 (그룹) — 봇은 후보가 여럿이면 되묻는다
  ('first_adversary', null::text,                '쌀'),

  -- 난이도 특정 — 4난이도 × 2계열
  ('first_adversary', 'first_adversary_easy',    '이대'),
  ('first_adversary', 'first_adversary_normal',  '노대'),
  ('first_adversary', 'first_adversary_hard',    '하대'),
  ('first_adversary', 'first_adversary_extreme', '익대'),
  ('first_adversary', 'first_adversary_easy',    '이쌀'),
  ('first_adversary', 'first_adversary_normal',  '노쌀'),
  ('first_adversary', 'first_adversary_hard',    '하쌀'),
  ('first_adversary', 'first_adversary_extreme', '익쌀')
) as v(boss_id, entry_id, alias)
on conflict do nothing;


-- -----------------------------------------------------------------------------
-- 22-9. 자기검증 — 별칭 9개 + 전체 충돌 0건
-- -----------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_bad   text;
begin
  -- (1) 9개가 전부 최초의 대적자에 붙었는가.
  --     `on conflict do nothing` 은 남의 보스와 부딪힌 행을 **조용히 버린다** —
  --     개수를 세는 것이 그 침묵을 깨는 유일한 방법이다.
  select count(*) into v_count
    from public.boss_aliases
   where boss_id = 'first_adversary'
     and normalized_alias in ('쌀', '이대', '노대', '하대', '익대', '이쌀', '노쌀', '하쌀', '익쌀');
  if v_count <> 9 then
    raise exception '대/쌀 계열 별칭이 9개가 아닙니다 (%개) — 다른 보스와 충돌해 접혔을 수 있습니다.', v_count;
  end if;

  -- (2) 난이도 특정 8개가 **정확히 그 난이도**를 가리키는가
  select string_agg(e.alias, ', ' order by e.alias) into v_bad
    from (values
      ('이대', 'first_adversary_easy'),    ('이쌀', 'first_adversary_easy'),
      ('노대', 'first_adversary_normal'),  ('노쌀', 'first_adversary_normal'),
      ('하대', 'first_adversary_hard'),    ('하쌀', 'first_adversary_hard'),
      ('익대', 'first_adversary_extreme'), ('익쌀', 'first_adversary_extreme')
    ) as e(alias, entry)
   where not exists (
     select 1
       from public.boss_aliases a
      where a.normalized_alias   = e.alias
        and a.boss_difficulty_id = e.entry
   );
  if v_bad is not null then
    raise exception '난이도 특정 별칭이 엉뚱한 엔트리를 가리킵니다: %', v_bad;
  end if;

  -- (3) `쌀` 은 난이도 무관이어야 한다. 엔트리가 붙으면 이지/노멀에서 안 걸린다.
  if not exists (
    select 1
      from public.boss_aliases
     where normalized_alias   = '쌀'
       and boss_id            = 'first_adversary'
       and boss_difficulty_id is null
  ) then
    raise exception '`쌀` 이 난이도 무관 별칭으로 들어가지 않았습니다.';
  end if;

  -- (4) 같은 별칭 문자열이 두 보스를 가리키지 않는가 — **표 전체** 대상.
  --     ⚠️ 유니크 인덱스 둘은 (난이도 특정 = 전역 유일) (그룹 = 보스별 유일) 까지만
  --     막는다. **그룹 별칭이 두 보스에 걸리는 경우**와 **한쪽은 그룹·다른 쪽은 난이도
  --     특정으로 같은 문자열을 쓰는 경우**는 두 부분 인덱스의 사이로 빠져나간다.
  --     검색이 엉뚱한 보스를 띄우는 건 정확히 그때다.
  select string_agg(x.normalized_alias, ', ' order by x.normalized_alias) into v_bad
    from (
      select normalized_alias
        from public.boss_aliases
       group by normalized_alias
      having count(distinct boss_id) > 1
    ) x;
  if v_bad is not null then
    raise exception '같은 별칭이 두 개 이상의 보스를 가리킵니다: %', v_bad;
  end if;

  -- (5) 같은 보스 안에서도 난이도 특정 별칭이 두 엔트리에 걸리면 안 된다.
  --     전역 유니크 인덱스가 이미 막지만, 인덱스가 사라져도 여기서 잡히게 둔다.
  select string_agg(x.normalized_alias, ', ' order by x.normalized_alias) into v_bad
    from (
      select normalized_alias
        from public.boss_aliases
       where boss_difficulty_id is not null
       group by normalized_alias
      having count(distinct boss_difficulty_id) > 1
    ) x;
  if v_bad is not null then
    raise exception '같은 별칭이 두 개 이상의 난이도를 가리킵니다: %', v_bad;
  end if;

  raise notice '22-8. 최초의 대적자 별칭 9개(대 4 · 쌀 4 · 그룹 1) · 별칭 충돌 0건';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 새 객체(`party_bosses`, `boss_difficulties.short_name`, `parties.name_is_custom`)는
-- 민감 정보가 아니지만, 이 호출의 목적은 값의 민감도가 아니라 **테이블 단위 GRANT 가
-- 조용히 넓어지지 않았는지**를 확인하는 것이다. 생략이 곧 share_bp 가 샜던 경로다.
select public.assert_no_public_sensitive_columns();
