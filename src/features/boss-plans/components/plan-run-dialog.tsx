"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, CheckCircle2, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import {
  BOSS_DIFFICULTY_BORDER_L,
  BOSS_DIFFICULTY_LABEL,
  BossIcon,
  MesoAmount,
  PartyOptionGrid,
  myPartyLens,
  resolveMyPartyOption,
  type PartyOptionData,
} from "@/components/domain";
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
} from "@/components/ui";
import {
  createPartyRun,
  fetchMyBundles,
  fetchMyRunCharacters,
  fetchPartyBosses,
  fetchPartyMembers,
} from "@/features/schedule/data";
import { crystalShareMeso } from "@/features/schedule/lib/crystal";
import { buildDayRows } from "@/features/schedule/lib/overlay-layout";
/*
  ★ 소요 시간 기본값은 **상수 하나**를 함께 읽는다. 예전에는 이 파일이 30 을 따로
    적어 두었고, 한쪽만 고치면 같은 "기본값"이 화면마다 달라졌다.
*/
import { DEFAULT_DURATION_MINUTES } from "@/features/schedule/lib/run-defaults";
import {
  describeResolvedDuration,
  resolveBossDuration,
} from "@/lib/domain/boss-duration-estimate";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import {
  kstDayKey,
  kstMoment,
  minutesFromTimeText,
} from "@/lib/time/kst-wallclock";
import { getWeekKey } from "@/lib/time/week";
import { participantLabel } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type {
  BossCatalogEntry,
  PartyId,
  PartyMember,
  PersonId,
  RunCharacterOption,
  ScheduledRun,
  TimeRange,
} from "@/types/domain";

import type { CharacterBossPlan, ChecklistCharacter } from "../types";
import { withJosa } from "@/lib/text/josa";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "매주 가는 보스" 행 클릭 → **그 보스로 일정(run)을 만든다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자 요구: *"이 화면에서 행을 하나 클릭하면 바로 파티를 설정할 수 있게 해야지.
 * 3인 어디서 설정하는 건데? 모달 뜨게 해."*
 *
 * 이전에는 **계획과 일정이 끊겨 있었다.** `/boss-plans` 는 "이 캐릭터가 매주 갈 보스"만
 * 관리하고, 실제 시간을 잡는 곳은 주간 일정표(`/`)다. 계획에서 일정으로 넘어가는 길이
 * 없어 사용자가 보스 이름을 다시 검색해야 했다. 이 모달이 그 다리다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버 경로는 **전부 기존 것**이다 — 새 라우트를 만들지 않았다
 * ─────────────────────────────────────────────────────────────────────────────
 *   파티 목록      `GET  /api/schedule/parties`  ← 2026-10-04 부터. 예전에는
 *                  `/parties/mine` 이었는데 그 payload 에는 파티원 초상화도 보스도 없어서
 *                  얼굴로 고를 수 없었다(`PlanRunParty` 주석). **왕복 수는 같다.**
 *   파티 구성원    `GET  /api/schedule/parties/{id}/members`
 *   일정 등록      `POST /api/schedule/parties/{id}/runs`  ← `/schedule` 과 **같은 경로**
 * 넥슨 호출은 **0건**이다. 전부 우리 DB 다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 파티 인원수(`entry_party_size`) — 발주자가 물은 "3인 어디서 설정하는 건데?"
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **2026-08-20 부터 숫자 칸이 아니라 참가자 체크박스가 정한다.** 아래 내용은 그 전의
 *   설계 근거이며, "왜 계획값이 초기값이었는가"의 기록으로 남긴다. 지금은 인원수를 따로
 *   적지 않으므로 계획값이 초기값으로 쓰이지도 않는다 — 이 창이 정하는 것은 "평소 몇 인"
 *   이 아니라 **"이번에 누가 가는가"** 이고, 그 답에서 인원수가 나온다.
 *
 * - (옛 설계) **기본값은 계획에 적어 둔 인원수**(`plan.defaultPartySize`)이고, **언제나 값이 있다** —
 *   `character_boss_plans.default_party_size` 가 `NOT NULL DEFAULT 1` 이기 때문이다
 *   (마이그레이션 25, 발주자 지시 2026-08-19: *"그냥 1인을 기본으로 잡아 굳이 1이라고
 *   설정안하게"*). 손대지 않은 보스의 1 도 "정해진 값"이므로 폴백 분기가 없다.
 *
 *   ★ 계획값이 이기는 이유: 계획값은 이 사용자가 "나는 이 보스를 N인으로 돈다"고
 *     **직접 말한 값**이다. 실제 입장 인원의 추정치로는 그보다 나은 것이 없다.
 *   ★ 2026-08-18 변경 — 계획값이 없을 때 `max_party` 로 떨어지던 것을 **1 로 바꿨다**.
 *     보스 계획 화면의 기본 표시와 **같은 값이어야** 하고, `max_party` 는 대부분 세대
 *     규칙에서 **추정**된 값이라(§1.3 D5) 애초에 기본값으로 삼기에 근거가 약했다.
 *     2026-08-19 에 DB 기본값 자체가 1 이 되면서 이 폴백은 코드에서 사라졌다.
 *   ★ 그래도 여기서 고른 값이 최종이다 — 이 칸은 **그 입장의 사실**(`entry_party_size`)을
 *     적는 자리이고, 계획값은 그 자리에 미리 채워 두는 초기값일 뿐이다. 사실이 기본값을
 *     이긴다는 규칙(마이그레이션 21 머리말)이 화면에서도 그대로 성립한다.
 *
 * - **§1.3 D5 대로 소프트 상한**이다. 초과 입력을 막지 않고 **경고만** 한다 — `max_party`
 *   대부분이 개별 출처 없이 6으로 추정된 값이라 CHECK 로 굳히면 진짜 파티를 막을 수 있다.
 * - **§1.3 D3**: 이 값의 의미는 "실제로 몇 명이 입장했는가"이며 사용자가 고칠 수 있다.
 * - 이 값이 **결정석 1/n 의 분모**라는 사실이 화면에 드러나야 한다. 아래 미리보기가
 *   인원을 바꾸는 즉시 갱신된다.
 *
 * ⚠️ **예상 수령액은 등록 전 미리보기라 DB 를 쓸 수 없다.**
 *    `distribute_meso()` / `v_run_share_weights` 는 **이미 존재하는 `party_runs` 행**을
 *    입력으로 받는다. 아직 만들지 않은 런에는 대상 행도, 참가자(`run_signups`)도 없으므로
 *    호출할 것이 없다. 그래서 미리보기는 클라이언트 계산이지만, **새로 구현하지 않고**
 *    다른 등록 경로가 같은 목적으로 이미 쓰고 있는 `crystalShareMeso()` 를
 *    그대로 재사용한다 — 1/n 식이 코드베이스에 두 벌 생기지 않는다.
 *    등록이 끝난 뒤의 실제 분배 금액은 언제나 DB(`resolve_crystal_payout`)가 낸다.
 */

/** 조회 전 기본값. 매 렌더 새 배열을 만들면 아래 파생 계산이 매번 달라진다. */
const EMPTY_MEMBERS: readonly PartyMember[] = [];
/** 같은 이유의 상수. 내 캐릭터 목록(`fetchMyRunCharacters`)의 조회 전 값이다. */
const EMPTY_RUN_CHARACTERS: readonly RunCharacterOption[] = [];

/**
 * 모달이 파티를 고르는 데 필요한 최소 정보 = **공용 파티 선택 컴포넌트의 입력**.
 *
 * ★ 2026-10-04 — 예전에는 `{partyId, name, memberCount}` 세 칸이었고
 *   (`dashboard-repo.DashboardParty` 의 부분집합), 그래서 이 창은 파티를 `<select>`
 *   드롭다운으로 골랐다. 발주 지시(*"파티를 선택하는부분은 전부다 같은 컴포넌트를
 *   사용해서 좀 보기 편하게 만들어"*)에 따라 시간표 등록 창과 **같은 `PartyOption`**
 *   을 쓰게 되면서 **파티원 초상화와 보스 얼굴**이 필요해졌고, 그 둘은
 *   `schedule-repo.fetchParties()` 의 `Party` 에 이미 실려 있다
 *   (`Party.members` · `Party.bosses`).
 * ★ 그래서 **별칭이지 새 타입이 아니다.** 여기서 필드를 따로 적으면 공용 컴포넌트가
 *   요구하는 모양과 갈라지고, 갈라지는 순간 호출부가 변환 함수를 만들게 된다.
 * ★ **새 왕복은 없다.** `/boss-plans` 는 쓰던 조회를 `/api/schedule/parties/mine` 에서
 *   `/api/schedule/parties` 로 **바꿨을** 뿐이다(`boss-plan-workspace.tsx` 주석).
 */
export type PlanRunParty = PartyOptionData;

/*
 * ⚠️ ═══════════════════════════════════════════════════════════════════════════
 *   **이 창은 묶음을 고르지 않는다 — 고르게 하면 안 된다** (2026-10-16, 2단계)
 *   ═══════════════════════════════════════════════════════════════════════════
 *   2단계에서 일정 잡기의 축이 파티 → **보스 묶음**으로 옮겼고(`/` 의 빈 칸), 이 창은
 *   **의도적으로 따라가지 않았다.**
 *
 *   이 창이 잡는 것은 *계획표에서 누른 그 보스 한 건*이다(`plan.bossDifficultyId`).
 *   묶음은 "연달아 도는 조합" 이므로, 묶음을 고르게 하면
 *     · 그 보스가 어느 묶음에도 없을 때 **일정을 잡을 길이 막히고**(계획표의 보스는
 *       묶음과 무관하게 12칸에서 나온다),
 *     · 고른 묶음의 나머지 보스까지 함께 잡히거나(= 이 창이 하는 일이 아니다) 묶음에서
 *       보스 하나만 떼어 쓰는 모순이 생긴다.
 *   그래서 **파티만** 고르고, 서버가 그 파티의 기본 묶음(활성 중 번호 최소)에 런을
 *   붙인다(`createPartyRuns` 가 `bundleId` 없이 불리는 유일한 경로다 — 봇 `!보스` 와 같다).
 *
 *   ★ 결과가 어긋나지 않는 근거: 런에 `bundle_id` 는 **반드시 찍힌다**(기본 묶음). 그래서
 *     시간표가 끊는 축(`sameBundle`)도, 분배가 따르는 설정도 빈 값이 되지 않는다 — 다만
 *     "어느 조합인가" 가 사용자의 선택이 아니라 기본값이 된다. 이 창의 질문이 조합이
 *     아니므로 그것이 옳다.
 */

export interface PlanRunDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 클릭된 계획 행. 보스 신원(난이도까지)과 소프트 상한이 여기서 온다. */
  readonly plan: CharacterBossPlan;
  /** 이 계획의 주인. **일정에 데려갈 캐릭터가 곧 이 캐릭터다**(계획이 캐릭터에 속한다). */
  readonly character: ChecklistCharacter;
  /**
   * 보스 마스터 항목. 결정석 솔로 기준가와 확정된 `max_party` 가 여기 있다.
   * 카탈로그가 아직 안 왔거나 매핑이 없으면 `null` — 가격 미리보기 없이 등록은 된다.
   */
  readonly boss: BossCatalogEntry | null;
  /** 내가 속한 파티만. 공개 파티는 등록 권한이 없어 후보가 아니다. */
  readonly parties: readonly PlanRunParty[];
  /** 이번 주(KST 목 00:00 → 다음 목 00:00). 서버가 계산해 넘긴다. */
  readonly range: TimeRange;
  /** 보는 사람(세션 사용자 id). 참여자 중 본인을 가려 자기 캐릭터 값으로 분을 접는다. */
  readonly viewerPersonId: string;
}

export function PlanRunDialog({
  open,
  onClose,
  plan,
  character,
  boss,
  parties,
  range,
  viewerPersonId,
}: PlanRunDialogProps) {
  const queryClient = useQueryClient();
  const dayId = useId();
  const timeId = useId();

  const dayRows = useMemo(() => buildDayRows(range), [range]);

  /** `max_party` 를 기본값으로. 카탈로그가 우선이고, 없으면 계획 행의 값을 쓴다. */
  const maxParty = boss?.maxParty ?? plan.maxParty ?? null;

  const [partyId, setPartyId] = useState<PartyId | null>(
    parties[0]?.partyId ?? null,
  );
  const [dayKey, setDayKey] = useState(() => {
    const today = kstDayKey(new Date());
    return dayRows.some((row) => row.dayKey === today)
      ? today
      : (dayRows[0]?.dayKey ?? today);
  });
  const [timeText, setTimeText] = useState("21:00");
  /**
   * 참가자 **후보**는 그 파티의 전원이다. 겹쳐보기 없이 여는 모달이라 "이 시간대에 가능한
   * 사람"을 좁힐 근거가 없기 때문이고, 실제로 갈 사람은 **아래 체크박스가 고른다**
   * (2026-08-20 — 예전에는 전원이 그대로 등록됐다).
   * 각자의 캐릭터는 `/parties` 에서 본인이 채운다(§ 남의 캐릭터는 알 수 없다).
   */
  const membersQuery = useQuery({
    // 티어: db(60초). 이 조회는 **모달을 열 때만** 켜지므로 prefetch 대상이 아니다.
    ...dbQueryOptions(queryKeys.db.party.members(partyId ?? "none")),
    queryFn: () => fetchPartyMembers(partyId ?? ""),
    enabled: open && partyId !== null,
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 이 파티가 **이 보스에 쓰는 시간** — 고치는 칸은 **두지 않는다**
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 발주 지시(2026-10-11)가 가리킨 자리는 셋이다(일정 잡기 창 · 일정 상세 창 · 파티
   * 관리). 이 모달은 **네 번째 런 생성 경로**이고, 입력 칸을 두지 않은 근거가 둘이다.
   *
   *   ① **보스가 하나짜리 경로다.** 이 창이 잡는 런은 `plan.bossDifficultyId` 한 건이라
   *      "뒤 보스가 몇 시에 시작하나"라는 질문이 없다 — 소요 시간을 고쳐서 달라지는
   *      것이 화면에 하나도 없고, 저장된 길이는 **일정 상세 창에서 그대로 고칠 수
   *      있다**(그쪽이 이 값의 수정 경로다).
   *   ② 이 창의 질문은 *"어느 파티로, 몇 시에, 몇 인으로"* 다. 파티의 성질인 소요 시간을
   *      여기서도 묻기 시작하면 같은 사실을 네 곳에서 정하게 되고, 그중 하나는 반드시
   *      다른 값을 쓰게 된다(파티 보스 목록을 `/parties` 하나가 소유하는 것과 같은 근거).
   *
   * 그래도 **보여는 준다.** 아래 꼬리말이 `20분` 이라고 적고 있었는데, 2026-10-11 부터
   * 그 숫자는 거짓일 수 있다 — 서버 우선순위가
   * `① 요청의 보스별 값 → ② 묶음에 저장된 값 → ③ 참여자 배율 합산 추정 → ④ 요청의
   * 폴백` 이라(2026-10-21 — `resolveBossDuration`) 파티가 40분을 저장해 두면 **실제로
   * 40분으로 잡힌다.** 그래서 ②를 읽고 ③까지 같은 함수로 접어 적는다(`resolvedMinutes`).
   *
   * ⚠️ 이 조회는 **`bossDurationMinutes` 를 보내기 위한 것이 아니다.** 등록 요청은 그
   *    필드를 계속 생략하고(서버가 파티 값을 읽는다), 여기 읽은 값은 **표시 전용**이다.
   *    보내기 시작하면 이 창이 파티 값을 다시 저장하는 경로가 되어 ②의 주인이 흐려진다.
   */
  const partyBossesQuery = useQuery({
    /*
      ⚠️ 자리표시자가 둘이고 **둘 다 도달하지 않는다**(`enabled` 가 `partyId !== null` 을
         요구한다). 값이 다른 것은 역할이 다르기 때문이다: 캐시 키는 실제 파티 id 와
         **충돌하지 않을 문자열**이어야 해서 `"none"` 이고, 조회 함수는 빈 문자열에서
         즉시 빈 배열로 빠지는 가드를 타야 해서 `""` 다(`fetchPartyBosses` 첫 줄).
         키에 `""` 를 쓰면 "파티 없음"과 구별되지 않고, 함수에 `"none"` 을 넘기면 없는
         파티로 404 왕복이 나간다. 바로 위 `membersQuery` 가 같은 이유로 같은 모양이다.
    */
    ...dbQueryOptions(queryKeys.db.party.bosses(partyId ?? "none")),
    queryFn: () => fetchPartyBosses(partyId ?? ""),
    enabled: open && partyId !== null,
  });

  /**
   * 파티가 이 보스의 시간을 정하지 않았으면(또는 목록에 없으면) `null`.
   *
   * ⚠️ **`DEFAULT_DURATION_MINUTES` 로 접지 않는다**(정정 2026-10-11). 접으면 조회 중과
   *    조회 실패가 *"20분"* 이라는 **확정된 숫자**로 그려지는데, 실제 등록은 파티에
   *    저장된 40분으로 잡힐 수 있다. 모르는 것을 아는 척하지 않고, 아래 꼬리말이
   *    로딩·오류를 **따로** 말한다(§0.3 — 세 상태가 다 있어야 한다).
   */
  const plannedMinutes =
    partyBossesQuery.data?.find(
      (entry) => entry.bossDifficultyId === plan.bossDifficultyId,
    )?.durationMinutes ?? null;

  const createRun = useMutation({
    mutationFn: createPartyRun,
    onSuccess: (created: ScheduledRun) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.list(created.partyId, created.weekKey),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.root(),
      });
      /*
       * ★ **이번 주 시간표도 함께**(2026-08-20, §0.2-1 형제 위치). 방금 만든 런에 나도
       *   참가로 들어가므로 현황 › 이번주 일정에 나타나야 한다. `runs.list` 는 파티별
       *   키라 `runs.timetable` 을 덮지 못한다 — 시간표의 묶음 등록도 같은 줄을
       *   갖고 있고, 여기만 빠지면 이 창으로 잡은 일정이 시간표에서 60초 동안 없다.
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.timetable(created.weekKey),
      });
      /*
       * ★ 관리 › 기타의 "내 파티" 카드는 파티마다 **이번 주 일정 건수**를 싣는다.
       *   여기서 날리지 않으면 방금 잡은 일정이 그 화면에서는 보이지 않는다 (§2.4 Rule 1).
       */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });
      /*
       * ★ 2026-09-28 — 여기 있던 `availability.root()` 무효화가 **빠졌다.** 등록된 런이
       *   시간을 점유한다는 사실(마이그레이션 23)은 DB 에 그대로 있지만, 그것을 읽어
       *   그리던 겹쳐보기 화면이 삭제되면서 키 자체가 없어졌다(`lib/query-keys.ts`).
       *   같은 이유로 주간 일정표의 등록 뮤테이션(`timetable-run-dialog.tsx`)에도 없다.
       */
    },
  });

  /*
    ═══════════════════════════════════════════════════════════════════════════
    참여자 = **체크한 사람.** 인원수는 그 수에서 나온다
    ═══════════════════════════════════════════════════════════════════════════
    2026-08-20. 이 모달은 **파티 구성원 전원**을 참가자로 밀어 넣고 있었고, 고를 방법이
    아예 없었다. 그래서 5명 방에서 2명만 갈 일정을 잡아도 5명이 등록되고, 단톡방에 나가는
    알림이 안 가는 사람의 이름까지 불렀다(발주 지적: *"이거 왜 5명 다들어가냐고"*).

    ★ 발주자가 세운 모델은 이렇다 — **파티 ≠ 보스 파티.**
        · 파티      = 단톡방에 모인 사람들 (5명)
        · 보스 일정 = 그중 실제로 가는 사람들 (2명)
      전원을 넣는 것은 이 구분을 지운다.
    ★ 겹쳐보기 등록 폼(`run-composer`)이 이미 같은 방식으로 고쳐졌다(`c8c23dc`).
      **같은 결함이 두 곳에 있었는데 한 곳만 고쳤던 것**이고(§0.2 위반), 이제 둘이 같다.
    ★ 여기에는 겹침 정보가 없으므로 후보는 **파티 전원**이고 기본은 **전원 체크**다.
      "안 가는 사람만 빼면 된다"가 가장 적은 조작이다.
  */
  const [excludedPersonIds, setExcludedPersonIds] = useState<
    ReadonlySet<PersonId>
  >(() => new Set());

  /**
   * 내 추적 캐릭터 — **파티 목록에서 내 줄을 찾는 열쇠**로만 쓴다(발주 2026-10-16).
   *
   * ★ `/boss-plans` 는 세션 전용 화면이라(`app/boss-plans/page.tsx` — 비로그인에게는
   *   안내 카드를 그린다) 401 로 떨어질 길이 없다.
   * ★ **창을 열 때만** 켠다. 키(`db.characters.forRuns()`)는 파티 관리·시간표 등록 창과
   *   같으므로 대개 이미 캐시에 있고, 그러면 왕복이 0 이다.
   * ★ 실패해도 화면을 세우지 않는다 — 못 읽으면 `mine` 이 전부 `null` 이 되어 **예전과
   *   똑같은** 목록이 된다. 보조 표시라 오류 UI 를 띄울 값이 아니다.
   */
  const charactersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.characters.forRuns()),
    queryFn: fetchMyRunCharacters,
    enabled: open,
  });

  /*
    ── 파티마다 **내가 데려가는 캐릭터** ───────────────────────────────────────
    ⚠️ **이 창이 실제로 보내는 캐릭터는 계획의 캐릭터다**(`character.characterId` —
       계획이 캐릭터에 속하므로 그 캐릭터로 간다). 그래서 이 표식은 "이번에 갈 캐릭터"
       가 아니라 **"이 파티에 평소 데려가는 캐릭터"** 이고, 둘이 다르면 그 사실이
       눈에 보이는 것이 맞다 — 같은 구성원으로 캐릭터만 바꿔 도는 파티가 여섯 개씩
       있는 계정에서(발주 실측), 엉뚱한 묶음을 고르는 것이 바로 이 혼동이다.
    ★ 확정값을 넘기지 않는다 — 목록 전체를 확정하려면 파티마다 `fetchPartyMembers`
      왕복이 필요하다(§ `resolveMyPartyOption` 머리말).
  */
  const lens = useMemo(
    () => myPartyLens(charactersQuery.data ?? EMPTY_RUN_CHARACTERS),
    [charactersQuery.data],
  );
  const partyOptions = useMemo<readonly PartyOptionData[]>(
    () =>
      parties.map((party) => ({
        ...party,
        mine: resolveMyPartyOption(party.members, lens),
      })),
    [parties, lens],
  );

  const members = membersQuery.data ?? EMPTY_MEMBERS;
  const participants = members.filter(
    (member) => !excludedPersonIds.has(member.personId),
  );
  /*
    인원수는 **파생값**이다. 사람이 따로 적지 않으므로 참여자 목록과 어긋날 수가 없다.
    (`plan.defaultPartySize` 는 이제 초기값으로도 쓰이지 않는다 — 계획값은 "평소 몇 인"
     이고 이 창이 정하는 것은 "이번에 누가 가는가"라, 후자가 앞선다.)
  */
  const partySize = participants.length;
  const partySizeValid = partySize >= 1;

  /**
   * 다른 참여자의 캐릭터 값 — 서버가 이 등록에 쓰는 **대표 묶음**(번호 최소 활성 묶음 —
   * `ensure_party_bundle`, `fetchMyBundles` 가 같은 순서로 정렬해 내려 준다)의
   * `memberBossMinutes`. 키 = `personId`. 본인 줄은 쓰지 않는다(본인은 아래 `character`).
   * 조회 중·실패면 빈 지도 → 다른 참여자는 미보정으로 접히고, 꼬리말이 그 수를 말한다.
   */
  const bundlesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.myBundles()),
    queryFn: fetchMyBundles,
    enabled: open && partyId !== null,
  });
  const representativeMinutes =
    bundlesQuery.data?.find((bundle) => bundle.partyId === partyId)
      ?.memberBossMinutes ?? null;
  const myCharacterMinutes =
    (charactersQuery.data ?? EMPTY_RUN_CHARACTERS).find(
      (entry) => entry.characterId === character.characterId,
    )?.bossMinutes ?? null;
  /**
   * ★ **실제로 깔릴 분** — 서버(`createPartyRuns`)와 같은 함수 `resolveBossDuration` 으로
   *   접는다(2026-10-21). 묶음 값 > **체크한 참여자들의 배율 합산 추정** > 보내는 상수.
   *   참여자는 서버가 참가 기록을 만드는 사람·캐릭터와 같다: 본인 = 이 창이 보내는 계획의
   *   캐릭터(`character.characterId`), 나머지 = 대표 묶음의 그 사람 캐릭터 값.
   *   예전 꼬리말은 파티 값이 없으면 `20분(파티에 정해 두지 않음)` 이라 적었는데, 이제
   *   그 자리에는 참여자 추정이 깔리므로 20 은 거짓이 된다.
   */
  const resolvedMinutes = resolveBossDuration({
    bossDifficultyId: plan.bossDifficultyId,
    bundleMinutes: plannedMinutes,
    /*
      ★ 본인은 **언제나** 이 창이 보내는 캐릭터의 값이다(대표 묶음을 못 읽어도) — 서버가
        요청의 `characterId` 로 읽는 것과 같다. 본인 판정은 **보는 사람 id 비교**다(60초
        캐시 안에 새로 들어온 구성원을 본인으로 오인하지 않게). 남은 대표 묶음의 값, 못
        읽었으면 미보정(`null`).
    */
    participants: participants.map((member) =>
      member.personId === viewerPersonId
        ? myCharacterMinutes
        : (representativeMinutes?.[member.personId] ?? null),
    ),
    fallbackMinutes: DEFAULT_DURATION_MINUTES,
  });
  const resolvedNote = describeResolvedDuration(resolvedMinutes);

  const toggleParticipant = (personId: PersonId) => {
    setExcludedPersonIds((previous) => {
      const next = new Set(previous);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };
  const startMinutes = minutesFromTimeText(timeText);
  const overMaxParty =
    maxParty !== null && partySizeValid && partySize > maxParty;

  /** 등록 전 미리보기. 위 주석대로 다른 등록 경로와 **같은 함수**를 쓴다. */
  const shareMeso = crystalShareMeso(
    boss?.crystalPriceMeso ?? null,
    partySizeValid ? partySize : 1,
  );

  const selectedParty =
    parties.find((entry) => entry.partyId === partyId) ?? null;

  const canSubmit =
    selectedParty !== null &&
    partySizeValid &&
    startMinutes !== null &&
    !createRun.isPending;

  const created = createRun.data ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="이 보스로 일정 잡기"
      description={`${plan.bossDisplayName} · ${withJosa(character.name, "으로/로")} 참가합니다. 등록하면 파티원 모두에게 공유됩니다.`}
      className="sm:max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        {/*
          보스 신원.
          §4: **난이도는 좌측 보더 색**으로 인코딩한다. 매핑은 `boss-card.tsx` 의
          `BOSS_DIFFICULTY_BORDER_L` 를 그대로 재사용한다 — 두 벌이 되면 반드시 갈라진다.
          색만으로 정보를 주지 않도록 난이도 라벨을 텍스트로 함께 둔다.
        */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-l-4 border-border bg-background px-3 py-2",
            BOSS_DIFFICULTY_BORDER_L[plan.difficulty],
          )}
        >
          <BossIcon
            bossDifficultyId={plan.bossDifficultyId}
            difficulty={plan.difficulty}
          />
          <span className="text-body font-semibold text-ink">
            {plan.bossDisplayName}
          </span>
          <span className="text-body-sm text-ink-label">
            {BOSS_DIFFICULTY_LABEL[plan.difficulty]}
            {maxParty === null ? "" : ` · 최대 ${maxParty}인`}
          </span>
        </div>

        {parties.length === 0 ? (
          /*
            파티가 없으면 등록할 대상 자체가 없다. 일정은 **파티에 속하기** 때문이다.
            막다른 빈 화면이 아니라 파티 만들기로 보낸다.
          */
          <EmptyState
            icon={<Users size={24} />}
            title="아직 파티가 없습니다"
            description="보스 일정은 파티에 속합니다. 파티 관리에서 파티를 먼저 만들면 여기서 바로 일정을 잡을 수 있습니다."
            action={
              <Link href="/parties">
                <Button size="sm">
                  <Users aria-hidden size={16} />
                  파티 만들러 가기
                </Button>
              </Link>
            }
            className="py-8"
          />
        ) : (
          <>
            {/*
              ── 어느 파티에 만들 것인가 ─────────────────────────────────────
              ★ **2026-10-04 — `<select>` 드롭다운을 얼굴 격자로 바꿨다.**
                발주 지시: *"파티를 선택하는부분은 전부다 같은 컴포넌트를 사용해서 좀
                보기 편하게 만들어"*. 쓰는 것은 시간표 등록 창 · 파티 관리 띠와 **같은
                컴포넌트**(`PartyOption`)이고, 밀도만 `card` 다.
              ★ 드롭다운이 나쁜 이유는 이 도메인 고유다: 실측된 파티 이름이
                `발벨3인` · `세쌀카2인523` 처럼 **보스 줄임말 + 인원**이라 서로 구분되지
                않는다. `구성원 N명` 을 붙여도 마찬가지다 — 인원이 이미 이름 안에 있다.
                실제로 구분에 쓰이는 정보는 **누가 들어 있고 무엇을 도는가**이고,
                `<option>` 안에는 그림을 넣을 수 없다.
              ★ 높이를 `max-h-56` 으로 줄여 둔다. 이 창은 아래로 캐릭터 · 날짜 · 시각 ·
                참가자 · 예상 수령액이 더 이어지는 **폼**이라, 공용 기본값
                (`max-h-[60vh]` — 파티만 묻는 창용)을 그대로 쓰면 파티 목록이 화면을
                독차지하고 등록 버튼이 보이지 않는다.
              ★ `<Label htmlFor>` 가 없어졌다 — 가리킬 폼 컨트롤이 하나가 아니라
                버튼 여러 개이기 때문이다. 대신 격자가 `aria-label` 로 자기를 말하고,
                각 버튼은 `aria-pressed` 로 선택 여부를 말한다(공용 컴포넌트가 진다).
            */}
            <div className="flex flex-col gap-1.5">
              <Label required>파티</Label>
              <PartyOptionGrid
                parties={partyOptions}
                selectedPartyId={partyId}
                onSelect={setPartyId}
                className="max-h-56"
              />
              {membersQuery.isError ? (
                <ErrorState
                  title="파티 구성원을 불러오지 못했습니다"
                  onRetry={() => void membersQuery.refetch()}
                  className="py-6"
                />
              ) : membersQuery.isLoading ? (
                <Skeleton className="h-5" />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {/*
                    ★ **누가 가는지 여기서 고른다.** 예전에는 "구성원 N명이 참여
                      예정으로 등록됩니다"라고 **통보**했고 뺄 방법이 없었다.
                    ★ 기본은 전원 체크다. 이 창에는 겹침 정보가 없어 누가 가능한지 모르므로
                      좁힐 근거가 없고, 안 가는 사람만 빼는 쪽이 조작이 적다.
                  */}
                  <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-border bg-background p-pad-md">
                    {members.map((member) => (
                      <Checkbox
                        key={member.personId}
                        checked={!excludedPersonIds.has(member.personId)}
                        onChange={() => toggleParticipant(member.personId)}
                        label={participantLabel(member)}
                      />
                    ))}
                  </div>
                  <HelperText>
                    체크한 {partySize}명이 참여로 등록됩니다. 각자 어느 캐릭터로
                    갈지는 겹쳐보기 화면에서 본인이 고릅니다.
                  </HelperText>
                </div>
              )}
            </div>

            {/* 내 캐릭터 — 계획이 캐릭터에 속하므로 이미 정해져 있다 */}
            <div className="flex flex-col gap-1.5">
              <Label>내 캐릭터</Label>
              <p className="rounded-md border border-border bg-background px-3 py-2 text-body-sm text-ink">
                {character.name}
                {character.worldName === null
                  ? ""
                  : ` · ${character.worldName}`}
                {character.isMain ? " · 본캐" : ""}
              </p>
              <HelperText>
                이 계획은 {character.name} 의 것이라 그 캐릭터로 등록됩니다.
                결정석 주간 12개 상한은 캐릭터마다 따로 셉니다.
              </HelperText>
            </div>

            {/* 시각 — 시간표 등록과 같은 규약(KST, 목요일 주차 경계) */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={dayId} required>
                  날짜 (KST)
                </Label>
                <select
                  id={dayId}
                  value={dayKey}
                  onChange={(event) => setDayKey(event.target.value)}
                  className={cn(
                    "h-control-md w-full rounded-md border border-border bg-surface px-3",
                    "text-body-sm text-ink transition duration-200 outline-none",
                    "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                  )}
                >
                  {dayRows.map((row) => (
                    <option key={row.dayKey} value={row.dayKey}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={timeId} required>
                  시각 (KST)
                </Label>
                <Input
                  id={timeId}
                  type="time"
                  step={1800}
                  value={timeText}
                  invalid={startMinutes === null}
                  onChange={(event) => setTimeText(event.target.value)}
                />
              </div>
            </div>

            {/*
              ★ 인원수 **입력칸이 사라졌다**(2026-08-20). 발주자가 물었던 "3인 어디서
                설정하는 건데?" 의 답은 이제 **위 체크박스**다 — 갈 사람을 고르면 인원수는
                거기서 나온다. 숫자를 따로 적게 두면 "누가 가는가"와 "몇 명인가"가 서로
                모르는 두 값이 되고, 실제로 그 어긋남이 사고를 냈다.
              ★ 아래 경고(최대 파티 초과)는 그대로 남는다 — 체크를 많이 해도 §1.3 D5 대로
                막지 않고 알리기만 한다.
            */}
            <div className="flex flex-col gap-1.5">
              {partySizeValid ? null : (
                <HelperText tone="error">
                  한 명 이상 체크해 주세요. 아무도 안 가면 등록할 일정이
                  없습니다.
                </HelperText>
              )}
              {overMaxParty ? (
                /*
                  §1.3 D5 — **막지 않고 경고만** 한다. 색은 §4 대로 tertiary orange 이고,
                  red 는 실패·취소 전용이다. 주황은 배경·아이콘이 지고 문장은 잉크가
                  진다(주황 본문은 라이트에서 2.80:1 로 AA 미달). (2026-08-19 라이트 재산정 후 3.93:1 — 여전히 미달이라 이 규약은 그대로다)
                */
                <p className="flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span>
                    {plan.bossDisplayName} 의 최대 파티는 {maxParty}인입니다.
                    등록은 막지 않으니 실제 입장 인원이 맞는지 확인해 주세요.
                  </span>
                </p>
              ) : (
                <HelperText>
                  실제로 입장하는 인원입니다. 이 수로 결정석이 1/n 나뉘며,
                  나중에 고칠 수 있습니다.
                  {/*
                    ★ 2026-08-19 — 분기가 사라졌다. `defaultPartySize` 는 언제나 값이 있고
                      (NOT NULL DEFAULT 1), 손대지 않은 보스의 1 도 **정해진 값**이다.
                  */}
                  {` 보스 계획에 적어 둔 ${String(plan.defaultPartySize)}인을 기본값으로 채웠습니다.`}
                </HelperText>
              )}
            </div>

            {/* 예상 결정석 수령액 — 인원을 바꾸면 즉시 갱신된다 */}
            <div className="flex flex-col gap-1 rounded-md border border-border bg-background p-3">
              {boss === null ? (
                <p className="text-body-sm text-ink-muted">
                  이 보스는 가격표에 연결되지 않아 예상 수령액을 계산할 수
                  없습니다. 등록은 그대로 됩니다.
                </p>
              ) : (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-caption text-ink-muted">
                      결정석 (솔로 기준가)
                    </span>
                    <MesoAmount
                      value={boss.crystalPriceMeso}
                      compact
                      tone="muted"
                      className="text-body-sm"
                    />
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-caption text-ink-label">
                      예상 수령액 · {partySizeValid ? partySize : "-"}인 분배
                    </span>
                    <MesoAmount
                      value={shareMeso}
                      compact
                      tone="accent"
                      className="text-body-sm font-semibold"
                    />
                  </div>
                  {boss.crystalPriceMeso === null ? (
                    <p className="mt-1 flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                      <TriangleAlert
                        aria-hidden
                        size={16}
                        className="mt-0.5 shrink-0 text-tertiary"
                      />
                      <span>
                        가격 미확인 — 0 메소가 아니라
                        &ldquo;모른다&rdquo;입니다. 수익 합계에서 제외됩니다
                        (§1.3 D4).
                      </span>
                    </p>
                  ) : null}
                </>
              )}
            </div>

            {createRun.isError ? (
              <ErrorState
                title="일정을 등록하지 못했습니다"
                detail={createRun.error.message}
                className="py-6"
              />
            ) : null}

            {created !== null ? (
              <Card className="flex flex-col gap-2 border-chip-done-border bg-chip-done-bg">
                <p className="flex items-start gap-2 text-body-sm text-ink">
                  <CheckCircle2
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-chip-done-fg"
                  />
                  <span>
                    {created.runNo}번 일정으로 등록했습니다 ·{" "}
                    {created.bossKoreanName} · {created.entryPartySize}인 ·{" "}
                    {created.weekKey}
                  </span>
                </p>
                <Link href="/" className="self-start">
                  <Button variant="secondary" size="sm">
                    시간표에서 확인하기 →
                  </Button>
                </Link>
              </Card>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={!canSubmit}
                onClick={() => {
                  if (
                    selectedParty === null ||
                    startMinutes === null ||
                    !partySizeValid
                  ) {
                    return;
                  }
                  createRun.mutate({
                    partyId: selectedParty.partyId,
                    bossDifficultyId: plan.bossDifficultyId,
                    scheduledAt: kstMoment(dayKey, startMinutes),
                    /*
                      ⚠️ **폴백이다. 1순위가 아니다.** 서버가
                         `① bossDurationMinutes → ② party_bosses.duration_minutes
                          → ③ 이 값` 순으로 접으므로, 파티가 정해 둔 분이 있으면 그쪽이
                         이긴다(위 `partyBossesQuery` 머리말). 여기 상수를 넣는 것은
                         아무도 아무것도 정하지 않았을 때를 위한 것이다.
                    */
                    durationMinutes: DEFAULT_DURATION_MINUTES,
                    entryPartySize: partySize,
                    participantPersonIds: participants.map(
                      (member) => member.personId,
                    ),
                    characterId: character.characterId,
                    note: null,
                  });
                }}
              >
                <CalendarPlus aria-hidden size={16} />
                {createRun.isPending ? "등록 중…" : "일정 등록"}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                닫기
              </Button>
              {/*
                ── 소요 시간 꼬리말 — **로딩 · 오류 · 값 세 상태** ─────────────
                ★ **파티에 저장된 분**이고 코드 상수가 아니다(위 `partyBossesQuery`).
                  고치는 곳은 파티 관리와 일정 상세다 — 여기에 입력 칸을 두지 않은
                  근거도 그 머리말에 있다.
                ⚠️ 예전 주석은 *"둘 다 같은 폴백 순서를 쓰므로 틀린 값이 그려지는 순간이
                   없다"* 고 적었는데 **사실이 아니었다.** 조회 중에는 알 수 없고, 실패하면
                   **영구히** 알 수 없는데 화면은 `20분` 이라고 단정하고 있었다. 그래서
                   세 상태를 가른다 — 모르는 동안에는 숫자를 적지 않는다.
              */}
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-body-sm text-ink-muted">
                <span>
                  {getWeekKey(kstMoment(dayKey, startMinutes ?? 0))} 주차
                </span>
                {partyBossesQuery.isPending ? (
                  <span>· 소요 시간 확인 중…</span>
                ) : partyBossesQuery.isError ? (
                  <>
                    <span className="text-error">
                      · 소요 시간을 불러오지 못했습니다
                    </span>
                    {/*
                      다시 시도할 길을 준다. 등록 자체는 막지 않는다 — 소요 시간은
                      **서버가 파티에서 읽어** 깔기 때문에, 이 조회가 실패해도 잡히는
                      시간은 올바르다. 모르는 것은 화면뿐이다.
                    */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void partyBossesQuery.refetch()}
                    >
                      다시 시도
                    </Button>
                  </>
                ) : (
                  <span>
                    ·{" "}
                    {String(resolvedMinutes.minutes)}분
                    {resolvedMinutes.source === "bundle"
                      ? "(파티에 정해 둔 값)"
                      : resolvedMinutes.source === "fallback"
                        ? "(정해 둔 값 없음)"
                        : resolvedNote === null
                          ? null
                          : `(${resolvedNote})`}
                  </span>
                )}
              </span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
