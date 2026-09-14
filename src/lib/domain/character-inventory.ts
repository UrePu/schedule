/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 캐릭터 재고 비교 — **"무엇이 늘었고 누가 사라졌는가"의 순수 판정**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `features/auth/server/account.ts` 의 `refreshUserCharacterInventory` 가 쓰는 판정만
 * 떼어 낸 모듈이다. DB 도 넥슨도 모른다 — 입력은 전부 평범한 값이고 출력도 값이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 굳이 갈라 놓았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 판정이 틀리면 **멀쩡한 캐릭터가 동기화에서 빠지고 그만큼의 수익이 조용히 누락된다.**
 * 그런 판정은 실제 계정과 실제 넥슨 호출 없이 재현할 수 있어야 한다. 서버 모듈 안에
 * 두면 `server-only` 와 Supabase 클라이언트가 함께 딸려 와서 값 하나를 확인하는 데도
 * 자격증명이 필요해진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 이 모듈의 핵심 규칙 — **"안 보였다"와 "못 봤다"는 다르다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 사라짐 판정의 모집단은 **"이번에 실제로 한 명이라도 관측된 넥슨 계정"** 뿐이다.
 * 조회에 실패했거나, 200 이면서 **캐릭터를 0명 돌려준** 계정은 모집단에서 빠진다.
 *
 * 0명 응답이 왜 위험한가: 넥슨 스키마상 `character_list` 는 `nullable().optional()` 이라
 * `account_list:[{account_id:"x", character_list:[]}]` 가 **예외 없이 200 을 통과한다.**
 * 그 계정을 모집단에 넣으면 관측이 0건이므로 **그 계정 캐릭터 전원이 사라짐**으로 찍히고,
 * 야간 동기화·초상화 백필·수동 동기화에서 통째로 빠진다.
 *
 * "정말 그 계정에 캐릭터가 없다"와 "부분 장애"를 API 로 구분할 방법은 없다. 그래서
 * **대가가 작은 쪽으로 기운다**:
 *   · 오탐(있는데 사라졌다고 표시) = 동기화 제외 → **조용한 수익 누락.** 사용자는 원인을
 *     짐작할 수 없고, 알아차렸을 때는 이미 지난 주차다.
 *   · 미탐(사라졌는데 그대로 둠) = 유령이 하루 더 남는다. 다음 새로고침이 잡는다.
 * 비교가 되지 않으므로 **의심스러우면 사라졌다고 말하지 않는다.**
 */

/** 비교에 필요한 캐릭터 한 행. DB 컬럼명이 아니라 **값의 이름**으로 부른다. */
export interface CharacterInventoryEntry {
  readonly id: string;
  /** 넥슨 식별자. 옛 행은 `null` 일 수 있다(§1.1 — 가변값이라 PK 가 아니다). */
  readonly ocid: string | null;
  readonly name: string;
  readonly worldName: string | null;
  /** 이 캐릭터가 속한 넥슨 계정. `null` 이면 출처 기록이 없는 옛 행이다. */
  readonly accountRef: string | null;
  /** 사라짐 표시. `null` 이 정상이다. */
  readonly missingSince: string | null;
}

/**
 * **이번에 실제로 관측된 넥슨 계정**의 집합.
 *
 * 계정을 넣는 근거는 "조회를 시도했다"가 아니라 **"그 계정의 캐릭터를 한 명이라도 봤다"**
 * 이다. 그래서 캐릭터 0명을 돌려준 계정은 여기 들어올 방법 자체가 없다 — 조건문으로
 * 거르는 것이 아니라 **구조가 보장한다**(머리말).
 *
 * @param rows  갱신이 끝난 뒤의 전체 캐릭터(계정 소속이 최신이어야 한다)
 * @param seenOcids  이번 조회들이 돌려준 모든 ocid
 */
export function collectObservedAccountRefs(
  rows: readonly CharacterInventoryEntry[],
  seenOcids: ReadonlySet<string>,
): ReadonlySet<string> {
  const observed = new Set<string>();
  for (const row of rows) {
    if (row.accountRef === null) continue;
    if (row.ocid === null || !seenOcids.has(row.ocid)) continue;
    observed.add(row.accountRef);
  }
  return observed;
}

/**
 * 사라졌다고 새로 표시할 캐릭터 하나. 이름은 화면이 "누가?"에 답하는 데 쓴다.
 *
 * ★ `worldName` 이 함께 실리는 이유 — **한꺼번에 사라지는 일이 정상이기 때문**이다
 *   (발주 2026-09-14). 챌린저스 계열은 시즌이 끝나면 그 월드 캐릭터가 통째로 없어진다
 *   (실측 이 계정만 7명: 챌린저스 4 · 챌린저스2 2 · 챌린저스3 1). 이름만 주면 화면이 일곱
 *   줄을 늘어놓게 되고, 정작 알아야 할 **"어느 월드가 통째로 날아갔는가"** 가 묻힌다.
 */
export interface MissingCharacter {
  readonly id: string;
  readonly name: string;
  /** 옛 행은 `null` 일 수 있다. 그때는 월드로 묶지 못하고 이름으로만 말한다. */
  readonly worldName: string | null;
}

export interface CharacterInventoryDiff {
  readonly added: number;
  readonly renamed: number;
  readonly worldChanged: number;
  /** **이번에 처음** 안 보이게 된 캐릭터. 이미 사라진 채였던 행은 들어오지 않는다. */
  readonly nowMissing: readonly MissingCharacter[];
  /** 사라짐 표시가 붙어 있었는데 다시 보인 캐릭터. */
  readonly returnedIds: readonly string[];
}

/**
 * 새로고침 전/후를 비교한다.
 *
 * ⚠️ **사라짐 여부는 `before` 로 판단한다.** `after` 로 보면 안 되는 이유가 있다:
 *    재고 동기화(`syncCredentialInventory`)가 **목록에서 보인 캐릭터의 `missing_since` 를
 *    이미 풀어 두기 때문**에, `after` 만 보면 방금 돌아온 캐릭터가 "원래 안 사라졌던
 *    캐릭터"와 구분되지 않는다. 그러면 복귀 건수가 언제나 0이 된다.
 *
 * ⚠️ 월드 리프(ocid·월드가 함께 바뀌는 이전)는 **잇지 않는다.** 옛 행과 새 행을 이을
 *    근거가 한 톨도 남지 않고, 잘못 이으면 남의 클리어 기록이 붙는다. 그래서 리프는
 *    `added 1 · nowMissing 1` 로 보고된다 — 그것이 우리가 아는 사실 그대로다.
 *    따라서 `worldChanged` 는 **ocid 가 유지된 월드 변경만** 센다.
 */
export function diffCharacterInventory(input: {
  readonly before: readonly CharacterInventoryEntry[];
  readonly after: readonly CharacterInventoryEntry[];
  readonly seenOcids: ReadonlySet<string>;
  readonly observedAccountRefs: ReadonlySet<string>;
}): CharacterInventoryDiff {
  const beforeById = new Map(input.before.map((row) => [row.id, row]));

  let added = 0;
  let renamed = 0;
  let worldChanged = 0;
  const nowMissing: MissingCharacter[] = [];
  const returnedIds: string[] = [];

  for (const row of input.after) {
    const previous = beforeById.get(row.id);
    if (previous === undefined) {
      added += 1;
    } else {
      if (previous.name !== row.name) renamed += 1;
      if (previous.worldName !== row.worldName) worldChanged += 1;
    }

    // 출처를 모르는 옛 행은 어느 계정에 물어봐야 하는지 알 수 없다 → 판단하지 않는다.
    if (row.accountRef === null) continue;
    // 이번에 관측되지 않은 계정(조회 실패 · 0명 응답 · 키 없음)도 마찬가지다(머리말).
    if (!input.observedAccountRefs.has(row.accountRef)) continue;

    const seen = row.ocid !== null && input.seenOcids.has(row.ocid);
    const wasMissing = previous !== undefined && previous.missingSince !== null;

    if (seen) {
      if (wasMissing) returnedIds.push(row.id);
      continue;
    }
    if (!wasMissing) {
      nowMissing.push({ id: row.id, name: row.name, worldName: row.worldName });
    }
  }

  return { added, renamed, worldChanged, nowMissing, returnedIds };
}
