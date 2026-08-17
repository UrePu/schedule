/**
 * 응답 파싱용 zod 스키마.
 *
 * 스펙이 실제와 어긋날 수 있다는 것이 이 도구의 전제이므로, 스키마는 **관대하게** 잡는다.
 * - 값 형태를 확정하려는 필드(`registration_flag` 등)는 `string | boolean` 유니온으로 받아
 *   실제 런타임 타입을 별도로 관측한다(미확인 항목: 문자열 "true" 인가 불리언인가).
 * - 옵셔널/널을 넉넉히 허용해 파싱 실패로 도구가 죽지 않게 한다. 실패는 관측 결과로 기록한다.
 */
import { z } from 'zod'

/** 문자열 "true"/"false" 인지 진짜 불리언인지 확정하지 못한 플래그 */
export const flagSchema = z.union([z.string(), z.boolean()])

export const errorBodySchema = z.object({
  error: z.object({
    name: z.string(),
    message: z.string().optional(),
  }),
})

export const characterListSchema = z.object({
  account_list: z
    .array(
      z.object({
        account_id: z.string().nullable().optional(),
        character_list: z
          .array(
            z.object({
              ocid: z.string(),
              character_name: z.string().nullable().optional(),
              world_name: z.string().nullable().optional(),
              character_class: z.string().nullable().optional(),
              character_level: z.number().nullable().optional(),
            }),
          )
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
})

export const characterBasicSchema = z.object({
  date: z.string().nullable().optional(),
  character_name: z.string().nullable().optional(),
  world_name: z.string().nullable().optional(),
  character_class: z.string().nullable().optional(),
  character_level: z.number().nullable().optional(),
  character_guild_name: z.string().nullable().optional(),
})

export const schedulerContentSchema = z.object({
  content_name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  registration_flag: flagSchema.nullable().optional(),
  now_count: z.number().nullable().optional(),
  max_count: z.number().nullable().optional(),
  quest_state: z.union([z.string(), z.number()]).nullable().optional(),
})

export const schedulerBossSchema = z.object({
  content_name: z.string().nullable().optional(),
  difficulty: z.string().nullable().optional(),
  cycle: z.string().nullable().optional(),
  list_order_no: z.number().nullable().optional(),
  registration_flag: flagSchema.nullable().optional(),
  complete_flag: flagSchema.nullable().optional(),
})

export const characterStateSchema = z.object({
  date: z.string().nullable().optional(),
  character_name: z.string().nullable().optional(),
  world_name: z.string().nullable().optional(),
  character_level: z.number().nullable().optional(),
  character_class: z.string().nullable().optional(),
  daily_contents: z.array(schedulerContentSchema).nullable().optional(),
  weekly_contents: z.array(schedulerContentSchema).nullable().optional(),
  boss_contents: z.array(schedulerBossSchema).nullable().optional(),
  weekly_boss_clear_count: z.number().nullable().optional(),
  weekly_boss_clear_limit_count: z.number().nullable().optional(),
})

export const ocidSchema = z.object({ ocid: z.string() })

export const guildIdSchema = z.object({ oguild_id: z.string() })

export const guildBasicSchema = z.object({
  guild_name: z.string().nullable().optional(),
  world_name: z.string().nullable().optional(),
  guild_member: z.array(z.string()).nullable().optional(),
})

export type CharacterList = z.infer<typeof characterListSchema>
export type CharacterBasic = z.infer<typeof characterBasicSchema>
export type CharacterState = z.infer<typeof characterStateSchema>
export type GuildBasic = z.infer<typeof guildBasicSchema>
