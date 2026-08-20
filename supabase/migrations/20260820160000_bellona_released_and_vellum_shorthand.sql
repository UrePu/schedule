-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 벨로나 출시 + 벨룸을 줄임말에서 뺀다 (`노벨` 을 벨로나에게)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-20):
--   · *"벨로나에 있는 미출시 태그좀 떼줘"*
--   · *"벨룸같은 찌끄레기는 없애"* → *"현재 겹치는게 그거뿐이니 (…) 겹치는건 벨룸만 없애"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 "둘 다 띄우기" 가 아니라 "하나를 뺀다" 인가
-- ───────────────────────────────────────────────────────────────────────────────
-- 처음에는 `노벨` 을 벨룸·벨로나 양쪽에 달고 해석기가 둘 다 후보로 내놓게 하려 했다.
-- 해석기는 실제로 그걸 할 줄 안다(`resolveBoss` → `kind: "ambiguous"`). 그런데 **DB 가
-- 구조적으로 막는다**:
--
--   boss_aliases_normalized_uniq  UNIQUE (normalized_alias) WHERE boss_difficulty_id IS NOT NULL
--
-- 난이도까지 특정하는 별칭은 **전역에서 한 건**만 존재할 수 있다. 시드가 `노벨` 을
-- "의도적으로 제외" 한 것도 이 제약 때문이었다. 제약을 푸는 것은 별칭 체계 전체의 전제를
-- 바꾸는 일이라(그 유일성 위에 조회가 서 있다) 겹침 하나를 위해 치를 값이 아니다.
--
-- 그래서 **겹침의 한쪽을 없앤다.** 카오스 벨룸 928만 · 노멀 벨룸 55만은 이제 아무도 돌지
-- 않는 구세대 보스이고, 벨로나는 Lv280 신규 보스(하드 29.5억)다. `노벨` 이 어느 쪽을
-- 가리켜야 하는지는 물어볼 필요가 없다.
--
-- ★ **행을 지우지 않는다.** 줄임말과 별칭만 거둔다. 벨룸으로 잡아 둔 과거 클리어·일정이
--   있으면 그대로 살아 있어야 하고(`boss_difficulties` 는 폐지도 행 삭제로 다루지 않는다),
--   정식 이름 `카오스 벨룸` 으로는 여전히 검색된다.
-- ★ 벨룸은 `released` 를 **건드리지 않는다.** 여전히 라이브에 있는 보스다 — 우리가 줄임말을
--   안 줄 뿐이지 "미출시" 가 아니다. 그 둘을 섞으면 화면이 거짓말을 한다.

-- ── 1. 벨로나 3종 출시 ────────────────────────────────────────────────────────
-- 시드는 `released = false` 였다. 그때는 라이브에 없었고 가격도 몰랐다(§1.3 D4).
-- 이제 가격이 확정됐고(`20260820120000_bellona_crystal_prices.sql`) 라이브에도 있다.
--
-- ⚠️ `nexon_name_verified` 는 그대로 둔다. "출시됐다" 와 "우리 조인 키가 실측으로
--    확인됐다" 는 다른 사실이고, 뒤엣것은 아직 관측하지 못했다.
update public.boss_difficulties bd
   set released = v.released
  from (values
    ('bellona_easy',   true),
    ('bellona_normal', true),
    ('bellona_hard',   true)
  ) as v(id, released)
 where bd.id = v.id;

-- ── 2. 벨룸 줄임말 제거 ───────────────────────────────────────────────────────
-- `노벨룸` · `카벨` 이 사라진다. 정식 이름으로는 계속 찾을 수 있다.
update public.boss_difficulties sn
   set short_name = v.short_name
  from (values
    ('vellum_normal', null::text),
    ('vellum_chaos',  null::text)
  ) as v(id, short_name)
 where sn.id = v.id;

-- ── 3. 벨룸 별칭 제거 ─────────────────────────────────────────────────────────
delete from public.boss_aliases a
 using (values ('vellum')) as v(boss_id)
 where a.boss_id = v.boss_id;

-- ── 4. 비워진 `노벨` 을 벨로나에게 ────────────────────────────────────────────
-- 3번이 자리를 비웠으므로 이제 유니크 인덱스에 걸리지 않는다.
-- ⚠️ `normalized_alias` 는 **트리거가 채우지 않는다.** NOT NULL 이므로 시드와 똑같이
--    여기서 직접 만든다 — 정규화 규칙(`lower(btrim(replace(alias,' ','')))`)이 DB CHECK 및
--    생성기 `normalizeAlias()` 와 한 글자도 달라지면 안 된다.
insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id, v.entry_id, v.alias,
       lower(btrim(replace(v.alias, ' ', ''))), 'seed:research-BOSS-DATA'
from (values
  ('bellona', 'bellona_normal', '노벨')
) as v(boss_id, entry_id, alias)
on conflict do nothing;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_unreleased  integer;
  v_vellum_alias integer;
  v_vellum_short integer;
  v_nobel_entry  text;
begin
  select count(*) into v_unreleased
    from public.boss_difficulties where id like 'bellona%' and not released;
  if v_unreleased > 0 then
    raise exception '벨로나 미출시 행이 %건 남았습니다.', v_unreleased;
  end if;

  select count(*) into v_vellum_alias
    from public.boss_aliases where boss_id = 'vellum';
  if v_vellum_alias > 0 then
    raise exception '벨룸 별칭이 %건 남았습니다.', v_vellum_alias;
  end if;

  select count(*) into v_vellum_short
    from public.boss_difficulties where id like 'vellum%' and short_name is not null;
  if v_vellum_short > 0 then
    raise exception '벨룸 줄임말이 %건 남았습니다.', v_vellum_short;
  end if;

  select boss_difficulty_id into v_nobel_entry
    from public.boss_aliases where normalized_alias = '노벨';
  if v_nobel_entry is distinct from 'bellona_normal' then
    raise exception '`노벨` 이 노멀 벨로나를 가리켜야 하는데 % 입니다.', coalesce(v_nobel_entry, '(없음)');
  end if;

  -- 벨룸 엔트리 자체는 살아 있어야 한다. 과거 기록이 매달려 있다.
  perform 1 from public.boss_difficulties where id = 'vellum_chaos';
  if not found then
    raise exception '벨룸 엔트리가 사라졌습니다 — 행을 지우면 안 됩니다.';
  end if;

  raise notice '벨로나 출시 · 벨룸 줄임말 제거 · 노벨 → 노멀 벨로나 완료';
end $$;

select public.assert_no_public_sensitive_columns();
