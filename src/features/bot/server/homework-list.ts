import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `!숙제` · `!검마` 의 **접는 규칙과 카드 모형** — 평문과 그림의 공통 원본
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-07 에 `commands.ts` 에서 갈라 나왔다. 발주 지시: *"주소로 만들어서 보내는게
 * 나을거같은데 !숙제 부분이 생각보다 보기 힘든거같아서 저렇게 사진으로보내면 개편하잖아"*
 *
 * 그 결과 같은 목록을 **두 곳**이 그린다 — 방에 나가는 평문(`commands.ts`)과 카톡
 * 미리보기 그림(`app/s/[token]/card.png`). 접는 기준(금액 문턱 · 줄 상한)이 두 벌이 되면
 * 평문은 "남은 38건"이라 하고 그림은 다른 숫자를 말하는 날이 온다. 그래서 **기준은 이
 * 파일 하나가 갖는다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 그림은 **방에 이미 나간 정보만** 담는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 주소 하나만 알면 세션 없이 열리는 화면이다(`share-token.ts`). 그러니 거기 담기는 것은
 * **지금도 `!숙제` 가 방에 평문으로 뿌리는 것**을 넘지 않아야 한다 — 더 담으면 "방에 없던
 * 정보가 링크로 새는 것"이고 그건 다른 판단이 필요한 별건이다.
 *
 * 그래서 카드는 평문과 **똑같이 접힌다**: `HOMEWORK_MIN_MESO` 문턱과
 * `HOMEWORK_LIST_MAX` 줄 상한을 그림에도 그대로 적용하고, 접힌 것은 평문과 같은 꼬리말
 * 문장으로 센다. 카드가 평문보다 더 아는 것은 **없다** — 캐릭터별 소계조차 평문에 이미
 * 줄줄이 나가 있는 금액의 합이다.
 *
 * 다른 것은 **배열**뿐이다. 발주자가 가리킨 참고 화면(`/boss-status`)처럼 캐릭터로 묶는다 —
 * 평문 목록이 읽기 힘든 이유가 캐릭터 이름이 줄마다 반복되는 것이기 때문이다.
 */

import { formatMesoCompact } from "@/lib/utils";
import type { BossCycle, BossDifficultyTier } from "@/types/domain";

import type { AdminDb } from "@/lib/supabase/admin-db";

import {
  fetchRemainingBosses,
  type RemainingBoss,
  type RemainingBossScope,
} from "./bot-repo";
import { resetLabel } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// 접는 기준 — `commands.ts` 에서 옮겨 왔다. 주석의 근거는 원문 그대로 보존한다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 목록에 내줄 **최대 줄 수**. 20 에서 내렸다 — 같은 날 월간을 목록에 넣었기 때문이기도
 * 하다. 줄이 늘어난 만큼 상한을 그대로 두면 한 풍선이 600자를 넘기고, 그러면 '전체보기'로
 * 접힐 부분이 절반을 넘게 된다. 15줄이면 머리말까지 400자 남짓이다.
 *
 * ★ **그림에도 같은 상한을 쓴다**(2026-10-07). 상한의 원래 근거는 카톡 풍선 길이였지만,
 *   그림에서도 같은 값이 필요한 별개의 근거가 있다 — 미리보기는 작게 뜨므로 아이콘을 100개
 *   깔면 전부 색 얼룩이 된다. 두 근거가 우연히 같은 값을 가리킨다.
 */
export const HOMEWORK_LIST_MAX = 15;

/**
 * 목록에 **줄을 내줄 최소 금액** — 2억 (발주 지시 2026-09-02: *"기준을 2억으로 가자"*.
 * 같은 날 3억으로 먼저 잡았다가 내렸다).
 *
 * 실측(2026-09-02, 한 계정의 남은 31건)에서 하위 절반은 개인 수령액 1억 이하였다 —
 * 하진 1억 600만 · 하듄 9,440만 · 하윌 7,710만 · 카더 6,980만 · 하루 6,290만 …
 * 이런 줄이 목록의 절반을 먹으면 **"이번 주에 어디부터 돌지"** 라는 질문의 답이 묻힌다.
 * 한 줄이 곧 "가 볼 만하다"는 뜻이어야 목록이 일한다.
 *
 * ★ **3억 → 2억으로 내린 이유**는 문턱과 시세표 사이에 낀 보스들이다. 노세(노멀 세렌)
 *   2억 3,900만 · 하세(하드 세렌) 3억 5,600만처럼 실제로 도는 보스가 3억 근처에 몰려
 *   있어, 3억이면 노세가 통째로 빠지고 하세도 2인부터 빠졌다.
 * ★ **합계에서 빼지 않는다.** `남은 N건 · 총액` 은 여전히 전부를 말하고, 걸러진 것은
 *   `N억 이하 결정석 M건` 이 받는다 — 자른 사실을 숨기지 않는다.
 * ★ 기준은 **개인 수령액**(`floor(솔로가/인원)`)이다. 솔로가로 재면 2인으로 도는 보스가
 *   기준을 통과했다가 정작 손에 쥐는 것은 절반이 된다(§1 · D3).
 */
export const HOMEWORK_MIN_MESO = 200_000_000;

/** 그 문턱을 사람 말로. 문구와 값이 갈라지지 않게 한 곳에서 만든다. */
export const HOMEWORK_MIN_LABEL = formatMesoCompact(HOMEWORK_MIN_MESO);

/** 문턱을 넘는 것만. 정렬은 이미 되어 있으므로 순서를 건드리지 않는다. */
export function worthListing(
  items: readonly RemainingBoss[],
): readonly RemainingBoss[] {
  return items.filter((item) => item.shareMeso >= HOMEWORK_MIN_MESO);
}

// ─────────────────────────────────────────────────────────────────────────────
// 카드 모형
// ─────────────────────────────────────────────────────────────────────────────

export interface HomeworkCardBoss {
  /** `boss_difficulties.id` — 아이콘 파일명이 이 값이다. */
  readonly bossDifficultyId: string;
  readonly shortName: string;
  /** `하드 카링` — 웹 공유 화면의 `title`(그림에는 자리가 없다). */
  readonly koreanName: string;
  /** §4 — 난이도는 색으로. 아이콘 테두리가 쓴다. */
  readonly difficulty: BossDifficultyTier;
  readonly cycle: BossCycle;
  /** 개인 수령액. 캐릭터 소계가 이 값들의 합이다. */
  readonly shareMeso: number;
  /**
   * 그 금액을 나눈 파티 인원(`RemainingBoss.defaultPartySize` — `null` 은 이미 1 로 접혀 온다).
   * ★ 2026-10-08 에 더했다. 이 모형이 `RemainingBoss` 와 **같은 모양**이어야 `remainingRow`
   *   같은 공용 함수가 양쪽을 다 받는다 — 한쪽에만 필드를 더하면 그 경계에서 타입이 깨진다.
   */
  readonly defaultPartySize: number;
}

export interface HomeworkCardCharacter {
  readonly characterName: string;
  /** **목록에 오른** 보스 수. 문턱 아래는 포함하지 않는다(평문과 같다). */
  readonly listedCount: number;
  /** 그 보스들의 개인 수령액 합. */
  readonly listedMeso: number;
  readonly bosses: readonly HomeworkCardBoss[];
}

export interface HomeworkCard {
  readonly scope: RemainingBossScope;
  /** `남은 주간 보스` / `남은 월간 보스` — 이모지는 **붙이지 않는다**(아래 ⚠️). */
  readonly title: string;
  /** `~10/9 목 00:00` 또는 `매월 1일 초기화`. 초기화 시계를 제목 옆에서 말한다. */
  readonly resetNote: string;
  /** 남은 것 **전부**의 건수(문턱·상한과 무관). 평문 요약 줄과 같은 값이다. */
  readonly totalCount: number;
  /** 남은 것 전부의 개인 수령액 합(가격 미확인 제외). */
  readonly totalMeso: number;
  /** 목록에 실제로 오른 건수. */
  readonly listedCount: number;
  /**
   * 빠진 이유별 꼬리말. **평문과 글자까지 같다** — 한쪽만 고치면 두 화면이 다른 말을 한다.
   * 순서도 평문과 같다(잘림 → 문턱 → 가격 미확인).
   */
  readonly notes: readonly string[];
  /** 남은 금액이 큰 캐릭터 순. */
  readonly characters: readonly HomeworkCardCharacter[];
}

/**
 * 남은 보스 → 카드. **조회는 한 번뿐이고 규칙은 `fetchRemainingBosses` 의 것**이다
 * (개인 수령액 내림차순 · 주간+시즌 · 가격 미확인 제외 · 추적 캐릭터만).
 *
 * ★ 캐릭터 정렬은 **그 캐릭터의 목록 합계 내림차순**이다. 보스 한 건의 금액으로 줄을
 *   세우면 87억짜리 하나를 가진 캐릭터가 2억 × 5개를 가진 캐릭터보다 앞에 오는데,
 *   캐릭터 묶음이 답해야 하는 질문은 *"어느 캐릭을 먼저 켤까"* 라서 합계가 맞다.
 *   합계가 같으면 이름으로 가른다 — 같은 명령을 두 번 쳤을 때 순서가 흔들리면
 *   "숫자가 바뀌었나?" 라는 헛의심을 부른다(`fetchRemainingBosses` 와 같은 이유).
 */
export async function buildHomeworkCard(
  db: AdminDb,
  userId: string,
  scope: RemainingBossScope,
  now: Date,
): Promise<HomeworkCard> {
  const remaining = await fetchRemainingBosses(db, userId, { scope });

  const eligible = worthListing(remaining.items);
  const shown = eligible.slice(0, HOMEWORK_LIST_MAX);
  const belowCount = remaining.items.length - eligible.length;
  const cutCount = eligible.length - shown.length;

  const byCharacter = new Map<string, HomeworkCardBoss[]>();
  for (const item of shown) {
    const bucket = byCharacter.get(item.characterName);
    const boss: HomeworkCardBoss = {
      bossDifficultyId: item.bossDifficultyId,
      shortName: item.shortName,
      koreanName: item.koreanName,
      difficulty: item.difficulty,
      cycle: item.cycle,
      shareMeso: item.shareMeso,
      defaultPartySize: item.defaultPartySize,
    };
    if (bucket === undefined) {
      byCharacter.set(item.characterName, [boss]);
    } else {
      bucket.push(boss);
    }
  }

  const characters: HomeworkCardCharacter[] = [...byCharacter.entries()]
    .map(([characterName, bosses]) => ({
      characterName,
      listedCount: bosses.length,
      listedMeso: bosses.reduce((sum, boss) => sum + boss.shareMeso, 0),
      bosses,
    }))
    .sort(
      (a, b) =>
        b.listedMeso - a.listedMeso ||
        a.characterName.localeCompare(b.characterName, "ko"),
    );

  /*
    ── 꼬리말은 **빠진 이유별로 갈라 적는다** ─────────────────────
    발주 지시(2026-09-02): *"밑에 3억이하 결정석 14건 정도로 해"*.
    둘을 한 줄로 합치면 **조치가 다른 둘이 같은 말로 보인다** — 문턱 아래는 "그만한
    가치가 없다"라 할 일이 없고, 15줄에 잘린 것은 "그다음에 돈다"다.
  */
  const notes = [
    cutCount > 0 ? `…외 ${String(cutCount)}건` : null,
    belowCount > 0
      ? `${HOMEWORK_MIN_LABEL} 이하 결정석 ${String(belowCount)}건`
      : null,
    remaining.unknownCount > 0
      ? `가격 미확인 ${String(remaining.unknownCount)}건 제외`
      : null,
  ].filter((note): note is string => note !== null);

  return {
    scope,
    title: scope === "monthly" ? "남은 월간 보스" : "남은 주간 보스",
    resetNote: scope === "monthly" ? "매월 1일 초기화" : resetLabel(now),
    totalCount: remaining.items.length,
    totalMeso: remaining.totalMeso,
    listedCount: shown.length,
    notes,
    characters,
  };
}

/** `남은 38건 · 1조 2,345억` — 평문 요약 줄과 그림 머리줄이 **같은 문자열**을 쓴다. */
export function homeworkSummaryLine(card: HomeworkCard): string {
  return `남은 ${String(card.totalCount)}건 · ${formatMesoCompact(card.totalMeso)}`;
}
