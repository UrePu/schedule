import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import {
  createPartyBundle,
  fetchPartyBundles,
} from "@/features/schedule/server/schedule-repo";
import {
  RUN_SHARE_WEIGHT_MAX,
  type PartyBundlesResponse,
} from "@/features/schedule/types";
/*
 * ★ 소요 시간 경계는 **리터럴로 적지 않는다**(2026-10-11 — 다섯 벌로 복사돼 있던 숫자를
 *   한 곳으로 모았다). 주인은 환경 중립 모듈이다.
 */
import { RUN_DURATION_MAX, RUN_DURATION_MIN } from "@/lib/domain/run-grouping";

/**
 * `GET  /api/schedule/parties/{partyId}/bundles` — 그 파티의 **보스 묶음** 목록
 * `POST /api/schedule/parties/{partyId}/bundles` — 묶음 하나 **만들기**
 *
 * 발주 문제(2026-10-16): *"같은 두 사람이 보스 묶음·캐릭터·분배만 바꿔 여러 조합을
 * 도는데 조합마다 파티를 새로 만들어야 한다."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **읽기도 세션이 필요하다** — 형제 라우트 `.../bosses` 와 다르다
 * ─────────────────────────────────────────────────────────────────────────────
 * `.../bosses` 는 비로그인도 200 이다("이 공개 파티는 무엇을 도는가" 가 안 보이면 공개할
 * 이유가 없다). 묶음에는 거기에 **분배 비율**이 함께 실리고 그것은 정산 값이다 —
 * 공개면에 실은 적이 없고 실어서도 안 된다(B-5 가 그 방식으로 났다). 그래서 이 라우트는
 * 세션 + **파티 구성원**까지 요구하고(repo 의 `requirePartyMembership`), 보이지 않는
 * 파티는 404 로 접는다(403 은 "그 파티는 존재한다" 를 알려 준다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 묶음 수정은 **여기가 아니라 `/api/schedule/bundles/{bundleId}`** 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 묶음 id 하나로 파티를 되찾을 수 있으므로(그 행이 `party_id` 를 들고 있다) 경로에 파티를
 * 또 적게 하면 **두 값이 어긋난 요청**이 가능해진다. 어긋났을 때 무엇이 옳은지 정할 방법이
 * 없고, 서버가 둘을 대조하는 코드는 애초에 쓸 이유가 없는 코드다. 만들기만 파티 밑에
 * 남는 이유는 그때는 묶음 id 가 **아직 없기** 때문이다.
 */

/** `boss_difficulties.id` 의 CHECK(`^[a-z0-9][a-z0-9_]{0,59}$`)와 같은 경계. */
const bossDifficultyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]{0,59}$/, "보스 식별자 형식이 올바르지 않습니다.");

/**
 * 분배 — **세 경우뿐이다**(`BundleShareInput`).
 *
 * `shareMode` + `shares` 두 칸으로 받으면 "비어 있음" 이 두 벌이 되어 어긋난 요청을 보낼
 * 수 있고, 어긋났을 때 상속인지 균등인지 서버가 추측해야 한다. 판별 합집합으로 받으면
 * 그 조합이 **애초에 존재하지 않는다.**
 */
const shareSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inherit") }),
  z.object({ kind: z.literal("equal") }),
  z.object({
    kind: z.literal("manual"),
    /*
      `weight` 는 **화면이 100 을 곱해 보낸 정수**다(`RUN_SHARE_WEIGHT_SCALE`). 비율은
      배율에 불변이고 `distribute_meso(p_weights integer[])` 가 정수만 받는다 —
      형제 라우트 `.../shares` 와 같은 규약이다.
    */
    weights: z
      .array(
        z.object({
          participantId: z.uuid("참가자 식별자 형식이 올바르지 않습니다."),
          weight: z
            .number({ error: "분배 배율 형식이 올바르지 않습니다." })
            .int("분배 배율은 정수로 보내야 합니다.")
            .min(0, "분배 배율은 0 이상이어야 합니다.")
            .max(RUN_SHARE_WEIGHT_MAX, "분배 배율이 너무 큽니다."),
        }),
      )
      .min(1, "분배 배율을 한 명 이상 보내야 합니다.")
      .max(24, "파티 구성원은 24명을 넘을 수 없습니다."),
  }),
]);

/**
 * 묶음 본문 — **보낸 칸만 바뀐다.**
 *
 * ⚠️ 생략과 값이 **다른 뜻**이다. `bossDifficultyIds` 를 빼면 보존이고(그래야 분배만
 *    고치는 저장이 보스를 지우지 않는다), `durationMinutes` 를 빼면 DB 함수가 기존 분을
 *    보존한다. 길이가 다르면 **거절**한다 — 짧은 쪽을 맞추면 어느 보스의 시간인지 한
 *    칸씩 어긋나고, 그 어긋남은 화면에 그럴듯하게 그려져 아무도 알아채지 못한다.
 */
export const saveBundleSchema = z
  .object({
    /** 빈 문자열은 **자동 이름으로 되돌리기**이지 "안 바꿈" 이 아니다(생략이 그쪽이다). */
    name: z.string().max(80, "묶음 이름은 80자까지입니다.").optional(),
    bossDifficultyIds: z
      .array(bossDifficultyIdSchema)
      .max(24, "한 묶음에 등록할 수 있는 보스는 24개까지입니다.")
      .optional(),
    durationMinutes: z
      .array(
        z
          .number({ error: "소요 시간 형식이 올바르지 않습니다." })
          .int("소요 시간은 정수(분)여야 합니다.")
          .min(
            RUN_DURATION_MIN,
            `소요 시간은 ${String(RUN_DURATION_MIN)}분 이상이어야 합니다.`,
          )
          .max(
            RUN_DURATION_MAX,
            `소요 시간은 ${String(RUN_DURATION_MAX)}분을 넘을 수 없습니다.`,
          )
          .nullable(),
      )
      .max(24)
      .optional(),
    share: shareSchema.optional(),
    /**
     * `false` = **결정석만 균등**, 드랍은 비율대로(발주: *"드랍만 비율로 거는사람도있어"*).
     */
    crystalFollowsShare: z.boolean().optional(),
    /**
     * **내 캐릭터만** 고칠 수 있다. `null` = 지정 해제(파티 기본값으로 떨어진다).
     * 남의 캐릭터를 고를 수 있게 하려면 남의 캐릭터 목록을 내주는 경로가 필요하고,
     * 그건 그 사람의 로스터를 전부 공개하는 일이다(§ `BUNDLE_OTHER_CHARACTER_NOTE`).
     */
    myCharacterId: z
      .uuid("캐릭터 식별자 형식이 올바르지 않습니다.")
      .nullable()
      .optional(),
  })
  .refine(
    (value) =>
      value.durationMinutes === undefined ||
      value.durationMinutes.length === (value.bossDifficultyIds?.length ?? -1),
    { message: "보스 개수와 소요 시간 개수가 다릅니다." },
  );

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const bundles = await fetchPartyBundles(session.uid, partyId);
    return jsonOk<PartyBundlesResponse>({ bundles });
  } catch (error) {
    return handleRouteError(
      error,
      "api/schedule/parties/[partyId]/bundles#GET",
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ partyId: string }> },
): Promise<Response> {
  try {
    const { partyId } = await params;
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const body = await readJsonBody(request, saveBundleSchema);
    const bundles = await createPartyBundle(session.uid, partyId, body);
    /*
      응답은 **바뀐 뒤의 목록 전체**다(다른 쓰기 라우트와 같은 규약). 만들어진 하나만
      돌려주면 화면이 목록에 끼워 넣어야 하고 정렬 규칙이 두 벌이 된다 — 자동 이름과
      번호는 서버가 정하므로 화면이 조립한 값은 곧 낡는다.
    */
    return jsonOk<PartyBundlesResponse>({ bundles }, 201);
  } catch (error) {
    return handleRouteError(
      error,
      "api/schedule/parties/[partyId]/bundles#POST",
    );
  }
}
