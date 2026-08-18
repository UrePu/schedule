import { z } from "zod";

import { getAdminDb } from "@/lib/supabase/admin-db";
import { deleteCredentialFromUser } from "@/features/auth/server/account";
import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { readSession } from "@/features/auth/server/session";
import type { DeleteCredentialResponse } from "@/features/auth/types";

/**
 * `DELETE /api/auth/credentials/{credentialId}` — 등록된 넥슨 API 키 1개 삭제 (세션 필요)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `../route.ts` 에 `DELETE` 를 얹지 않고 경로를 팠나
 * ─────────────────────────────────────────────────────────────────────────────
 * 옆 파일의 `GET`/`POST` 는 **컬렉션**을 다룬다(목록 조회 / 새 항목 추가). 삭제는
 * **항목 하나**를 다루므로 대상이 경로에 드러나는 편이 정확하다. 게다가 `DELETE` 에
 * 본문을 싣는 것은 스펙상 의미가 정의되지 않아 프록시·런타임에 따라 조용히 버려진다 —
 * 실제로 그 방식은 "왜 가끔 아무것도 안 지워지지?"로 돌아온다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 쓰기 API 공통 규약을 그대로 따른다
 * ─────────────────────────────────────────────────────────────────────────────
 *   1) `readSession()` → 없으면 `ApiError.unauthenticated()` (401)
 *   2) 입력 검증 실패는 400 + 한국어 문구
 *   3) **바뀐 뒤의 사용자 전체**를 응답으로 돌려준다 — 화면이 부분 갱신을 조립하지 않는다
 *   4) 마지막 catch 는 `handleRouteError` (원문 키·내부 메시지가 새어 나가지 않는 유일한 문)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 되돌릴 수 없는 동작의 경계는 **여기가 아니라 서버 로직**에 있다
 * ─────────────────────────────────────────────────────────────────────────────
 * "마지막 남은 키는 못 지운다", "주 키를 지우면 승격한다", "남의 키는 404" 세 규칙은
 * 전부 `deleteCredentialFromUser()` 안에 있다. 라우트에 복제하지 않는다 — 두 곳에
 * 두면 반드시 갈라지고, 갈라지는 쪽이 하필 안전장치다.
 */

/**
 * `credentialId` 는 `user_credentials.id`(uuid)다.
 *
 * 형식 검사를 하는 이유는 보안이 아니라 **오답 분류**다. uuid 가 아닌 값을 그대로
 * Postgres 에 보내면 `22P02`(invalid input syntax) 가 나고, 그건 `handleRouteError` 가
 * 500 으로 접는다 — 사용자 잘못인 요청이 서버 장애처럼 보이게 된다.
 */
const credentialIdSchema = z.uuid("잘못된 키 식별자입니다.");

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ credentialId: string }> },
): Promise<Response> {
  try {
    const session = await readSession();
    if (session === null) throw ApiError.unauthenticated();

    const { credentialId } = await params;
    const parsed = credentialIdSchema.safeParse(credentialId);
    if (!parsed.success) {
      throw ApiError.badRequest("잘못된 키 식별자입니다.");
    }

    const result = await deleteCredentialFromUser(getAdminDb(), {
      userId: session.uid,
      credentialId: parsed.data,
    });

    return jsonOk<DeleteCredentialResponse>(result);
  } catch (error) {
    return handleRouteError(error, "api/auth/credentials/[credentialId]#DELETE");
  }
}
