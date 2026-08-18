import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type {
  AvailabilityBoardResponse,
  AvailabilityExceptionsResponse,
  AvailabilityIntervalWire,
  AvailabilityIntervalsResponse,
  AvailabilityOverlapResponse,
  OverlapWindowWire,
  RunCommitmentWire,
  RunCommitmentsResponse,
} from "@/features/schedule/data/schedule-queries";
import {
  fetchAvailability,
  fetchAvailabilityBoard,
  fetchAvailabilityExceptions,
  fetchAvailabilityOverlap,
  fetchPersonRunCommitments,
} from "@/features/schedule/server/schedule-repo";
import type {
  AvailabilityInterval,
  OverlapWindow,
  RunCommitment,
  RunId,
  TimeRange,
} from "@/types/domain";

/**
 * `GET /api/schedule/availability?kind=board|intervals|overlap|exceptions|commitments&personIds=…&from=…&to=…`
 *
 * 조회들을 한 경로에 둔 이유: **입력이 완전히 같다**(사람 목록 + 조회 구간). 경로를 나누면
 * `personIds` 파싱·열람권한 필터·구간 검증이 여러 벌이 되고, 한 곳만 고치는 사고가 난다.
 * `kind` 는 그 위에서 **어떤 DB 함수를 부를지**만 고른다.
 *
 * ★ **화면이 쓰는 것은 `kind=board` 하나다** (2026-08-18 성능 작업). 나머지는 조각 하나만
 *   필요한 호출부(카톡 봇 · 특이사항 편집기)를 위해 남아 있다.
 *
 * ★ **비로그인에게는 빈 배열이 정상이다.** 가용시간 열람은 본인 / 수락된 친구 /
 *   같은 파티 구성원으로 제한되고 판정은 `public.can_view_availability()` 가 한다
 *   (DB-SCHEMA §10-5). 그 함수는 열람자가 없으면 **무조건 false** 다.
 *   그래서 **403 이 아니라 200 + 빈 배열**로 답한다 — 개인의 생활 시간표가 비공개인 것은
 *   실패가 아니라 정책이고, 화면은 에러가 아니라 빈 상태를 그려야 한다.
 *
 * ★ **사람 id 는 UUID 형태를 강제한다.** repo 가 이 값을 PostgREST 필터에 넘기므로,
 *   경계에서 형태를 못박아 두는 편이 안전하다.
 */

const personIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "사람 식별자 형식이 올바르지 않습니다.",
  );

const KINDS = [
  /**
   * **화면 한 벌** (`public.availability_board`) — 아래 넷을 한 응답에 싣는다.
   *
   * 겹쳐보기를 그리는 경로(서버 prefetch · 클라이언트 조회)는 **전부 이것만 쓴다.**
   * 넷은 같은 사람 집합 · 같은 구간의 한 시점 스냅샷이라 따로 받을 이유가 없고,
   * 원격 Supabase 왕복 1회 ≈ 78ms 라 나눠 받는 값이 그대로 지연이 된다.
   *
   * ⚠️ 아래 네 `kind` 는 **지우지 않는다.** 카톡 봇과 특이사항 편집기(다른 구간의 예외만
   *    필요하다)가 조각 하나만 물을 수 있어야 하고, 그때 세 계산을 함께 시키는 것은 낭비다.
   */
  "board",
  "intervals",
  "overlap",
  "exceptions",
  /**
   * **이미 등록된 런이 잡아먹은 시간** (`person_run_commitments`).
   *
   * 겹침(`overlap`)은 이 시간을 **이미 뺀** 답을 준다. 이 종류가 따로 있는 이유는
   * 화면이 그 사실을 **"이미 일정 있음" 으로 구분해 보여 줘야** 하기 때문이다 —
   * 가능 시간이 조용히 줄기만 하면 사용자에게는 "왜 안 되지?" 만 남는다.
   */
  "commitments",
] as const;
type Kind = (typeof KINDS)[number];

function readKind(params: URLSearchParams): Kind {
  const raw = params.get("kind") ?? "intervals";
  const kind = KINDS.find((candidate) => candidate === raw);
  if (kind === undefined) {
    throw ApiError.badRequest(
      "kind 는 board · intervals · overlap · exceptions · commitments 중 하나여야 합니다.",
    );
  }
  return kind;
}

/** 빈 문자열은 **빈 목록**이며 오류가 아니다(구성원 0명인 파티가 정상이다). */
function readPersonIds(params: URLSearchParams): readonly string[] {
  const raw = params.get("personIds") ?? "";
  if (raw.trim() === "") return [];

  const parts = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const parsed = z.array(personIdSchema).max(64).safeParse(parts);
  if (!parsed.success) {
    throw ApiError.badRequest("personIds 형식이 올바르지 않습니다.");
  }
  return parsed.data;
}

function readInstant(params: URLSearchParams, name: string): Date {
  const raw = params.get(name);
  if (raw === null) throw ApiError.badRequest(`${name} 가 필요합니다.`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`${name} 를 시각으로 해석할 수 없습니다.`);
  }
  return date;
}

/** 역전된 구간은 거부한다 — DB 함수가 조용히 0건을 내므로 화면이 원인을 알 수 없다. */
function readRange(params: URLSearchParams): TimeRange {
  const from = readInstant(params, "from");
  const to = readInstant(params, "to");
  if (to.getTime() <= from.getTime()) {
    throw ApiError.badRequest("조회 구간의 끝이 시작보다 빠릅니다.");
  }
  return { from, to };
}

function readMinCount(params: URLSearchParams): number {
  const raw = params.get("minCount");
  if (raw === null) return 1;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw ApiError.badRequest("minCount 는 1 이상의 정수여야 합니다.");
  }
  return value;
}

/**
 * 점유 계산에서 **뺄 런 하나**. 수정 중인 런이 자기 자신을 막으면 시각을 옮길 수 없다.
 * 없으면 `null` 이고 그게 기본값이다.
 */
function readExcludeRunId(params: URLSearchParams): RunId | null {
  const raw = params.get("excludeRunId");
  if (raw === null || raw.trim() === "") return null;
  const parsed = personIdSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw ApiError.badRequest("excludeRunId 형식이 올바르지 않습니다.");
  }
  return parsed.data;
}

/** `Date` 는 JSON 으로 못 나간다. 시각만 ISO 문자열로 바꾼다. */
function toIntervalWire(
  interval: AvailabilityInterval,
): AvailabilityIntervalWire {
  return {
    ...interval,
    startsAt: interval.startsAt.toISOString(),
    endsAt: interval.endsAt.toISOString(),
  };
}

function toOverlapWire(window: OverlapWindow): OverlapWindowWire {
  return {
    ...window,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
  };
}

function toCommitmentWire(commitment: RunCommitment): RunCommitmentWire {
  return {
    ...commitment,
    startsAt: commitment.startsAt.toISOString(),
    endsAt: commitment.endsAt.toISOString(),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const kind = readKind(params);
    const personIds = readPersonIds(params);
    const range = readRange(params);

    const session = await readSession();
    const viewerUserId = session?.uid ?? null;

    if (kind === "board") {
      /*
        ⚠️ 마이그레이션 24 미적용이면 repo 가 **옛 4종 호출로 되돌아간다**(오류가 아니다).
           그때도 응답 모양과 값은 완전히 같고 왕복만 늘어난다.
      */
      const board = await fetchAvailabilityBoard(
        viewerUserId,
        personIds,
        range,
        readMinCount(params),
        readExcludeRunId(params),
      );
      return jsonOk<AvailabilityBoardResponse>({
        intervals: board.intervals.map(toIntervalWire),
        overlap: board.overlap.map(toOverlapWire),
        exceptions: board.exceptions,
        commitments: board.commitments.map(toCommitmentWire),
      });
    }

    if (kind === "overlap") {
      const overlap = await fetchAvailabilityOverlap(
        viewerUserId,
        personIds,
        range,
        readMinCount(params),
        readExcludeRunId(params),
      );
      return jsonOk<AvailabilityOverlapResponse>({
        overlap: overlap.map(toOverlapWire),
      });
    }

    if (kind === "commitments") {
      /*
        ⚠️ 마이그레이션 미적용이면 repo 가 **빈 배열**을 준다(오류가 아니다).
           그 상태의 화면은 "이미 일정 있음" 블록만 안 보이는 예전 그대로의 겹쳐보기다.
      */
      const commitments = await fetchPersonRunCommitments(
        viewerUserId,
        personIds,
        range,
        readExcludeRunId(params),
      );
      return jsonOk<RunCommitmentsResponse>({
        commitments: commitments.map(toCommitmentWire),
      });
    }

    if (kind === "exceptions") {
      const exceptions = await fetchAvailabilityExceptions(
        viewerUserId,
        personIds,
        range,
      );
      return jsonOk<AvailabilityExceptionsResponse>({ exceptions });
    }

    const intervals = await fetchAvailability(viewerUserId, personIds, range);
    return jsonOk<AvailabilityIntervalsResponse>({
      intervals: intervals.map(toIntervalWire),
    });
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability#GET");
  }
}
