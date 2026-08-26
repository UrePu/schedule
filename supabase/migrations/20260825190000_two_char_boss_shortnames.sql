-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 줄임말을 **두 글자로** — `익검마` → `익검`
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-25): *"세글자로 쓰지말고 익검 이렇게 줄여"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 세 글자짜리가 남아 있었나
-- ───────────────────────────────────────────────────────────────────────────────
-- 마이그레이션 22 는 줄임말을 **규칙으로 짓지 않는다**고 못박았다. 규칙("난이도 첫 글자 +
-- 이름 마지막 단어 첫 글자")이 안전하지 않기 때문이다 — 진 힐라와 힐라가 둘 다 `하힐` 이
-- 되고, 검은 마법사는 `익마` 가 되어 무엇의 줄임인지 사라진다. 그래서 **길어질 뿐 틀리지
-- 않는 쪽**을 골랐고, 그 결과 78개 중 7개가 세 글자로 남았다.
--
-- 그 판단은 여전히 옳다. 다만 **두 글자로 줄여도 충돌하지 않는 자리**가 있었고, 화면에서
-- 이 일곱만 유독 길어 목록의 세로 리듬을 깨고 있었다. 규칙을 되살리는 것이 아니라
-- **일곱 개를 손으로 고르는** 것이라, 22 의 교훈과 충돌하지 않는다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 고른 값과 근거
-- ───────────────────────────────────────────────────────────────────────────────
--   노카웅 → **노웅**   ⚠️ `노카` 는 **노멀 카링**이 이미 쓴다. 카웅을 구별하는 음절은
--                          `웅` 이므로 그쪽을 남긴다. (일간이라 추적 범위 밖이지만,
--                          중복된 줄임말을 만들지 않는 것이 더 중요하다.)
--   노진힐 → **노진** · 하진힐 → **하진**
--                       `진` 이 진 힐라를 유일하게 가리킨다. 힐라(`노힐`/`하힐`)와
--                       섞이지 않으므로 22 가 걱정한 그 충돌이 여기서는 생기지 않는다.
--   하검마 → **하검** · 익검마 → **익검**
--                       `검` 으로 시작하는 보스가 검은 마법사뿐이다. 22 가 피하려던
--                       `익마`(마지막 단어 첫 글자)와 다르다 — 이쪽은 **첫 단어**를 남긴다.
--   노메린 → **노메** · 하메린 → **하메**
--                       `메` 로 시작하는 보스가 메이린뿐이다.
--
-- ⚠️ **옛 줄임말도 별칭으로 남는다.** `익검마` 라고 치던 사람이 갑자기 못 찾게 되면
--    안 된다. 별칭은 지우지 않고 새 값만 더한다(`익검`·`하검` 은 이미 별칭에 있었다).

update public.boss_difficulties sn
   set short_name = v.short_name
  from (values
    ('kaung_normal',       '노웅'),
    ('verus_hilla_normal', '노진'),
    ('verus_hilla_hard',   '하진'),
    ('black_mage_hard',    '하검'),
    ('black_mage_extreme', '익검'),
    ('meilin_normal',      '노메'),
    ('meilin_hard',        '하메')
  ) as v(id, short_name)
 where sn.id = v.id;

-- 새 줄임말을 **별칭으로도** 넣는다. 화면이 `익검` 이라고 적는데 방에서 그렇게 쳤을 때
-- 못 알아들으면, 화면과 봇이 다른 말을 쓰는 셈이 된다.
insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id, v.entry_id, v.alias, lower(btrim(replace(v.alias, ' ', ''))), 'owner:2026-08-25'
from (values
  ('kaung',       'kaung_normal',       '노웅'),
  ('verus_hilla', 'verus_hilla_normal', '노진'),
  ('verus_hilla', 'verus_hilla_hard',   '하진'),
  ('meilin',      'meilin_normal',      '노메'),
  ('meilin',      'meilin_hard',        '하메')
) as v(boss_id, entry_id, alias)
on conflict do nothing;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_long integer;
  v_dup  integer;
  v_miss integer;
begin
  -- 세 글자 이상이 남아 있으면 이 마이그레이션이 할 일을 덜 한 것이다.
  select count(*) into v_long
    from public.boss_difficulties
   where short_name is not null and char_length(short_name) > 2;
  if v_long > 0 then
    raise exception '세 글자 이상 줄임말이 %건 남았습니다.', v_long;
  end if;

  /*
    ★ **중복이 0 이어야 한다.** 줄임말이 겹치면 목록에서 두 보스가 같은 이름으로 보이고,
      방에서 그 말을 쳤을 때 봇이 어느 쪽인지 알 수 없다. 22 가 규칙 생성을 포기한 이유가
      정확히 이것이라, 손으로 고른 값에서도 같은 기준을 지킨다.
  */
  select count(*) into v_dup
    from (select short_name from public.boss_difficulties
           where short_name is not null
           group by short_name having count(*) > 1) d;
  if v_dup > 0 then
    raise exception '중복된 줄임말이 %건 있습니다.', v_dup;
  end if;

  -- 새 줄임말이 전부 별칭으로도 있어야 한다(옛 줄임말은 그대로 남는다).
  select count(*) into v_miss
    from (values ('노웅'), ('노진'), ('하진'), ('하검'), ('익검'), ('노메'), ('하메')) as v(alias)
   where not exists (
     select 1 from public.boss_aliases a where a.normalized_alias = v.alias
   );
  if v_miss > 0 then
    raise exception '별칭으로 등록되지 않은 새 줄임말이 %건 있습니다.', v_miss;
  end if;

  raise notice '줄임말 두 글자화 완료 — 중복 0, 별칭 연결 확인';
end $$;

select public.assert_no_public_sensitive_columns();
