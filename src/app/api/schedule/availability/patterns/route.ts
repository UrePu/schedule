import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { AvailabilityPatternsResponse } from "@/features/schedule/data/schedule-queries";
import {
  MAX_PATTERN_ROWS,
  MAX_SPAN_MINUTES,
} from "@/features/schedule/lib/pattern-slots";
import {
  fetchMyAvailabilityPatterns,
  replaceMyAvailabilityPatterns,
} from "@/features/schedule/server/schedule-repo";
import type { AvailabilityPatternInput, IsoWeekday } from "@/types/domain";

/**
 * `GET /api/schedule/availability/patterns` — **내** 요일별 반복 패턴
 * `PUT /api/schedule/availability/patterns` — 내 패턴 전체 교체
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `../route.ts` 의 `kind` 에 얹지 않았나
 * ─────────────────────────────────────────────────────────────────────────────
 * 옆 파일(`../route.ts`)의 세 조회는 **입력이 같아서**(사람 목록 + 구간) 한 경로에 모았다.
 * 패턴은 그 셋과 입력이 다르다 — 사람 목록도 구간도 받지 않고, 대상은 **언제나 세션 본인**
 * 하나다. 같은 경로에 넣으면 `personIds` 를 받지도 쓰지도 않는 분기가 생기고, "남의 것도
 * 쓸 수 있나?" 라는 질문이 코드에서 사라지지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 규약은 다른 쓰기 API 와 같다
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT /api/characters/tracked` · `PUT /api/boss-plans` · `PUT .../members` 와 동일하게
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) `readJsonBody(request, schema)` 로 본문 검증 (실패는 400 + 한국어 문구)
 *   3) **바뀐 뒤의 컬렉션 전체**를 응답으로 돌려준다 — 화면이 부분 갱신을 조립하지 않아도 된다
 *   4) 마지막 catch 는 `handleRouteError`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 읽기도 **세션 필수**다 (여기만 다르다)
 * ─────────────────────────────────────────────────────────────────────────────
 * 옆 파일의 조회는 비로그인에게 200 + 빈 배열을 준다 — 공개 시간표가 열려야 하기 때문이다.
 * 이 경로가 주는 것은 **편집용 원본**이라 "남의 것"이라는 개념이 아예 없다. 세션이 없으면
 * 돌려줄 대상 자체가 없으므로 401 이 정확하다. 화면은 이 쿼리를 로그인 상태에서만 켠다.
 *
 * ★ **쓰기는 본인 것만.** repo 가 `user_id = session.uid` 로만 지우고 넣는다.
 *   경로 어디에도 "누구의 패턴인가"를 받는 자리가 없다 — 받지 않는 값은 위조될 수 없다.
 */

/**
 * DB CHECK 와 **같은 경계**를 그대로 옮겼다
 * (`availability_patterns_range` · `availability_patterns_max_span` · 컬럼 CHECK).
 * 여기서 걸러야 사용자가 한국어 문구를 받는다 — DB 까지 내려가면 Postgres 의 영어
 * 제약 위반 메시지가 나고, 그 메시지는 `unwrap` 이 500 으로 접어 버린다.
 */
const patternSchema = z
  .object({
    weekday: z
      .number()
      .int()
      .min(1, "요일 값이 올바르지 않습니다.")
      .max(7, "요일 값이 올바르지 않습니다."),
    startMinute: z
      .number()
      .int()
      .min(0, "시작 시각이 하루 범위를 벗어납니다.")
      .max(1439, "시작 시각이 하루 범위를 벗어납니다."),
    // 1440 초과 = 자정 넘김. 2880 = 익일 24:00 (DB 상한).
    endMinute: z
      .number()
      .int()
      .min(1, "끝 시각이 올바르지 않습니다.")
      .max(2880, "끝 시각이 저장 가능한 범위를 벗어납니다."),
  })
  .refine((value) => value.endMinute > value.startMinute, {
    message: "가능 시간의 끝이 시작보다 빠릅니다.",
  })
  .refine(
    (value) => value.endMinute - value.startMinute <= MAX_SPAN_MINUTES,
    { message: "한 구간은 24시간을 넘을 수 없습니다." },
  );

const replaceSchema = z.object({
  patterns: z
    .array(patternSchema)
    .max(
      MAX_PATTERN_ROWS,
      "저장할 수 있는 구간 수를 넘었습니다. 구간을 합쳐 주세요.",
    ),
});

export async function GET(): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const patterns = await fetchMyAvailabilityPatterns(session.uid);
    return jsonOk<AvailabilityPatternsResponse>({ patterns });
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/patterns#GET");
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, replaceSchema);
    // zod 는 1~7 임을 보장하지만 타입까지 좁혀 주지는 않는다. 경계에서 한 번만 캐스팅한다.
    const patterns: readonly AvailabilityPatternInput[] = body.patterns.map(
      (pattern) => ({
        weekday: pattern.weekday as IsoWeekday,
        startMinute: pattern.startMinute,
        endMinute: pattern.endMinute,
      }),
    );

    const saved = await replaceMyAvailabilityPatterns(session.uid, patterns);
    return jsonOk<AvailabilityPatternsResponse>({ patterns: saved });
  } catch (error) {
    return handleRouteError(error, "api/schedule/availability/patterns#PUT");
  }
}
