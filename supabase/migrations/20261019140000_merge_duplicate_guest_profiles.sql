-- ═══════════════════════════════════════════════════════════════════════════════
-- 같은 이름 게스트 합치기 — ⚠️ **적용하지 않았다. 발주자 판단 대기** (2026-10-19)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시: *"이미 생긴 중복 8종을 어떻게 할지 판단해 보고해라. 고치지는 마라."*
-- 그래서 이 파일은 **제안**이다. `supabase db push` / MCP `apply_migration` 으로
-- 적용된 적이 없고, 적용 여부는 발주자가 정한다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 지우지 않고 **합치는가**
-- ───────────────────────────────────────────────────────────────────────────────
-- `party_participants.guest_id` 의 FK 는 **ON DELETE CASCADE** 다. 게스트 행을 지우면
-- 그 사람의 참가자 행이 함께 죽고, 거기에 또 CASCADE 로 매달린 것이 있다:
--   `run_signups` · `run_drop_shares` · `party_bundle_shares` · `party_bundle_characters`.
-- 즉 "안 쓰는 것 같아서 지웠다" 가 **일정 참여 기록을 지우는 일**이 된다. 실측으로
-- 지는 쪽(loser) 아홉 행 중 하나(`구름아이` 2026-09-02 08:22 행)는 `run_signups` 4건을
-- 지고 있다 — 보관된 파티의 과거 일정이고, 지우면 그 주의 참여 기록이 사라진다.
--
-- 합치기는 그 문제가 없다: **`party_participants` 행의 id 를 그대로 두고 `guest_id`
-- 만 바꿔 끼운다.** 그래서 매달린 것 전부(참여·분배·캐릭터)가 따라오고,
-- `member_no` 도 손대지 않는다 — 번호는 재배열·재사용하지 않는다 (CLAUDE.md §1.4).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 남길 쪽(keeper)을 **가장 최근에 만들어진 행**으로 고른 이유
-- ───────────────────────────────────────────────────────────────────────────────
-- 런타임의 재사용 규칙과 **같은 규칙**이어야 한다
-- (`features/schedule/server/schedule-repo.ts` → `resolveGuestNames`: 같은 이름이
-- 둘 이상이면 가장 최근에 만들어진 것을 집는다). 규칙이 갈리면 정리 직후에 앱이
-- 다른 행을 집어 **중복이 다시 생긴다.**
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 손대지 않는 것
-- ───────────────────────────────────────────────────────────────────────────────
-- ⚠️ **승계된 게스트(`claimed_by_user_id is not null`)는 건드리지 않는다.** 실측으로
--    참가자 행이 하나도 없는 게스트 6개(`더저` · `라온내일` · `바이보라` · `죠린`(최초) ·
--    `킴잔중일땐좀` · `풍무고불빠따`)가 **전부 이 경우**다. 참가자 행이 없는 이유는
--    안 쓰여서가 아니라 초대 링크 승계(`claim_guest_profile`)가 그 자리를 계정으로
--    옮겼기 때문이고, 각 행은 `guest_claims` 1건을 지고 있다(그 FK 도 CASCADE 다).
--    지우면 **"이 사람이 승계했다"는 기록이 사라진다.** 남겨도 아무 화면에 안 나온다 —
--    후보 목록은 `party_participants` 를 지나 만들어지고, 재사용도 승계된 행은 건너뛴다.
-- ⚠️ 이름에 **유니크 제약을 걸지 않는다.** 걸면 동명이인을 넣을 수 없다(발주 지시).
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 안전장치
-- ───────────────────────────────────────────────────────────────────────────────
-- · **같은 파티에 둘 다 들어 있는 짝은 건너뛴다.** `party_participants` 에
--   `(party_id, guest_id)` 유니크가 있어 바꿔 끼우는 순간 위반이고, 무엇보다 한 파티에
--   같은 이름이 두 줄이면 그건 **정말 다른 사람일 가능성**이 가장 높은 경우다.
--   (2026-10-19 실측: 그런 짝은 0건. 그래도 가드는 남긴다.)
-- · 재실행 가능하다. 한 번 돌면 중복이 없으니 두 번째는 0건 처리로 끝난다.
-- · 끝에서 결과를 `raise notice` 로 센다. 숫자가 예상과 다르면 트랜잭션을 되돌려라.

do $$
declare
  v_merged_participants int := 0;
  v_merged_guests int := 0;
  v_skipped int := 0;
  v_rows int := 0;
  v_rec record;
begin
  /*
    지는 쪽 → 남는 쪽 짝. **승계된 행은 양쪽 모두에서 제외**한다.
    `row_number()` 의 정렬이 런타임 재사용 규칙과 같아야 한다(머리말).
  */
  create temporary table tmp_guest_merge on commit drop as
  with candidates as (
    select id, display_name, created_at
      from public.guest_profiles
     where claimed_by_user_id is null
  ),
  ranked as (
    select id, display_name, created_at,
           row_number() over (
             partition by display_name
             order by created_at desc, id desc
           ) as rn
      from candidates
     where display_name in (
       select display_name from candidates group by 1 having count(*) > 1
     )
  )
  select l.id as loser_id, l.display_name, k.id as keeper_id
    from ranked l
    join ranked k
      on k.display_name = l.display_name and k.rn = 1
   where l.rn > 1;

  for v_rec in select * from tmp_guest_merge loop
    -- 같은 파티에 둘 다 있으면 건너뛴다(머리말 안전장치).
    if exists (
      select 1
        from public.party_participants a
        join public.party_participants b on b.party_id = a.party_id
       where a.guest_id = v_rec.loser_id
         and b.guest_id = v_rec.keeper_id
    ) then
      v_skipped := v_skipped + 1;
      raise notice
        '건너뜀: % — %, % 가 같은 파티에 함께 있다(동명이인일 수 있다).',
        v_rec.display_name, v_rec.loser_id, v_rec.keeper_id;
      continue;
    end if;

    /*
      ★ 행을 **옮기지 않고 가리키는 사람만 바꾼다.** `party_participants.id` 가 그대로라
        `run_signups` · `run_drop_shares` · `party_bundle_shares` ·
        `party_bundle_characters` 가 전부 따라온다. `member_no` 는 건드리지 않는다 (§1.4).
    */
    update public.party_participants
       set guest_id = v_rec.keeper_id
     where guest_id = v_rec.loser_id;
    get diagnostics v_rows = row_count;
    v_merged_participants := v_merged_participants + v_rows;

    /*
      이제 지는 쪽은 아무도 가리키지 않는다. 그때만 지운다 — 남아 있는 참조가 있으면
      CASCADE 가 무엇을 데려갈지 알 수 없으므로 **조건부**로 둔다.
      `invite_redemptions`(SET NULL)와 `guest_claims`(CASCADE)도 함께 확인한다.
    */
    if not exists (select 1 from public.party_participants where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.guest_claims where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.invite_redemptions where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.availability_patterns where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.availability_cycles where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.availability_exceptions where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.availability_modes where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.shift_assignments where guest_id = v_rec.loser_id)
       and not exists (select 1 from public.shift_presets where guest_id = v_rec.loser_id)
    then
      delete from public.guest_profiles where id = v_rec.loser_id;
      v_merged_guests := v_merged_guests + 1;
    else
      raise notice
        '남겨둠: % (%) — 아직 가리키는 행이 있다.', v_rec.display_name, v_rec.loser_id;
    end if;
  end loop;

  raise notice
    '합침: 참가자 % 행 · 게스트 % 행 삭제 · 건너뜀 % 짝',
    v_merged_participants, v_merged_guests, v_skipped;

  -- 끝났으면 같은 이름의 **미승계** 게스트가 남아 있지 않아야 한다(건너뛴 짝 제외).
  if v_skipped = 0 and exists (
    select 1 from public.guest_profiles
     where claimed_by_user_id is null
     group by display_name having count(*) > 1
  ) then
    raise exception '합치고도 같은 이름 게스트가 남아 있다 — 되돌려라.';
  end if;
end
$$;

-- ⚠️ 민감 컬럼 가드 — CLAUDE.md §0.3. 이 파일은 컬럼을 추가하지도 GRANT 를 바꾸지도
--    않지만, **호출을 생략하는 것이 규칙 위반**이다(생략으로 통과한 전례가 share_bp 유출).
select public.assert_no_public_sensitive_columns();
