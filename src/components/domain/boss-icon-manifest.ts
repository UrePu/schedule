import type { BossDifficultyId } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `public/bosses/` 에 실제로 파일이 있는 `boss_difficulties.id` 목록 — **생성물**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 런타임 `onError` 가 아니라 정적 목록인가
 * ─────────────────────────────────────────────────────────────────────────────
 * `boss_difficulties` 78개 중 아이콘이 있는 것은 47개뿐이다. 나머지 31개를 `<img>` 로
 * 일단 그려 보고 `onError` 로 폴백하면, 그릴 때마다 **404 요청이 실제로 나가고** 콘솔이
 * 빨개지며, 폴백이 뜨기 전 한 프레임 동안 깨진 이미지가 보인다. "아이콘 없음은 오류가
 * 아니라 정상 상태"(CLAUDE.md §2.1.1 의 초상화 규약)라는 원칙과 정면으로 어긋난다.
 *
 * 그래서 **있는 것만 그린다.** 없는 보스는 처음부터 폴백 실루엣으로 렌더되고 네트워크
 * 요청 자체가 없다. 덤으로 이 모듈은 순수 상수라 서버 컴포넌트에서도 쓸 수 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 갱신 방법 — 파일을 추가/삭제했으면 이 목록도 같이 고쳐야 한다
 * ─────────────────────────────────────────────────────────────────────────────
 * `public/bosses/` 의 파일명(확장자 제외)을 정렬해 그대로 옮겨 적으면 된다.
 *
 * ```sh
 * ls public/bosses/*.png | xargs -n1 basename | sed 's/\.png$//' | sort
 * ```
 *
 * ★ 파일명은 **`boss_difficulties.id` 와 정확히 같아야 한다** (`hard_verus_hilla` 가
 *   아니라 `verus_hilla_hard`). 원본 에셋(`img/bossIcon/`)은 `{난이도}_{보스영문}` 이고
 *   보스 영문명도 우리 `bosses.id` 와 다른 것이 여럿이라(`gloom`→`dusk`,
 *   `darknell`→`dunkel`, `slime`→`guardian_angel_slime`, `maleficStar`→
 *   `radiant_malefic_star`, `bardrix`→`baldrix`, `adversary`→`first_adversary`,
 *   `lotus`→`lotus`(스우)) 그대로 복사하면 전부 폴백으로 조용히 떨어진다.
 *
 * ★ **`destiny_*` 6종은 일부러 넣지 않았다.** 데스티니는 퀘스트 콘텐츠이지 난이도가
 *   아니다(발주자 확인 2026-08-18). 여섯 번째 난이도로 추가하지 않는다.
 *
 * ★ DB 변경은 **0건**이다. `boss_difficulties.id` 는 스키마가 변경 금지로 못박은 영구
 *   키라 파일명으로 쓸 수 있다 — `image_url` 컬럼도 마이그레이션도 필요 없다.
 */
export const BOSS_ICON_IDS: ReadonlySet<BossDifficultyId> = new Set([
  "baldrix_hard",
  "baldrix_normal",
  "bellona_easy",
  "bellona_hard",
  "bellona_normal",
  "black_mage_extreme",
  "black_mage_hard",
  "damien_hard",
  "damien_normal",
  "dunkel_hard",
  "dunkel_normal",
  "dusk_chaos",
  "dusk_normal",
  "first_adversary_easy",
  "first_adversary_extreme",
  "first_adversary_hard",
  "first_adversary_normal",
  "guardian_angel_slime_chaos",
  "guardian_angel_slime_normal",
  "jupiter_hard",
  "jupiter_normal",
  "kaling_easy",
  "kaling_extreme",
  "kaling_hard",
  "kaling_normal",
  "kalos_chaos",
  "kalos_easy",
  "kalos_extreme",
  "kalos_normal",
  "limbo_hard",
  "limbo_normal",
  "lotus_extreme",
  "lotus_hard",
  "lotus_normal",
  "lucid_easy",
  "lucid_hard",
  "lucid_normal",
  "radiant_malefic_star_hard",
  "radiant_malefic_star_normal",
  "seren_extreme",
  "seren_hard",
  "seren_normal",
  "verus_hilla_hard",
  "verus_hilla_normal",
  "will_easy",
  "will_hard",
  "will_normal",
]);

/** 이 보스 난이도에 실제 아이콘 파일이 있는가. 없으면 폴백을 그린다(오류가 아니다). */
export function hasBossIcon(bossDifficultyId: BossDifficultyId): boolean {
  return BOSS_ICON_IDS.has(bossDifficultyId);
}

/** `public/bosses/{id}.png` — 경로 규칙은 **이 함수 하나뿐이다.** 문자열을 복제하지 말 것. */
export function bossIconSrc(bossDifficultyId: BossDifficultyId): string {
  return `/bosses/${bossDifficultyId}.png`;
}
