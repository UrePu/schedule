import { getBossSortOrder } from "@/lib/boss-master";

import type { ClearRecord, IncomeCharacterOption } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 원장 상세의 **정렬과 묶음** — 캐릭터 먼저, 그 안에서 보스 순서
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-25): *"클릭하면 뜨는 모달도 캐릭터별로 분리해서 정렬해서 보여주고.
 * 보스 난이도에따라서 항상 정렬되도록 보여줘. 처음 설정한 캐릭터 정렬, 그 후에 보스들
 * 순서대로"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 순서의 근거를 **여기서 새로 만들지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 캐릭터 순서 — `options` 배열의 순서 그대로다. 그 배열은 서버의
 *     `fetchMyRunCharacters`(본캐 → 레벨 내림차순)가 만들고, 일정 화면의 캐릭터
 *     드롭다운도 **같은 배열**을 쓴다. 여기서 다시 정렬하면 두 화면이 갈라진다.
 *   · 보스 순서 — `getBossSortOrder`(= `boss_difficulties.sort_order`) 내림차순.
 *     보스 목록을 그리는 모든 화면이 이미 그 값으로 정렬돼 있다(최신·상위 난이도가 위).
 *     난이도 서열을 화면이 따로 적으면 그 순간 규칙이 두 벌이 된다.
 *
 * ★ 정렬이 **항상** 걸린다는 것이 요구의 핵심이다. 예전에는 서버가 준 순서(= 클리어가
 *   기록된 순서)를 그대로 그렸다. 같은 하루를 두 번 열면 순서가 달라 보일 수 있었고,
 *   그러면 "내가 뭘 고쳤는지" 를 눈으로 좇을 수 없다.
 */

/** 캐릭터 한 명분 묶음. `characterId` 가 `null` 이면 아직 귀속되지 않은 클리어다. */
export interface ClearGroup {
  readonly characterId: string | null;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly clears: readonly ClearRecord[];
  /** 이 묶음의 `내 몫` 합. **가격 미확인(`null`)은 더하지 않는다** (§1.3 D4). */
  readonly shareMeso: number;
  /** 가격 미확인 건수. 합계에서 빠졌다는 사실을 화면이 말할 수 있게 따로 센다. */
  readonly unknownPriceCount: number;
}

/**
 * 보스 순서로 정렬한 **사본**을 돌려준다(원본을 건드리지 않는다).
 *
 * 같은 보스가 여러 건이면 이름 → id 로 마저 가른다. 완전한 순서를 주지 않으면 브라우저
 * 정렬의 안정성에 기대게 되고, 그건 목록이 바뀔 때마다 순서가 흔들린다는 뜻이다.
 */
export function sortClearsByBoss(
  clears: readonly ClearRecord[],
): readonly ClearRecord[] {
  return [...clears].sort(
    (a, b) =>
      getBossSortOrder(b.bossDifficultyId) - getBossSortOrder(a.bossDifficultyId) ||
      a.bossDisplayName.localeCompare(b.bossDisplayName, "ko-KR") ||
      a.clearId.localeCompare(b.clearId),
  );
}

/**
 * 캐릭터별로 나누고, 캐릭터는 `options` 순서로, 그 안의 클리어는 보스 순서로 정렬한다.
 *
 * ⚠️ `options` 에 없는 캐릭터도 **버리지 않는다.** 추적을 끊었거나 삭제된 캐릭터의 과거
 *    기록이 여기 있고, 안 보이면 그 수익이 사라진 것처럼 보인다. 알 수 없는 캐릭터는
 *    이름순으로 뒤에 붙이고, 귀속되지 않은 클리어(`characterId === null`)는 **맨 끝**에
 *    둔다 — 그건 고쳐야 할 것이라 목록의 끝에서 눈에 띄는 편이 낫다.
 */
export function groupClearsByCharacter(
  clears: readonly ClearRecord[],
  options: readonly IncomeCharacterOption[],
): readonly ClearGroup[] {
  const rank = new Map(options.map((option, index) => [option.characterId, index]));

  const buckets = new Map<string, ClearRecord[]>();
  for (const clear of clears) {
    const key = clear.characterId ?? "";
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [clear]);
    else bucket.push(clear);
  }

  const groups: ClearGroup[] = [];
  for (const [key, bucket] of buckets) {
    const sorted = sortClearsByBoss(bucket);
    const head = sorted[0];
    groups.push({
      characterId: key === "" ? null : key,
      characterName:
        key === ""
          ? "캐릭터 미지정"
          : (head?.characterName ??
            options.find((option) => option.characterId === key)?.name ??
            "이름 미상"),
      worldName: head?.worldName ?? null,
      clears: sorted,
      shareMeso: sorted.reduce(
        (sum, clear) => sum + (clear.shareMeso ?? 0),
        0,
      ),
      unknownPriceCount: sorted.filter((clear) => clear.shareMeso === null)
        .length,
    });
  }

  return groups.sort((a, b) => {
    // 귀속되지 않은 묶음은 언제나 맨 끝.
    if ((a.characterId === null) !== (b.characterId === null)) {
      return a.characterId === null ? 1 : -1;
    }
    const ra = a.characterId === null ? Infinity : (rank.get(a.characterId) ?? Infinity);
    const rb = b.characterId === null ? Infinity : (rank.get(b.characterId) ?? Infinity);
    if (ra !== rb) return ra - rb;
    return a.characterName.localeCompare(b.characterName, "ko-KR");
  });
}
