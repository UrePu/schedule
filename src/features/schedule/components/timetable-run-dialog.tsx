"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  BossIcon,
  MemberFace,
  MyCharacterMark,
  PartyOptionGrid,
  SeatNumber,
  type PartyOptionData,
  type PartyOptionMine,
} from "@/components/domain";
import { formatKstFull } from "@/components/domain/kst-format";
import {
  Button,
  Checkbox,
  Dialog,
  DurationField,
  EmptyState,
  ErrorState,
  HelperText,
  Skeleton,
  useToaster,
} from "@/components/ui";
import { participantLabel } from "@/lib/domain/participant-label";
import { describeStaleBossMentions } from "@/lib/domain/party-title";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { formatKst, getWeekKey } from "@/lib/time/week";
import { cn } from "@/lib/utils";
import type {
  BossDifficultyId,
  CreateRunBundleInput,
  Party,
  PartyMember,
  PartyMemberBrief,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";

import {
  createPartyRunBundle,
  fetchMyBundles,
  fetchMyRunCharacters,
  fetchParties,
  fetchPartyMembers,
} from "../data";
import { DEFAULT_DURATION_MINUTES } from "../lib/run-defaults";
import type { BundleOptionWire, PartyBundleBossWire } from "../types";

/**
 * 보스별 소요 시간의 **편집분만** 담는 지도. 키는 `bossDifficultyId`.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **"안 건드렸다"와 "20분으로 정했다"는 다른 사실이다.**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   비어 있으면 저장 요청에서 `bossDurationMinutes` 를 **아예 싣지 않는다**. 그러면
 *   서버가 `party_bosses.duration_minutes` 를 읽어 접고(§ `CreateRunBundleInput`),
 *   그것이 웹·봇이 같은 값을 보는 유일한 길이다. 반대로 화면이 접어서 되돌려 보내면
 *   *"파티가 안 정함(null)"* 이 *"20 으로 정함"* 으로 조용히 굳는다 — 그 뒤로는 기본값을
 *   25분으로 바꿔도 이 파티만 영원히 20분이다.
 * ★ 값 자체도 **접지 않는다.** 건드린 보스의 값이 `null`(빈 칸)이면 `null` 을 보낸다.
 */
type DurationEdits = ReadonlyMap<string, number | null>;

/** 모듈 상수 하나를 공유한다 — `NO_EXCLUSIONS` 와 같은 근거(새 참조가 리렌더를 부른다). */
const NO_DURATION_EDITS: DurationEdits = new Map<string, number | null>();

/**
 * 이 보스에 **실제로 쓰일 분**. 편집분 → 파티에 저장된 값 → 기본값 순으로 접는다.
 * 서버(`resolveBossDurations`)의 우선순위와 **같은 순서**다 — 두 벌이 되면 미리보기가
 * 저장 결과와 갈라진다.
 */
function effectiveMinutes(
  entry: PartyBundleBossWire,
  edits: DurationEdits,
): number {
  const edited = edits.has(entry.bossDifficultyId)
    ? (edits.get(entry.bossDifficultyId) ?? null)
    : entry.durationMinutes;
  return edited ?? DEFAULT_DURATION_MINUTES;
}

/**
 * 저장 요청에 실을 값.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **사용자가 고친 보스만 값을 싣고, 나머지는 `null` 이다.**
 *   ═══════════════════════════════════════════════════════════════════════════
 *   계약이 배열 길이를 보스 수와 맞추라고 요구하므로(다르면 400) 안 건드린 보스도
 *   **자리는** 차지해야 한다. 그 자리에 무엇을 담는지가 전부다:
 *     · `entry.durationMinutes`(캐시에서 읽은 값)를 담으면 — 2026-10-11 결함 —
 *       60초 stale 캐시의 20분이 **다른 파티원이 방금 넣은 40분을 덮어쓴다.**
 *       서버는 명시된 값을 `party_bosses` 에 저장하므로(발주 지시대로) 조용히 지워진다.
 *     · `null` 을 담으면 서버가 ① 요청값 없음 → ② `party_bosses` 의 저장값 →
 *       ③ 묶음 폴백 순으로 접고, **쓰지도 않는다** —
 *       `schedule-repo.createPartyRuns` 가 `explicitDurations` 를 만들 때
 *       `requested === null` 인 자리를 `flatMap` 으로 **버린다**(실측 확인).
 *   즉 `null` 은 이 경로에서 "지운다"가 아니라 정확히 "지정하지 않음"이다.
 *
 * ⚠️ 미리보기는 이 함수가 아니라 `effectiveMinutes` 를 쓴다. 화면은 **실제로 깔릴 분**을
 *    그려야 하고(= 캐시의 파티 값까지 접은 값), 전송은 **아는 것만** 보내야 한다.
 *    두 질문이 다르므로 함수도 둘이다.
 */
function rawMinutes(
  entry: PartyBundleBossWire,
  edits: DurationEdits,
): number | null {
  return edits.has(entry.bossDifficultyId)
    ? (edits.get(entry.bossDifficultyId) ?? null)
    : null;
}

/**
 * 묶음의 i 번째 보스가 **시작하는 시각**들. 끝 시각은 마지막 원소 + 마지막 보스의 분이다.
 *
 * ★ `개수 × 한 값` 으로 그리지 않는다(2026-10-11). 보스마다 길이가 다르므로 그렇게 그리면
 *   **두 번째 보스부터 어긋나고**, 그 어긋남은 그럴듯하게 그려져 아무도 알아채지 못한다.
 */
function cumulativeStarts(
  startsAt: Date,
  bosses: readonly PartyBundleBossWire[],
  edits: DurationEdits,
): readonly Date[] {
  const starts: Date[] = [];
  let offsetMs = 0;
  for (const entry of bosses) {
    starts.push(new Date(startsAt.getTime() + offsetMs));
    offsetMs += effectiveMinutes(entry, edits) * 60_000;
  }
  return starts;
}

/** 묶음 전체가 끝나는 시각. 보스가 없으면 `null`. */
function bundleEnd(
  startsAt: Date,
  bosses: readonly PartyBundleBossWire[],
  edits: DurationEdits,
): Date | null {
  if (bosses.length === 0) return null;
  const totalMinutes = bosses.reduce(
    (sum, entry) => sum + effectiveMinutes(entry, edits),
    0,
  );
  return new Date(startsAt.getTime() + totalMinutes * 60_000);
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 시간표 빈 칸 → **파티만 고르면 일정이 잡힌다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-09-28): *"일정표를 항상 띄우고 일정 계획칸을 삭제. 일정표에서 특정
 * 구간을 눌러 파티를 고르는것으로 변경. 기존에 파티를 생성할때 보스 선택하는것을 이용하여"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 없어진 두 단계가 이 창의 정의다
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전 등록은 **시간 → 보스 → 참여자** 3단 마법사(`run-wizard-dialog.tsx`)였다. 셋 다
 * 여기서는 물을 필요가 없다:
 *
 *   시간   → **누른 칸이 시작 시각이다.** 창이 뜨기 전에 이미 정해져 있다.
 *   보스   → **그 파티에 등록된 보스 전체**(`party_bosses`). `/parties` 가 이미 소유한
 *            정보를 여기서 또 고르게 하면 같은 사실을 두 곳에서 정하게 된다.
 *   참여자 → **그 파티의 구성원 전원.** 파티는 "같이 보스 가는 사람들"의 정의 그 자체다.
 *
 * 그래서 남는 질문이 **"어느 파티로?"** 하나이고, 그 하나만 묻는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 파티를 누르는 즉시 저장하지 **않는** 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * "고르면 잡힌다"를 글자 그대로 구현하면 클릭 하나에 DB 쓰기가 붙는데, 이 창이 필요한
 * 정보(파티 보스·구성원)는 **파티를 고른 뒤에야** 조회된다. 그 사이에 있을 수 있는 일이
 * 둘이다.
 *
 *   ① **보스가 0개인 파티** — `/parties` 에서 보스를 아직 안 정한 파티가 실제로 있다.
 *      서버는 "등록할 보스를 하나 이상 선택해 주세요" 로 400 을 주므로, 즉시 저장 방식은
 *      누르자마자 오류를 보여 주게 된다. 무엇을 해야 하는지(=`/parties` 로 가서 보스
 *      등록)는 오류 문구가 말해 주지 못한다.
 *   ② **조회 지연** — 응답이 오기 전에는 저장할 값이 없어 창이 아무 반응 없이 멈춘다.
 *
 * 그래서 고른 뒤 **무엇이 잡히는지 한 줄로 보여 주고** 확인을 받는다. 단계가 늘어난 것이
 * 아니다 — 화면은 하나이고 되돌아갈 앞 단계도 없다. 늘어난 것은 "이대로 맞나"를 볼 기회다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 파티를 **얼굴로** 고른다 (발주 지시 2026-10-04)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"보스일정잡기를 예전 파티 선택처럼 얼굴도 보이는걸로 바꿔줘"*
 *
 * 이 창이 생길 때(2026-09-28) 파티 줄은 **이름 + 파티원 이름 한 줄**짜리 글자 목록이
 * 됐다. 그 전까지 쓰던 `PartyPickerDialog` 는 파티원 초상화를 격자로 띄우고 있었는데,
 * 화면이 통째로 없어지면서 그 표현도 함께 삭제됐다. 글자만 남으니 2026-09-01 에 이미
 * 한 번 고쳤던 문제가 되돌아왔다 — 실측된 파티 이름이 `발벨3인` · `세쌀카2인523`
 * 처럼 **보스 줄임말 + 인원**이라, 이름으로는 서로 구분되지 않고 파티원 이름을 한 줄로
 * 이어 붙여도 뒤쪽이 잘린다.
 *
 * 그래서 삭제된 `party-picker-dialog.tsx` 에서 **두 가지를 되살렸다**(되살린 것은
 * 표현이지 컴포넌트가 아니다 — 저 파일은 복원하지 않았다):
 *   ① **파티원 초상화 타일** — `scale-[5]` 얼굴 크롭. 배율의 근거는 실측이다(아래
 *      `MemberFace` 머리말). 그림이 없으면 실루엣이고 그것이 **정상 상태**다(§2.1.1).
 *   ② **게스트 얼굴 메우기**(`useGuestLookBackfill`) — 게스트는 `characters` 행이
 *      없어 영원히 실루엣이라, 창을 열 때 한 번 이름으로 생김새를 받아 둔다.
 *
 * 여기에 **보스 얼굴**을 더했다. 이 창의 일이 "어느 파티로 가나"이고 파티의 정체는
 * *누구와* + *무엇을* 이므로, 사람만 보이고 보스가 글자로만 있으면 절반만 보인다.
 * 얼굴은 일정표 블록(`week-timetable.tsx` 의 `RunBlock`)과 **같은 `BossIcon`**이다 —
 * 같은 보스가 두 화면에서 다르게 보이지 않아야 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 표현은 이제 **이 파일의 것이 아니다** (2026-10-04, 같은 날 두 번째 지시)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"파티를 선택하는부분은 전부다 같은 컴포넌트를 사용해서 좀 보기 편하게 만들어"*
 *
 * 위에서 되살린 얼굴 타일 · 얼굴 줄 · `+N` 칩은 처음에 **이 파일 안의 지역 컴포넌트**로
 * 들어왔다. 그 상태로는 `/boss-plans` 의 등록 창과 `/parties` 의 파티 띠가 같은 표현을
 * 쓸 길이 없고(둘은 각각 `<select>` 와 글자 칩이었다), 베껴 가면 두 벌이 되어 반드시
 * 갈라진다. 그래서 전부 **`@/components/domain/party-option`** 으로 옮기고 여기서는
 * 지웠다 — 세 화면이 같은 컴포넌트를 쓰고, 밀도(`card` / `chip`)만 다르다.
 *
 * ★ **왕복도 같이 지웠다.** 보스 얼굴을 그리려고 이 창은 `useQueries` 로 **파티당 한 건**
 *   보스를 따로 받고 있었다(실측 파티 30개 → 30건). 양을 줄이려고 "앞 8개만 받고
 *   목록을 굴리면 더 받는" 꼼수까지 붙어 있었다. 이제 `GET /api/schedule/parties` 가
 *   `Party.bosses` 로 얼굴용 최소값을 함께 싣는다 — 서버는 `party_bosses` 를 한 번
 *   읽고, 브라우저 왕복은 **30건 → 0건**이다. 꼼수와 그 상수도 함께 사라졌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 2026-10-06 — **보스와 파티원을 여기서 고른다.** 위 "보스는 묻지 않는다"가 뒤집혔다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 요청 원문: *"일정잡을때 보스 한개만 선택하고싶은데 무조건 전체 선택후 그 후에
 * 취소해야함 파티원과 보스 선택가능하게 변경"*
 *
 * **뒤집힌 결정을 지우지 않는 이유**는 그 근거가 틀렸던 게 아니기 때문이다. 2026-09-28
 * 의 논리는 *"보스는 `/parties` 가 이미 소유한 정보이므로 같은 사실을 두 곳에서 정하게
 * 하지 말자"* 였고, 그 말은 **소유권**에 관해서는 지금도 맞다 — 이 창은 `party_bosses`
 * 를 고치지 않는다. 틀렸던 것은 거기서 한 걸음 더 간 **"그러니 매번 전부 간다"** 쪽이다.
 * 파티는 *"같이 도는 묶음"* 의 정의이지 *"매번 그 묶음을 통째로 돈다"* 는 약속이 아니다.
 * 실제 쓰임이 그것을 증명했다: 보스 하나만 잡으려면 전부로 등록한 뒤 나머지를 **하나씩
 * 취소**해야 했고, 취소된 런은 행이 남아(`cancelled_at`) 시간표에 쓰레기로 쌓인다.
 * 즉 예전 방식은 "조작이 적다"가 아니라 **조작이 제일 많은 길**이었다.
 *
 * ★ **기본값은 여전히 전부 선택이다.** 예전 경로가 느려지면 안 된다 — 파티를 고르고
 *   바로 [잡기] 를 누르는 동작 수는 **변하지 않았다**(체크를 건드릴 필요가 없다).
 *   고르는 일은 "빼고 싶을 때"만 하는 일이고, 그래서 상태도 선택 집합이 아니라
 *   **제외 집합**(`excluded*`)이다. 제외 집합이면 목록이 늦게 도착해도(보스·구성원은
 *   파티를 고른 뒤에 조회된다) 초기값을 심는 effect 가 필요 없다 — 비어 있는 제외
 *   집합이 곧 "전원·전부"다. 선택 집합으로 두면 도착 시점에 state 를 채우는 동기화가
 *   생기고, 그 동기화가 늦으면 **한 순간 0개가 되어 등록 버튼이 깜빡 꺼진다.**
 * ★ **단계를 늘리지 않았다.** 체크는 이미 있던 확인 화면의 **같은 줄에** 얹혔다.
 *   `/boss-plans` 의 등록 모달이 2026-08-20 에 참여자에 대해 똑같이 한 선택이고
 *   (`boss-plans/components/plan-run-dialog.tsx`), 이제 두 화면의 언어가 같다.
 * ★ **1/n 의 분모가 고른 인원으로 간다** — 아래 `submit` 의 `entryPartySize` 참고.
 *   이걸 파티 전체 인원으로 두면 수익이 조용히 틀린다(§1 · §1.3 D3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-10-16 (2단계) — 고르는 대상이 파티에서 **보스 묶음**으로 바뀌었다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 문제: 같은 사람들이 보스 조합·캐릭터·분배만 바꿔 여러 조합을 도는데 조합마다
 * 파티를 새로 만들어야 했다(실측 활성 파티 34개 중 **6개가 같은 구성원**이고 이름이
 * `본캐 림흉 돌먹` · `은월 림흉 돌먹` 처럼 캐릭터 이름으로만 갈렸다).
 *
 * ⚠️ **고르는 횟수는 늘지 않았다**(§1.1.1 — 이 창은 한 질문에만 답한다). 예전에 "파티
 *    1클릭" 이던 자리가 "묶음 1클릭" 이 됐을 뿐이고, 파티를 고른 뒤 묶음을 고르는 2단은
 *    **만들지 않았다.** 그러려면 목록이 평평해야 하고, 그래서 서버에
 *    `GET /api/schedule/bundles/mine` 하나가 생겼다(내 모든 파티의 활성 묶음).
 *    어느 파티의 조합인지는 줄의 **둘째 줄**(`PartyOptionData.subtitle`)이 말한다.
 *
 * ★ **보스 조회가 사라졌다.** 예전에는 파티를 고른 뒤 `fetchPartyBosses` 를 한 건 더
 *   돌았다. 묶음 목록 payload 가 보스와 그 소요 시간을 함께 싣고 오므로(`bundle.bosses`)
 *   고른 뒤의 왕복이 **1건 → 0건**이고, 더 중요한 것은 **그 묶음의** 값을 쓴다는 점이다 —
 *   파티축 조회는 "번호가 가장 작은 묶음" 을 돌려주므로 익스+흉성을 골랐는데 카칼+노벨의
 *   소요 시간이 깔릴 수 있었다.
 */

export interface TimetableRunDialogProps {
  /** 시작 시각 — **누른 칸**이 정한다. `null` 이면 창이 닫혀 있다. */
  readonly startsAt: Date | null;
  readonly onClose: () => void;
  /**
   * 열람자 본인(`app_users.id`). 비로그인은 쓰기가 전부 401 이라 부모가 애초에 열지
   * 않지만, 여기서도 조회를 켜지 않는다 — `/api/schedule/characters` 는 세션이 없으면
   * 401 이고, 공개 시간표에 없어야 할 에러 UI 가 뜬다.
   *
   * 값 자체는 **"파티 안에서 어느 줄이 나인가"** 를 찾는 데 쓴다(`PartyMember` 에는
   * `isMe` 가 없다 — 판정의 주인은 화면이 아니라 세션이다).
   */
  readonly viewerPersonId: PersonId | null;
}

const EMPTY_PARTIES: readonly Party[] = [];
const EMPTY_CHARACTERS: readonly RunCharacterOption[] = [];
const EMPTY_BUNDLES: readonly BundleOptionWire[] = [];
/** 고른 묶음이 없을 때의 보스 목록. 매 렌더 새 배열을 만들면 하위 memo 가 무효화된다. */
const EMPTY_BUNDLE_BOSSES: readonly PartyBundleBossWire[] = [];

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 묶음 줄의 **둘째 줄** — 소속 파티와 실제 보스
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 신고(2026-10-19): *"일정 잡을땐 세대카 무고 가 있는데 파티관리에는 없음.
 * 이거 왜이러는거야?"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 원인 — 묶음 이름이 **파티 이름 변경을 따라가지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 묶음 이름은 1단계 백필 때 파티 이름을 **복사한 값**이고, 그 뒤 파티 이름이 바뀌어도
 * 따라가지 않는다. 그래서 이 창은 묶음 이름을, `/parties` 는 파티 이름을 보여 주고
 * 같은 것이 두 이름으로 보인다. 라이브 실측(2026-10-19, 활성 묶음 33건):
 *
 *   세대카무고            → 파티 `카인 세카대 2인`   (신고된 그 줄)
 *   엔버 익세하적하카 2인 → 파티 `엔버 세카대 2인`
 *   진듄더 익세하카하적   → 파티 `진듄더 익검 4인` · `레테 익검 4인` · `보마 익검 4인`
 *
 * **28건은 두 이름이 같고 5건만 다르다.**
 *
 * ⚠️ **이름을 자동으로 다시 짓지 않는다.** "사용자가 일부러 묶음에 다른 이름을 줬다" 와
 *    "파티가 나중에 개명됐다" 를 **구분할 방법이 없고**(둘 다 그냥 `name <> party.name`
 *    이다), 구분할 수 없는 것을 덮으면 `(돌먹)` 처럼 사람이 더한 정보가 사라진다.
 *    그래서 고치는 것은 이름이 아니라 **보이는 것**이다 — 소속을 함께 적는다.
 *
 * ⚠️ **같을 때는 두 번 적지 않는다.** 2026-10-19 까지 이 줄은 `partyName` 을 **언제나**
 *    적었고, 그 결과 28건의 카드가 **같은 이름을 위아래로 두 번** 들고 있었다(위는
 *    `ink` + semibold, 아래는 `ink-muted`). 두 번 적힌 이름은 정보가 아니라 소음이고,
 *    더 나쁜 것은 그 소음 때문에 **진짜 다른 5건의 둘째 줄이 눈에 걸리지 않았다**는
 *    점이다 — 신고가 바로 그것이다. 다를 때만 적으면 그 줄은 "볼 때만 뜨는 줄" 이 된다.
 *
 * ★ `파티` 라는 **낱말을 붙인다.** 이름만 적으면 `카인 세카대 2인` 이 무엇인지(다른
 *   묶음? 캐릭터? 보스 줄임말?) 읽는 사람이 알 수 없다. 신고자가 찾던 곳이 바로
 *   `파티 관리` 이므로, 그 낱말이 화면에 있어야 질문이 사라진다.
 * ★ 보스 어긋남(2026-10-17)은 **그대로 유지**된다. 두 사실이 동시에 참일 수 있으므로
 *   한 줄에 `·` 로 잇는다 — `파티 레테 익검 4인 · 보스 익검 4인`.
 * ★ 둘 다 아니면 `null` 이고 **줄 자체가 없다**(`PartyOption` 이 `null` 이면 그리지
 *   않는다). 그래서 폭 400px 에서 줄이 늘어나는 카드는 5건뿐이고, 늘어난 줄도
 *   `truncate` 라 가로로 넘치지 않는다.
 */
function bundleSubtitle(bundle: BundleOptionWire): string | null {
  const parts: string[] = [];
  if (bundle.name !== bundle.partyName) parts.push(`파티 ${bundle.partyName}`);
  if (bundle.staleBossMentions.length > 0) {
    parts.push(`보스 ${bundle.autoName}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * 제외 집합의 초기값 — **빈 집합이 곧 "전부 선택"**이다(머리말 2026-10-06).
 *
 * 모듈 상수 하나를 공유한다. `useState(new Set())` 처럼 호출부에서 만들면 리셋할 때마다
 * 새 참조가 생겨 "비어 있음"끼리도 같지 않게 되고, 파티를 되돌릴 때 불필요한 리렌더가
 * 붙는다. 비어 있는 상태는 하나이므로 객체도 하나다.
 */
const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

/** 집합에서 하나를 켜고/끄는 순수 함수. 원본을 고치지 않는다(state 불변식). */
function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function TimetableRunDialog({
  startsAt,
  onClose,
  viewerPersonId,
}: TimetableRunDialogProps) {
  const queryClient = useQueryClient();
  const toaster = useToaster();

  /** 고른 **묶음**. `null` = 아직 고르지 않았다(목록만 보이는 상태). */
  const [pickedBundleId, setPickedBundleId] = useState<string | null>(null);

  /*
    ★ **빼기만 담는다**(머리말 2026-10-06). 비어 있는 집합이 곧 "보스 전부 · 파티원
      전원"이라, 조회가 늦게 도착해도 초기값을 심을 필요가 없다.
    ★ 파티를 바꾸면 **반드시 비운다.** id 는 파티별로 다르니 남은 제외가 새 파티에
      걸릴 일은 없지만, 비우지 않으면 같은 파티로 되돌아왔을 때 아까 뺀 것이 조용히
      살아 있다 — 창이 "전부 선택"이라고 말하면서 그렇지 않은 상태다.
  */
  const [excludedBossIds, setExcludedBossIds] =
    useState<ReadonlySet<string>>(NO_EXCLUSIONS);
  const [excludedPersonIds, setExcludedPersonIds] =
    useState<ReadonlySet<string>>(NO_EXCLUSIONS);

  /*
    ★ 보스별 소요 시간의 **편집분만** 담는다(위 `DurationEdits` 머리말). 파티를 바꾸면
      반드시 비운다 — 다른 파티의 보스 id 가 겹칠 수 있고(같은 보스를 두 파티가 돈다),
      그러면 아까 고친 분이 새 파티에 조용히 따라붙는다.
  */
  const [durationEdits, setDurationEdits] =
    useState<DurationEdits>(NO_DURATION_EDITS);

  const pickBundle = (bundleId: string | null) => {
    setPickedBundleId(bundleId);
    setExcludedBossIds(NO_EXCLUSIONS);
    setExcludedPersonIds(NO_EXCLUSIONS);
    setDurationEdits(NO_DURATION_EDITS);
  };

  const open = startsAt !== null;

  /**
   * **고를 목록** — 내 모든 파티의 활성 묶음. 평평하다(머리말 ⚠️).
   *
   * 티어: db(60초). 신선도는 묶음 뮤테이션 후 무효화가 지며, `/parties` 의 저장이
   * `queryKeys.db.party.myBundles()` 를 **명시해서** 날린다(형제 키라 접두사로 안 따라온다).
   */
  const bundlesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.myBundles()),
    queryFn: fetchMyBundles,
    enabled: open && viewerPersonId !== null,
  });

  const bundles = bundlesQuery.data ?? EMPTY_BUNDLES;

  /**
   * 파티 목록 — **얼굴 재료**로만 쓴다(게스트 얼굴 메우기 + 초상화 캐시).
   *
   * ★ 묶음 payload 가 `members`(초상화 포함)를 이미 싣고 오므로 **고르는 데는 필요하지
   *   않다.** 그런데 `useGuestLookBackfill` 은 `Party` 를 받아 돌고(그 훅이 파티 목록
   *   쿼리를 무효화한다), 게스트 얼굴은 그 경로로만 채워진다. 쿼리는 이 창이 열릴 때
   *   어차피 캐시에 있는 값이라 왕복이 늘지 않는다.
   */
  const partiesQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.list()),
    queryFn: fetchParties,
    enabled: open,
  });

  const parties = partiesQuery.data ?? EMPTY_PARTIES;
  const myParties = useMemo(
    () => parties.filter((party) => party.members.length > 0),
    [parties],
  );

  /*
    게스트 얼굴을 조용히 메운다. 화면 모양에는 아무 영향이 없고, 메울 것이 없으면
    요청도 나가지 않는다(훅 머리말). 창이 닫혀 있으면 아무 일도 하지 않는다.
  */
  useGuestLookBackfill(open, myParties);

  /*
    ★ **보스 조회가 없다**(머리말). 고른 묶음의 보스와 소요 시간은 목록 payload 에
      이미 들어 있다 — 그리고 그것이 **그 묶음의** 값이다.
  */
  const pickedBundle =
    bundles.find((bundle) => bundle.bundleId === pickedBundleId) ?? null;
  const pickedPartyId = pickedBundle?.partyId ?? null;

  const membersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.party.members(pickedPartyId ?? "none")),
    queryFn: () => fetchPartyMembers(pickedPartyId ?? ""),
    enabled: open && pickedPartyId !== null,
  });

  /**
   * 내가 데려갈 캐릭터. **서버가 요구하는 값**이라 비울 수 없다.
   *
   * 고르게 하지 않는 이유: 파티마다 데려갈 캐릭터는 `/parties` 에서 이미 정해 뒀고
   * (`party_participants.character_id`), 정하지 않았으면 본캐(목록 첫 행)가 맞다.
   * 특정 일정만 다른 캐릭으로 나가는 경우는 드물고, 그 조정은 이 창의 질문이 아니다.
   */
  const charactersQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.characters.forRuns()),
    queryFn: fetchMyRunCharacters,
    enabled: open && viewerPersonId !== null,
  });

  const characters = charactersQuery.data ?? EMPTY_CHARACTERS;
  const partyBosses = pickedBundle?.bosses ?? EMPTY_BUNDLE_BOSSES;
  const members = membersQuery.data ?? [];

  /*
    ── 묶음 한 줄을 공용 컴포넌트가 읽는 모양으로 ──────────────────────────────
    ★ **`PartyOption` 을 그대로 쓴다**(형제를 만들지 않았다 — 근거는
      `components/domain/party-option.tsx` 의 `subtitle` 머리말). 그릴 것이 글자 그대로
      같고, 더해지는 것은 "어느 파티의 묶음인가" 한 줄뿐이다.
    ★ **내 캐릭터는 서버가 푼 값**이다(묶음 지정 → 파티 기본값). 그래서 목록 단계에서도
      `assigned` 가 **확정**이다 — 파티축 목록에서는 본캐 폴백과 지정을 가를 수 없어
      `null`(모름)이 나왔는데(`resolveMyPartyOption` 머리말), 묶음 payload 는
      `myCharacterAssigned` 를 직접 싣고 온다. 즉 2단계에서 그 모호함이 없어졌다.
    ★ `mine.member` 는 **얼굴 재료**다. 묶음 payload 의 `members` 에서 캐릭터 이름이
      같은 줄을 찾아 쓰고, 못 찾으면 이름만 담은 최소 brief 를 만든다 — 실루엣은
      오류가 아니라 정상 상태다(§2.1.1).
  */
  const bundleOptions = useMemo<readonly PartyOptionData[]>(
    () =>
      bundles.map((bundle): PartyOptionData => {
        const mine: PartyOptionMine | null =
          bundle.myCharacterName === null
            ? { member: null, assigned: false }
            : {
                member:
                  bundle.members.find(
                    (member) => member.characterName === bundle.myCharacterName,
                  ) ?? {
                    displayName: bundle.myCharacterName,
                    characterName: bundle.myCharacterName,
                    characterLevel: null,
                    characterClass: null,
                    characterImageUrl: null,
                    isGuest: false,
                  },
                assigned: bundle.myCharacterAssigned,
              };
        return {
          partyId: bundle.bundleId,
          name: bundle.name,
          /*
            ── 판정 규칙 전부는 **`bundleSubtitle` 머리말**에 있다. 2026-10-19 에
               **소속 파티**가 더해지고 "언제나 적던 파티 이름"이 "다를 때만" 으로
               바뀌었다(같은 이름을 두 번 적던 28건이 한 줄로 줄었다).
            ── **이름이 보스와 어긋났으면 실제 보스를 함께 적는다** (2026-10-17) ──
            ★ ═════════════════════════════════════════════════════════════════
              신고의 증상은 "틀렸다" 가 아니라 **"못 찾았다"** 였다
              ═════════════════════════════════════════════════════════════════
              파티원 신고: *"진듄더 세카데 4인을 익검4인으로 변경해서 일정
              넣을려고하니까 보스일정에 안나옴요"*. 그 묶음은 목록에 **있었다** —
              이름이 `진듄더 익세하카하적` 이라 `익검` 을 찾는 눈에 걸리지 않았을
              뿐이다. 그래서 이 자리에서 필요한 것은 경고가 아니라 **알아볼 수
              있게 하는 것**이고, 둘째 줄에 `보스 익검 4인` 을 덧붙이면 그 줄에서
              답이 나온다.
            ★ **주황 경고를 여기 두지 않는다.** 이 창에서는 묶음 이름을 고칠 수
              없고(그 집은 `/parties` 의 묶음 편집이다), 고칠 수 없는 자리의 경고는
              읽은 사람이 할 수 있는 일이 없다. 고치는 길은 묶음을 고른 뒤 아래
              확인 단계가 한 줄로 말한다.
            ★ 어긋나지 않았으면 **덧붙이지 않는다.** `은월 익검 2인(돌먹)` 처럼
              사람이 정보를 덧붙인 이름은 거짓이 아니므로 줄이 늘 이유가 없다
              (판정 근거는 `findStaleBossMentions` 머리말).
          */
          subtitle: bundleSubtitle(bundle),
          memberCount: bundle.memberCount,
          members: bundle.members,
          bosses: bundle.bosses.map((boss) => ({
            bossDifficultyId: boss.bossDifficultyId,
            koreanName: boss.koreanName,
            difficulty: boss.difficulty,
          })),
          mine,
        };
      }),
    [bundles],
  );

  /*
    ── **실제로 등록될 것** ────────────────────────────────────────────────────
    아래 두 값이 등록에 들어가는 전부다. `partyBosses` · `members` 는 **목록을 그리는
    데만** 쓰고(체크 안 된 줄도 보여야 한다), 서버로 가는 것은 언제나 이쪽이다.
    규칙 하나로 고정해 두는 이유는 §6 — *"요약이 고른 것만 말해야 한다"* — 를 지키려면
    화면이 읽는 값과 전송되는 값이 **같은 변수**여야 하기 때문이다. 두 벌이 되면
    "전부라고 말하면서 일부만 잡히는" 거짓말이 다시 생길 자리가 열린다.
  */
  const goingBosses = partyBosses.filter(
    (entry) => !excludedBossIds.has(entry.bossDifficultyId),
  );
  const goingMembers = members.filter(
    (member) => !excludedPersonIds.has(member.personId),
  );

  /**
   * ★ 우선순위는 **① 묶음 지정 → ② 파티 기본값 → ③ 본캐**다. 서버가 ①②를 이미 풀어
   *   `myCharacterId` 로 내려 주므로(`fetchMyBundles`) 여기서는 ③만 더한다 —
   *   `fetchMyRunCharacters` 가 본캐를 맨 앞으로 정렬하므로 `characters[0]` 이 본캐다.
   *   **같은 순서가 서버 쪽 `createPartyRuns` 에도 있다**(묶음 → 파티 → 본캐). 두 곳이
   *   어긋나면 화면이 보여 준 캐릭터와 실제로 등록되는 캐릭터가 달라진다.
   * ★ 서버가 준 id 도 `characters` 안에서 **다시 찾는다** — 추적을 끊은 캐릭터가 묶음에
   *   남아 있을 수 있고, 목록에 없는 id 를 그대로 보내면 서버가 400 으로 거절한다.
   */
  const characterId =
    characters.find(
      (entry) => entry.characterId === (pickedBundle?.myCharacterId ?? null),
    )?.characterId ??
    characters[0]?.characterId ??
    null;

  const createRun = useMutation({
    mutationFn: (
      input: CreateRunBundleInput & { readonly bundleId: string },
    ) => createPartyRunBundle(input),
    onSuccess: (created) => {
      const first = created[0];
      if (first === undefined || startsAt === null) return;
      /*
        ⚠️ `scheduledAt` 은 **널러블**이다(시각 미정 런이 있을 수 있다). 여기서 만든
           런은 언제나 시각이 있지만, 타입이 그 사실을 모르므로 우리가 보낸 값으로
           주차를 계산한다 — 서버 응답을 다시 파싱하는 것보다 확실하다.
      */
      const weekKey = getWeekKey(startsAt);
      /*
        ⚠️ ═══════════════════════════════════════════════════════════════════════
          **옮겨 온 목록이라고 그대로 믿으면 안 된다 — 뮤테이션의 효과가 달라졌다.**
          ═══════════════════════════════════════════════════════════════════════
          예전 주석은 *"무효화 목록은 예전 등록 뮤테이션과 같다. 옮겨 온 것이므로 판단은
          이미 검증된 그대로다"* 였다. 그 문장이 2026-10-11 의 결함을 그대로 만들었다:
          이 뮤테이션은 이제 런만 만들지 않고 **보스별 소요 시간을 쓴다**
          (`bossDurationMinutes` 를 실어 보내면 서버가 그 묶음에도 저장한다). 그런데
          목록에 `party.bosses` 가 없어서, 스우를 20→40 으로 잡고 다른 빈 칸에서 같은
          파티를 고르면 **칸이 다시 비어 있고 끝 시각이 20분 짧았다.**
          §2.4 Rule 5 가 말하는 바로 그 함정이며, 교훈은 "목록이 같다"가 아니라
          **"효과가 바뀌면 목록을 다시 센다"** 다.
          ★ 2026-10-16 — 그 값이 가는 곳이 **묶음**으로 바뀌었다. 그래서 목록을 다시
            셌고 두 줄이 늘었다(`party.bundles(partyId)` · `party.myBundles()`).
            이 창이 **읽는 목록이 바로 `myBundles()`** 이므로 그것을 빼먹으면 소요 시간을
            고쳐 잡은 뒤 다른 빈 칸에서 같은 묶음을 골랐을 때 옛 분이 그려진다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.list(first.partyId, weekKey),
      });
      /*
        ★ **이번 주 시간표.** `runs.list` 는 파티별 키라 시간표(`runs.timetable`)를
          덮지 못한다 — 접두사가 겹치지 않아 자동으로 따라오지 않는다. 이걸 빼먹으면
          방금 잡은 일정이 **바로 지금 보고 있는 화면**에 안 나타난다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.runs.timetable(weekKey),
      });
      /* 파티 카드의 "이번 주 일정 N건". 파티 자체는 안 바뀌었으므로 `mine` 만 짚는다. */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.mine(weekKey),
      });
      /*
        ★ **이 창이 방금 쓴 값이다.** 소요 시간을 고쳐 보냈으면 서버가 `party_bosses` 에
          저장하므로, 이 키를 날려야 다음에 이 창을 열 때(그리고 `/parties` 와 파티 편집
          창에서) 고친 값이 보인다. 형제인 `run-detail-dialog` 가 같은 이유로 같은 키를
          날린다 — 두 창이 같은 컬럼을 쓰니 무효화도 같아야 한다.
          ⚠️ 고치지 않았을 때도 날린다. 비용은 그 파티 한 건의 재조회뿐이고, 조건을 달면
             "어떤 조건일 때 날리는가"가 또 하나의 틀릴 자리가 된다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.bosses(first.partyId),
      });
      /*
        ★ **묶음 두 키.** `bundles(partyId)` 는 `/parties` 의 묶음 카드가 읽고,
          `myBundles()` 는 **이 창**이 읽는다. 둘은 서로의 접두사가 아니므로(§2.4 경고)
          각각 적는다 — 하나만 적으면 다른 화면이 옛 소요 시간을 들고 남는다.
      */
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.bundles(first.partyId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.party.myBundles(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.dashboard.root(),
      });

      /*
        ⚠️ **창을 닫고 결과를 말한다**(2026-08-28 발주 지적: *"등록을 눌러도 반응이없음.
           생성된건지 확인안됨"*). 사용자가 볼 수 있는 것이 하나도 안 바뀌면 성공과
           "아무 일도 일어나지 않음"이 구별되지 않고, 그 상태에서 할 수 있는 일은 다시
           누르는 것뿐이라 중복 등록으로 이어진다.
      */
      onClose();
      toaster.notify({
        tone: "success",
        title: `일정 ${String(created.length)}건을 잡았습니다`,
        description: `${pickedBundle?.name ?? "묶음"} · ${pickedBundle?.partyName ?? "파티"} · ${formatKstFull(startsAt)} 시작`,
      });
    },
  });

  if (!open) return null;

  /*
    ★ **고른 것이 0 이면 못 누른다**(발주 2026-10-06 §3). 보스 0개는 서버도 400 으로
      막지만(`createPartyRuns` — "등록할 보스를 하나 이상 선택해 주세요"), 버튼을 눌러
      왕복을 돌고 나서야 듣는 말과 누르기 전에 화면이 하는 말은 같은 문장이 아니다.
      파티원 0명은 **서버가 막지 않는다** — `participantPersonIds` 가 비어도 런은
      만들어지고 참가자만 없는 상태가 된다. 그래서 여기가 유일한 관문이다.
      (그 상태를 허용해 두는 것 자체는 옳다: 2026-08-20 결정대로 등록자가 안 가는
       일정도 정상이므로, 서버가 "한 명 이상"을 강제하면 그 쓰임이 막힌다.)
  */
  const canSubmit =
    pickedBundle !== null &&
    goingBosses.length > 0 &&
    goingMembers.length > 0 &&
    characterId !== null &&
    !createRun.isPending;

  /*
    ★ **겹침은 여기서 막지 않는다** (2026-09-28). 같은 파티에 이미 겹치는 런이 있으면
      서버(`schedule-repo.createPartyRuns`)가 409 로 거절하고, 그 문구가 아래
      `createRun.error` 의 `ErrorState` 에 그대로 실린다("… 9/28 19:20 흑련 — 다른
      시각으로 잡거나 …").

      창에서 미리 거르지 않는 이유는 **방(`!보스`)과 같은 규칙이어야 하기 때문**이다.
      판정을 창에도 한 벌 두면 판정이 둘이 되고, 그 둘은 반드시 갈라진다. 게다가 창이
      들고 있는 시간표 payload 에는 **내가 `going` 인 런만** 실려 있어(§1.1.1 — `/` 는
      그것만 그린다) 남이 잡아 둔 같은 파티의 런이 보이지 않는다. 즉 여기서는 애초에
      올바르게 판정할 수 없다. 경계는 언제나 서버다.
  */
  const submit = () => {
    if (pickedBundle === null || characterId === null) return;
    if (goingBosses.length === 0 || goingMembers.length === 0) return;
    createRun.mutate({
      partyId: pickedBundle.partyId,
      /*
        ★ ═════════════════════════════════════════════════════════════════════
          **묶음 id 를 반드시 보낸다** (2026-10-16).
          ═════════════════════════════════════════════════════════════════════
          런에 그 값이 찍혀야
            ① 시간표가 **조합별로 끊기고**(`lib/domain/run-grouping.ts` 의 `sameBundle`) —
               안 보내면 같은 파티의 익스+흉성 두 묶음이 한 블록으로 합쳐져 캐릭터
               하나만 보인다. 발주자가 든 바로 그 사례다.
            ② 그 묶음의 분배(`v_run_share_weights` → `share_mode` ·
               `crystal_follows_share`)가 이 런에 적용된다. 안 보내면 번호가 가장 작은
               묶음의 설정으로 정산된다 — 돈이 조용히 틀리는 자리다.
          파티와의 짝·보관 여부는 서버가 다시 확인한다(`requireLiveBundle`).
      */
      bundleId: pickedBundle.bundleId,
      /*
        ★ **체크한 것만, 체크한 순서대로.** `filter` 는 원래 순서를 유지하고
          `CreateRunBundleInput.bossDifficultyIds` 는 *"배열 순서가 곧 등록 순서"* 이므로
          (서버가 i 번째를 `시작 + 앞 보스들의 소요 시간 합` 에 놓는다) 가운데를 빼면 뒤가
          **당겨진다** — 구멍이 남지 않는다. 아래 미리보기가 같은 규칙으로 시각을 계산한다.
      */
      bossDifficultyIds: goingBosses.map((entry) => entry.bossDifficultyId),
      scheduledAt: startsAt,
      /*
        ⚠️ **이 값은 1순위가 아니다.** 서버 우선순위는
           `① bossDurationMinutes → ② party_bosses.duration_minutes → ③ 이 값` 이라
           (`CreateRunBody.durationMinutes`), 여기 담은 상수는 파티도 창도 아무것도
           정하지 않았을 때의 마지막 방어선일 뿐이다. 상수의 주인은
           `lib/domain/run-grouping.ts` 하나다.
      */
      durationMinutes: DEFAULT_DURATION_MINUTES,
      /*
        ★ ═════════════════════════════════════════════════════════════════════
          **고치지 않았으면 보내지 않는다.**
          ═════════════════════════════════════════════════════════════════════
          보내면 서버가 그 값으로 깔고 **파티에도 저장한다**(발주 지시: *"한번 수정되면
          저장되어 항상 이용"*) — 그래서 사용자가 이 창에서 방금 고친 값일 때만 실어야
          한다. 안 고쳤는데 화면이 접어서 되돌려 보내면 *"파티가 안 정함"* 이
          *"20 으로 정함"* 으로 굳는다(위 `DurationEdits` 머리말).
          ★ 길이는 `bossDifficultyIds` 와 **같아야 한다**(다르면 400). 같은
            `goingBosses` 를 두 번 돌려 짝을 맞춘다.
      */
      ...(durationEdits.size > 0
        ? {
            bossDurationMinutes: goingBosses.map((entry) =>
              rawMinutes(entry, durationEdits),
            ),
          }
        : {}),
      /*
        ★ ═════════════════════════════════════════════════════════════════════
          **1/n 의 분모는 `goingMembers.length` 다 — 파티 전체 인원이 아니다.**
          ═════════════════════════════════════════════════════════════════════
          결정석은 **들어간 인원**으로 나뉜다(§1: 실수령 = `floor(시세/파티원수)`).
          4인 파티에서 2명만 가면 각자 받는 돈은 1/2 이고, 여기에 4 를 보내면 pot 이
          `4 × floor(base/4)` 로 잡힌 뒤 `going` 2명이 나눠 갖는다 — 1인당 `base/2` 가
          되어 금액은 우연히 비슷해지지만, **저장된 `entry_party_size` 가 거짓**이 된다.
          그 값은 §1.3 D3 가 *"몇 명이 실제로 입장했는가"* 로 정의한 컬럼이고,
          수익 화면(`/income` 의 `인원` 열)과 "등록 6명 vs 입장 3명" 경고가 그것을
          그대로 읽는다. 여기서 틀리면 수익이 조용히 틀리는 게 아니라 **조용히 틀렸다고
          주장하지도 않는다.**
          (실제 분배는 `resolve_crystal_payout` 이 런의 `going` 참가자 수로 나누므로,
           같은 수를 두 자리에 보내는 아래 두 줄이 **짝이 맞아야** 한다.)
      */
      entryPartySize: goingMembers.length,
      participantPersonIds: goingMembers.map((member) => member.personId),
      characterId,
      note: null,
      /* 고정팟(여러 주 반복)은 이 창의 질문이 아니다 — 한 번만 잡는다. */
      repeatWeeks: 1,
    });
  };

  /*
    ⚠️ **보스별 시간의 합**이다. 예전에는 `개수 × 20` 이었고, 저장은 이미 보스별 값으로
       가고 있었으므로 **미리보기가 거짓말**을 하고 있었다(40·20·30 세 보스면 `~21:00`
       이라 적고 실제로는 21:30 까지 잡힌다).
  */
  const endsAt = bundleEnd(startsAt, goingBosses, durationEdits);
  const endsAtText = endsAt === null ? null : formatKst(endsAt, "HH:mm");
  /** 안내 문장이 적는 총 분. "보스당 N분"이라고 말할 수 없으므로 합계를 말한다. */
  const totalMinutes = goingBosses.reduce(
    (sum, entry) => sum + effectiveMinutes(entry, durationEdits),
    0,
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="보스 일정 잡기"
      description={`${formatKstFull(startsAt)} 시작`}
      footer={
        pickedBundle === null ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => pickBundle(null)}>
              다른 묶음
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              <CalendarPlus aria-hidden size={16} />
              {/*
                ★ 버튼이 **몇 건이 잡히는지** 말한다. 보스 하나 = 런 하나라 이 수는
                  성공 토스트("일정 N건을 잡았습니다")와 같은 수이고, 체크를 끄면
                  버튼의 숫자가 바로 줄어 **고른 것만 잡힌다는 사실이 눌리기 전에**
                  보인다. 0 건일 때는 숫자를 말하지 않는다 — 그 상태의 설명은 아래
                  보스 칸의 문장이 하고, 버튼은 어차피 비활성이다.
              */}
              {createRun.isPending
                ? "잡는 중…"
                : goingBosses.length === 0
                  ? "이 묶음으로 잡기"
                  : `일정 ${String(goingBosses.length)}건 잡기`}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {pickedBundle === null ? (
          <BundleList
            bundles={bundleOptions}
            isLoading={bundlesQuery.isLoading}
            isError={bundlesQuery.isError}
            onRetry={() => void bundlesQuery.refetch()}
            onPick={(bundleId) => pickBundle(bundleId)}
          />
        ) : (
          <>
            <section className="flex flex-col gap-1">
              <h3 className="text-overline uppercase text-ink-muted">묶음</h3>
              <p className="text-body-lg font-semibold text-ink">
                {pickedBundle.name}
              </p>
              {/*
                어느 파티의 조합인가. 묶음 이름이 보스 줄임말(`익세 하대 하카 3인`)이라
                이 줄 없이는 "누구와" 가 답되지 않는다.

                ★ 2026-10-19 — **`파티` 라는 낱말을 붙였다.** 이름만 적혀 있으면
                  `카인 세카대 2인` 이 파티인지 다른 묶음인지 읽는 사람이 알 수 없고,
                  신고자가 찾아간 곳이 바로 `파티 관리` 였다(`bundleSubtitle` 머리말).
                ★ ⚠️ **여기서는 이름이 같아도 적는다** — 목록(`bundleSubtitle`)과
                  판단이 갈리는 유일한 자리다. 근거는 **개수**다: 목록은 한 화면에
                  33줄이라 같은 이름이 두 번 적히면 그 소음이 진짜 다른 5줄을 덮지만,
                  여기는 카드 하나이고 **확정 직전**이라 "어느 파티에 잡히는가" 가
                  빠지면 안 된다. 중복 한 줄이 누락보다 싸다.
              */}
              <p className="text-body-sm text-ink-muted">
                파티 {pickedBundle.partyName}
              </p>
              {/*
                ── **이름이 보스와 어긋났다** (2026-10-17 파티원 신고) ──────────────
                ★ 목록에서는 둘째 줄에 실제 보스를 덧붙이는 것으로 끝냈다(위
                  `subtitle` 머리말). 여기서는 **확정 직전**이라 한 줄을 더 쓴다 —
                  이 이름으로 일정이 잡히고, 그 뒤로 이 묶음을 부르는 호칭이 된다.
                ★ 주황이고 **문장은 ink** 다(§4). 고치는 자리는 `/parties` 이므로
                  그쪽을 가리킨다 — 이 창에 이름 칸을 만들면 창이 묻는 질문이
                  둘이 된다(§1.1.1, 이 파일의 `내가 어느 캐릭터로 가는가` 와 같은 선).
              */}
              {pickedBundle.staleBossMentions.length === 0 ? null : (
                <p className="flex items-start gap-1.5 rounded-md border border-chip-soon-border bg-chip-soon-bg px-2 py-1 text-body-sm text-ink">
                  <TriangleAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-tertiary"
                  />
                  <span className="min-w-0">
                    {describeStaleBossMentions(
                      pickedBundle.staleBossMentions,
                      pickedBundle.autoName,
                    )}{" "}
                    일정은 아래 보스로 잡힙니다. 이름은 파티 관리의 묶음 편집에서
                    고칠 수 있습니다.
                  </span>
                </p>
              )}
              {/*
                ── **내가 어느 캐릭터로 가는가** ─────────────────────────────────
                ★ 2026-10-16(2단계) — **서버가 푼 확정값**이다. 묶음 payload 가
                  `myCharacterAssigned` 를 직접 싣고 오므로, 파티축에서 가릴 수 없던
                  "본캐 폴백인가 지정인가" 가 여기서는 확정이다
                  (§ `resolveMyPartyOption` 머리말의 그 모호함이 없어졌다).
                ★ **고를 것을 늘리지 않는다.** 이 줄은 아래 `characterId` 가 실제로
                  보낼 값을 그대로 비춘다(묶음 → 파티 → 본캐). 여기에 선택 칸을 두면
                  이 창이 묻는 질문이 둘이 된다(§1.1.1). 캐릭터를 바꾸는 자리는
                  `/parties` 의 묶음 편집이다.
                ★ **조회를 기다리지 않는다.** 재료가 이미 손에 있으므로(목록 payload)
                  "미지정" 이라는 틀린 말을 할 순간이 아예 없다.
              */}
              {(() => {
                const mine = bundleOptions.find(
                  (option) => option.partyId === pickedBundle.bundleId,
                )?.mine;
                return mine === null || mine === undefined ? null : (
                  <MyCharacterMark mine={mine} density="card" />
                );
              })()}
            </section>
            <section className="flex flex-col gap-1.5">
              <h3 className="text-overline uppercase text-ink-muted">
                갈 보스{" "}
                {partyBosses.length === 0
                  ? ""
                  : `${String(goingBosses.length)}/${String(partyBosses.length)}`}
              </h3>
              {/*
                ★ **로딩도 오류도 없다**(2026-10-16). 보스는 묶음 목록 payload 에 함께
                  실려 오므로(`bundle.bosses`) "묶음은 왔는데 보스는 아직" 인 상태가
                  존재하지 않는다 — 고른 뒤의 왕복이 1건에서 0건이 됐다. 목록 자체의
                  로딩·오류는 고르기 전 단계(`BundleList`)가 받는다.
              */}
              {partyBosses.length === 0 ? (
                /*
                  ⚠️ 이 묶음으로는 일정을 잡을 수 없다. 서버도 거절하지만, **무엇을 해야
                     하는지**는 여기서만 말할 수 있다 — 보스는 묶음이 소유한다.
                */
                <EmptyState
                  title="이 묶음에 등록된 보스가 없습니다"
                  description="일정은 묶음에 등록된 보스로 잡힙니다. 먼저 파티 관리에서 이 묶음에 갈 보스를 담아 주세요."
                  action={
                    <Link href="/parties">
                      <Button variant="secondary" size="sm">
                        파티 관리로 →
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <>
                  <BossCheckList
                    bosses={partyBosses}
                    excludedIds={excludedBossIds}
                    startsAt={startsAt}
                    durationEdits={durationEdits}
                    onToggle={(bossDifficultyId) => {
                      /*
                        ⚠️ **체크를 끄면 그 보스의 수정은 버린다** (2026-10-11 결함).
                           전송 배열은 체크된 보스와 자리끼리 짝이라(`goingBosses` 를
                           map 한다) 꺼진 보스의 값은 **실릴 자리가 없다.** 그런데도
                           편집값을 들고 있으면 (회색) 칸이 40 을 적고 있는데 40 은
                           어디에도 가지 않는다 — 칸을 비활성한 판단은 맞았고,
                           **고아가 된 값을 화면에 남긴 것이 틀렸다.** 버리면 칸은 파티에
                           저장된 값(또는 기본값 placeholder)으로 돌아가고, 화면이 적는
                           것과 저장되는 것이 다시 같아진다.
                        ★ 판정을 **업데이터 밖에서** 한다. `setExcludedBossIds` 의 업데이터
                          안에서 다른 setState 를 부르면 그 함수가 순수하지 않게 되고,
                          StrictMode 가 업데이터를 두 번 호출할 때 편집값이 두 번 지워진다
                          (지금은 멱등해서 증상이 없지만, 다음 사람이 멱등하지 않은 일을
                          그 자리에 넣으면 조용히 깨진다).
                      */
                      const willExclude =
                        !excludedBossIds.has(bossDifficultyId);
                      setExcludedBossIds((prev) =>
                        toggled(prev, bossDifficultyId),
                      );
                      if (!willExclude) return;
                      setDurationEdits((edits) => {
                        if (!edits.has(bossDifficultyId)) return edits;
                        const nextEdits = new Map(edits);
                        nextEdits.delete(bossDifficultyId);
                        return nextEdits;
                      });
                    }}
                    onDurationChange={(bossDifficultyId, minutes) => {
                      setDurationEdits((prev) => {
                        const next = new Map(prev);
                        next.set(bossDifficultyId, minutes);
                        return next;
                      });
                    }}
                  />
                  {goingBosses.length === 0 ? (
                    /*
                      ⚠️ **등록을 막는 상태**다. `tone="error"` 를 쓰는 근거는 §4 가
                         아니라 `/boss-plans` 등록 모달의 같은 문장과 **짝을 맞추는**
                         것이다 — 두 화면이 같은 사건을 다른 색으로 말하면 안 된다.
                         (주황은 §4 대로 임박·주의용이고, 이건 "지금 누를 수 없다"다.)
                    */
                    <HelperText tone="error">
                      갈 보스를 하나 이상 체크해 주세요. 하나도 없으면 잡을
                      일정이 없습니다.
                    </HelperText>
                  ) : (
                    <HelperText>
                      체크한 {goingBosses.length}개가 모두{" "}
                      <strong className="font-semibold tabular-nums">
                        {totalMinutes}분
                      </strong>{" "}
                      동안 연달아 배치됩니다 — {formatKst(startsAt, "HH:mm")}
                      {endsAtText === null ? null : `~${endsAtText}`}. 보스별
                      소요 시간을 고치면 저 시각이 바로 따라가고,{" "}
                      {/*
                        ⚠️ 이 단언은 **마이그레이션이 적용된 뒤** 참이다.
                           `party_bosses.duration_minutes` 가 없는 DB 에서는 서버
                           (`savePartyBossDurations`)가 **조용히 리턴**하고 런 등록만
                           성공한다 — 즉 저장되지 않는데 화면은 저장됐다고 말한다.
                           발주자가 적용을 승인했으므로(2026-10-11) 문구를 미적용 상태에
                           맞춰 깎지 않고 **적용 후에 참이 되는 문장**으로 둔다.
                           적용이 미뤄지면 이 문장이 아니라 그 결정을 되짚을 것.
                      */}
                      <strong className="font-semibold">
                        고친 값은 이 파티에 저장되어 다음에도 쓰입니다.
                      </strong>
                    </HelperText>
                  )}
                </>
              )}
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-overline uppercase text-ink-muted">
                참여자{" "}
                {members.length === 0
                  ? ""
                  : `${String(goingMembers.length)}/${String(members.length)}`}
              </h3>
              {membersQuery.isPending ? (
                <Skeleton className="h-10" />
              ) : membersQuery.isError ? (
                <ErrorState
                  title="구성원을 불러오지 못했습니다"
                  onRetry={() => void membersQuery.refetch()}
                  className="py-4"
                />
              ) : members.length === 0 ? (
                <p className="text-body-sm text-ink-muted">
                  구성원이 없습니다. 파티 관리에서 파티원을 먼저 넣어 주세요.
                </p>
              ) : (
                <>
                  <MemberCheckList
                    members={members}
                    /*
                      얼굴 재료. 묶음 payload 의 `members` 가 파티 구성원 전원의
                      초상화를 들고 있다(묶음이 사람을 고르지는 않는다).
                    */
                    looks={pickedBundle.members}
                    excludedIds={excludedPersonIds}
                    onToggle={(personId) => {
                      setExcludedPersonIds((prev) => toggled(prev, personId));
                    }}
                  />
                  {goingMembers.length === 0 ? (
                    <HelperText tone="error">
                      갈 파티원을 한 명 이상 체크해 주세요. 아무도 안 가면
                      결정석을 나눌 사람이 없습니다.
                    </HelperText>
                  ) : (
                    <HelperText>
                      체크한 {goingMembers.length}명이{" "}
                      <strong className="font-semibold">참가</strong>로
                      들어가고, 결정석이 그 {goingMembers.length}명으로 1/n
                      나뉩니다. 각자 어느 캐릭터로 갈지는 본인이 고릅니다.
                    </HelperText>
                  )}
                </>
              )}
            </section>

            {/*
              내가 데려갈 캐릭터는 고르지 않고 **말해 준다**(머리말). 추적 캐릭터가 아예
              없으면 등록이 불가능하므로 그때만 경고한다 — 빨강이 아니라 주황이다
              (§4: 빨강은 실패·취소 전용).
            */}
            {viewerPersonId !== null &&
            !charactersQuery.isPending &&
            characterId === null ? (
              <p className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
                추적 중인 캐릭터가 없어 일정을 잡을 수 없습니다. 설정에서
                캐릭터를 먼저 골라 주세요.
              </p>
            ) : null}

            {createRun.error === null ? null : (
              <ErrorState
                title="일정을 잡지 못했습니다"
                detail={createRun.error.message}
                className="py-4"
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 고르는 줄 — 보스 · 파티원 (2026-10-06)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 체크 줄 한 개의 바탕. **두 채널로 말한다** — 테두리와 면.
 *
 * 색 하나로만 말하면 색각 이상에서 구분이 사라진다. 세 번째 채널은 `Checkbox` 자신의
 * 채움(primary)이고, 보조 기술 쪽은 `<input type="checkbox">` 의 네이티브 상태가 진다.
 *
 * ⚠️ 측정해 둔 쌍(`globals.css` 머리말): `ink-muted` / `primary-subtle` 은 라이트 5.46 ·
 *    다크 6.13 으로 둘 다 AA 를 넘는다. 즉 **고른 줄에서도** 12px 시각 주석이 읽힌다 —
 *    새 면을 만들지 않고 이미 감사된 면을 쓰는 이유가 그것이다(§4: 대비는 토큰 표가
 *    아니라 실제로 겹친 쌍에서 판정한다).
 */
const CHECK_ROW = (going: boolean): string =>
  cn(
    "flex w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border px-2.5 py-1.5",
    "transition duration-200",
    going
      ? "border-primary bg-primary-subtle hover:bg-primary-subtle-hover"
      : "border-border bg-background hover:border-border-strong hover:bg-hover-strong",
  );

/**
 * 갈 보스를 고르는 목록 — **체크 + 소요 시간**.
 *
 * ★ **시각은 체크된 것들만으로 다시 계산된다.** 가운데를 빼면 뒤 보스의 시각이
 *   당겨져야 하고(서버가 `시작 + 앞 보스들의 소요 시간 합` 으로 놓으므로 실제로 그렇게
 *   저장된다), 목록이 원래 자리의 시각을 그대로 들고 있으면 **미리보기가 거짓말**이
 *   된다. 그래서 배치 규칙을 여기서 한 번 더 쓰지 않고, `submit` 이 보내는 것과 **같은
 *   필터·같은 순서**로 `cumulativeStarts` 를 돌려 시각을 표에 적어 둔다.
 * ★ 체크가 꺼진 줄은 시각 자리가 `—` 다. 비워 두면 "아직 안 정해졌나"로 읽히고,
 *   글자를 적으면(`제외`) 줄마다 읽을 것이 하나 더 늘어난다.
 * ★ `<ol>` 이 아니라 `<ul>` 이다 — 순서 번호를 그리지 않기 때문이다. 순서는 시각이
 *   말하고, 등록된 뒤의 번호(`run_no`)는 **서버가 부여하는 다른 값**이다(§1.4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 소요 시간 칸은 **`<label>` 바깥**이다 — 안에 두면 체크박스가 토글된다
 * ─────────────────────────────────────────────────────────────────────────────
 * 줄 전체를 `<label>` 로 감싸 "어디를 눌러도 체크"가 되게 해 둔 구조였는데, 암묵적 라벨은
 * **첫 번째 폼 컨트롤**에 묶인다. 숫자 칸을 그 안에 넣으면 숫자를 누를 때마다 체크가
 * 뒤집힌다. 그래서 줄은 `<div>` 로 바꾸고 `<label>` 은 **체크박스 + 얼굴 + 이름**까지만
 * 감싼다. 숫자 칸은 형제이고 자기 `aria-label` 로 이름을 갖는다(아이콘만 있고 라벨 없는
 * 칸을 만들지 않는다).
 *
 * ⚠️ **체크가 꺼진 줄의 숫자 칸은 비활성**이다. 저장 요청의 `bossDurationMinutes` 는
 *    체크된 보스와 자리끼리 짝이므로(길이가 다르면 400) 꺼진 보스의 값은 실릴 자리가
 *    없다. 눌리는데 저장되지 않는 칸을 두는 것보다 못 누르는 쪽이 정직하다.
 *
 * 📱 폭 400px: 안쪽 폭 ≈ 352px 이고 고정분이 체크박스 16 + 얼굴 24 + 숫자줄 ~124 +
 *    시각 38 + 간격이라, 이름이 140px 남는다. 그래도 `flex-wrap` 을 켜 두어 글자 크기를
 *    키운 환경에서는 숫자줄이 **아래로 떨어지고** 겹치지 않는다.
 */
function BossCheckList({
  bosses,
  excludedIds,
  startsAt,
  durationEdits,
  onToggle,
  onDurationChange,
}: {
  readonly bosses: readonly PartyBundleBossWire[];
  readonly excludedIds: ReadonlySet<string>;
  readonly startsAt: Date;
  readonly durationEdits: DurationEdits;
  readonly onToggle: (bossDifficultyId: BossDifficultyId) => void;
  readonly onDurationChange: (
    bossDifficultyId: BossDifficultyId,
    minutes: number | null,
  ) => void;
}) {
  const going = bosses.filter(
    (entry) => !excludedIds.has(entry.bossDifficultyId),
  );
  const starts = cumulativeStarts(startsAt, going, durationEdits);
  const timeByBossId = new Map<string, Date>();
  going.forEach((entry, index) => {
    const at = starts[index];
    if (at !== undefined) timeByBossId.set(entry.bossDifficultyId, at);
  });

  return (
    <ul className="flex flex-col gap-1">
      {bosses.map((entry) => {
        const at = timeByBossId.get(entry.bossDifficultyId) ?? null;
        const checked = at !== null;
        return (
          <li className="min-w-0" key={entry.bossDifficultyId}>
            <div className={CHECK_ROW(checked)}>
              {/*
                ★ `Checkbox` 를 **라벨 없이** 쓰고 체크·얼굴·이름을 `<label>` 로 감싼다.
                  `Checkbox` 의 `label` 프롭을 쓰면 그쪽이 `<label>` 을 만들어 클릭
                  영역이 글자만큼으로 좁아진다. 이렇게 두면 **이름까지 어디를 눌러도**
                  켜지고, 숫자 칸은 라벨 밖이라 영향을 받지 않는다(머리말 ⚠️).
                  (커서는 `globals.css` 의 `label:has(input[type=checkbox])` 가 준다.)
              */}
              <label className="flex min-w-0 flex-1 basis-32 items-center gap-2.5">
                <Checkbox
                  checked={checked}
                  onChange={() => onToggle(entry.bossDifficultyId)}
                />
                <BossIcon
                  bossDifficultyId={entry.bossDifficultyId}
                  difficulty={entry.difficulty}
                  size="sm"
                />
                <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                  {entry.koreanName}
                </span>
              </label>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <DurationField
                  id={`boss-duration-${entry.bossDifficultyId}`}
                  value={
                    durationEdits.has(entry.bossDifficultyId)
                      ? (durationEdits.get(entry.bossDifficultyId) ?? null)
                      : entry.durationMinutes
                  }
                  fallbackMinutes={DEFAULT_DURATION_MINUTES}
                  allowUnset
                  disabled={!checked}
                  aria-label={`${entry.koreanName} 소요 시간(분)`}
                  onChange={(minutes) =>
                    onDurationChange(entry.bossDifficultyId, minutes)
                  }
                />
                <span className="w-10 shrink-0 text-right text-caption tabular-nums text-ink-muted">
                  {at === null ? "—" : formatKst(at, "HH:mm")}
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 갈 파티원을 고르는 목록.
 *
 * ⚠️ **얼굴과 id 가 서로 다른 응답에서 온다.** 등록에 실제로 보내는 값(`personId`)은
 *    `fetchPartyMembers`(=`PartyMember`)가 소유하는데 그 타입에는 초상화 필드가 아예
 *    없다 — 저쪽은 `participantId` · `seatNo` 를 들고 로스터를 편집하는 무거운 타입이고,
 *    초상화는 목록용 `PartyMemberBrief`(파티 목록 payload)에만 실린다. 그래서 **줄의
 *    주인은 `members`** 이고 `looks` 는 **그림만** 빌려 준다.
 * ★ 둘을 잇는 열쇠는 `displayName` 이다. 양쪽 다 `party_participants.display_name`
 *   에서 나오므로 같은 사람이면 같은 글자다. **id 를 잇는 것이 아니라서 안전하다** —
 *   한 파티에 같은 표시명이 둘 있어 잘못 집어도 틀리는 것은 *초상화 한 칸*이고,
 *   서버로 가는 `personId` 는 언제나 `members` 쪽에서 그대로 나간다.
 * ★ 못 찾으면 `members` 의 값으로 **최소 brief 를 만든다.** 그림이 없으면 실루엣이고
 *   그것이 정상 상태다(§2.1.1) — 줄을 빼거나 오류를 그리지 않는다.
 * ★ 번호(`seatNo`)를 함께 그린다. 카톡에서 "1번"으로 부르는 그 번호이고(§1.4), 실측된
 *   파티는 이름이 서로 비슷해 번호가 실제 식별에 쓰인다. 접지 않고 **전원을 그린다** —
 *   여기서 `+2` 로 접으면 "누가 빠졌나"를 숨기는 쪽으로만 작동한다.
 */
function MemberCheckList({
  members,
  looks,
  excludedIds,
  onToggle,
}: {
  readonly members: readonly PartyMember[];
  readonly looks: readonly PartyMemberBrief[];
  readonly excludedIds: ReadonlySet<string>;
  readonly onToggle: (personId: PersonId) => void;
}) {
  const lookByName = new Map(
    looks.map((look) => [look.displayName, look] as const),
  );

  return (
    <ul className="flex flex-col gap-1">
      {members.map((member) => {
        const going = !excludedIds.has(member.personId);
        const look: PartyMemberBrief = lookByName.get(member.displayName) ?? {
          displayName: member.displayName,
          characterName: member.characterName,
          characterLevel: null,
          characterClass: null,
          characterImageUrl: null,
          isGuest: member.isGuest,
        };

        return (
          <li className="min-w-0" key={member.personId}>
            <label className={CHECK_ROW(going)}>
              <Checkbox
                checked={going}
                onChange={() => onToggle(member.personId)}
              />
              <MemberFace member={look} />
              <SeatNumber
                seatNo={member.seatNo}
                size="sm"
                tone={going ? "primary" : "muted"}
              />
              {/*
                이름은 `participantLabel` 이 소유한다 — `더저(메검메)` 조합 규칙을
                여기서 다시 만들면 파티 바와 글자가 갈린다.
              */}
              <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                {participantLabel(member)}
              </span>
              {member.isGuest ? (
                <span className="shrink-0 text-caption text-ink-muted">
                  게스트
                </span>
              ) : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/*
 * ★ 여기 있던 `MAX_FACES` · `BOSS_REVEAL_STEP` · `MemberFace` · `MemberFaceRow` ·
 *   `BossFaceRow` · `MoreChip` 은 **전부 `@/components/domain/party-option` 으로
 *   옮겼다** (2026-10-04 발주 지시 — 머리말 참고). 근거 주석(크롭 배율 실측 · 실루엣
 *   색 선택 · `isPending` 함정 · `min-w-0` 가드)도 함께 갔으니 **여기서 다시 쓰지 말고
 *   그 파일을 읽을 것.** 두 벌이 되는 순간 갈라진다.
 *   `BOSS_REVEAL_STEP` 은 옮긴 것이 아니라 **없어졌다** — 보스가 파티 목록 payload 에
 *   함께 실려 와(`Party.bosses`) 나눠 받을 이유가 사라졌다.
 */

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 실루엣 메우기 — **창을 열 때 한 번, 조용히** (삭제된 picker 에서 되살림)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-09-03): *"내 api 로 파티원들의 이미지를 가져오는식으로"*.
 *
 * 게스트는 우리 DB 에 `characters` 행도 ocid 도 없어서 얼굴 자리가 **영원히** 비어
 * 있다. `POST /api/characters/looks` 가 **이름만으로** 넥슨에서 생김새를 받아
 * `character_looks` 에 적고, 다음 파티 조회가 그 캐시를 읽어 그림을 채운다
 * (`schedule-repo.withCachedLooks` — 파티 목록 경로에 그대로 살아 있다).
 *
 * ★ **서버 렌더가 아니라 여기서 부른다.** 이름 하나에 넥슨 2콜 + 250ms 간격이라 렌더
 *   경로에 넣으면 창을 여는 데 초 단위가 걸린다. 읽기는 DB 조회뿐이다.
 * ★ **메울 것이 없으면 요청이 나가지 않는다.** 얼굴이 이미 있는 사람은 건너뛰고,
 *   한 번 물어본 이름은 다시 묻지 않는다 — 넥슨에 없는 이름이면 응답 후에도 초상화가
 *   계속 `null` 이라, 시도 기록이 없으면 창을 열 때마다 같은 2콜이 영원히 나간다.
 * ★ 끝나면 **파티 목록 쿼리를 무효화**한다. 화면 데이터의 주인은 쿼리 캐시이므로
 *   (§2.4 규칙 1) `router.refresh()` 를 부르지 않는다(규칙 3). 키는
 *   `queryKeys.db.party.list()` — 이 창의 `partiesQuery` 가 쓰는 **바로 그 키**다
 *   (접두사가 비슷하다고 덮인다고 가정하지 않는다 — §2.4 경고).
 * ★ **실패해도 아무 일도 일어나지 않는다.** 실루엣은 오류가 아니라 정상 상태이고
 *   (§2.1.1) 일정을 잡는 일과 무관하다 — 토스트도 로딩 표시도 띄우지 않는다.
 */
/** 한 번에 물어보는 최대 이름 수. 라우트의 상한과 같은 값이다. */
const LOOKUP_BATCH_LIMIT = 20;

/** `character_looks.character_name` 의 CHECK(1~40자)와 같은 값. */
const LOOKUP_NAME_MAX_LENGTH = 40;

function useGuestLookBackfill(open: boolean, parties: readonly Party[]): void {
  const queryClient = useQueryClient();
  /*
    시도한 이름. 창을 닫았다 열어도 살아 있어야 하므로 ref 다 — state 로 두면 값이
    바뀔 때마다 다시 그려지는데, 이 값은 화면에 한 글자도 나오지 않는다.
  */
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;

    const names: string[] = [];
    for (const party of parties) {
      for (const member of party.members) {
        // 이미 얼굴이 있는 사람은 물을 이유가 없다.
        if (member.characterImageUrl !== null) continue;
        const name = (member.characterName ?? member.displayName).trim();
        if (name === "" || name.length > LOOKUP_NAME_MAX_LENGTH) continue;
        if (attempted.current.has(name)) continue;
        attempted.current.add(name);
        names.push(name);
        if (names.length >= LOOKUP_BATCH_LIMIT) break;
      }
      if (names.length >= LOOKUP_BATCH_LIMIT) break;
    }
    if (names.length === 0) return;

    /*
      무효화가 `parties` 를 새 배열로 갈아 끼워 이 effect 가 다시 돈다. 그때 남은
      이름은 전부 `attempted` 에 있으므로 위 반복이 빈 배열을 만들고 여기서 끝난다 —
      되먹임 고리가 생기지 않는다.
    */
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/characters/looks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ names }),
        });
        if (cancelled || !response.ok) return;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.db.party.list(),
        });
      } catch {
        // 조용히 넘어간다. 실루엣은 정상 상태다(§2.1.1).
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, parties, queryClient]);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 묶음 목록 — 이 창이 묻는 **유일한 질문**이다.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **한 번 누르면 끝이다** (§1.1.1)
 *   ═══════════════════════════════════════════════════════════════════════════
 *   2026-10-16 까지 이 자리는 **파티** 목록이었다. 묶음이 생긴 뒤에도 클릭 수는
 *   그대로여야 하므로, 파티를 고른 뒤 묶음을 고르는 2단으로 가지 않고 목록 자체를
 *   **평평하게** 만들었다(서버 `GET /api/schedule/bundles/mine`). 어느 파티의 조합인지는
 *   줄의 둘째 줄이 말한다(`PartyOptionData.subtitle`).
 *
 * ★ **줄의 모양과 배치는 전부 `PartyOptionGrid` 가 소유한다**(2026-10-04). 두 열 · 좁은
 *   화면 한 열 · `min-w-0` 가로 스크롤 가드 · 얼굴 순서 · `+N` 접기까지 거기 있고,
 *   `/boss-plans` 의 등록 창과 `/parties` 의 파티 띠가 **같은 컴포넌트**를 쓴다.
 *   묶음을 위해 형제 컴포넌트를 만들지 않은 근거는 그 파일의 `subtitle` 머리말에 있다 —
 *   얼굴 크롭 배율 · 실루엣 색 · 가로 스크롤 가드 · `sr-only` 함정이 전부 두 벌이 된다.
 * ★ 여기 남은 것은 이 창에만 있는 세 가지 상태(오류 · 로딩 · 빈 목록)뿐이다 — 그 셋은
 *   쿼리에 달린 값이라 공용 컴포넌트가 가질 수 없다(§2.4 Rule 1: 조회는 화면이 소유한다).
 * ★ **보스 얼굴을 위한 조회가 없다.** 묶음 목록 payload 가 보스를 함께 싣고 온다.
 */
function BundleList({
  bundles,
  isLoading,
  isError,
  onRetry,
  onPick,
}: {
  /**
   * ★ `BundleOptionWire` 가 아니라 `PartyOptionData` 다 — 호출부가 묶음을 공용 컴포넌트가
   *   읽는 모양으로 풀어서 넘기기 때문이다(`partyId` 자리에 **묶음 id** 가 들어간다).
   *   변환을 여기서 하면 이 목록이 서버 타입을 알아야 하고, 공용 컴포넌트와 이 목록
   *   사이에 뜻이 다른 중간 타입이 하나 더 생긴다.
   */
  readonly bundles: readonly PartyOptionData[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** ⚠️ 받는 값은 **묶음 id** 다(`PartyOptionData.partyId` 자리에 실려 온다). */
  readonly onPick: (bundleId: string) => void;
}) {
  if (isError) {
    return (
      <ErrorState
        title="보스 묶음을 불러오지 못했습니다"
        onRetry={onRetry}
        className="py-6"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  if (bundles.length === 0) {
    return (
      <EmptyState
        icon={<Users aria-hidden size={22} className="text-primary" />}
        title="고를 보스 묶음이 없습니다"
        description="일정은 보스 묶음 단위로 잡힙니다. 파티 관리에서 같이 갈 사람을 파티로 묶고, 그 안에 도는 보스 묶음을 하나 만들어 주세요."
        action={
          <Link href="/parties">
            <Button>파티 관리로 가기 →</Button>
          </Link>
        }
      />
    );
  }

  /*
    고른 줄을 표시하지 않는다(`selectedPartyId` 를 넘기지 않는다) — 이 창은 고르는
    순간 **확인 단계로 넘어가** 목록 자체가 사라지므로, 강조할 줄이 존재하는 순간이
    없다. 넘겨 두면 "아무것도 안 골랐는데 왜 하나가 켜져 있나"가 된다.
  */
  return <PartyOptionGrid parties={bundles} onSelect={onPick} />;
}
