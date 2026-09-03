-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 이름만으로 찾은 **캐릭터 생김새 캐시**
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-09-03): *"각각 다른사람 api를 사용하지말고. 내 api 로 파티원들의 이미지를
-- 가져오는식으로 ocid 가져오려고 하지말고 캐릭터 생긴거만 검색하는방법을 가져와"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 무엇이 문제였나 — 게스트는 영영 실루엣이었다
-- ───────────────────────────────────────────────────────────────────────────────
-- 파티에는 우리 DB 에 `characters` 행이 없는 사람이 올라온다(`guest_profiles`, 그리고
-- `party_participants.character_id is null`). 그 사람에게는 **ocid 가 없고**, 우리 초상화
-- 경로는 전부 ocid 를 입구로 삼는다(`features/characters/server/portrait-backfill.ts`).
-- 그래서 파티 고르기 화면에서 게스트만 계속 실루엣으로 남았다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 이름만으로 가능한가 — 2026-09-03 실측
-- ───────────────────────────────────────────────────────────────────────────────
-- `GET /maplestory/v1/id?character_name=<이름>` 은 **소유권 검사가 없다.** 우리 키 하나로
-- 남의 캐릭터도 ocid 가 나오고, 그 ocid 로 `/character/basic` 이 200 을 준다. 실제 호출:
--
--   지연뚱      → 제니스 · 아델 · Lv.297 · character_image 있음
--   파이어9053  → 제니스 · 아크메이지(불,독) · Lv.295 · 있음
--   풍무고불빠따 → **오로라** · 카데나 · Lv.296 · 있음
--
-- ★ 월드 파라미터를 넘기지 않았는데 **서로 다른 월드**가 나왔다. `/id` 는 이름만으로 전
--   월드를 훑고 KMS 캐릭터명은 전역 고유라, 월드를 물어볼 필요가 없다. 그래서 이 표의
--   기본키는 `(world, name)` 쌍이 아니라 **이름 하나**다.
-- ★ CLAUDE.md §1.1 의 *"자신의 계정에 속한 캐릭터만 조회가 가능합니다"* 는 **스케줄러**
--   (`/scheduler/character-state`)에 걸린 문장이다. `/id` 와 `/character/basic` 에는 걸리지
--   않는다(2026-09-02 정정과 같은 근거).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★★ 표가 필요한 이유는 **음성 캐시** 때문이다 ★★
-- ───────────────────────────────────────────────────────────────────────────────
-- 이름 하나를 그리는 데 **2콜**이 든다(`/id` + `/character/basic`). 개발 키는 하루
-- 1,000콜이다(§1.0). 그런데 그 2콜이 얼굴을 못 주는 **정상적인 경우가 둘** 있다:
--
--   ① **그런 이름 없음** — 사람이 캐릭터명이 아닌 별명("동생", "형")을 적었다.
--      `/id` 가 **HTTP 400 `OPENAPI00004`**.
--   ② **죽은 ocid** — `/id` 는 **200** 인데 그 ocid 로 부른 `/character/basic` 이
--      **HTTP 400 `OPENAPI00003`**. 이름 검색은 살아 있는데 캐릭터는 볼 수 없는 상태로,
--      캐릭터 삭제·이관으로 보인다. 지휘 측 실측(2026-09-03, 실제 호출):
--        GET /id?character_name=구해야됨             → 200 {"ocid":"2690b2ff8dc65197…"}
--        GET /character/basic?ocid=2690b2ff8dc65197… → 400 OPENAPI00003
--
-- 게이트웨이 캐시(`lib/nexon/gateway.ts`)는 **성공 응답만** 담고 실패는 담지 않는다. 즉
-- 이 둘은 캐시가 하나도 막아 주지 못해서, 화면을 열 때마다 그 이름으로 2콜이 영원히
-- 나간다. `missing_at` 이 그 반복을 끊는 유일한 장치이고, **두 원인 모두** 이 칸에 적힌다.
--
-- ⚠️ `missing_at` 은 **오류 기록이 아니라 정상 상태**다. "그런 캐릭터 없음"도 "그 ocid 로는
--    못 본다"도 넥슨이 정상적으로 답해 준 사실이며, 화면은 그때 실루엣과 이름만 그린다.
-- ⚠️ 반대로 **무효 키(`OPENAPI00005`) · 할당량(`OPENAPI00007`) · 점검 · 네트워크 오류는
--    절대 이 칸에 적지 않는다.** 그것들은 "이 캐릭터를 볼 수 없다"가 아니라 "지금 우리가
--    부를 수 없다"이고, 여기 박으면 멀쩡한 캐릭터가 재시도 주기(7일) 내내 실루엣이 된다.
--    쓰는 쪽 판별은 `features/characters/server/name-portrait-lookup.ts` 가 갖는다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 읽기는 왜 공개인가
-- ───────────────────────────────────────────────────────────────────────────────
-- 비로그인 상태에서 공개 시간표를 볼 수 있고(§2.1) 거기에 파티원 얼굴이 그려진다. 담긴
-- 값은 전부 **넥슨이 이름만 알면 누구에게나 주는 공개 정보**(초상화 URL · 월드 · 직업 ·
-- 레벨)라, 우리가 감출 이유가 없는 것들이다. 개인을 계정에 잇는 값은 한 칸도 없다.
-- 쓰기는 service_role 뿐이다 — 이 표는 우리가 넥슨에서 받아 적는 것이지 사용자가 채우는
-- 것이 아니다.
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. 표
-- #############################################################################

create table if not exists public.character_looks (
  /*
    ★ 기본키가 **이름 그 자체**다. 위 실측대로 `/id` 는 월드를 묻지 않으므로 이름 하나가
      캐릭터를 특정한다. `guest_profiles.display_name` 과 같은 1~40자 제약을 쓴다.
    ★ `btrim` 된 값만 받는다. 앞뒤 공백이 붙은 채로 들어오면 같은 사람이 두 행이 되고,
      그중 하나는 넥슨이 영영 못 찾는 행이 된다. 정규화 책임을 호출부에 남기지 않고
      **제약으로 못박는다.**
  */
  character_name  text primary key
                  check (character_name = btrim(character_name))
                  check (length(character_name) between 1 and 40),

  /*
    재조회용 중간값일 뿐이다. **식별자로 쓰지 않는다** — ocid 는 넥슨이 명시적으로
    가변값이라고 적어 둔 값이고(§1.1), 그래서 우리 `characters` 도 ocid 를 PK 로 쓰지
    않는다. 여기 보관하는 이유는 다음 갱신 때 `/id` 1콜을 아낄 수 있는지 판단할 근거로
    남겨 두기 위해서다.
  */
  ocid            text,

  world_name      text,
  character_class text,
  character_level int,
  /** 초상화 URL. **null 은 정상 상태**다(§2.1.1) — 화면은 실루엣을 그린다. */
  image_url       text,

  /** 마지막으로 넥슨에서 이 캐릭터를 **찾은** 시각. 양성 캐시 TTL 의 기준. */
  fetched_at      timestamptz,
  /*
    마지막으로 **"이 이름으로는 지금 캐릭터를 볼 수 없다"** 를 받은 시각. 음성 캐시의 기준.
    원인은 둘이고(머리말) 화면에서는 같다 — 그런 이름 없음(`/id` 400 `OPENAPI00004`) ·
    죽은 ocid(`/character/basic` 400 `OPENAPI00003`).
    ⚠️ 아래 `comment on column` 에는 첫째 원인만 적혀 있다. 이 마이그레이션은 이미 운영에
       적용됐고 적용된 DDL 은 고치지 않는다는 규칙(CLAUDE.md §3)에 따라 그대로 두었다.
       코드 쪽 설명은 `name-portrait-lookup.ts` 의 `CharacterLook.missing` 이 갖는다.
  */
  missing_at      timestamptz,

  created_at      timestamptz not null default now(),

  /*
    ★ **아무것도 모르는 행은 남기지 않는다.** 둘 다 null 인 행은 "찾았다"도 "없다"도
      아니어서 읽는 쪽이 캐시 적중으로 볼지 미조회로 볼지 정할 수 없고, 그런 행이 하나
      생기면 그 이름은 매번 다시 부르면서도 계속 캐시에 있는 것처럼 보인다.
      행을 만드는 경로는 조회 성공/실패 두 가지뿐이므로 이 제약은 절대 사람을 막지 않는다.
  */
  constraint character_looks_knows_something
    check (num_nonnulls(fetched_at, missing_at) >= 1)
);

comment on table public.character_looks is
  '캐릭터 **이름만으로** 넥슨에서 받아 둔 생김새 캐시(초상화·월드·직업·레벨). '
  '우리 DB 에 characters 행도 ocid 도 없는 파티 게스트의 얼굴을 그리는 유일한 경로다. '
  '이름 하나당 /id + /character/basic 2콜이 들고 없는 이름은 게이트웨이 캐시가 막아 '
  '주지 못하므로, missing_at(음성 캐시)이 이 표의 존재 이유의 절반이다. '
  '쓰기는 service_role 전용, 읽기는 공개(전부 넥슨이 누구에게나 주는 공개 정보).';

comment on column public.character_looks.character_name is
  '기본키. btrim 된 캐릭터명 1~40자. /id 가 월드를 묻지 않고 KMS 캐릭터명이 전역 고유라 '
  '이름 하나로 캐릭터가 특정된다(2026-09-03 실측: 이름만으로 제니스/오로라가 각각 조회됨).';
comment on column public.character_looks.ocid is
  '재조회용 중간값. **식별자로 쓰지 말 것** — ocid 는 가변값이다(§1.1).';
comment on column public.character_looks.world_name is '넥슨 /character/basic 의 world_name.';
comment on column public.character_looks.character_class is '넥슨 /character/basic 의 character_class.';
comment on column public.character_looks.character_level is '넥슨 /character/basic 의 character_level.';
comment on column public.character_looks.image_url is
  '초상화 URL. null 은 정상 상태이며 오류가 아니다(§2.1.1) — 화면은 실루엣을 그린다.';
comment on column public.character_looks.fetched_at is
  '마지막으로 넥슨이 이 이름을 찾아 준 시각. 양성 캐시 TTL 의 기준.';
comment on column public.character_looks.missing_at is
  '마지막으로 "그런 캐릭터 없음"(HTTP 400 OPENAPI00004)을 받은 시각. '
  '오류 기록이 아니라 정상 응답의 기록이며, 같은 이름을 매 화면마다 2콜씩 다시 묻는 것을 막는다.';
comment on column public.character_looks.created_at is '행이 처음 생긴 시각.';

/*
  "오래된 것부터 갱신" 조회를 위한 인덱스. 게스트 이름은 많아야 수백 개라 순차 스캔으로도
  죽지 않지만, 이 표를 읽는 자리 중 하나가 **화면 렌더 경로**(파티 고르기)라 그 비용을
  굳이 화면에 물릴 이유가 없다.
  `missing_at` 쪽은 **부분 인덱스**다 — 대부분의 행은 찾힌 행이라 `missing_at` 이 null 이고,
  그 null 들을 인덱스에 담아 봐야 크기만 커진다.
*/
create index if not exists character_looks_fetched_at_idx
  on public.character_looks (fetched_at);
create index if not exists character_looks_missing_at_idx
  on public.character_looks (missing_at)
  where missing_at is not null;


-- #############################################################################
-- 2. RLS — 읽기 공개, 쓰기 service_role 전용
-- #############################################################################

alter table public.character_looks enable row level security;

/*
  ★ **컬럼 단위 GRANT 를 쓴다**(마이그레이션 11-A 가 세운 규약). 테이블 단위 grant 는
    나중에 추가되는 컬럼을 자동으로 열어 주고, 그게 `share_bp` 유출 사고의 원인이었다.
    여기 새 컬럼이 붙어도 명시하지 않는 한 anon 에게 열리지 않는다.

  공개 목록에서 뺀 것과 이유:
    ocid       — 캐릭터 식별자다. 화면이 그리는 데 전혀 필요 없고(초상화 URL 은 이미
                 이 표에 펼쳐져 있다), 남에게 줄 이유가 없는 내부 중간값이다.
    missing_at — 운영값이다. "이 이름은 넥슨에 없다"는 우리 캐시의 사정이지
                 비로그인 열람자가 알아야 할 값이 아니다.
    created_at — 운영값이다.
*/
revoke all on table public.character_looks from anon;
revoke all on table public.character_looks from authenticated;
grant select (
  character_name, world_name, character_class, character_level, image_url, fetched_at
) on table public.character_looks to anon, authenticated;
grant all on table public.character_looks to service_role;

drop policy if exists character_looks_public_select on public.character_looks;
create policy character_looks_public_select on public.character_looks
  as permissive for select to anon, authenticated
  using (true);

drop policy if exists character_looks_no_public_insert on public.character_looks;
create policy character_looks_no_public_insert on public.character_looks
  as permissive for insert to anon, authenticated with check (false);

drop policy if exists character_looks_no_public_update on public.character_looks;
create policy character_looks_no_public_update on public.character_looks
  as permissive for update to anon, authenticated using (false) with check (false);

drop policy if exists character_looks_no_public_delete on public.character_looks;
create policy character_looks_no_public_delete on public.character_looks
  as permissive for delete to anon, authenticated using (false);

drop policy if exists character_looks_service_role_all on public.character_looks;
create policy character_looks_service_role_all on public.character_looks
  as permissive for all to service_role using (true) with check (true);


-- #############################################################################
-- 3. 자기검증
-- #############################################################################

do $$
declare
  v_rls boolean;
begin
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.character_looks'::regclass;
  if v_rls is not true then
    raise exception 'character_looks 에 RLS 가 켜져 있지 않습니다.';
  end if;

  -- 쓰기가 열려 있으면 안 된다. 이 표는 우리가 넥슨에서 받아 적는 것이다.
  if has_table_privilege('anon', 'public.character_looks', 'INSERT')
     or has_table_privilege('authenticated', 'public.character_looks', 'INSERT')
     or has_table_privilege('anon', 'public.character_looks', 'UPDATE')
     or has_table_privilege('authenticated', 'public.character_looks', 'UPDATE')
     or has_table_privilege('anon', 'public.character_looks', 'DELETE')
     or has_table_privilege('authenticated', 'public.character_looks', 'DELETE')
  then
    raise exception 'character_looks 에 공개 쓰기 권한이 남아 있습니다.';
  end if;

  -- ocid 는 공개 목록에서 뺐다. 실제로 빠졌는지 확인한다.
  if has_column_privilege('anon', 'public.character_looks', 'ocid', 'SELECT') then
    raise exception 'character_looks.ocid 가 anon 에게 노출되었습니다.';
  end if;

  raise notice 'character_looks 생성 완료 — 읽기 공개(6칸), 쓰기 service_role 전용';
end $$;

select public.assert_no_public_sensitive_columns();
