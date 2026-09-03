/**
 * 넥슨 응답 검증 스키마 (zod).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 관대하지 않고 **엄격**한가
 * ─────────────────────────────────────────────────────────────────────────────
 * 탐침 도구(`scripts/nexon-probe`)의 스키마는 "무엇이 오는지 모른다"는 전제라 관대했다.
 * 이제는 실측이 끝났고(`Claude/NEXON-API-OBSERVED.md`, 스펙 대조 불일치 0건),
 * 이 앱은 그 실측을 **계약으로 삼아 동작한다.**
 *
 * 그래서 어긋나면 조용히 넘기지 않고 `schema_mismatch` 로 **터뜨린다.**
 * 특히 플래그를 `z.literal("true" | "false")` 로 못박은 것이 핵심이다 —
 * 관대하게 받으면 넥슨이 진짜 불리언으로 바꿔도 아무도 모른 채 집계만 틀어진다.
 *
 * 반대로 **우리가 안 쓰는 필드는 검증하지 않는다.** zod 는 기본적으로 모르는 키를
 * 통과시키므로, 넥슨이 필드를 *추가*해도 우리는 멀쩡하다. 잡고 싶은 것은 "추가"가
 * 아니라 **"우리가 의존하는 값의 변형"**이다.
 */

import { z } from "zod";

/** 실측된 플래그 표현. 진짜 불리언도 허용하되(미래 대비) 그 외는 거부한다. */
const flagSchema = z.union([
  z.literal("true"),
  z.literal("false"),
  z.boolean(),
]);

/** `{"error":{"name":"OPENAPI00005","message":"..."}}` */
export const nexonErrorBodySchema = z.object({
  error: z.object({
    name: z.string(),
    message: z.string().nullable().optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /maplestory/v1/character/list
// ─────────────────────────────────────────────────────────────────────────────

const characterListEntrySchema = z.object({
  // ocid 는 가변값이지만 **응답에는 반드시 있다.** 없으면 캐릭터를 식별할 수 없다.
  ocid: z.string(),
  character_name: z.string(),
  // 아래 셋은 DB 에서도 nullable 이라 없어도 저장할 수 있다.
  world_name: z.string().nullable().optional(),
  character_class: z.string().nullable().optional(),
  character_level: z.number().int().nullable().optional(),
});

export const characterListResponseSchema = z.object({
  account_list: z
    .array(
      z.object({
        // 키를 재발급해도 유지되는 보조 식별자(§2.1.1). 반드시 저장한다.
        account_id: z.string().nullable().optional(),
        character_list: z
          .array(characterListEntrySchema)
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /maplestory/v1/character/basic
// ─────────────────────────────────────────────────────────────────────────────

export const characterBasicResponseSchema = z.object({
  date: z.string().nullable().optional(),
  character_name: z.string().nullable().optional(),
  world_name: z.string().nullable().optional(),
  character_class: z.string().nullable().optional(),
  character_level: z.number().int().nullable().optional(),
  character_guild_name: z.string().nullable().optional(),
  /** 초상화. **없는 것이 정상 상태**라 nullable 이다(§2.1.1). */
  character_image: z.string().nullable().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /maplestory/v1/id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 캐릭터명 → ocid.
 *
 * `ocid` 를 nullable 로 둔 이유: 없는 이름은 **200 + 빈 본문**이 아니라 **400
 * `OPENAPI00004`** 로 돌아온다(2026-09-03 실측). 즉 여기까지 왔다면 찾았다는 뜻이고
 * `ocid` 는 사실상 항상 있다. 그래도 옵셔널로 받는 이유는, 만에 하나 넥슨이 빈 성공
 * 응답을 주기 시작해도 그것은 **드리프트가 아니라 "없음"**이라서 `schema_mismatch` 로
 * 터뜨릴 일이 아니기 때문이다. 호출부가 `null` 을 "없음"으로 접는다.
 */
export const characterIdResponseSchema = z.object({
  ocid: z.string().nullable().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /maplestory/v1/scheduler/character-state
// ─────────────────────────────────────────────────────────────────────────────

const schedulerBossSchema = z.object({
  content_name: z.string().nullable().optional(),
  /** 실측 값 집합: easy / normal / chaos / hard / extreme (우리 enum 과 일치). */
  difficulty: z.string().nullable().optional(),
  /** 실측 값 집합: bossDaily / bossWeekly / bossMonthly (우리 enum 과 **불일치** → 매핑). */
  cycle: z.string().nullable().optional(),
  list_order_no: z.number().int().nullable().optional(),
  registration_flag: flagSchema.nullable().optional(),
  complete_flag: flagSchema.nullable().optional(),
});

const schedulerChoreSchema = z.object({
  content_name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  registration_flag: flagSchema.nullable().optional(),
  now_count: z.number().int().nullable().optional(),
  max_count: z.number().int().nullable().optional(),
  // 실측: daily 는 문자열 "0", weekly 는 "0"/"2". 숫자로 올 가능성도 열어 둔다.
  quest_state: z.union([z.string(), z.number()]).nullable().optional(),
});

export const schedulerStateResponseSchema = z.object({
  date: z.string().nullable().optional(),
  character_name: z.string().nullable().optional(),
  world_name: z.string().nullable().optional(),
  character_class: z.string().nullable().optional(),
  character_level: z.number().int().nullable().optional(),
  daily_contents: z.array(schedulerChoreSchema).nullable().optional(),
  weekly_contents: z.array(schedulerChoreSchema).nullable().optional(),
  boss_contents: z.array(schedulerBossSchema).nullable().optional(),
  weekly_boss_clear_count: z.number().int().nullable().optional(),
  /** 실측 12. 값을 그대로 보관하고 코드에 12를 박지 않는다. */
  weekly_boss_clear_limit_count: z.number().int().nullable().optional(),
});

export type CharacterListResponse = z.infer<typeof characterListResponseSchema>;
export type CharacterBasicResponse = z.infer<
  typeof characterBasicResponseSchema
>;
export type SchedulerStateResponse = z.infer<
  typeof schedulerStateResponseSchema
>;
