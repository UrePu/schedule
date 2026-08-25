-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 메이린 결정석 시세 확정 — 노멀 3억 / 하드 6억
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주자 확인(2026-08-25): 노멀 3억, 하드 6억.
--
-- 한 시간 전(마이그레이션 43)에는 공개 가격표에 없어 `null`(미상)로 넣었다. 값이
-- 확인됐으므로 채운다. **다른 보스와 똑같이 다룬다** — 별도의 보상 종류나 예외 경로를
-- 만들지 않는다(발주 지시: *"분리하지말고 그냥 결정석 가격에 넣어"*).
-- 즉 `floor(가격 / 인원)` 규칙도, pot 계산도, 수익 합계도 전부 기존 경로 그대로다.
--
-- ⚠️ 12칸 면제(`counts_toward_weekly_limit = false`)는 **그대로 둔다.** 시세와 무관한
--    별개 사실이고, 근거는 실측이다 — 킴잔델이 12/12 인데도 하드 메이린 등록이 살아
--    있었다(43번 머리말). 가격이 붙었다고 12칸을 먹기 시작하는 것이 아니다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 새 행을 얹지 않고 **그 자리를 고치는가** — R3 의 좁은 예외
-- ───────────────────────────────────────────────────────────────────────────────
-- 원칙(벨로나 · R3)은 "시세표는 이력이니 새 `effective_from` 으로 얹고 옛 행은 두라"다.
-- 그 원칙이 지키려는 것은 **과거 스냅샷의 설명 가능성** — 이미 `base_price_meso` 를 복사해
-- 간 클리어가 있는데 그 행을 고치면 그 기록의 출처를 설명할 수 없어진다.
--
-- 여기엔 지킬 과거가 없다. 메이린 클리어는 **0건**이고(아래 자기검증이 강제한다), null 행은
-- 오늘 만든 것이며 하루도 쓰이지 않았다. 게다가 값이 *바뀐* 것이 아니라 **우리가 몰랐던
-- 것을 알게 된 것**이라, 새 효력 시각을 만들면 "오늘 몇 시부터 3억이 되었다"는 **없던
-- 사건**을 기록하게 된다. 그쪽이 더 나쁜 거짓말이다.
--
-- ⚠️ 그래서 자기검증이 **클리어 0건을 조건으로 건다.** 나중에 이 파일을 본떠 시세를
--    제자리에서 고치려 할 때, 이미 클리어가 있으면 그 자리에서 실패한다.

-- ★ 값과 설명을 두 문장으로 나눈다. 상수 생성기가 읽는 것은 앞의 `pv` 블록이고, 튜플이
--   `(id, 가격)` 두 칸이라 파싱이 단순해진다. 별칭을 다르게 준 것은 앵커를 가르기
--   위해서다 — 같은 표에 UPDATE 가 둘이면 앵커 하나로는 앞의 것만 잡힌다.
update public.boss_crystal_prices pv
   set price_meso  = v.price,
       patch_label = '2026 OVERDRIVE'
  from (values
    ('meilin_normal', 300000000),
    ('meilin_hard',   600000000)
  ) as v(id, price)
 where pv.boss_difficulty_id = v.id;

update public.boss_crystal_prices pn
   set note = v.note
  from (values
    ('meilin_normal', '발주자 확인(2026-08-25). 공개 가격표에 없어 미상이던 값.'),
    ('meilin_hard',   '발주자 확인(2026-08-25). 공개 가격표에 없어 미상이던 값.')
  ) as v(id, note)
 where pn.boss_difficulty_id = v.id;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_clears integer;
  v_rows   integer;
  v_normal bigint;
  v_hard   bigint;
  v_exempt integer;
begin
  /*
    ★ 제자리 수정의 **전제**다. 클리어가 하나라도 있으면 그 기록은 null 을 복사해 갔고,
      이 UPDATE 는 그 출처를 설명 불가능하게 만든다(R3). 그때는 새 행을 얹어야 한다.
  */
  select count(*) into v_clears
    from public.boss_clears where boss_difficulty_id like 'meilin%';
  if v_clears > 0 then
    raise exception
      '메이린 클리어가 %건 있습니다 — 시세를 제자리에서 고치면 그 기록의 출처가 설명되지 않습니다(R3). 새 effective_from 행으로 얹으세요.',
      v_clears using errcode = 'raise_exception';
  end if;

  select count(*) into v_rows
    from public.boss_crystal_prices where boss_difficulty_id like 'meilin%';
  if v_rows <> 2 then
    raise exception '메이린 시세 행이 %건입니다(2건이어야 함).', v_rows;
  end if;

  select cp.price_meso into v_normal
    from public.current_crystal_price('meilin_normal', now()) cp;
  select cp.price_meso into v_hard
    from public.current_crystal_price('meilin_hard', now()) cp;

  if v_normal is distinct from 300000000 then
    raise exception '노멀 메이린 현재 시세가 %입니다(3억이어야 함).', coalesce(v_normal, -1);
  end if;
  if v_hard is distinct from 600000000 then
    raise exception '하드 메이린 현재 시세가 %입니다(6억이어야 함).', coalesce(v_hard, -1);
  end if;

  -- 하드가 노멀보다 싸면 어딘가 뒤집혔다는 뜻이다.
  if v_hard <= v_normal then
    raise exception '하드(%)가 노멀(%) 이하입니다.', v_hard, v_normal;
  end if;

  -- 가격이 붙었다고 12칸 면제가 풀리면 안 된다(머리말).
  select count(*) into v_exempt from public.boss_difficulties
   where id in ('meilin_normal','meilin_hard') and not counts_toward_weekly_limit;
  if v_exempt <> 2 then
    raise exception '메이린 12칸 면제가 %건입니다(2건이어야 함).', v_exempt;
  end if;

  raise notice '메이린 시세 확정 — 노멀 3억 / 하드 6억';
end $$;

select public.assert_no_public_sensitive_columns();
