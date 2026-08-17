import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/**
 * service_role Supabase 클라이언트에 **생성 스키마 타입을 입힌** 별칭.
 *
 * 왜 필요한가: 인증 모델은 (c) **서버 전용 쓰기**다(DB-SCHEMA 난제 1).
 * anon/authenticated 는 전 테이블 차단이므로, 이 앱의 모든 쓰기는 Route Handler 안에서
 * service_role 로 일어난다. 그런데 `createAdminSupabaseClient()` 는 제네릭 없이 만들어져
 * `from("...")` 결과가 전부 `any` 가 된다 — 컬럼 오타가 런타임까지 살아남는다.
 * 여기서 한 번만 타입을 붙여 그 구멍을 막는다.
 *
 * ⚠️ **`import "server-only"` 가 이 파일의 안전장치다.** service_role 키는 RLS 를 통째로
 *    우회하므로 클라이언트 번들에 단 한 조각도 들어가면 안 된다. 이 import 가 있으면
 *    클라이언트 컴포넌트에서 실수로 끌어다 쓰는 순간 **빌드가 실패한다**.
 */
export type AdminDb = SupabaseClient<Database>;

/** 요청마다 새로 만든다. 커넥션 풀이 아니라 fetch 래퍼라 비용이 거의 없다. */
export function getAdminDb(): AdminDb {
  return createAdminSupabaseClient();
}
