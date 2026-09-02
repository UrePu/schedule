-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 익스트림 스우의 줄임말을 `익스` → **`익슈`** 로
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-09-02): *"익스 = 익스트림 스우인데 익슈로 바꿔봐 얘만 익스우 익스스우 다
-- 검색되게는 하고 익슈 < 이것도 검색되고 표시도 익슈로"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 `익스` 가 나쁜 줄임말인가
-- ───────────────────────────────────────────────────────────────────────────────
-- `익스` 는 **난이도 접두사 그 자체**다. `lib/command-parse.ts` 의 `DIFFICULTY_PREFIXES`
-- 에 `익스트림` 과 함께 `익스` 가 들어 있어, 방에서 `익스` 라고 치면 "익스트림 + (보스
-- 이름 없음)" 으로도 읽힌다. 화면에서도 `익스 더저 5억 7,400만` 은 무엇의 익스트림인지
-- 말하지 않는다 — 78개 줄임말 중 **유일하게 보스를 가리키는 음절이 하나도 없는** 값이다.
--
-- `익슈` 는 스우(Lotus)의 별명 `슈`(스우 → 슈) 를 남긴다. 마이그레이션 22 가 규칙 생성을
-- 포기하며 세운 기준 — *"길어질 뿐 틀리지 않는 쪽"* · *"무엇의 줄임인지 남을 것"* — 에
-- 맞고, 두 글자화(2026-08-25)가 세운 **두 글자** 제약도 지킨다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 옛 이름은 **하나도 지우지 않는다**
-- ───────────────────────────────────────────────────────────────────────────────
-- `익스우` · `익스스우` · `익스` 는 이미 별칭으로 있고 그대로 둔다(발주 지시: *"익스우
-- 익스스우 다 검색되게는 하고"*). 두 글자화 때 세운 규칙과 같다 — 쓰던 말로 못 찾게
-- 되는 것이 이름을 바꾸는 것보다 나쁘다. 이 파일이 하는 일은 **표시값을 옮기고 새 이름을
-- 검색어에 더하는 것**뿐이다.

update public.boss_difficulties sn
   set short_name = v.short_name
  from (values
    ('lotus_extreme', '익슈')
  ) as v(id, short_name)
 where sn.id = v.id;

-- 새 줄임말을 **별칭으로도** 넣는다. 화면이 `익슈` 라고 적는데 방에서 그렇게 쳤을 때
-- 못 알아들으면 화면과 봇이 다른 말을 쓰는 셈이 된다(두 글자화 파일과 같은 이유).
insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id, v.entry_id, v.alias, lower(btrim(replace(v.alias, ' ', ''))), 'owner:2026-09-02'
from (values
  ('lotus', 'lotus_extreme', '익슈')
) as v(boss_id, entry_id, alias)
on conflict do nothing;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_short text;
  v_dup   integer;
  v_miss  integer;
begin
  select short_name into v_short
    from public.boss_difficulties where id = 'lotus_extreme';
  if v_short is distinct from '익슈' then
    raise exception '익스트림 스우 줄임말이 %(익슈 여야 함)입니다.', coalesce(v_short, '(없음)');
  end if;

  /*
    ★ **중복이 0 이어야 한다.** 줄임말이 겹치면 목록에서 두 보스가 같은 이름으로 보이고,
      방에서 그 말을 쳤을 때 봇이 어느 쪽인지 알 수 없다(두 글자화 파일과 같은 기준).
  */
  select count(*) into v_dup
    from (select short_name from public.boss_difficulties
           where short_name is not null
           group by short_name having count(*) > 1) d;
  if v_dup > 0 then
    raise exception '중복된 줄임말이 %건 있습니다.', v_dup;
  end if;

  -- 새 이름과 **옛 이름 셋이 모두** 검색되어야 한다. 하나라도 빠지면 발주 지시에 어긋난다.
  select count(*) into v_miss
    from (values ('익슈'), ('익스우'), ('익스스우'), ('익스')) as v(alias)
   where not exists (
     select 1 from public.boss_aliases a
      where a.normalized_alias = v.alias
        and a.boss_difficulty_id = 'lotus_extreme'
   );
  if v_miss > 0 then
    raise exception '익스트림 스우 별칭 %건이 빠졌습니다.', v_miss;
  end if;

  raise notice '익스트림 스우 줄임말 익슈 적용 — 중복 0, 옛 별칭 3종 유지';
end $$;

select public.assert_no_public_sensitive_columns();
