-- =============================================================================
-- M_Schedule · 18. 미매핑 분류 범위 수정 — 결정은 **보스 단위**다
-- =============================================================================
-- ── 실제 DB 에서 잡은 결함 ──────────────────────────────────────────────────
-- 17 번에서 `시즌 보스 메이린` 을 (content_name=메이린, difficulty=null, cycle=null) 로
-- `intentionally_excluded` 등록했다. 그런데 실제 API 는 난이도·주기를 채워서 보낸다:
--   nexon_resolve_boss_difficulty('시즌 보스 메이린','normal','bossWeekly')
-- 유니크 키가 (content_name, difficulty, cycle) 이라 **새 행**이 생기고 resolution 이
-- 기본값 `unknown` 으로 들어갔다. 결과적으로 의도적 제외 보스가 매번
-- "미지의 신규 보스" 경고 목록에 뜬다 — 요구사항이 금지한 바로 그 상황이다.
--
-- ── 원인 ────────────────────────────────────────────────────────────────────
-- "이 보스는 우리가 안 쓴다"는 판단은 **보스(content_name) 단위**다.
-- 난이도별로 다르게 판단할 일이 없는데 분류를 난이도까지 포함한 키에 매달아 둔 것이 잘못이다.
-- 관측 행은 난이도·주기까지 남기는 게 맞지만(진단에 필요), **분류는 이름 단위로 전파**해야 한다.
--
-- ── 수정 ────────────────────────────────────────────────────────────────────
-- 기록 시 같은 content_name 에 이미 내려진 분류가 있으면 **그것을 물려받는다.**
-- 그리고 사람이 분류할 때는 그 이름의 **모든 행**에 한 번에 적용한다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 18-1. 기록 함수 — 같은 보스에 내려진 분류를 물려받는다
-- -----------------------------------------------------------------------------
create or replace function public.nexon_record_unmapped_content(
  p_content_name text,
  p_difficulty   text default null,
  p_cycle        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_id         uuid;
  v_name       text := btrim(p_content_name);
  v_resolution public.nexon_mapping_resolution;
  v_note       text;
begin
  if p_content_name is null or v_name = '' then
    return null;
  end if;

  -- ★ 분류는 보스 단위다. 같은 이름에 이미 판단이 내려져 있으면 물려받는다.
  --   그러지 않으면 의도적으로 제외한 보스가 난이도 조합마다 새로 "미지의 보스"로 뜬다.
  select u.resolution, u.note
    into v_resolution, v_note
    from public.nexon_unmapped_contents u
   where u.content_name = v_name
     and u.resolution <> 'unknown'
   order by u.first_seen_at
   limit 1;

  insert into public.nexon_unmapped_contents (content_name, difficulty, cycle, resolution, note)
  values (v_name, p_difficulty, p_cycle,
          coalesce(v_resolution, 'unknown'::public.nexon_mapping_resolution),
          v_note)
  on conflict (content_name, difficulty, cycle) do update
    set seen_count   = public.nexon_unmapped_contents.seen_count + 1,
        last_seen_at = now()
  returning id into v_id;

  return v_id;
end;
$func$;

comment on function public.nexon_record_unmapped_content(text, text, text) is
  '미매핑 content_name 기록. 분류(resolution)는 **보스 이름 단위**라 같은 이름의 기존 판단을 물려받는다. 재관측 시 카운트만 올린다.';

-- -----------------------------------------------------------------------------
-- 18-2. 사람이 분류하는 진입점 — 이름 단위로 한 번에
-- -----------------------------------------------------------------------------
create or replace function public.nexon_classify_content(
  p_content_name text,
  p_resolution   public.nexon_mapping_resolution,
  p_note         text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_rows integer;
begin
  update public.nexon_unmapped_contents
     set resolution = p_resolution,
         note       = coalesce(p_note, note)
   where content_name = btrim(p_content_name);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$func$;

comment on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) is
  '미매핑 보스를 이름 단위로 분류한다. 난이도·주기 조합이 여러 개여도 한 번에 적용되어 경고 목록에서 함께 사라진다.';

revoke all on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) from public;
revoke all on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) from anon;
revoke all on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) from authenticated;
grant execute on function public.nexon_classify_content(text, public.nexon_mapping_resolution, text) to service_role;

-- -----------------------------------------------------------------------------
-- 18-3. 이미 쌓인 행 보정
-- -----------------------------------------------------------------------------
-- 같은 이름에 판단이 있는데 'unknown' 으로 남은 행들을 끌어올린다.
update public.nexon_unmapped_contents u
   set resolution = d.resolution,
       note       = coalesce(u.note, d.note)
  from (
    select distinct on (content_name) content_name, resolution, note
    from public.nexon_unmapped_contents
    where resolution <> 'unknown'
    order by content_name, first_seen_at
  ) d
 where u.content_name = d.content_name
   and u.resolution = 'unknown';

-- 검증 중 만든 가짜 보스 기록 제거 (실제 API 가 준 이름이 아니다)
delete from public.nexon_unmapped_contents where content_name = '신규 보스 테스트';

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_open integer;
begin
  -- 실제 API 형태(난이도·주기 포함)로 의도적 제외 보스를 다시 만나도
  -- 경고 목록에 뜨면 안 된다.
  perform public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'normal', 'bossWeekly');
  perform public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'hard',   'bossWeekly');

  select count(*) into v_open
    from public.v_nexon_unmapped_open
   where content_name = '시즌 보스 메이린';

  if v_open <> 0 then
    raise exception '의도적 제외 보스가 여전히 경고 목록에 뜹니다 (%건).', v_open;
  end if;

  -- 반대로 진짜 미지의 보스는 반드시 떠야 한다.
  perform public.nexon_resolve_boss_difficulty('가상의 신규 보스 XYZ', 'hard', 'bossWeekly');
  if not exists (select 1 from public.v_nexon_unmapped_open where content_name = '가상의 신규 보스 XYZ') then
    raise exception '미지의 신규 보스가 경고 목록에 뜨지 않습니다.';
  end if;
  delete from public.nexon_unmapped_contents where content_name = '가상의 신규 보스 XYZ';
end
$$;

select public.assert_no_public_sensitive_columns();
