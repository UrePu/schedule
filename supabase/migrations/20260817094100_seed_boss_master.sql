-- =============================================================================
-- M_Schedule · 17. 보스 마스터 시드
-- =============================================================================
-- 출처: Claude/research-BOSS-DATA.md (표) + Claude/review-BOSS-DATA.md (교차검증)
--       + Claude/NEXON-API-OBSERVED.md (실측 content_name 32종)
--
-- 보스 그룹 32 / 난이도 엔트리 78 (일간 24 · 주간 52 · 월간 2)
--
-- ── 시드하면서 내린 판단 3가지 ────────────────────────────────────────────
-- 1. `radiant_omen` → **`radiant_malefic_star`** 로 고쳐 넣는다.
--    review-BOSS-DATA.md 가 "찬란한 흉성의 영문명은 Radiant Malefic Star 이고,
--    id 가 DB 영구 키라고 스스로 못 박은 이상 지금 고치는 것이 옳다"고 지적했다.
--    출시 후에는 변경 비용이 발생하므로 **시드 시점인 지금이 마지막 기회**다.
--
-- 2. **모호한 별칭 2개는 넣지 않는다.**
--    `노벨` → 노멀 벨룸 / 노멀 벨로나 양쪽에 걸린다.
--    `노반` → 노멀 반반 / 노멀 반 레온 양쪽에 걸린다.
--    봇이 조용히 엉뚱한 보스에 등록하는 것보다 두 글자 더 치게 하는 편이 낫다
--    (research-KAKAO-BOT §2.10 이 정확히 경고한 사고 유형).
--    → `노벨룸`/`노벨로나`, `노반반`/`노반레` 를 쓴다.
--
-- 3. **벨로나 3종은 가격 null + released=false** (CLAUDE.md §1.3 D4).
--    이지/하드는 단일 출처, 노멀은 850M vs 890M 출처 충돌이라 셋 다 신뢰도가 같다.
--    null 은 0 이 아니라 "미확인"이며 수익 집계에서 제외되고 별도로 카운트된다.
--
-- 재실행 안전: 전부 on conflict do update. 별칭만 seed 출처로 지우고 다시 넣는다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 17-1. 보스 그룹 (32)
-- -----------------------------------------------------------------------------
-- nexon_content_name 은 NEXON-API-OBSERVED.md 의 실측 32종에서 그대로 가져왔다.
-- 벨로나만 미출시라 실측되지 않았고, 그 사실을 nexon_name_verified = false 로 남긴다.
insert into public.bosses (id, korean_name, generation, nexon_content_name, nexon_name_verified, sort_order)
values
  ('zakum',                '자쿰',              'classic', '자쿰',              true,  10),
  ('papulatus',            '파풀라투스',        'classic', '파풀라투스',        true,  20),
  ('magnus',               '매그너스',          'classic', '매그너스',          true,  30),
  ('hilla',                '힐라',              'classic', '힐라',              true,  40),
  ('horntail',             '혼테일',            'classic', '혼테일',            true,  50),
  ('bloody_queen',         '블러디퀸',          'classic', '블러디퀸',          true,  60),
  ('von_bon',              '반반',              'classic', '반반',              true,  70),
  ('pierre',               '피에르',            'classic', '피에르',            true,  80),
  ('vellum',               '벨룸',              'classic', '벨룸',              true,  90),
  ('von_leon',             '반 레온',           'classic', '반 레온',           true, 100),
  ('arkarium',             '아카이럼',          'classic', '아카이럼',          true, 110),
  ('kaung',                '카웅',              'classic', '카웅',              true, 120),
  ('pink_bean',            '핑크빈',            'classic', '핑크빈',            true, 130),
  ('cygnus',               '시그너스',          'classic', '시그너스',          true, 140),
  ('lotus',                '스우',              'classic', '스우',              true, 150),
  ('damien',               '데미안',            'classic', '데미안',            true, 160),
  ('guardian_angel_slime', '가디언 엔젤 슬라임','classic', '가디언 엔젤 슬라임',true, 170),
  ('lucid',                '루시드',            'classic', '루시드',            true, 180),
  ('will',                 '윌',                'classic', '윌',                true, 190),
  ('dusk',                 '더스크',            'classic', '더스크',            true, 200),
  ('dunkel',               '듄켈',              'classic', '듄켈',              true, 210),
  ('verus_hilla',          '진 힐라',           'classic', '진 힐라',           true, 220),
  ('seren',                '선택받은 세렌',     'classic', '선택받은 세렌',     true, 230),
  ('kalos',                '감시자 칼로스',     'classic', '감시자 칼로스',     true, 240),
  ('first_adversary',      '최초의 대적자',     'modern',  '최초의 대적자',     true, 250),
  ('kaling',               '카링',              'classic', '카링',              true, 260),
  -- 미출시라 실측되지 않았다. 이름은 추정이며 조인이 실패할 수 있다.
  ('bellona',              '벨로나',            'modern',  '벨로나',            false,270),
  ('radiant_malefic_star', '찬란한 흉성',       'modern',  '찬란한 흉성',       true, 280),
  ('limbo',                '림보',              'modern',  '림보',              true, 290),
  ('baldrix',              '발드릭스',          'modern',  '발드릭스',          true, 300),
  ('jupiter',              '유피테르',          'modern',  '유피테르',          true, 310),
  ('black_mage',           '검은 마법사',       'classic', '검은 마법사',       true, 320)
on conflict (id) do update set
  korean_name         = excluded.korean_name,
  generation          = excluded.generation,
  nexon_content_name  = excluded.nexon_content_name,
  nexon_name_verified = excluded.nexon_name_verified,
  sort_order          = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 17-2. 난이도 엔트리 (78)
-- -----------------------------------------------------------------------------
-- max_party: 구세대 6 / 신세대 3 / **익스트림 스우만 2** (CLAUDE.md §1.3 D5 — 소프트 상한)
insert into public.boss_difficulties
  (id, boss_id, korean_name, difficulty, cycle, max_party, entry_level, released, nexon_difficulty, sort_order)
values
  -- ── 일간 24 ─────────────────────────────────────────────────────────────
  ('zakum_easy',                'zakum',       '이지 자쿰',        'easy',   'daily', 6,  50, true, 'easy',    10),
  ('zakum_normal',              'zakum',       '노멀 자쿰',        'normal', 'daily', 6,  90, true, 'normal',  20),
  ('papulatus_easy',            'papulatus',   '이지 파풀라투스',  'easy',   'daily', 6, 115, true, 'easy',    30),
  ('magnus_easy',               'magnus',      '이지 매그너스',    'easy',   'daily', 6, 115, true, 'easy',    40),
  ('hilla_normal',              'hilla',       '노멀 힐라',        'normal', 'daily', 6,  85, true, 'normal',  50),
  ('horntail_easy',             'horntail',    '이지 혼테일',      'easy',   'daily', 6, 130, true, 'easy',    60),
  ('bloody_queen_normal',       'bloody_queen','노멀 블러디퀸',    'normal', 'daily', 6, 125, true, 'normal',  70),
  ('von_bon_normal',            'von_bon',     '노멀 반반',        'normal', 'daily', 6, 125, true, 'normal',  80),
  ('pierre_normal',             'pierre',      '노멀 피에르',      'normal', 'daily', 6, 125, true, 'normal',  90),
  ('vellum_normal',             'vellum',      '노멀 벨룸',        'normal', 'daily', 6, 125, true, 'normal', 100),
  ('horntail_normal',           'horntail',    '노멀 혼테일',      'normal', 'daily', 6, 130, true, 'normal', 110),
  ('von_leon_easy',             'von_leon',    '이지 반 레온',     'easy',   'daily', 6, 125, true, 'easy',   120),
  ('arkarium_easy',             'arkarium',    '이지 아카이럼',    'easy',   'daily', 6, 140, true, 'easy',   130),
  ('kaung_normal',              'kaung',       '노멀 카웅',        'normal', 'daily', 6, 180, true, 'normal', 140),
  ('horntail_chaos',            'horntail',    '카오스 혼테일',    'chaos',  'daily', 6, 135, true, 'chaos',  150),
  ('pink_bean_normal',          'pink_bean',   '노멀 핑크빈',      'normal', 'daily', 6, 140, true, 'normal', 160),
  ('von_leon_normal',           'von_leon',    '노멀 반 레온',     'normal', 'daily', 6, 125, true, 'normal', 170),
  ('von_leon_hard',             'von_leon',    '하드 반 레온',     'hard',   'daily', 6, 125, true, 'hard',   180),
  ('arkarium_normal',           'arkarium',    '노멀 아카이럼',    'normal', 'daily', 6, 140, true, 'normal', 190),
  ('magnus_normal',             'magnus',      '노멀 매그너스',    'normal', 'daily', 6, 155, true, 'normal', 200),
  ('papulatus_normal',          'papulatus',   '노멀 파풀라투스',  'normal', 'daily', 6, 155, true, 'normal', 210),
  ('hilla_hard',                'hilla',       '하드 힐라',        'hard',   'daily', 6, 170, true, 'hard',   220),
  ('pink_bean_chaos',           'pink_bean',   '카오스 핑크빈',    'chaos',  'daily', 6, 170, true, 'chaos',  230),
  ('cygnus_normal',             'cygnus',      '노멀 시그너스',    'normal', 'daily', 6, 165, true, 'normal', 240),

  -- ── 주간 52 ─────────────────────────────────────────────────────────────
  ('zakum_chaos',                     'zakum',                '카오스 자쿰',                 'chaos',   'weekly', 6,  90, true, 'chaos',  310),
  ('bloody_queen_chaos',              'bloody_queen',         '카오스 블러디퀸',             'chaos',   'weekly', 6, 180, true, 'chaos',  320),
  ('von_bon_chaos',                   'von_bon',              '카오스 반반',                 'chaos',   'weekly', 6, 180, true, 'chaos',  330),
  ('pierre_chaos',                    'pierre',               '카오스 피에르',               'chaos',   'weekly', 6, 180, true, 'chaos',  340),
  ('magnus_hard',                     'magnus',               '하드 매그너스',               'hard',    'weekly', 6, 175, true, 'hard',   350),
  ('vellum_chaos',                    'vellum',               '카오스 벨룸',                 'chaos',   'weekly', 6, 180, true, 'chaos',  360),
  ('papulatus_chaos',                 'papulatus',            '카오스 파풀라투스',           'chaos',   'weekly', 6, 190, true, 'chaos',  370),
  ('lotus_normal',                    'lotus',                '노멀 스우',                   'normal',  'weekly', 6, 190, true, 'normal', 380),
  ('damien_normal',                   'damien',               '노멀 데미안',                 'normal',  'weekly', 6, 190, true, 'normal', 390),
  ('guardian_angel_slime_normal',     'guardian_angel_slime', '노멀 가디언 엔젤 슬라임',     'normal',  'weekly', 6, 210, true, 'normal', 400),
  ('lucid_easy',                      'lucid',                '이지 루시드',                 'easy',    'weekly', 6, 220, true, 'easy',   410),
  ('will_easy',                       'will',                 '이지 윌',                     'easy',    'weekly', 6, 235, true, 'easy',   420),
  ('lucid_normal',                    'lucid',                '노멀 루시드',                 'normal',  'weekly', 6, 220, true, 'normal', 430),
  ('will_normal',                     'will',                 '노멀 윌',                     'normal',  'weekly', 6, 235, true, 'normal', 440),
  ('dusk_normal',                     'dusk',                 '노멀 더스크',                 'normal',  'weekly', 6, 245, true, 'normal', 450),
  ('dunkel_normal',                   'dunkel',               '노멀 듄켈',                   'normal',  'weekly', 6, 255, true, 'normal', 460),
  ('damien_hard',                     'damien',               '하드 데미안',                 'hard',    'weekly', 6, 190, true, 'hard',   470),
  ('lotus_hard',                      'lotus',                '하드 스우',                   'hard',    'weekly', 6, 190, true, 'hard',   480),
  ('lucid_hard',                      'lucid',                '하드 루시드',                 'hard',    'weekly', 6, 220, true, 'hard',   490),
  ('dusk_chaos',                      'dusk',                 '카오스 더스크',               'chaos',   'weekly', 6, 245, true, 'chaos',  500),
  ('verus_hilla_normal',              'verus_hilla',          '노멀 진 힐라',                'normal',  'weekly', 6, 250, true, 'normal', 510),
  ('guardian_angel_slime_chaos',      'guardian_angel_slime', '카오스 가디언 엔젤 슬라임',   'chaos',   'weekly', 6, 210, true, 'chaos',  520),
  ('will_hard',                       'will',                 '하드 윌',                     'hard',    'weekly', 6, 235, true, 'hard',   530),
  ('dunkel_hard',                     'dunkel',               '하드 듄켈',                   'hard',    'weekly', 6, 255, true, 'hard',   540),
  ('verus_hilla_hard',                'verus_hilla',          '하드 진 힐라',                'hard',    'weekly', 6, 250, true, 'hard',   550),
  ('seren_normal',                    'seren',                '노멀 선택받은 세렌',          'normal',  'weekly', 6, 260, true, 'normal', 560),
  ('kalos_easy',                      'kalos',                '이지 감시자 칼로스',          'easy',    'weekly', 6, 265, true, 'easy',   570),
  ('first_adversary_easy',            'first_adversary',      '이지 최초의 대적자',          'easy',    'weekly', 3, 270, true, 'easy',   580),
  ('seren_hard',                      'seren',                '하드 선택받은 세렌',          'hard',    'weekly', 6, 260, true, 'hard',   590),
  ('kaling_easy',                     'kaling',               '이지 카링',                   'easy',    'weekly', 6, 275, true, 'easy',   600),
  ('bellona_easy',                    'bellona',              '이지 벨로나',                 'easy',    'weekly', 3, 280, false,'easy',   610),
  ('kalos_normal',                    'kalos',                '노멀 감시자 칼로스',          'normal',  'weekly', 6, 265, true, 'normal', 620),
  ('first_adversary_normal',          'first_adversary',      '노멀 최초의 대적자',          'normal',  'weekly', 3, 270, true, 'normal', 630),
  ('lotus_extreme',                   'lotus',                '익스트림 스우',               'extreme', 'weekly', 2, 190, true, 'extreme',640),
  ('radiant_malefic_star_normal',     'radiant_malefic_star', '노멀 찬란한 흉성',            'normal',  'weekly', 3, 280, true, 'normal', 650),
  ('kaling_normal',                   'kaling',               '노멀 카링',                   'normal',  'weekly', 6, 275, true, 'normal', 660),
  ('bellona_normal',                  'bellona',              '노멀 벨로나',                 'normal',  'weekly', 3, 280, false,'normal', 670),
  ('limbo_normal',                    'limbo',                '노멀 림보',                   'normal',  'weekly', 3, 285, true, 'normal', 680),
  ('kalos_chaos',                     'kalos',                '카오스 감시자 칼로스',        'chaos',   'weekly', 6, 265, true, 'chaos',  690),
  ('baldrix_normal',                  'baldrix',              '노멀 발드릭스',               'normal',  'weekly', 3, 290, true, 'normal', 700),
  ('first_adversary_hard',            'first_adversary',      '하드 최초의 대적자',          'hard',    'weekly', 3, 270, true, 'hard',   710),
  ('jupiter_normal',                  'jupiter',              '노멀 유피테르',               'normal',  'weekly', 3, 295, true, 'normal', 720),
  ('kaling_hard',                     'kaling',               '하드 카링',                   'hard',    'weekly', 6, 275, true, 'hard',   730),
  ('limbo_hard',                      'limbo',                '하드 림보',                   'hard',    'weekly', 3, 285, true, 'hard',   740),
  ('radiant_malefic_star_hard',       'radiant_malefic_star', '하드 찬란한 흉성',            'hard',    'weekly', 3, 280, true, 'hard',   750),
  ('seren_extreme',                   'seren',                '익스트림 선택받은 세렌',      'extreme', 'weekly', 6, 260, true, 'extreme',760),
  ('bellona_hard',                    'bellona',              '하드 벨로나',                 'hard',    'weekly', 3, 280, false,'hard',   770),
  ('baldrix_hard',                    'baldrix',              '하드 발드릭스',               'hard',    'weekly', 3, 290, true, 'hard',   780),
  ('kalos_extreme',                   'kalos',                '익스트림 감시자 칼로스',      'extreme', 'weekly', 6, 265, true, 'extreme',790),
  ('first_adversary_extreme',         'first_adversary',      '익스트림 최초의 대적자',      'extreme', 'weekly', 3, 270, true, 'extreme',800),
  ('jupiter_hard',                    'jupiter',              '하드 유피테르',               'hard',    'weekly', 3, 295, true, 'hard',   810),
  ('kaling_extreme',                  'kaling',               '익스트림 카링',               'extreme', 'weekly', 6, 275, true, 'extreme',820),

  -- ── 월간 2 ──────────────────────────────────────────────────────────────
  ('black_mage_hard',    'black_mage', '하드 검은 마법사',     'hard',    'monthly', 6, 255, true, 'hard',    910),
  ('black_mage_extreme', 'black_mage', '익스트림 검은 마법사', 'extreme', 'monthly', 6, 255, true, 'extreme', 920)
on conflict (id) do update set
  boss_id          = excluded.boss_id,
  korean_name      = excluded.korean_name,
  difficulty       = excluded.difficulty,
  cycle            = excluded.cycle,
  max_party        = excluded.max_party,
  entry_level      = excluded.entry_level,
  released         = excluded.released,
  nexon_difficulty = excluded.nexon_difficulty,
  sort_order       = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- 17-3. 결정석 시세
-- -----------------------------------------------------------------------------
-- 기준 패치: 1.2.202 (2026-06-18 OVERDRIVE). 월간(검은 마법사)만 2026-07-01 적용.
insert into public.boss_crystal_prices (boss_difficulty_id, price_meso, effective_from, patch_label, note)
values
  ('zakum_easy',                   114000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('zakum_normal',                 349000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('papulatus_easy',               390000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('magnus_easy',                  411000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('hilla_normal',                 455000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('horntail_easy',                502000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bloody_queen_normal',          551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_bon_normal',               551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('pierre_normal',                551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('vellum_normal',                551000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('horntail_normal',              576000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_leon_easy',                602000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('arkarium_easy',                656000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaung_normal',                 712000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('horntail_chaos',               770000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('pink_bean_normal',             799000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_leon_normal',              830000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_leon_hard',               1070000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('arkarium_normal',             1110000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('magnus_normal',               1160000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('papulatus_normal',            1200000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('hilla_hard',                  1280000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '2026-06-18 주간→일간 원복'),
  ('pink_bean_chaos',             1320000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '2026-06-18 주간→일간 원복'),
  ('cygnus_normal',               1360000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '2026-06-18 주간→일간 원복 + 이지/노멀 통합'),

  ('zakum_chaos',                 8080000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bloody_queen_chaos',          8140000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('von_bon_chaos',               8150000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('pierre_chaos',                8170000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('magnus_hard',                 8560000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('vellum_chaos',                9280000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('papulatus_chaos',            13100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lotus_normal',               16700000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('damien_normal',              17500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('guardian_angel_slime_normal',25500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lucid_easy',                 29800000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('will_easy',                  32300000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lucid_normal',               35600000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('will_normal',                41100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dusk_normal',                44000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dunkel_normal',              47500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('damien_hard',                48900000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lotus_hard',                 51500000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lucid_hard',                 62900000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dusk_chaos',                 69800000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('verus_hilla_normal',         71200000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('guardian_angel_slime_chaos', 75100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('will_hard',                  77100000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('dunkel_hard',                94400000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('verus_hilla_hard',          106000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('seren_normal',              239000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kalos_easy',                280000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_easy',      308000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('seren_hard',                356000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_easy',               377000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  -- ★ 벨로나 3종: 가격 미확인. null 은 0 이 아니다 (CLAUDE.md §1.3 D4)
  ('bellona_easy',                   null, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '미출시(2026-08-20 예정). 단일 출처뿐이라 확정 불가 — null 은 0 이 아니라 미확인'),
  ('kalos_normal',              505000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_normal',    560000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('lotus_extreme',             574000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '최대 2인 — 1인당 287,000,000'),
  ('radiant_malefic_star_normal',625000000,timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_normal',             678000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bellona_normal',                 null, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '미출시(2026-08-20 예정). 출처 충돌 850,000,000 vs 890,000,000 — 확정 불가'),
  ('limbo_normal',             1026000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kalos_chaos',              1273000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('baldrix_normal',           1368000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_hard',     1435000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('jupiter_normal',           1615000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_hard',              1739000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('limbo_hard',               2385000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('radiant_malefic_star_hard',2678000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('seren_extreme',            2835000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('bellona_hard',                   null, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', '미출시(2026-08-21 예정). 단일 출처뿐이라 확정 불가'),
  ('baldrix_hard',             3078000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kalos_extreme',            4104000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('first_adversary_extreme',  4712000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('jupiter_hard',             4845000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),
  ('kaling_extreme',           5387000000, timestamptz '2026-06-18 00:00+09', '1.2.202 (2026-06-18)', null),

  ('black_mage_hard',           665000000, timestamptz '2026-07-01 00:00+09', '월간 결정 2026-07-01 적용', null),
  ('black_mage_extreme',       8740000000, timestamptz '2026-07-01 00:00+09', '월간 결정 2026-07-01 적용', null)
on conflict (boss_difficulty_id, effective_from) do update set
  price_meso  = excluded.price_meso,
  patch_label = excluded.patch_label,
  note        = excluded.note;

-- -----------------------------------------------------------------------------
-- 17-4. 별칭
-- -----------------------------------------------------------------------------
-- 시드 출처 행만 지우고 다시 넣는다. 운영 중 손으로 추가한 별칭(source <> 'seed:...')은 보존된다.
delete from public.boss_aliases where source = 'seed:research-BOSS-DATA';

insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id, v.entry_id, v.alias, lower(btrim(replace(v.alias, ' ', ''))), 'seed:research-BOSS-DATA'
from (values
  -- ── 그룹 별칭 (난이도 미지정 → 봇이 후보가 여럿이면 되묻는다) ─────────────
  ('zakum', null, '자쿰'), ('zakum', null, '쟈쿰'),
  ('papulatus', null, '파풀라투스'), ('papulatus', null, '파풀'),
  ('magnus', null, '매그너스'), ('magnus', null, '매그'),
  ('hilla', null, '힐라'),
  ('horntail', null, '혼테일'), ('horntail', null, '혼테'),
  ('bloody_queen', null, '블러디퀸'), ('bloody_queen', null, '블퀸'),
  ('von_bon', null, '반반'),
  ('pierre', null, '피에르'),
  ('vellum', null, '벨룸'),
  ('von_leon', null, '반레온'), ('von_leon', null, '반레'),
  ('arkarium', null, '아카이럼'), ('arkarium', null, '아카'),
  ('kaung', null, '카웅'),
  ('pink_bean', null, '핑크빈'), ('pink_bean', null, '핑빈'),
  ('cygnus', null, '시그너스'), ('cygnus', null, '시그'), ('cygnus', null, '여제'),
  ('lotus', null, '스우'),
  ('damien', null, '데미안'), ('damien', null, '데미'),
  ('guardian_angel_slime', null, '가엔슬'), ('guardian_angel_slime', null, '슬라임'), ('guardian_angel_slime', null, 'GAS'),
  ('lucid', null, '루시드'),
  ('will', null, '윌'),
  ('dusk', null, '더스크'),
  ('dunkel', null, '듄켈'),
  ('verus_hilla', null, '진힐라'), ('verus_hilla', null, '진힐'),
  ('seren', null, '세렌'),
  ('kalos', null, '칼로스'),
  ('first_adversary', null, '적자'), ('first_adversary', null, '최적자'),
  ('kaling', null, '카링'),
  ('bellona', null, '벨로나'),
  ('radiant_malefic_star', null, '흉성'), ('radiant_malefic_star', null, '찬흉'),
  ('limbo', null, '림보'),
  ('baldrix', null, '발드릭스'), ('baldrix', null, '발드'),
  ('jupiter', null, '유피테르'), ('jupiter', null, '유피'),
  ('black_mage', null, '검마'), ('black_mage', null, '흑마'),

  -- ── 난이도 특정 별칭 ──────────────────────────────────────────────────────
  ('zakum','zakum_easy','이자쿰'), ('zakum','zakum_easy','이쟈쿰'), ('zakum','zakum_easy','이자'),
  ('zakum','zakum_normal','노자쿰'), ('zakum','zakum_normal','노자'),
  ('zakum','zakum_chaos','카자쿰'), ('zakum','zakum_chaos','카쿰'), ('zakum','zakum_chaos','카자'),
  ('papulatus','papulatus_easy','이파풀'), ('papulatus','papulatus_easy','이파'),
  ('papulatus','papulatus_normal','노파풀'), ('papulatus','papulatus_normal','노파'),
  ('papulatus','papulatus_chaos','카파풀'), ('papulatus','papulatus_chaos','카파'),
  ('magnus','magnus_easy','이매그'), ('magnus','magnus_easy','이매'),
  ('magnus','magnus_normal','노매그'), ('magnus','magnus_normal','노매'),
  ('magnus','magnus_hard','하매그'), ('magnus','magnus_hard','하매'),
  ('hilla','hilla_normal','노힐라'), ('hilla','hilla_normal','노힐'),
  ('hilla','hilla_hard','하드힐라'), ('hilla','hilla_hard','하힐라'), ('hilla','hilla_hard','하힐'),
  ('horntail','horntail_easy','이혼테'), ('horntail','horntail_easy','이혼'),
  ('horntail','horntail_normal','노혼테'), ('horntail','horntail_normal','노혼'),
  ('horntail','horntail_chaos','카혼테'), ('horntail','horntail_chaos','카혼'), ('horntail','horntail_chaos','카오스혼테일'),
  ('bloody_queen','bloody_queen_normal','노블퀸'), ('bloody_queen','bloody_queen_normal','노블'),
  ('bloody_queen','bloody_queen_chaos','카블퀸'), ('bloody_queen','bloody_queen_chaos','카블'),
  -- ⚠️ `노반` 은 노멀 반반 / 노멀 반 레온 양쪽에 걸려 **의도적으로 제외**한다.
  ('von_bon','von_bon_normal','노반반'),
  ('von_bon','von_bon_chaos','카반반'), ('von_bon','von_bon_chaos','카반'),
  ('pierre','pierre_normal','노피에르'), ('pierre','pierre_normal','노피'),
  ('pierre','pierre_chaos','카피에르'), ('pierre','pierre_chaos','카피'),
  -- ⚠️ `노벨` 은 노멀 벨룸 / 노멀 벨로나 양쪽에 걸려 **의도적으로 제외**한다.
  ('vellum','vellum_normal','노벨룸'),
  ('vellum','vellum_chaos','카벨룸'), ('vellum','vellum_chaos','카벨'),
  ('von_leon','von_leon_easy','이반레'), ('von_leon','von_leon_easy','이반'),
  ('von_leon','von_leon_normal','노반레'),
  ('von_leon','von_leon_hard','하반레'), ('von_leon','von_leon_hard','하반'), ('von_leon','von_leon_hard','하드반레온'),
  ('arkarium','arkarium_easy','이아카'),
  ('arkarium','arkarium_normal','노아카'),
  ('kaung','kaung_normal','노카웅'),
  ('pink_bean','pink_bean_normal','노핑빈'), ('pink_bean','pink_bean_normal','노핑'),
  ('pink_bean','pink_bean_chaos','카핑빈'), ('pink_bean','pink_bean_chaos','카핑'), ('pink_bean','pink_bean_chaos','카오스핑크빈'),
  ('cygnus','cygnus_normal','노시그'),
  ('lotus','lotus_normal','노스우'), ('lotus','lotus_normal','노스'),
  ('lotus','lotus_hard','하스우'), ('lotus','lotus_hard','하스'),
  ('lotus','lotus_extreme','익스우'), ('lotus','lotus_extreme','익스스우'), ('lotus','lotus_extreme','익스'),
  ('damien','damien_normal','노데미'), ('damien','damien_normal','노데'),
  ('damien','damien_hard','하데미'), ('damien','damien_hard','하데'),
  ('guardian_angel_slime','guardian_angel_slime_normal','노가엔슬'),
  ('guardian_angel_slime','guardian_angel_slime_chaos','카가엔슬'), ('guardian_angel_slime','guardian_angel_slime_chaos','카슬라임'),
  ('lucid','lucid_easy','이루시드'), ('lucid','lucid_easy','이루'),
  ('lucid','lucid_normal','노루시드'), ('lucid','lucid_normal','노루'),
  ('lucid','lucid_hard','하루시드'), ('lucid','lucid_hard','하루'),
  ('will','will_easy','이윌'), ('will','will_normal','노윌'), ('will','will_hard','하윌'),
  ('dusk','dusk_normal','노더스크'), ('dusk','dusk_normal','노더'),
  ('dusk','dusk_chaos','카더스크'), ('dusk','dusk_chaos','카더'),
  ('dunkel','dunkel_normal','노듄켈'), ('dunkel','dunkel_normal','노듄'),
  ('dunkel','dunkel_hard','하듄켈'), ('dunkel','dunkel_hard','하듄'),
  ('verus_hilla','verus_hilla_normal','노진힐라'), ('verus_hilla','verus_hilla_normal','노진힐'),
  ('verus_hilla','verus_hilla_hard','하진힐라'), ('verus_hilla','verus_hilla_hard','하진힐'),
  ('seren','seren_normal','노세렌'), ('seren','seren_normal','노세'),
  ('seren','seren_hard','하세렌'), ('seren','seren_hard','하세'),
  ('seren','seren_extreme','익세렌'), ('seren','seren_extreme','익세'),
  ('kalos','kalos_easy','이칼로스'), ('kalos','kalos_easy','이칼'),
  ('kalos','kalos_normal','노칼로스'), ('kalos','kalos_normal','노칼'),
  ('kalos','kalos_chaos','카칼로스'), ('kalos','kalos_chaos','카칼'),
  ('kalos','kalos_extreme','익칼로스'), ('kalos','kalos_extreme','익칼'),
  ('first_adversary','first_adversary_easy','이적자'), ('first_adversary','first_adversary_easy','이최적자'),
  ('first_adversary','first_adversary_normal','노적자'), ('first_adversary','first_adversary_normal','노최적자'),
  ('first_adversary','first_adversary_hard','하적자'), ('first_adversary','first_adversary_hard','하최적자'),
  ('first_adversary','first_adversary_extreme','익적자'), ('first_adversary','first_adversary_extreme','익최적자'),
  ('kaling','kaling_easy','이카링'), ('kaling','kaling_easy','이카'),
  ('kaling','kaling_normal','노카링'), ('kaling','kaling_normal','노카'),
  ('kaling','kaling_hard','하카링'), ('kaling','kaling_hard','하카'),
  ('kaling','kaling_extreme','익카링'), ('kaling','kaling_extreme','익카'),
  ('bellona','bellona_easy','이벨로나'), ('bellona','bellona_easy','이벨'),
  ('bellona','bellona_normal','노벨로나'),
  ('bellona','bellona_hard','하벨로나'), ('bellona','bellona_hard','하벨'),
  ('radiant_malefic_star','radiant_malefic_star_normal','노흉성'),
  ('radiant_malefic_star','radiant_malefic_star_hard','하흉성'), ('radiant_malefic_star','radiant_malefic_star_hard','하흉'),
  ('limbo','limbo_normal','노림보'), ('limbo','limbo_normal','노림'),
  ('limbo','limbo_hard','하림보'), ('limbo','limbo_hard','하림'),
  ('baldrix','baldrix_normal','노발드'),
  ('baldrix','baldrix_hard','하발드릭스'), ('baldrix','baldrix_hard','하발드'),
  ('jupiter','jupiter_normal','노유피'),
  ('jupiter','jupiter_hard','하유피테르'), ('jupiter','jupiter_hard','하유피'),
  ('black_mage','black_mage_hard','하검마'), ('black_mage','black_mage_hard','하검'), ('black_mage','black_mage_hard','하드검은마법사'),
  ('black_mage','black_mage_extreme','익검마'), ('black_mage','black_mage_extreme','익검'), ('black_mage','black_mage_extreme','익스검마')
) as v(boss_id, entry_id, alias);

-- -----------------------------------------------------------------------------
-- 17-5. 의도적 제외 보스 등록
-- -----------------------------------------------------------------------------
-- 실측 content_name 32종 중 `시즌 보스 메이린` 은 챌린저스 월드 전용 이벤트 보스라
-- 우리 마스터에서 **의도적으로 제외**했다(주간 12회 제한 미포함, 2026-09-16 입장 종료).
-- 미리 등록해 두지 않으면 동기화가 이걸 "미지의 신규 보스"로 계속 경고한다.
insert into public.nexon_unmapped_contents (content_name, difficulty, cycle, resolution, note)
values
  ('시즌 보스 메이린', null, null, 'intentionally_excluded',
   '챌린저스 월드 전용 이벤트 보스. 주간 12회 제한에 포함되지 않고 2026-09-16 입장 종료. 결정석 수익 계산 대상이 아니라 의도적으로 마스터에서 제외했다.')
on conflict (content_name, difficulty, cycle) do update set
  resolution = excluded.resolution,
  note       = excluded.note;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_bosses   integer;
  v_entries  integer;
  v_daily    integer;
  v_weekly   integer;
  v_monthly  integer;
  v_missing  text;
  v_observed text[] := array[
    '가디언 엔젤 슬라임','감시자 칼로스','검은 마법사','더스크','데미안','듄켈','루시드','림보',
    '매그너스','반 레온','반반','발드릭스','벨룸','블러디퀸','선택받은 세렌','스우','시그너스',
    '시즌 보스 메이린','아카이럼','윌','유피테르','자쿰','진 힐라','찬란한 흉성','최초의 대적자',
    '카링','카웅','파풀라투스','피에르','핑크빈','혼테일','힐라'
  ];
begin
  select count(*) into v_bosses  from public.bosses;
  select count(*) into v_entries from public.boss_difficulties;
  if v_bosses <> 32 then raise exception '보스 그룹이 32개가 아닙니다: %', v_bosses; end if;
  if v_entries <> 78 then raise exception '난이도 엔트리가 78개가 아닙니다: %', v_entries; end if;

  select count(*) filter (where cycle='daily'),
         count(*) filter (where cycle='weekly'),
         count(*) filter (where cycle='monthly')
    into v_daily, v_weekly, v_monthly
    from public.boss_difficulties;
  if v_daily <> 24 or v_weekly <> 52 or v_monthly <> 2 then
    raise exception '주기별 개수 오류: daily=% weekly=% monthly=%', v_daily, v_weekly, v_monthly;
  end if;

  -- ★ 핵심: 실측 32종이 전부 해석되는가.
  --   메이린은 의도적 제외로 등록되어 있어야 하고, 나머지 31종은 보스로 조인되어야 한다.
  select string_agg(o.name, ', ') into v_missing
  from unnest(v_observed) as o(name)
  where not exists (select 1 from public.bosses b where b.nexon_content_name = o.name)
    and not exists (
      select 1 from public.nexon_unmapped_contents u
      where u.content_name = o.name and u.resolution <> 'unknown'
    );
  if v_missing is not null then
    raise exception '실측 content_name 중 해석되지 않는 것이 있습니다: %', v_missing;
  end if;

  -- 벨로나 3종은 가격이 없어야 한다.
  if exists (
    select 1 from public.boss_crystal_prices p
    join public.boss_difficulties bd on bd.id = p.boss_difficulty_id
    where bd.boss_id = 'bellona' and p.price_meso is not null
  ) then
    raise exception '벨로나에 가격이 들어갔습니다. null(미확인)이어야 합니다.';
  end if;

  if exists (select 1 from public.boss_difficulties where boss_id = 'bellona' and released) then
    raise exception '벨로나가 released=true 입니다. 미출시여야 합니다.';
  end if;

  -- 모호 별칭이 들어가지 않았는가
  if exists (select 1 from public.boss_aliases where normalized_alias in ('노벨', '노반')) then
    raise exception '모호한 별칭(노벨/노반)이 시드되었습니다.';
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();
