-- =====================================================================
-- 20260817093000_harden_search_path_and_fk_indexes.sql
--
-- Supabase advisor 가 지적한 두 가지를 해소한다.
--   (1) 보안 : function_search_path_mutable  42건
--   (2) 성능 : unindexed_foreign_keys        19건 중 16건 (3건은 의도적 미생성)
--
-- 이 마이그레이션은 **새 테이블/뷰를 만들지 않는다.** 따라서 새로 필요한 RLS
-- 정책도 없다 (CLAUDE.md §0.3). 인덱스는 행을 담는 객체가 아니라 기존 테이블의
-- 접근 경로일 뿐이며, 부모 테이블의 RLS 를 그대로 상속한다.
--
-- 데이터는 넣지도 지우지도 않는다.
-- 기존 마이그레이션 14개는 수정하지 않는다. 보강은 이 파일에서만 한다.
-- =====================================================================


-- =====================================================================
-- 1. 함수 search_path 고정
-- =====================================================================
--
-- [왜 필요한가]
-- advisor 가 지적한 42건은 전부 SECURITY INVOKER 다. (SECURITY DEFINER 는 이 DB에
-- 단 2개뿐이고 둘 다 이미 고정되어 있다 — claim_guest_profile / rls_auto_enable.)
-- 그래서 "정의자 권한 탈취" 형태의 고전적 권한 상승은 성립하지 않는다.
--
-- 그럼에도 고정하는 이유는 이 프로젝트의 쓰기 경로가 전부 service_role 이기 때문이다.
-- service_role 은 RLS 를 우회하는 최고 권한 역할이고, 이 역할이 실행하는 세션의
-- search_path 가 가변이면 함수 본문의 미수식 이름(`boss_clears`, `week_key(...)`)이
-- 경로 앞쪽 스키마에 심어진 동명 객체로 해석될 수 있다. 즉 권한 상승이 아니라
-- **최고 권한 세션에서의 객체 하이재킹**이 위험이다. 고정이 맞다.
--
-- [왜 `public, pg_temp` 인가]
--   · public   — 이 프로젝트의 모든 테이블/함수가 public 에 있다.
--   · pg_catalog 는 적지 않는다. 경로에 명시하지 않으면 Postgres 가 **암묵적으로 맨 앞**
--     에서 먼저 찾기 때문이다. 굳이 적으면 우리 public 객체보다 뒤로 밀 수도 있어 손해다.
--   · pg_temp 를 **맨 끝**에 두는 것이 이 설정의 핵심이다.
--     pg_temp 를 아예 적지 않으면 Postgres 는 임시 스키마를 경로의 **맨 앞**에서 찾는다.
--     그러면 임시 테이블/함수를 만들 수 있는 호출자가 `pg_temp.boss_clears` 같은 것을
--     심어 우리 public 객체를 가릴 수 있다. 명시적으로 마지막에 적으면 public 이 항상
--     먼저 이기므로 그 경로가 막힌다. "적지 않는 것"과 "마지막에 적는 것"은 전혀 다르다.
--
-- [안전성 사전 확인 — 실측]
-- 이 DB 의 세션 기본 search_path 는 `"$user", public, extensions` 이고,
-- pgcrypto / uuid-ossp 는 `extensions` 스키마에 있다. 경로에서 extensions 를 빼면
-- 미수식 pgcrypto 호출(digest/gen_random_bytes/crypt/uuid_generate_v4)이 깨진다.
-- 그래서 적용 전에 public 의 전 함수 본문을 두 가지 방법으로 훑었다.
--   · pg_depend (SQL 언어 함수는 생성 시점에 파싱되어 의존성이 기록된다) → 0건
--   · 본문 정규식 스캔 (plpgsql 본문은 파싱되지 않으므로 텍스트로 확인) → extensions
--     스키마 함수 이름과 겹치는 호출 0건
-- 유일하게 public 밖을 참조하는 것은 assert_no_public_sensitive_columns() 의
-- `information_schema.columns` 인데 **스키마가 이미 수식되어 있어** 영향이 없다.
-- 따라서 42건 전부 `public, pg_temp` 로 안전하다.
--
-- [왜 함수를 하나씩 하드코딩하지 않는가]
-- 앞으로 추가되는 함수도 이 마이그레이션을 다시 돌리면 그대로 잡히게 하려고
-- pg_proc 순회 DO 블록으로 쓴다. 이미 고정된 함수는 건너뛰므로 몇 번 돌려도 무해하다.

do $$
declare
  r        record;
  v_count  integer := 0;
begin
  for r in
    select
      n.nspname                                  as schema_name,
      p.proname                                  as func_name,
      pg_get_function_identity_arguments(p.oid)  as identity_args,
      p.oid::regprocedure::text                  as pretty_sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'

      -- 집합함수(a)/윈도우함수(w)는 SET 절을 받지 못한다. 함수와 프로시저만.
      and p.prokind in ('f', 'p')

      -- 소유자가 우리가 아닌 함수는 제외한다.
      and pg_get_userbyid(p.proowner) = current_user

      -- 확장(extension)이 설치한 함수는 우리 것이 아니다. 확장 업그레이드가
      -- 되돌려 놓을 뿐 아니라, 남의 함수 동작을 바꾸는 것 자체가 월권이다.
      and not exists (
        select 1
        from pg_depend d
        where d.classid  = 'pg_proc'::regclass
          and d.objid    = p.oid
          and d.deptype  = 'e'
      )

      -- 이벤트 트리거 함수는 Supabase 플랫폼이 심은 것이다. 우리 소유가 아니다.
      -- 여기서 걸러지는 것이 `rls_auto_enable()` (이벤트 트리거 `ensure_rls`) 이며,
      -- 이미 search_path = pg_catalog 로 고정되어 있다. 건드리지 않는다.
      and not exists (
        select 1 from pg_event_trigger et where et.evtfoid = p.oid
      )

      -- 위 조건과 중복이지만 명시적으로 한 번 더 막는다. 이 함수는 우리 것이 아니다.
      and p.proname <> 'rls_auto_enable'

      -- 이미 search_path 가 고정된 함수는 건너뛴다.
      -- claim_guest_profile(= public, pg_temp) 이 여기서 제외된다. 덮어쓰지 않는다.
      and coalesce(array_to_string(p.proconfig, ','), '') !~ 'search_path'
  loop
    -- 오버로드를 정확히 구분해야 한다. proname 만으로는 distribute_meso 처럼 인자만
    -- 다른 동명 함수를 구분할 수 없으므로 identity arguments 를 붙여 시그니처를 만든다.
    execute format(
      'alter function %I.%I(%s) set search_path = public, pg_temp',
      r.schema_name, r.func_name, r.identity_args
    );
    v_count := v_count + 1;
    raise notice 'search_path 고정: %', r.pretty_sig;
  end loop;

  raise notice '총 % 개 함수의 search_path 를 public, pg_temp 로 고정했다.', v_count;
end;
$$;


-- =====================================================================
-- 2. 외래키 인덱스
-- =====================================================================
--
-- [판단 기준]
-- 19건을 무지성으로 만들지 않는다. 각 FK 마다 다음을 따졌다.
--
--   (a) 참조 동작 비용 — on delete cascade / set null / restrict 가 걸린 FK 는
--       부모 행이 지워질 때마다 Postgres 가 자식 테이블에서 참조 행을 찾는다.
--       인덱스가 없으면 그 탐색이 **자식 테이블 전체 순차 스캔**이다.
--       부모 삭제가 일상적인 조작이고 자식 테이블이 계속 커진다면 반드시 필요하다.
--   (b) 조회 경로 — 그 컬럼이 실제 화면/봇 질의의 필터로 쓰이는가.
--   (c) 비용 — 인덱스는 공짜가 아니다. 자식 테이블이 **영구히 작고** 부모 삭제도
--       사실상 없다면 쓰기 비용과 저장공간만 늘 뿐이므로 만들지 않는 편이 낫다.
--
-- [nullable FK 는 전부 부분 인덱스로 만든다]
-- `where col is not null` 부분 인덱스는 nullable FK 에 대해 완전 인덱스보다
-- **엄격히 낫다.** 완전 btree 는 NULL 행까지 저장하는데 그 항목은 FK 참조 검사에
-- 절대 쓰이지 않는다(참조 검사는 항상 부모의 non-null 값을 찾는다). 즉 순수한 낭비다.
-- 그리고 Postgres 플래너는 `col = $1` 이 `col is not null` 을 함의한다는 것을
-- 증명할 수 있으므로 참조 검사 질의가 부분 인덱스를 그대로 탄다.
-- 실증: 기존 스키마의 characters_account_idx / bot_channels_owner_idx /
-- chore_definitions_owner_idx / parties_channel_idx 가 모두 부분 인덱스인데
-- 해당 FK 들은 advisor 의 19건 목록에 **없다**. Supabase 린터도 부분 인덱스를
-- 커버로 인정한다는 뜻이다.
--
-- [중복 확인]
-- 기존 인덱스의 **선행 컬럼**이 이미 FK 를 덮는 경우는 없었다. 예를 들어
-- boss_clears_week_uniq 는 boss_difficulty_id 를 갖지만 3번째 컬럼이라 참조 검사에
-- 쓸 수 없다. chore_completions 의 유니크 인덱스들도 character_id 가 2번째다.
-- 따라서 아래 16건은 모두 신규이며 중복이 아니다.


-- ---------------------------------------------------------------------
-- boss_clears — 이 스키마에서 가장 크게 자랄 테이블 (사용자 × 캐릭터 × 보스 × 주)
-- ---------------------------------------------------------------------

-- FK: boss_clears_boss_difficulty_id_fkey → boss_difficulties (on delete restrict, not null)
-- 생성. restrict 도 "참조 행이 있는가"를 확인해야 하므로 인덱스가 없으면 최대 테이블을
-- 통째로 순차 스캔한다. 게다가 boss_difficulty_id 는 실제 조회 필터다
-- ("이번 주 이 보스를 클리어한 사람"). week_key 를 뒤에 붙여 그 질의까지 한 번에 받는다.
-- 선행 컬럼이 FK 컬럼이므로 참조 검사 용도로도 그대로 유효하다.
create index if not exists boss_clears_difficulty_week_idx
  on public.boss_clears (boss_difficulty_id, week_key);

-- FK: boss_clears_crystal_price_id_fkey → boss_crystal_prices (on delete set null, nullable)
-- 생성. 시세표 행이 지워지면 set null 이 최대 테이블 전체를 훑는다.
-- §1.3 D4 대로 시세 미상(Velona 등) 행은 null 이므로 부분 인덱스가 그만큼 작아진다.
create index if not exists boss_clears_crystal_price_idx
  on public.boss_clears (crystal_price_id)
  where crystal_price_id is not null;


-- ---------------------------------------------------------------------
-- bot_command_log — 봇 명령이 들어올 때마다 한 행. 무한 증가하는 로그 테이블
-- ---------------------------------------------------------------------

-- FK: bot_command_log_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 로그 테이블이 가장 커지므로 계정 삭제 시의 set null 순차 스캔이 최악이다.
-- created_at desc 를 붙여 "이 사용자의 최근 명령 이력"(어뷰징 조사) 경로도 받는다.
-- !연결 안 한 발신자는 user_id 가 null 이라 부분 인덱스에서 빠진다 — 로그 적재
-- 비용을 그만큼 아낀다.
create index if not exists bot_command_log_user_idx
  on public.bot_command_log (user_id, created_at desc)
  where user_id is not null;


-- ---------------------------------------------------------------------
-- chore_completions — 일간 × 캐릭터 × 숙제. 행 수가 빠르게 늘어난다
-- ---------------------------------------------------------------------

-- FK: chore_completions_character_id_fkey → characters (on delete set null, nullable)
-- 생성. §2.1.1 의 캐릭터 선택 모달은 언제든 다시 열어 추적 캐릭터를 뺄 수 있다.
-- 즉 캐릭터 삭제는 **일상적인 조작**이고, 그때마다 set null 이 이 큰 테이블을 훑는다.
create index if not exists chore_completions_character_idx
  on public.chore_completions (character_id)
  where character_id is not null;

-- FK: chore_completions_definition_fk → chore_definitions (on delete cascade, not null)
-- 생성. chore_definitions 에는 owner_user_id 가 있으므로 사용자가 만든 커스텀 숙제가
-- 존재하고, 그 삭제 역시 일상적인 조작이다. cascade 가 이 테이블을 통째로 훑게 둘 수 없다.
-- 복합 FK 이므로 컬럼 순서를 제약과 동일하게 맞춘다.
create index if not exists chore_completions_definition_idx
  on public.chore_completions (chore_definition_id, scope);


-- ---------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------

-- FK: friendships_blocked_by_user_id_fkey → app_users (on delete cascade, nullable)
-- 생성. 이 컬럼은 차단이 걸린 관계에만 채워지므로 거의 항상 null 이다. 즉 부분
-- 인덱스가 거의 빈 인덱스라 사실상 공짜다. 그 대가로 계정 삭제 시의 cascade 순차
-- 스캔이 사라지고, "내가 차단한 관계" 목록 조회 경로도 덤으로 얻는다.
create index if not exists friendships_blocked_by_idx
  on public.friendships (blocked_by_user_id)
  where blocked_by_user_id is not null;


-- ---------------------------------------------------------------------
-- 초대 계열 — 파티 삭제가 invite_links → guest_profiles/invite_redemptions 로 번진다
-- ---------------------------------------------------------------------

-- FK: guest_profiles_created_via_invite_id_fkey → invite_links (on delete set null, nullable)
-- 생성. 파티가 지워지면 invite_links 가 cascade 로 지워지고, 그 각각이 다시
-- guest_profiles 에 set null 스캔을 유발한다. 파티 삭제는 일상적인 조작이고
-- guest_profiles 는 초대받은 비회원 수만큼 계속 늘어난다.
create index if not exists guest_profiles_invite_idx
  on public.guest_profiles (created_via_invite_id)
  where created_via_invite_id is not null;

-- FK: invite_links_created_by_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 계정 삭제 시 set null 스캔을 없애고 "내가 만든 초대 링크" 관리 화면 경로를 받는다.
create index if not exists invite_links_creator_idx
  on public.invite_links (created_by_user_id)
  where created_by_user_id is not null;

-- FK: invite_redemptions_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. party_participants 는 파티 삭제 시 cascade 로 사라지는데, 6인 파티면 참가자
-- 삭제 6번이 각각 set null 스캔을 부른다.
create index if not exists invite_redemptions_participant_idx
  on public.invite_redemptions (participant_id)
  where participant_id is not null;

-- FK: invite_redemptions_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 적재 속도는 낮지만 감사 로그라 삭제 없이 무한히 쌓인다("영구히 작다"에 해당하지
-- 않는다). 계정 삭제가 이 테이블을 순차 스캔하지 않도록 한다.
-- 게스트가 사용한 초대는 user_id 가 null 이라 부분 인덱스에서 빠진다.
create index if not exists invite_redemptions_user_idx
  on public.invite_redemptions (user_id)
  where user_id is not null;


-- ---------------------------------------------------------------------
-- party_participants
-- ---------------------------------------------------------------------

-- FK: party_participants_character_id_fkey → characters (on delete set null, nullable)
-- 생성. 캐릭터 추적 해제(§2.1.1)마다 set null 스캔이 걸린다. 게스트 참가자와
-- 캐릭터 미지정 참가자는 null 이라 부분 인덱스가 실제보다 작다.
create index if not exists party_participants_character_idx
  on public.party_participants (character_id)
  where character_id is not null;

-- FK: party_participants_invited_by_user_id_fkey → app_users (on delete set null, nullable)
-- 생성. 이 컬럼은 감사용이라 조회 필터로 쓰이지는 않는다. 그럼에도 만드는 이유는
-- (a) 기준 하나뿐 — 계정 삭제 시 set null 이 계속 커지는 테이블을 훑기 때문이다.
-- 삽입 시 1회 기록되고 이후 갱신되지 않으므로 유지 비용은 삽입당 btree 항목 하나다.
create index if not exists party_participants_invited_by_idx
  on public.party_participants (invited_by_user_id)
  where invited_by_user_id is not null;


-- ---------------------------------------------------------------------
-- party_runs / run_drops / run_signups
-- ---------------------------------------------------------------------

-- FK: party_runs_created_by_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. §1.4 대로 참가자는 파티에서 빠질 수 있고(#3번이 나가도 #4는 #4로 남는다),
-- 그 삭제마다 set null 스캔이 걸린다.
create index if not exists party_runs_creator_idx
  on public.party_runs (created_by_participant_id)
  where created_by_participant_id is not null;

-- FK: run_drops_recorded_by_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. 위와 동일한 이유. 드랍 기록은 런마다 쌓이므로 테이블이 계속 커진다.
create index if not exists run_drops_recorded_by_idx
  on public.run_drops (recorded_by_participant_id)
  where recorded_by_participant_id is not null;

-- FK: run_drops_solo_participant_id_fkey → party_participants (on delete set null, nullable)
-- 생성. 분배하지 않고 한 사람이 먹는 드랍에만 채워지므로 대부분 null 이다.
-- 부분 인덱스가 아주 작게 유지된다.
create index if not exists run_drops_solo_participant_idx
  on public.run_drops (solo_participant_id)
  where solo_participant_id is not null;

-- FK: run_signups_character_id_fkey → characters (on delete set null, nullable)
-- 생성. 캐릭터 추적 해제마다 set null 스캔. 참가 신청 시 캐릭터를 아직 안 고른
-- 행은 null 이라 부분 인덱스에서 빠진다.
create index if not exists run_signups_character_idx
  on public.run_signups (character_id)
  where character_id is not null;


-- ---------------------------------------------------------------------
-- 의도적으로 만들지 않는 3건
-- ---------------------------------------------------------------------
--
-- 아래 3건은 advisor 목록에 계속 남는다. 놓친 것이 아니라 판단한 결과다.
-- 나중에 이 테이블들의 전제(영구히 작다)가 깨지면 그때 만들면 된다.
--
-- ① boss_aliases_entry_belongs_to_boss  (boss_aliases → boss_difficulties, cascade)
--    미생성. boss_aliases 는 보스 마스터에 딸린 별칭표로 행 수가 보스 수에 묶여 있다
--    (수백 행 수준에서 영구히 멈춘다). 부모인 boss_difficulties 삭제는 패치 정비 때나
--    일어나는 일이고, 그 위의 bosses 는 애초에 restrict 로 잠겨 있어 함부로 지워지지도
--    않는다. 게다가 실제 조회 경로인 별칭 해석(`!등록 카룡` 파싱)은 이미
--    boss_aliases_normalized_uniq / _normalized_group_uniq 가 받고 있고, 그 반대 방향
--    (난이도 → 별칭 목록)은 수백 행짜리 관리 화면이다. 인덱스를 얹어봐야 쓰기 비용만 는다.
--
-- ② bot_link_codes_channel_id_fkey            (bot_link_codes → bot_channels, cascade)
-- ③ bot_link_codes_consumed_by_channel_id_fkey(bot_link_codes → bot_channels, set null)
--    둘 다 미생성. bot_link_codes 는 `!연결 <코드>` 용 6자리 코드로, 한 사용자가 평생
--    몇 번 발급받는 게 전부라 행 수가 (사용자 수 × 소수) 로 묶인다. 부모인 bot_channels
--    삭제(카톡방 제거)도 드문 사건이다. 즉 (a) 참조 동작 비용도 (b) 조회 경로도 없이
--    (c) 비용만 남는 전형적인 경우다. 특히 ③ 은 코드가 소비되기 전까지 계속 null 이라
--    인덱스가 거의 비어 있게 되는데, 그 빈 인덱스를 유지하려고 코드 발급마다 쓰기를
--    더할 이유가 없다.


-- =====================================================================
-- 3. 자체 검증 — 이 마이그레이션이 목표를 실제로 달성했는지 트랜잭션 안에서 확인
-- =====================================================================

do $$
declare
  v_mutable integer;
  v_names   text;
begin
  select count(*), string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into v_mutable, v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and pg_get_userbyid(p.proowner) = current_user
    and p.proname <> 'rls_auto_enable'
    and not exists (select 1 from pg_event_trigger et where et.evtfoid = p.oid)
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and coalesce(array_to_string(p.proconfig, ','), '') !~ 'search_path';

  if v_mutable > 0 then
    raise exception 'search_path 가 고정되지 않은 public 함수가 % 개 남았다: %', v_mutable, v_names;
  end if;
end;
$$;

-- 이미 고정되어 있던 claim_guest_profile 을 덮어쓰지 않았는지 확인한다.
do $$
declare
  v_cfg text;
begin
  select array_to_string(p.proconfig, ',') into v_cfg
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_guest_profile';

  if v_cfg is distinct from 'search_path=public, pg_temp' then
    raise exception 'claim_guest_profile 의 search_path 가 바뀌었다: %', v_cfg;
  end if;
end;
$$;

-- rls_auto_enable 은 우리 소유가 아니다. 손대지 않았음을 확인한다.
--
-- ⚠️ **없을 수도 있다.** 이 함수는 Supabase 플랫폼이 심는 이벤트 트리거 함수라
--    이 프로젝트에는 처음부터 있었지만, 새 Supabase 프로젝트나 로컬/CI 의 맨 Postgres 에는
--    존재하지 않는다. 가드의 의도는 "있으면 건드리지 않았는지 확인한다"이지
--    "반드시 존재해야 한다"가 아니므로 **없으면 검사할 대상 자체가 없다 → 건너뛴다.**
--
-- [이미 적용된 마이그레이션을 수정한 이유 — 이 저장소의 원칙에 대한 예외]
--   원칙은 "적용된 마이그레이션은 고치지 않는다"이다. 여기만 예외로 두는 근거는 두 가지다.
--     ① 라이브 DB(hryikreaxngexhjjxfyl)에는 함수가 존재하고 proconfig 도
--        `search_path=pg_catalog` 로 일치한다 → 아래 분기 중 **기존과 동일한 경로**를 타므로
--        동작 변화가 정확히 0 이다. 새 마이그레이션으로는 이미 실행된 DO 블록을 되돌릴 수 없다.
--     ② 고치지 않으면 **새 배포가 불가능**하다. 예전 판은 함수가 없을 때
--        `select ... into v_cfg` 가 v_cfg 를 NULL 로 남기고 `is distinct from` 이 참이 되어
--        깨끗한 Postgres 에서 전체 마이그레이션이 이 지점에서 멈췄다(실측 재현:
--        "rls_auto_enable 을 건드렸다. … : <NULL>").
--
-- 건너뛴 사실은 raise notice 로 남긴다. 조용히 지나가면 나중에 "왜 이 검사가 안 돌았지"를
-- 로그로 되짚을 수 없다.
do $$
declare
  v_cfg text;
begin
  select array_to_string(p.proconfig, ',') into v_cfg
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rls_auto_enable';

  -- SELECT INTO 는 행이 배정되지 않으면 FOUND 를 false 로 둔다. proconfig 가 NULL 인
  -- "존재하지만 search_path 미설정" 과 "아예 없음" 을 이 플래그로만 구별할 수 있다.
  -- (v_cfg 의 NULL 여부로 구별하면 전자를 후자로 오판해 진짜 사고를 놓친다.)
  if not found then
    raise notice 'rls_auto_enable 이 이 DB 에 없다 — Supabase 플랫폼 객체이므로 검사를 건너뛴다.';
  elsif v_cfg is distinct from 'search_path=pg_catalog' then
    raise exception 'rls_auto_enable 을 건드렸다. 이 함수는 우리 소유가 아니다: %', v_cfg;
  end if;
end;
$$;

-- KST 목요일 00:00 주간 리셋 경계가 그대로인지 확인한다 (CLAUDE.md §1, §0.3).
-- search_path 고정이 week_key/week_start 의 해석을 바꾸지 않았음을 보증한다.
do $$
begin
  if public.week_key('2026-08-19 23:59:59+09'::timestamptz) <> '2026-W33' then
    raise exception '주차 경계 파손: 수요일 23:59 KST 가 2026-W33 이 아니다';
  end if;
  if public.week_key('2026-08-20 00:00:00+09'::timestamptz) <> '2026-W34' then
    raise exception '주차 경계 파손: 목요일 00:00 KST 가 2026-W34 가 아니다';
  end if;
  if public.week_start('2026-08-20 00:00:00+09'::timestamptz) <> '2026-08-19 15:00:00+00'::timestamptz then
    raise exception '주 시작 파손: 2026-W34 의 시작이 목요일 00:00 KST 가 아니다';
  end if;
end;
$$;

-- 1/n 분배가 메소를 잃지도 만들지도 않는지 확인한다 (§1.3 D3).
do $$
declare
  v_total bigint;
begin
  select sum(amount) into v_total
  from public.distribute_meso(
    1000000000,
    array['11111111-1111-1111-1111-111111111111'::uuid,
          '22222222-2222-2222-2222-222222222222'::uuid,
          '33333333-3333-3333-3333-333333333333'::uuid],
    array[3333, 3333, 3334]);

  if v_total <> 1000000000 then
    raise exception 'distribute_meso 파손: 합계가 %', v_total;
  end if;
end;
$$;


-- =====================================================================
-- 4. DoD — 민감 컬럼이 anon/authenticated 에 새어나가지 않는지 (CLAUDE.md §0.3)
-- =====================================================================
-- 이 마이그레이션은 컬럼을 추가하지 않지만, 호출을 생략하지 않는다.
-- share_bp 가 새던 사고가 바로 "이번엔 컬럼 안 건드렸으니 괜찮겠지"에서 나왔다.
select public.assert_no_public_sensitive_columns();
