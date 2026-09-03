/**
 * 자동 생성 파일. 직접 수정 금지.
 * 스키마 변경 후 재생성할 것.
 *
 * 생성 명령: Supabase MCP `generate_typescript_types`
 *   (또는 `npx supabase gen types typescript --project-id hryikreaxngexhjjxfyl`)
 * 대상 프로젝트: hryikreaxngexhjjxfyl (M_Schedule)
 * 마지막 생성: 2026-09-03 · 마이그레이션 36(`20260903130000_availability_mode.sql`) 적용 후
 *
 * ★ 이번 재생성으로 그 전까지 손으로 넣어 두었던 항목들이 **전부 도구 출력으로 대체**됐다
 *   (`character_looks` · `bot_channel_kind` · `bot_direct_grants` · `bot_notification_prefs` ·
 *    `character_boss_plans.default_party_size` 등). 수기 반영 메모는 그래서 지웠다 —
 *   생성물과 메모가 같은 말을 하기 시작하면 다음 사람이 어느 쪽을 믿을지 모르게 된다.
 *
 * ⚠️ 재생성이 드러낸 드리프트: `boss_cycle` 이넘에 `season` 이 라이브에 이미 있었는데
 *   체크인된 타입에는 없었다. 손으로 반영해 온 대가이며, 이제 도구 출력이 사실이다.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_users: {
        Row: {
          auth_user_id: string | null
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          display_name: string
          friend_discoverable: boolean
          id: string
          last_login_at: string | null
          main_character_name: string | null
          main_world_name: string | null
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name: string
          friend_discoverable?: boolean
          id?: string
          last_login_at?: string | null
          main_character_name?: string | null
          main_world_name?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string
          friend_discoverable?: boolean
          id?: string
          last_login_at?: string | null
          main_character_name?: string | null
          main_world_name?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Relationships: []
      }
      availability_cycles: {
        Row: {
          anchor_date: string
          created_at: string
          cycle_days: number
          guest_id: string | null
          id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          anchor_date: string
          created_at?: string
          cycle_days: number
          guest_id?: string | null
          id?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          anchor_date?: string
          created_at?: string
          cycle_days?: number
          guest_id?: string | null
          id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "availability_cycles_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_cycles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_exceptions: {
        Row: {
          created_at: string
          end_minute: number
          exception_date: string
          guest_id: string | null
          id: string
          note: string | null
          start_minute: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          end_minute: number
          exception_date: string
          guest_id?: string | null
          id?: string
          note?: string | null
          start_minute: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          end_minute?: number
          exception_date?: string
          guest_id?: string | null
          id?: string
          note?: string | null
          start_minute?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "availability_exceptions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_exceptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_modes: {
        Row: {
          created_at: string
          guest_id: string | null
          id: string
          mode: Database["public"]["Enums"]["availability_mode"]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          guest_id?: string | null
          id?: string
          mode?: Database["public"]["Enums"]["availability_mode"]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          guest_id?: string | null
          id?: string
          mode?: Database["public"]["Enums"]["availability_mode"]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "availability_modes_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_modes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_patterns: {
        Row: {
          created_at: string
          cycle_day: number | null
          end_minute: number
          guest_id: string | null
          id: string
          note: string | null
          start_minute: number
          updated_at: string
          user_id: string | null
          weekday: number | null
        }
        Insert: {
          created_at?: string
          cycle_day?: number | null
          end_minute: number
          guest_id?: string | null
          id?: string
          note?: string | null
          start_minute: number
          updated_at?: string
          user_id?: string | null
          weekday?: number | null
        }
        Update: {
          created_at?: string
          cycle_day?: number | null
          end_minute?: number
          guest_id?: string | null
          id?: string
          note?: string | null
          start_minute?: number
          updated_at?: string
          user_id?: string | null
          weekday?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "availability_patterns_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_patterns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      boss_aliases: {
        Row: {
          alias: string
          boss_difficulty_id: string | null
          boss_id: string
          created_at: string
          id: string
          normalized_alias: string
          source: string
        }
        Insert: {
          alias: string
          boss_difficulty_id?: string | null
          boss_id: string
          created_at?: string
          id?: string
          normalized_alias: string
          source?: string
        }
        Update: {
          alias?: string
          boss_difficulty_id?: string | null
          boss_id?: string
          created_at?: string
          id?: string
          normalized_alias?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "boss_aliases_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "bosses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_aliases_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_id"]
          },
          {
            foreignKeyName: "boss_aliases_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "v_boss_nexon_mapping_health"
            referencedColumns: ["boss_id"]
          },
          {
            foreignKeyName: "boss_aliases_entry_belongs_to_boss"
            columns: ["boss_difficulty_id", "boss_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id", "boss_id"]
          },
        ]
      }
      boss_clears: {
        Row: {
          api_cleared: boolean | null
          api_observed_at: string | null
          base_price_meso: number | null
          boss_difficulty_id: string
          character_id: string | null
          cleared_at: string | null
          created_at: string
          crystal_price_id: string | null
          crystal_share_meso: number | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          effective_cleared: boolean
          has_conflict: boolean
          id: string
          manual_base_price_meso: number | null
          manual_cleared: boolean | null
          manual_set_at: string | null
          note: string | null
          party_size: number
          party_size_confirmed: boolean
          party_size_manual: boolean
          pot_meso: number | null
          price_snapshotted_at: string | null
          run_id: string | null
          share_bp: number | null
          source: Database["public"]["Enums"]["clear_source"]
          updated_at: string
          user_id: string
          week_key: string
          world_name: string | null
        }
        Insert: {
          api_cleared?: boolean | null
          api_observed_at?: string | null
          base_price_meso?: number | null
          boss_difficulty_id: string
          character_id?: string | null
          cleared_at?: string | null
          created_at?: string
          crystal_price_id?: string | null
          crystal_share_meso?: number | null
          cycle?: Database["public"]["Enums"]["boss_cycle"] | null
          effective_cleared?: boolean
          has_conflict?: boolean
          id?: string
          manual_base_price_meso?: number | null
          manual_cleared?: boolean | null
          manual_set_at?: string | null
          note?: string | null
          party_size?: number
          party_size_confirmed?: boolean
          party_size_manual?: boolean
          pot_meso?: number | null
          price_snapshotted_at?: string | null
          run_id?: string | null
          share_bp?: number | null
          source?: Database["public"]["Enums"]["clear_source"]
          updated_at?: string
          user_id: string
          week_key?: string
          world_name?: string | null
        }
        Update: {
          api_cleared?: boolean | null
          api_observed_at?: string | null
          base_price_meso?: number | null
          boss_difficulty_id?: string
          character_id?: string | null
          cleared_at?: string | null
          created_at?: string
          crystal_price_id?: string | null
          crystal_share_meso?: number | null
          cycle?: Database["public"]["Enums"]["boss_cycle"] | null
          effective_cleared?: boolean
          has_conflict?: boolean
          id?: string
          manual_base_price_meso?: number | null
          manual_cleared?: boolean | null
          manual_set_at?: string | null
          note?: string | null
          party_size?: number
          party_size_confirmed?: boolean
          party_size_manual?: boolean
          pot_meso?: number | null
          price_snapshotted_at?: string | null
          run_id?: string | null
          share_bp?: number | null
          source?: Database["public"]["Enums"]["clear_source"]
          updated_at?: string
          user_id?: string
          week_key?: string
          world_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "boss_clears_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "boss_clears_crystal_price_id_fkey"
            columns: ["crystal_price_id"]
            isOneToOne: false
            referencedRelation: "boss_crystal_prices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      boss_crystal_prices: {
        Row: {
          boss_difficulty_id: string
          created_at: string
          effective_from: string
          id: string
          note: string | null
          patch_label: string | null
          price_meso: number | null
        }
        Insert: {
          boss_difficulty_id: string
          created_at?: string
          effective_from?: string
          id?: string
          note?: string | null
          patch_label?: string | null
          price_meso?: number | null
        }
        Update: {
          boss_difficulty_id?: string
          created_at?: string
          effective_from?: string
          id?: string
          note?: string | null
          patch_label?: string | null
          price_meso?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_crystal_prices_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_crystal_prices_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "boss_crystal_prices_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
        ]
      }
      boss_difficulties: {
        Row: {
          boss_id: string
          counts_toward_weekly_limit: boolean
          created_at: string
          cycle: Database["public"]["Enums"]["boss_cycle"]
          difficulty: Database["public"]["Enums"]["boss_difficulty_tier"]
          entry_level: number | null
          id: string
          korean_name: string
          max_party: number
          nexon_difficulty: string | null
          released: boolean
          short_name: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          boss_id: string
          counts_toward_weekly_limit?: boolean
          created_at?: string
          cycle: Database["public"]["Enums"]["boss_cycle"]
          difficulty: Database["public"]["Enums"]["boss_difficulty_tier"]
          entry_level?: number | null
          id: string
          korean_name: string
          max_party?: number
          nexon_difficulty?: string | null
          released?: boolean
          short_name?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          boss_id?: string
          counts_toward_weekly_limit?: boolean
          created_at?: string
          cycle?: Database["public"]["Enums"]["boss_cycle"]
          difficulty?: Database["public"]["Enums"]["boss_difficulty_tier"]
          entry_level?: number | null
          id?: string
          korean_name?: string
          max_party?: number
          nexon_difficulty?: string | null
          released?: boolean
          short_name?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "boss_difficulties_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "bosses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_difficulties_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_id"]
          },
          {
            foreignKeyName: "boss_difficulties_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "v_boss_nexon_mapping_health"
            referencedColumns: ["boss_id"]
          },
        ]
      }
      bosses: {
        Row: {
          created_at: string
          generation: Database["public"]["Enums"]["boss_generation"]
          id: string
          korean_name: string
          nexon_content_name: string | null
          nexon_name_verified: boolean
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          generation?: Database["public"]["Enums"]["boss_generation"]
          id: string
          korean_name: string
          nexon_content_name?: string | null
          nexon_name_verified?: boolean
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          generation?: Database["public"]["Enums"]["boss_generation"]
          id?: string
          korean_name?: string
          nexon_content_name?: string | null
          nexon_name_verified?: boolean
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      bot_channel_members: {
        Row: {
          channel_id: string
          display_name: string | null
          id: string
          last_seen_at: string | null
          linked_at: string
          sender_id: string
          user_id: string
        }
        Insert: {
          channel_id: string
          display_name?: string | null
          id?: string
          last_seen_at?: string | null
          linked_at?: string
          sender_id: string
          user_id: string
        }
        Update: {
          channel_id?: string
          display_name?: string | null
          id?: string
          last_seen_at?: string | null
          linked_at?: string
          sender_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_channel_members_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_channel_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_channels: {
        Row: {
          created_at: string
          digest_minutes: number[]
          id: string
          kind: Database["public"]["Enums"]["bot_channel_kind"]
          last_polled_at: string | null
          last_seen_at: string | null
          owner_user_id: string | null
          platform: string
          previous_secret_expires_at: string | null
          previous_secret_hash: string | null
          room: string
          room_fingerprint: string | null
          runner: string | null
          secret_hash: string
          secret_rotated_at: string | null
          signature_failure_count: number
          signed: boolean
          status: Database["public"]["Enums"]["bot_channel_status"]
          suspended_until: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          digest_minutes?: number[]
          id?: string
          kind?: Database["public"]["Enums"]["bot_channel_kind"]
          last_polled_at?: string | null
          last_seen_at?: string | null
          owner_user_id?: string | null
          platform?: string
          previous_secret_expires_at?: string | null
          previous_secret_hash?: string | null
          room: string
          room_fingerprint?: string | null
          runner?: string | null
          secret_hash: string
          secret_rotated_at?: string | null
          signature_failure_count?: number
          signed?: boolean
          status?: Database["public"]["Enums"]["bot_channel_status"]
          suspended_until?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          digest_minutes?: number[]
          id?: string
          kind?: Database["public"]["Enums"]["bot_channel_kind"]
          last_polled_at?: string | null
          last_seen_at?: string | null
          owner_user_id?: string | null
          platform?: string
          previous_secret_expires_at?: string | null
          previous_secret_hash?: string | null
          room?: string
          room_fingerprint?: string | null
          runner?: string | null
          secret_hash?: string
          secret_rotated_at?: string | null
          signature_failure_count?: number
          signed?: boolean
          status?: Database["public"]["Enums"]["bot_channel_status"]
          suspended_until?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_channels_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_command_log: {
        Row: {
          channel_id: string
          command: string
          created_at: string
          duration_ms: number | null
          id: string
          nonce: string
          result: string | null
          sender_id: string | null
          status_code: number | null
          user_id: string | null
        }
        Insert: {
          channel_id: string
          command: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          nonce: string
          result?: string | null
          sender_id?: string | null
          status_code?: number | null
          user_id?: string | null
        }
        Update: {
          channel_id?: string
          command?: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          nonce?: string
          result?: string | null
          sender_id?: string | null
          status_code?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bot_command_log_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_command_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_direct_grants: {
        Row: {
          granted_at: string
          granted_by: string | null
          note: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_direct_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_direct_grants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_link_codes: {
        Row: {
          attempt_count: number
          channel_id: string | null
          code_hash: string
          consumed_at: string | null
          consumed_by_channel_id: string | null
          created_at: string
          expires_at: string
          id: string
          kind: Database["public"]["Enums"]["bot_link_code_kind"]
          max_attempts: number
          revoked_at: string | null
          user_id: string | null
        }
        Insert: {
          attempt_count?: number
          channel_id?: string | null
          code_hash: string
          consumed_at?: string | null
          consumed_by_channel_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          kind: Database["public"]["Enums"]["bot_link_code_kind"]
          max_attempts?: number
          revoked_at?: string | null
          user_id?: string | null
        }
        Update: {
          attempt_count?: number
          channel_id?: string | null
          code_hash?: string
          consumed_at?: string | null
          consumed_by_channel_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["bot_link_code_kind"]
          max_attempts?: number
          revoked_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bot_link_codes_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_link_codes_consumed_by_channel_id_fkey"
            columns: ["consumed_by_channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_link_codes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_notification_prefs: {
        Row: {
          created_at: string
          digest_at_minutes: number | null
          enabled: boolean
          lead_minutes: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          digest_at_minutes?: number | null
          enabled?: boolean
          lead_minutes?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          digest_at_minutes?: number | null
          enabled?: boolean
          lead_minutes?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_notification_prefs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_outbox: {
        Row: {
          attempts: number
          channel_id: string
          created_at: string
          dedupe_key: string
          delivered_at: string | null
          expires_at: string
          extra: string[] | null
          id: string
          last_error: string | null
          max_attempts: number
          reply: string
          state: Database["public"]["Enums"]["bot_outbox_state"]
          updated_at: string
          visible_after: string
        }
        Insert: {
          attempts?: number
          channel_id: string
          created_at?: string
          dedupe_key: string
          delivered_at?: string | null
          expires_at: string
          extra?: string[] | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          reply: string
          state?: Database["public"]["Enums"]["bot_outbox_state"]
          updated_at?: string
          visible_after?: string
        }
        Update: {
          attempts?: number
          channel_id?: string
          created_at?: string
          dedupe_key?: string
          delivered_at?: string | null
          expires_at?: string
          extra?: string[] | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          reply?: string
          state?: Database["public"]["Enums"]["bot_outbox_state"]
          updated_at?: string
          visible_after?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_outbox_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      character_boss_plans: {
        Row: {
          api_observed_at: string | null
          api_registered: boolean | null
          boss_difficulty_id: string
          character_id: string
          created_at: string
          default_party_size: number
          has_conflict: boolean
          id: string
          is_active: boolean
          manual_active: boolean | null
          manual_set_at: string | null
          note: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          api_observed_at?: string | null
          api_registered?: boolean | null
          boss_difficulty_id: string
          character_id: string
          created_at?: string
          default_party_size?: number
          has_conflict?: boolean
          id?: string
          is_active?: boolean
          manual_active?: boolean | null
          manual_set_at?: string | null
          note?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          api_observed_at?: string | null
          api_registered?: boolean | null
          boss_difficulty_id?: string
          character_id?: string
          created_at?: string
          default_party_size?: number
          has_conflict?: boolean
          id?: string
          is_active?: boolean
          manual_active?: boolean | null
          manual_set_at?: string | null
          note?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_boss_plans_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_boss_plans_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "character_boss_plans_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "character_boss_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      character_looks: {
        Row: {
          character_class: string | null
          character_level: number | null
          character_name: string
          created_at: string
          fetched_at: string | null
          image_url: string | null
          missing_at: string | null
          ocid: string | null
          world_name: string | null
        }
        Insert: {
          character_class?: string | null
          character_level?: number | null
          character_name: string
          created_at?: string
          fetched_at?: string | null
          image_url?: string | null
          missing_at?: string | null
          ocid?: string | null
          world_name?: string | null
        }
        Update: {
          character_class?: string | null
          character_level?: number | null
          character_name?: string
          created_at?: string
          fetched_at?: string | null
          image_url?: string | null
          missing_at?: string | null
          ocid?: string | null
          world_name?: string | null
        }
        Relationships: []
      }
      character_scheduler_snapshots: {
        Row: {
          character_id: string
          day_key: string | null
          fetched_at: string
          id: string
          is_empty: boolean
          payload: Json
          snapshot_at: string
          week_key: string | null
          weekly_boss_clear_count: number | null
          weekly_boss_clear_limit_count: number | null
        }
        Insert: {
          character_id: string
          day_key?: string | null
          fetched_at?: string
          id?: string
          is_empty?: boolean
          payload?: Json
          snapshot_at: string
          week_key?: string | null
          weekly_boss_clear_count?: number | null
          weekly_boss_clear_limit_count?: number | null
        }
        Update: {
          character_id?: string
          day_key?: string | null
          fetched_at?: string
          id?: string
          is_empty?: boolean
          payload?: Json
          snapshot_at?: string
          week_key?: string | null
          weekly_boss_clear_count?: number | null
          weekly_boss_clear_limit_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "character_scheduler_snapshots_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_scheduler_snapshots_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
        ]
      }
      characters: {
        Row: {
          character_class: string | null
          character_level: number | null
          character_name: string
          created_at: string
          guild_name: string | null
          id: string
          image_url: string | null
          is_main: boolean
          is_tracked: boolean
          last_synced_at: string | null
          nexon_account_ref: string | null
          ocid: string | null
          ocid_refreshed_at: string | null
          sync_state: Database["public"]["Enums"]["character_sync_state"]
          updated_at: string
          user_id: string
          world_name: string | null
        }
        Insert: {
          character_class?: string | null
          character_level?: number | null
          character_name: string
          created_at?: string
          guild_name?: string | null
          id?: string
          image_url?: string | null
          is_main?: boolean
          is_tracked?: boolean
          last_synced_at?: string | null
          nexon_account_ref?: string | null
          ocid?: string | null
          ocid_refreshed_at?: string | null
          sync_state?: Database["public"]["Enums"]["character_sync_state"]
          updated_at?: string
          user_id: string
          world_name?: string | null
        }
        Update: {
          character_class?: string | null
          character_level?: number | null
          character_name?: string
          created_at?: string
          guild_name?: string | null
          id?: string
          image_url?: string | null
          is_main?: boolean
          is_tracked?: boolean
          last_synced_at?: string | null
          nexon_account_ref?: string | null
          ocid?: string | null
          ocid_refreshed_at?: string | null
          sync_state?: Database["public"]["Enums"]["character_sync_state"]
          updated_at?: string
          user_id?: string
          world_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "characters_nexon_account_ref_fkey"
            columns: ["nexon_account_ref"]
            isOneToOne: false
            referencedRelation: "user_nexon_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "characters_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      chore_completions: {
        Row: {
          api_done: boolean | null
          api_observed_at: string | null
          character_id: string | null
          chore_definition_id: string
          completed_at: string | null
          created_at: string
          day_key: string
          effective_done: boolean
          has_conflict: boolean
          id: string
          manual_done: boolean | null
          manual_set_at: string | null
          max_count: number | null
          now_count: number | null
          scope: Database["public"]["Enums"]["chore_scope"]
          source: Database["public"]["Enums"]["clear_source"]
          updated_at: string
          user_id: string
          week_key: string
        }
        Insert: {
          api_done?: boolean | null
          api_observed_at?: string | null
          character_id?: string | null
          chore_definition_id: string
          completed_at?: string | null
          created_at?: string
          day_key?: string
          effective_done?: boolean
          has_conflict?: boolean
          id?: string
          manual_done?: boolean | null
          manual_set_at?: string | null
          max_count?: number | null
          now_count?: number | null
          scope: Database["public"]["Enums"]["chore_scope"]
          source?: Database["public"]["Enums"]["clear_source"]
          updated_at?: string
          user_id: string
          week_key?: string
        }
        Update: {
          api_done?: boolean | null
          api_observed_at?: string | null
          character_id?: string | null
          chore_definition_id?: string
          completed_at?: string | null
          created_at?: string
          day_key?: string
          effective_done?: boolean
          has_conflict?: boolean
          id?: string
          manual_done?: boolean | null
          manual_set_at?: string | null
          max_count?: number | null
          now_count?: number | null
          scope?: Database["public"]["Enums"]["chore_scope"]
          source?: Database["public"]["Enums"]["clear_source"]
          updated_at?: string
          user_id?: string
          week_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "chore_completions_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chore_completions_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "chore_completions_definition_fk"
            columns: ["chore_definition_id", "scope"]
            isOneToOne: false
            referencedRelation: "chore_definitions"
            referencedColumns: ["id", "scope"]
          },
          {
            foreignKeyName: "chore_completions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      chore_definitions: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          is_builtin: boolean
          name: string
          nexon_completable: boolean
          nexon_content_name: string | null
          owner_user_id: string | null
          scope: Database["public"]["Enums"]["chore_scope"]
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_builtin?: boolean
          name: string
          nexon_completable?: boolean
          nexon_content_name?: string | null
          owner_user_id?: string | null
          scope: Database["public"]["Enums"]["chore_scope"]
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_builtin?: boolean
          name?: string
          nexon_completable?: boolean
          nexon_content_name?: string | null
          owner_user_id?: string | null
          scope?: Database["public"]["Enums"]["chore_scope"]
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chore_definitions_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      credential_nexon_accounts: {
        Row: {
          credential_id: string
          first_seen_at: string
          id: string
          last_seen_at: string
          nexon_account_ref: string
        }
        Insert: {
          credential_id: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          nexon_account_ref: string
        }
        Update: {
          credential_id?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          nexon_account_ref?: string
        }
        Relationships: [
          {
            foreignKeyName: "credential_nexon_accounts_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "user_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credential_nexon_accounts_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["credential_id"]
          },
          {
            foreignKeyName: "credential_nexon_accounts_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "v_nexon_sync_plan"
            referencedColumns: ["credential_id"]
          },
          {
            foreignKeyName: "credential_nexon_accounts_nexon_account_ref_fkey"
            columns: ["nexon_account_ref"]
            isOneToOne: false
            referencedRelation: "user_nexon_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      friend_links: {
        Row: {
          created_at: string
          rotated_at: string | null
          token_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          rotated_at?: string | null
          token_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          rotated_at?: string | null
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "friend_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          addressee_user_id: string
          blocked_by_user_id: string | null
          created_at: string
          id: string
          requester_user_id: string
          responded_at: string | null
          status: Database["public"]["Enums"]["friendship_status"]
        }
        Insert: {
          addressee_user_id: string
          blocked_by_user_id?: string | null
          created_at?: string
          id?: string
          requester_user_id: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["friendship_status"]
        }
        Update: {
          addressee_user_id?: string
          blocked_by_user_id?: string | null
          created_at?: string
          id?: string
          requester_user_id?: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["friendship_status"]
        }
        Relationships: [
          {
            foreignKeyName: "friendships_addressee_user_id_fkey"
            columns: ["addressee_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_blocked_by_user_id_fkey"
            columns: ["blocked_by_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_requester_user_id_fkey"
            columns: ["requester_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_claims: {
        Row: {
          claim_method: string
          claimed_at: string
          guest_id: string
          id: string
          merged_participant_count: number
          moved_participant_count: number
          user_id: string
        }
        Insert: {
          claim_method?: string
          claimed_at?: string
          guest_id: string
          id?: string
          merged_participant_count?: number
          moved_participant_count?: number
          user_id: string
        }
        Update: {
          claim_method?: string
          claimed_at?: string
          guest_id?: string
          id?: string
          merged_participant_count?: number
          moved_participant_count?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_claims_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_claims_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_profiles: {
        Row: {
          claim_token_hash: string | null
          claimed_at: string | null
          claimed_by_user_id: string | null
          created_at: string
          created_via_invite_id: string | null
          display_name: string
          expires_at: string | null
          id: string
          last_seen_at: string
        }
        Insert: {
          claim_token_hash?: string | null
          claimed_at?: string | null
          claimed_by_user_id?: string | null
          created_at?: string
          created_via_invite_id?: string | null
          display_name: string
          expires_at?: string | null
          id?: string
          last_seen_at?: string
        }
        Update: {
          claim_token_hash?: string | null
          claimed_at?: string | null
          claimed_by_user_id?: string | null
          created_at?: string
          created_via_invite_id?: string | null
          display_name?: string
          expires_at?: string | null
          id?: string
          last_seen_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_profiles_claimed_by_user_id_fkey"
            columns: ["claimed_by_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_profiles_created_via_invite_id_fkey"
            columns: ["created_via_invite_id"]
            isOneToOne: false
            referencedRelation: "invite_links"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_links: {
        Row: {
          created_at: string
          created_by_user_id: string | null
          expires_at: string | null
          id: string
          label: string | null
          max_uses: number | null
          party_id: string
          revoked_at: string | null
          role_on_join: Database["public"]["Enums"]["party_member_role"]
          token_hash: string
          used_count: number
        }
        Insert: {
          created_at?: string
          created_by_user_id?: string | null
          expires_at?: string | null
          id?: string
          label?: string | null
          max_uses?: number | null
          party_id: string
          revoked_at?: string | null
          role_on_join?: Database["public"]["Enums"]["party_member_role"]
          token_hash: string
          used_count?: number
        }
        Update: {
          created_at?: string
          created_by_user_id?: string | null
          expires_at?: string | null
          id?: string
          label?: string | null
          max_uses?: number | null
          party_id?: string
          revoked_at?: string | null
          role_on_join?: Database["public"]["Enums"]["party_member_role"]
          token_hash?: string
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "invite_links_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_links_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_links_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_links_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["party_id"]
          },
        ]
      }
      invite_redemptions: {
        Row: {
          guest_id: string | null
          id: string
          invite_id: string
          ip_hash: string | null
          participant_id: string | null
          redeemed_at: string
          user_id: string | null
        }
        Insert: {
          guest_id?: string | null
          id?: string
          invite_id: string
          ip_hash?: string | null
          participant_id?: string | null
          redeemed_at?: string
          user_id?: string | null
        }
        Update: {
          guest_id?: string | null
          id?: string
          invite_id?: string
          ip_hash?: string | null
          participant_id?: string | null
          redeemed_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invite_redemptions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_redemptions_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "invite_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_redemptions_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invite_redemptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      nexon_api_quota_usage: {
        Row: {
          call_count: number
          credential_id: string
          day_key: string
          error_count: number
          id: string
          last_called_at: string | null
          throttled_count: number
          updated_at: string
        }
        Insert: {
          call_count?: number
          credential_id: string
          day_key: string
          error_count?: number
          id?: string
          last_called_at?: string | null
          throttled_count?: number
          updated_at?: string
        }
        Update: {
          call_count?: number
          credential_id?: string
          day_key?: string
          error_count?: number
          id?: string
          last_called_at?: string | null
          throttled_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nexon_api_quota_usage_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "user_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nexon_api_quota_usage_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["credential_id"]
          },
          {
            foreignKeyName: "nexon_api_quota_usage_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "v_nexon_sync_plan"
            referencedColumns: ["credential_id"]
          },
        ]
      }
      nexon_unmapped_contents: {
        Row: {
          content_name: string
          cycle: string | null
          difficulty: string | null
          first_seen_at: string
          id: string
          last_seen_at: string
          note: string | null
          resolution: Database["public"]["Enums"]["nexon_mapping_resolution"]
          seen_count: number
        }
        Insert: {
          content_name: string
          cycle?: string | null
          difficulty?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          note?: string | null
          resolution?: Database["public"]["Enums"]["nexon_mapping_resolution"]
          seen_count?: number
        }
        Update: {
          content_name?: string
          cycle?: string | null
          difficulty?: string | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          note?: string | null
          resolution?: Database["public"]["Enums"]["nexon_mapping_resolution"]
          seen_count?: number
        }
        Relationships: []
      }
      parties: {
        Row: {
          archived_at: string | null
          bot_channel_id: string | null
          created_at: string
          default_capacity: number
          description: string | null
          id: string
          name: string
          name_is_custom: boolean
          owner_user_id: string
          reminder_minutes: number[]
          share_mode: Database["public"]["Enums"]["run_share_mode"]
          share_slug: string | null
          updated_at: string
          visibility: Database["public"]["Enums"]["party_visibility"]
          world_name: string | null
        }
        Insert: {
          archived_at?: string | null
          bot_channel_id?: string | null
          created_at?: string
          default_capacity?: number
          description?: string | null
          id?: string
          name: string
          name_is_custom?: boolean
          owner_user_id: string
          reminder_minutes?: number[]
          share_mode?: Database["public"]["Enums"]["run_share_mode"]
          share_slug?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["party_visibility"]
          world_name?: string | null
        }
        Update: {
          archived_at?: string | null
          bot_channel_id?: string | null
          created_at?: string
          default_capacity?: number
          description?: string | null
          id?: string
          name?: string
          name_is_custom?: boolean
          owner_user_id?: string
          reminder_minutes?: number[]
          share_mode?: Database["public"]["Enums"]["run_share_mode"]
          share_slug?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["party_visibility"]
          world_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parties_bot_channel_id_fkey"
            columns: ["bot_channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parties_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      party_bosses: {
        Row: {
          boss_difficulty_id: string
          created_at: string
          id: string
          party_id: string
          sort_order: number
        }
        Insert: {
          boss_difficulty_id: string
          created_at?: string
          id?: string
          party_id: string
          sort_order?: number
        }
        Update: {
          boss_difficulty_id?: string
          created_at?: string
          id?: string
          party_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "party_bosses_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_bosses_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "party_bosses_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "party_bosses_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_bosses_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_bosses_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["party_id"]
          },
        ]
      }
      party_participants: {
        Row: {
          character_id: string | null
          created_at: string
          display_name: string
          guest_id: string | null
          id: string
          invited_by_user_id: string | null
          joined_at: string
          left_at: string | null
          member_no: number
          party_id: string
          role: Database["public"]["Enums"]["party_member_role"]
          share_bp: number | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          character_id?: string | null
          created_at?: string
          display_name: string
          guest_id?: string | null
          id?: string
          invited_by_user_id?: string | null
          joined_at?: string
          left_at?: string | null
          member_no: number
          party_id: string
          role?: Database["public"]["Enums"]["party_member_role"]
          share_bp?: number | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          character_id?: string | null
          created_at?: string
          display_name?: string
          guest_id?: string | null
          id?: string
          invited_by_user_id?: string | null
          joined_at?: string
          left_at?: string | null
          member_no?: number
          party_id?: string
          role?: Database["public"]["Enums"]["party_member_role"]
          share_bp?: number | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_participants_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_participants_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "party_participants_guest_fk"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_participants_invited_by_user_id_fkey"
            columns: ["invited_by_user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_participants_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_participants_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_participants_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["party_id"]
          },
          {
            foreignKeyName: "party_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      party_room_numbers: {
        Row: {
          assigned_at: string
          channel_id: string
          id: string
          party_id: string
          party_no: number
          week_key: string
        }
        Insert: {
          assigned_at?: string
          channel_id: string
          id?: string
          party_id: string
          party_no: number
          week_key: string
        }
        Update: {
          assigned_at?: string
          channel_id?: string
          id?: string
          party_id?: string
          party_no?: number
          week_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "party_room_numbers_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "bot_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_room_numbers_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_room_numbers_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_room_numbers_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["party_id"]
          },
        ]
      }
      party_runs: {
        Row: {
          boss_difficulty_id: string
          cancelled_at: string | null
          capacity: number
          created_at: string
          created_by_participant_id: string | null
          duration_minutes: number
          entry_party_size: number | null
          id: string
          note: string | null
          party_id: string
          run_no: number
          scheduled_at: string | null
          share_mode: Database["public"]["Enums"]["run_share_mode"]
          status: Database["public"]["Enums"]["run_status"]
          updated_at: string
          week_key: string | null
        }
        Insert: {
          boss_difficulty_id: string
          cancelled_at?: string | null
          capacity?: number
          created_at?: string
          created_by_participant_id?: string | null
          duration_minutes?: number
          entry_party_size?: number | null
          id?: string
          note?: string | null
          party_id: string
          run_no: number
          scheduled_at?: string | null
          share_mode?: Database["public"]["Enums"]["run_share_mode"]
          status?: Database["public"]["Enums"]["run_status"]
          updated_at?: string
          week_key?: string | null
        }
        Update: {
          boss_difficulty_id?: string
          cancelled_at?: string | null
          capacity?: number
          created_at?: string
          created_by_participant_id?: string | null
          duration_minutes?: number
          entry_party_size?: number | null
          id?: string
          note?: string | null
          party_id?: string
          run_no?: number
          scheduled_at?: string | null
          share_mode?: Database["public"]["Enums"]["run_share_mode"]
          status?: Database["public"]["Enums"]["run_status"]
          updated_at?: string
          week_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_runs_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "party_runs_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "party_runs_created_by_participant_id_fkey"
            columns: ["created_by_participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["party_id"]
          },
        ]
      }
      run_drop_shares: {
        Row: {
          created_at: string
          drop_id: string
          id: string
          participant_id: string
          share_bp: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          drop_id: string
          id?: string
          participant_id: string
          share_bp?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          drop_id?: string
          id?: string
          participant_id?: string
          share_bp?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_drop_shares_drop_id_fkey"
            columns: ["drop_id"]
            isOneToOne: false
            referencedRelation: "run_drops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_drop_shares_drop_id_fkey"
            columns: ["drop_id"]
            isOneToOne: false
            referencedRelation: "v_run_drop_settlement"
            referencedColumns: ["drop_id"]
          },
          {
            foreignKeyName: "run_drop_shares_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
        ]
      }
      run_drops: {
        Row: {
          created_at: string
          id: string
          item_name: string
          note: string | null
          recorded_by_participant_id: string | null
          run_id: string
          sale_amount_meso: number | null
          share_mode: Database["public"]["Enums"]["drop_share_mode"]
          sold_at: string | null
          solo_participant_id: string | null
          updated_at: string
          week_key: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_name: string
          note?: string | null
          recorded_by_participant_id?: string | null
          run_id: string
          sale_amount_meso?: number | null
          share_mode?: Database["public"]["Enums"]["drop_share_mode"]
          sold_at?: string | null
          solo_participant_id?: string | null
          updated_at?: string
          week_key?: string
        }
        Update: {
          created_at?: string
          id?: string
          item_name?: string
          note?: string | null
          recorded_by_participant_id?: string | null
          run_id?: string
          sale_amount_meso?: number | null
          share_mode?: Database["public"]["Enums"]["drop_share_mode"]
          sold_at?: string | null
          solo_participant_id?: string | null
          updated_at?: string
          week_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_drops_recorded_by_participant_id_fkey"
            columns: ["recorded_by_participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_drops_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_drops_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "run_drops_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "run_drops_solo_participant_id_fkey"
            columns: ["solo_participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
        ]
      }
      run_signups: {
        Row: {
          character_id: string | null
          created_at: string
          id: string
          note: string | null
          participant_id: string
          run_id: string
          share_bp: number
          status: Database["public"]["Enums"]["signup_status"]
          updated_at: string
        }
        Insert: {
          character_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          participant_id: string
          run_id: string
          share_bp?: number
          status?: Database["public"]["Enums"]["signup_status"]
          updated_at?: string
        }
        Update: {
          character_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          participant_id?: string
          run_id?: string
          share_bp?: number
          status?: Database["public"]["Enums"]["signup_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_signups_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_signups_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "run_signups_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_signups_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_signups_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "run_signups_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
        ]
      }
      scouter_stat_cache: {
        Row: {
          authentic_force: number | null
          authentic_symbols: number[] | null
          boss_stat: number | null
          character_class: string | null
          character_level: number | null
          created_at: string
          fetched_at: string | null
          grand_authentic_symbols: number[] | null
          hexa_stat: number | null
          missing_at: string | null
          name: string
          world_name: string | null
        }
        Insert: {
          authentic_force?: number | null
          authentic_symbols?: number[] | null
          boss_stat?: number | null
          character_class?: string | null
          character_level?: number | null
          created_at?: string
          fetched_at?: string | null
          grand_authentic_symbols?: number[] | null
          hexa_stat?: number | null
          missing_at?: string | null
          name: string
          world_name?: string | null
        }
        Update: {
          authentic_force?: number | null
          authentic_symbols?: number[] | null
          boss_stat?: number | null
          character_class?: string | null
          character_level?: number | null
          created_at?: string
          fetched_at?: string | null
          grand_authentic_symbols?: number[] | null
          hexa_stat?: number | null
          missing_at?: string | null
          name?: string
          world_name?: string | null
        }
        Relationships: []
      }
      shift_assignments: {
        Row: {
          created_at: string
          guest_id: string | null
          id: string
          preset_id: string | null
          updated_at: string
          user_id: string | null
          work_date: string
        }
        Insert: {
          created_at?: string
          guest_id?: string | null
          id?: string
          preset_id?: string | null
          updated_at?: string
          user_id?: string | null
          work_date: string
        }
        Update: {
          created_at?: string
          guest_id?: string | null
          id?: string
          preset_id?: string | null
          updated_at?: string
          user_id?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_assignments_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_assignments_preset_id_fkey"
            columns: ["preset_id"]
            isOneToOne: false
            referencedRelation: "shift_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_assignments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_presets: {
        Row: {
          created_at: string
          end_minute: number
          guest_id: string | null
          id: string
          name: string
          sort_order: number
          start_minute: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          end_minute: number
          guest_id?: string | null
          id?: string
          name: string
          sort_order?: number
          start_minute: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          end_minute?: number
          guest_id?: string | null
          id?: string
          name?: string
          sort_order?: number
          start_minute?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_presets_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_presets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_credentials: {
        Row: {
          allow_server_side_use: boolean
          api_key_hash: string
          consent_at: string | null
          created_at: string
          encrypted_api_key: string | null
          encryption_key_id: string | null
          id: string
          invalidated_at: string | null
          is_primary: boolean
          label: string | null
          last_validated_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_server_side_use?: boolean
          api_key_hash: string
          consent_at?: string | null
          created_at?: string
          encrypted_api_key?: string | null
          encryption_key_id?: string | null
          id?: string
          invalidated_at?: string | null
          is_primary?: boolean
          label?: string | null
          last_validated_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_server_side_use?: boolean
          api_key_hash?: string
          consent_at?: string | null
          created_at?: string
          encrypted_api_key?: string | null
          encryption_key_id?: string | null
          id?: string
          invalidated_at?: string | null
          is_primary?: boolean
          label?: string | null
          last_validated_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_credentials_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_nexon_accounts: {
        Row: {
          first_seen_at: string
          id: string
          last_seen_at: string
          nexon_account_id: string
          user_id: string
        }
        Insert: {
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          nexon_account_id: string
          user_id: string
        }
        Update: {
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          nexon_account_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_nexon_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_boss_catalog: {
        Row: {
          boss_difficulty_id: string | null
          boss_id: string | null
          boss_korean_name: string | null
          crystal_price_meso: number | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          difficulty: Database["public"]["Enums"]["boss_difficulty_tier"] | null
          entry_level: number | null
          generation: Database["public"]["Enums"]["boss_generation"] | null
          korean_name: string | null
          max_party: number | null
          nexon_content_name: string | null
          nexon_difficulty: string | null
          price_effective_from: string | null
          price_patch_label: string | null
          released: boolean | null
          sort_order: number | null
        }
        Relationships: []
      }
      v_boss_nexon_mapping_health: {
        Row: {
          boss_id: string | null
          difficulty_count: number | null
          korean_name: string | null
          nexon_content_name: string | null
          nexon_name_verified: boolean | null
          released_count: number | null
        }
        Relationships: []
      }
      v_character_boss_plan_status: {
        Row: {
          api_observed_at: string | null
          api_registered: boolean | null
          boss_difficulty_id: string | null
          boss_display_name: string | null
          boss_id: string | null
          boss_sort_order: number | null
          character_id: string | null
          character_name: string | null
          clear_has_conflict: boolean | null
          clear_id: string | null
          cleared_at: string | null
          counts_toward_weekly_limit: boolean | null
          created_at: string | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          default_party_size: number | null
          difficulty: Database["public"]["Enums"]["boss_difficulty_tier"] | null
          difficulty_sort_order: number | null
          has_conflict: boolean | null
          is_active: boolean | null
          is_cleared: boolean | null
          manual_active: boolean | null
          max_party: number | null
          note: string | null
          origin: string | null
          plan_id: string | null
          released: boolean | null
          updated_at: string | null
          user_id: string | null
          week_key: string | null
          world_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_difficulties_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "bosses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_difficulties_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_id"]
          },
          {
            foreignKeyName: "boss_difficulties_boss_id_fkey"
            columns: ["boss_id"]
            isOneToOne: false
            referencedRelation: "v_boss_nexon_mapping_health"
            referencedColumns: ["boss_id"]
          },
          {
            foreignKeyName: "character_boss_plans_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_boss_plans_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "character_boss_plans_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "character_boss_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_character_sync_source: {
        Row: {
          allow_server_side_use: boolean | null
          character_id: string | null
          character_name: string | null
          credential_id: string | null
          credential_is_primary: boolean | null
          credential_label: string | null
          is_main: boolean | null
          nexon_account_id: string | null
          nexon_account_ref: string | null
          ocid: string | null
          sync_state: Database["public"]["Enums"]["character_sync_state"] | null
          user_id: string | null
          world_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "characters_nexon_account_ref_fkey"
            columns: ["nexon_account_ref"]
            isOneToOne: false
            referencedRelation: "user_nexon_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "characters_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_character_weekly_boss_progress: {
        Row: {
          character_id: string | null
          character_name: string | null
          cleared_total: number | null
          cleared_weekly: number | null
          cleared_weekly_exempt: number | null
          conflict_count: number | null
          inactive_total: number | null
          planned_daily: number | null
          planned_monthly: number | null
          planned_total: number | null
          planned_weekly: number | null
          planned_weekly_exempt: number | null
          remaining_total: number | null
          remaining_weekly: number | null
          user_id: string | null
          week_key: string | null
          weekly_limit: number | null
          weekly_over_limit: boolean | null
          weekly_slots_remaining: number | null
          world_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "character_boss_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_monthly_crystal_income: {
        Row: {
          clear_count: number | null
          income_meso: number | null
          month_key: string | null
          unknown_price_count: number | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_nexon_sync_plan: {
        Row: {
          calls_remaining: number | null
          calls_used_today: number | null
          credential_id: string | null
          credential_label: string | null
          daily_budget: number | null
          day_key: string | null
          full_sync_fits: boolean | null
          total_character_count: number | null
          tracked_character_count: number | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "characters_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_nexon_unmapped_open: {
        Row: {
          content_name: string | null
          cycle: string | null
          difficulty: string | null
          first_seen_at: string | null
          last_seen_at: string | null
          seen_count: number | null
        }
        Insert: {
          content_name?: string | null
          cycle?: string | null
          difficulty?: string | null
          first_seen_at?: string | null
          last_seen_at?: string | null
          seen_count?: number | null
        }
        Update: {
          content_name?: string | null
          cycle?: string | null
          difficulty?: string | null
          first_seen_at?: string | null
          last_seen_at?: string | null
          seen_count?: number | null
        }
        Relationships: []
      }
      v_public_party_board: {
        Row: {
          created_at: string | null
          default_capacity: number | null
          description: string | null
          id: string | null
          member_count: number | null
          name: string | null
          share_slug: string | null
          updated_at: string | null
          world_name: string | null
        }
        Relationships: []
      }
      v_public_party_runs: {
        Row: {
          boss_difficulty_id: string | null
          boss_display_name: string | null
          boss_korean_name: string | null
          capacity: number | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          difficulty: Database["public"]["Enums"]["boss_difficulty_tier"] | null
          duration_minutes: number | null
          entry_party_size: number | null
          going_count: number | null
          max_party: number | null
          maybe_count: number | null
          party_id: string | null
          party_name: string | null
          run_id: string | null
          scheduled_at: string | null
          share_slug: string | null
          status: Database["public"]["Enums"]["run_status"] | null
          week_key: string | null
        }
        Relationships: []
      }
      v_run_crystal_settlement: {
        Row: {
          amount_meso: number | null
          display_name: string | null
          member_no: number | null
          participant_id: string | null
          party_size: number | null
          pot_meso: number | null
          run_id: string | null
          share_bp: number | null
          user_id: string | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "party_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_run_drop_recipients: {
        Row: {
          drop_id: string | null
          participant_id: string | null
          weight: number | null
        }
        Relationships: []
      }
      v_run_drop_settlement: {
        Row: {
          amount_meso: number | null
          display_name: string | null
          drop_id: string | null
          item_name: string | null
          member_no: number | null
          participant_id: string | null
          run_id: string | null
          sale_amount_meso: number | null
          share_mode: Database["public"]["Enums"]["drop_share_mode"] | null
          user_id: string | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_drops_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_drops_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "run_drops_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
        ]
      }
      v_run_participation: {
        Row: {
          boss_difficulty_id: string | null
          capacity: number | null
          declined_count: number | null
          going_count: number | null
          is_full: boolean | null
          maybe_count: number | null
          party_id: string | null
          run_id: string | null
          scheduled_at: string | null
          status: Database["public"]["Enums"]["run_status"] | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_runs_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "party_runs_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "party_runs_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_runs_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["party_id"]
          },
        ]
      }
      v_run_share_weights: {
        Row: {
          display_name: string | null
          guest_id: string | null
          member_no: number | null
          participant_id: string | null
          run_id: string | null
          share_bp: number | null
          user_id: string | null
          weight: number | null
        }
        Relationships: [
          {
            foreignKeyName: "party_participants_guest_fk"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "party_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_signups_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "party_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_signups_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_signups_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "run_signups_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
        ]
      }
      v_user_weekly_boss_progress: {
        Row: {
          character_count: number | null
          cleared_total: number | null
          cleared_weekly: number | null
          conflict_count: number | null
          inactive_total: number | null
          over_limit_character_count: number | null
          planned_daily: number | null
          planned_monthly: number | null
          planned_total: number | null
          planned_weekly: number | null
          remaining_total: number | null
          remaining_weekly: number | null
          user_id: string | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "character_boss_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_crystal_income: {
        Row: {
          character_count: number | null
          clear_count: number | null
          daily_clear_count: number | null
          daily_income_meso: number | null
          income_meso: number | null
          monthly_clear_count: number | null
          monthly_income_meso: number | null
          monthly_unknown_price_count: number | null
          season_clear_count: number | null
          season_income_meso: number | null
          season_unknown_price_count: number | null
          unknown_price_count: number | null
          user_id: string | null
          week_key: string | null
          weekly_clear_count: number | null
          weekly_income_meso: number | null
          weekly_over_limit_count: number | null
          weekly_unknown_price_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_crystal_income_by_character: {
        Row: {
          character_id: string | null
          clear_count: number | null
          daily_clear_count: number | null
          income_meso: number | null
          monthly_clear_count: number | null
          season_clear_count: number | null
          unknown_price_count: number | null
          user_id: string | null
          week_key: string | null
          weekly_clear_count: number | null
          weekly_over_limit_count: number | null
          weekly_sell_limit: number | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_crystal_income_by_character_cycle: {
        Row: {
          character_id: string | null
          clear_count: number | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          income_meso: number | null
          over_limit_count: number | null
          season_clear_count: number | null
          season_income_meso: number | null
          season_unknown_price_count: number | null
          unknown_price_count: number | null
          user_id: string | null
          week_key: string | null
          weekly_sell_limit: number | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_crystal_pending: {
        Row: {
          boss_difficulty_id: string | null
          boss_display_name: string | null
          character_id: string | null
          clear_id: string | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          has_conflict: boolean | null
          max_party: number | null
          run_id: string | null
          scheduled_at: string | null
          user_id: string | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "boss_difficulties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_boss_catalog"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "boss_clears_boss_difficulty_id_fkey"
            columns: ["boss_difficulty_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["boss_difficulty_id"]
          },
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "party_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_public_party_runs"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "boss_clears_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "v_run_participation"
            referencedColumns: ["run_id"]
          },
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_crystal_world_usage: {
        Row: {
          crystal_count: number | null
          daily_crystal_count: number | null
          monthly_crystal_count: number | null
          over_limit: boolean | null
          remaining_slots: number | null
          season_crystal_count: number | null
          user_id: string | null
          week_key: string | null
          weekly_crystal_count: number | null
          world_name: string | null
          world_sell_limit: number | null
        }
        Relationships: [
          {
            foreignKeyName: "boss_clears_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_drop_income: {
        Row: {
          drop_count: number | null
          drop_income_meso: number | null
          drop_share_count: number | null
          user_id: string | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_income: {
        Row: {
          clear_count: number | null
          crystal_income_meso: number | null
          daily_crystal_income_meso: number | null
          drop_count: number | null
          drop_income_meso: number | null
          monthly_clear_count: number | null
          monthly_crystal_income_meso: number | null
          monthly_unknown_price_count: number | null
          total_income_meso: number | null
          unknown_price_count: number | null
          unsold_drop_count: number | null
          user_id: string | null
          week_key: string | null
          weekly_clear_count: number | null
          weekly_crystal_income_meso: number | null
          weekly_over_limit_count: number | null
          weekly_unknown_price_count: number | null
        }
        Relationships: []
      }
      v_weekly_plan_potential: {
        Row: {
          character_count: number | null
          counted_count: number | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          over_limit_count: number | null
          planned_count: number | null
          potential_meso: number | null
          unknown_price_count: number | null
          user_id: string | null
          weekly_sell_limit: number | null
        }
        Relationships: [
          {
            foreignKeyName: "character_boss_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_plan_potential_by_character: {
        Row: {
          character_id: string | null
          counted_count: number | null
          cycle: Database["public"]["Enums"]["boss_cycle"] | null
          over_limit_count: number | null
          planned_count: number | null
          potential_meso: number | null
          unknown_price_count: number | null
          user_id: string | null
          weekly_sell_limit: number | null
        }
        Relationships: [
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_boss_plans_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "v_character_sync_source"
            referencedColumns: ["character_id"]
          },
          {
            foreignKeyName: "character_boss_plans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      v_weekly_unsold_drops: {
        Row: {
          unsold_drop_count: number | null
          user_id: string | null
          week_key: string | null
        }
        Relationships: [
          {
            foreignKeyName: "party_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      apply_plan_party_sizes_to_clears: {
        Args: { p_character_id: string; p_dry_run?: boolean }
        Returns: number
      }
      assert_no_public_sensitive_columns: { Args: never; Returns: undefined }
      assign_party_number: {
        Args: { p_party_id: string; p_week_key: string }
        Returns: number
      }
      attach_nexon_credential: {
        Args: {
          p_api_key_hash: string
          p_label?: string
          p_make_primary?: boolean
          p_user_id: string
        }
        Returns: string
      }
      availability_board: {
        Args: {
          p_exclude_run_id?: string
          p_from: string
          p_min_count?: number
          p_person_ids: string[]
          p_to: string
          p_viewer_user_id: string
        }
        Returns: Json
      }
      availability_overlap: {
        Args: {
          p_exclude_run_id?: string
          p_from: string
          p_min_count?: number
          p_person_ids: string[]
          p_to: string
        }
        Returns: {
          available_count: number
          person_ids: string[]
          window_end: string
          window_start: string
        }[]
      }
      bot_direct_notify_pending: { Args: { p_now?: string }; Returns: boolean }
      bot_direct_notify_targets: {
        Args: { p_now?: string }
        Returns: {
          channel_id: string
          digest: boolean
          imminent: boolean
          room: string
          user_id: string
        }[]
      }
      bot_notify_tick_minutes: { Args: never; Returns: number }
      can_view_availability: {
        Args: { p_person_id: string; p_viewer_user_id: string }
        Returns: boolean
      }
      can_view_character_plans: {
        Args: { p_character_id: string; p_viewer_user_id: string }
        Returns: boolean
      }
      character_is_syncable: {
        Args: { p_account_ref: string; p_user_id: string }
        Returns: boolean
      }
      claim_guest_profile: {
        Args: { p_guest_id: string; p_user_id: string }
        Returns: {
          merged_participants: number
          moved_participants: number
        }[]
      }
      current_app_user_id: { Args: never; Returns: string }
      current_crystal_price: {
        Args: { p_at?: string; p_boss_difficulty_id: string }
        Returns: {
          price_id: string
          price_meso: number
        }[]
      }
      day_key: { Args: { ts: string }; Returns: string }
      day_start: { Args: { ts: string }; Returns: string }
      distribute_meso: {
        Args: { p_keys: string[]; p_total: number; p_weights: number[] }
        Returns: {
          amount: number
          key: string
          weight: number
        }[]
      }
      enqueue_due_reminders: {
        Args: { p_channel_id?: string; p_now?: string }
        Returns: number
      }
      enqueue_run_notice: {
        Args: { p_kind?: string; p_now?: string; p_run_id: string }
        Returns: number
      }
      format_kst_when: {
        Args: { p_at: string; p_ref: string }
        Returns: string
      }
      format_run_entry: {
        Args: { p_max_names?: number; p_multiline?: boolean; p_run_id: string }
        Returns: string
      }
      format_run_notice: {
        Args: {
          p_kind?: string
          p_max_names?: number
          p_now?: string
          p_offset_minutes?: number
          p_run_id: string
        }
        Returns: string
      }
      kst_date: { Args: { ts: string }; Returns: string }
      kst_moment: { Args: { d: string; minutes: number }; Returns: string }
      kst_wall_moment: {
        Args: { p_day: string; p_minutes: number }
        Returns: string
      }
      nexon_classify_content: {
        Args: {
          p_content_name: string
          p_note?: string
          p_resolution: Database["public"]["Enums"]["nexon_mapping_resolution"]
        }
        Returns: number
      }
      nexon_cycle_to_boss_cycle: {
        Args: { p_cycle: string }
        Returns: Database["public"]["Enums"]["boss_cycle"]
      }
      nexon_daily_call_budget: { Args: never; Returns: number }
      nexon_difficulty_to_tier: {
        Args: { p_difficulty: string }
        Returns: Database["public"]["Enums"]["boss_difficulty_tier"]
      }
      nexon_flag_to_boolean: { Args: { p_flag: string }; Returns: boolean }
      nexon_record_unmapped_content: {
        Args: {
          p_content_name: string
          p_cycle?: string
          p_difficulty?: string
        }
        Returns: string
      }
      nexon_resolve_boss_difficulties: {
        Args: { p_entries: Json }
        Returns: {
          boss_difficulty_id: string
          idx: number
        }[]
      }
      nexon_resolve_boss_difficulty: {
        Args: { p_content_name: string; p_cycle?: string; p_difficulty: string }
        Returns: string
      }
      next_week_reset: { Args: { ts: string }; Returns: string }
      participant_label: {
        Args: {
          p_character_name: string
          p_display_name: string
          p_is_guest: boolean
          p_is_main: boolean
        }
        Returns: string
      }
      party_notify_channel_ids: {
        Args: { p_party_id: string }
        Returns: string[]
      }
      person_run_commitments: {
        Args: {
          p_exclude_run_id?: string
          p_from: string
          p_person_ids: string[]
          p_to: string
        }
        Returns: {
          boss_difficulty_id: string
          ends_at: string
          party_id: string
          person_id: string
          run_id: string
          short_name: string
          starts_at: string
        }[]
      }
      rebalance_run_shares: { Args: { p_run_id: string }; Returns: number }
      recompute_run_crystal_shares: {
        Args: { p_run_id: string }
        Returns: number
      }
      resolve_availability: {
        Args: { p_from: string; p_person_ids: string[]; p_to: string }
        Returns: {
          ends_at: string
          person_id: string
          starts_at: string
        }[]
      }
      resolve_crystal_payout: {
        Args: {
          p_party_size: number
          p_pot: number
          p_run_id: string
          p_user_id: string
        }
        Returns: {
          amount: number
          share_bp: number
        }[]
      }
      resolve_login_by_key_hash: {
        Args: { p_api_key_hash: string }
        Returns: {
          account_status: Database["public"]["Enums"]["account_status"]
          credential_id: string
          credential_label: string
          is_invalidated: boolean
          is_primary: boolean
          main_character_name: string
          main_world_name: string
          user_id: string
        }[]
      }
      run_participant_names: {
        Args: { p_max_names?: number; p_run_id: string }
        Returns: string
      }
      set_character_boss_plan: {
        Args: {
          p_active: boolean
          p_boss_difficulty_id: string
          p_character_id: string
        }
        Returns: string
      }
      set_character_boss_plan_party_size: {
        Args: {
          p_boss_difficulty_id: string
          p_character_id: string
          p_party_size: number
        }
        Returns: string
      }
      set_clear_party_size: {
        Args: { p_clear_id: string; p_party_size: number }
        Returns: undefined
      }
      set_party_bosses: {
        Args: { p_boss_difficulty_ids: string[]; p_party_id: string }
        Returns: {
          boss_difficulty_id: string
          created_at: string
          id: string
          party_id: string
          sort_order: number
        }[]
        SetofOptions: {
          from: "*"
          to: "party_bosses"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_run_shares: {
        Args: {
          p_participant_ids: string[]
          p_run_id: string
          p_share_bps: number[]
        }
        Returns: number
      }
      sync_character_boss_plan: {
        Args: {
          p_boss_difficulty_id: string
          p_character_id: string
          p_observed_at?: string
          p_registration_flag: string
        }
        Returns: string
      }
      sync_character_boss_plans: {
        Args: {
          p_character_id: string
          p_entries: Json
          p_observed_at?: string
        }
        Returns: number
      }
      trigger_bot_notify: { Args: { p_now?: string }; Returns: number }
      trigger_web_sync: { Args: { p_slot?: string }; Returns: number }
      user_week_runs: {
        Args: { p_user_id: string; p_week_key: string }
        Returns: {
          character_name: string
          duration_minutes: number
          party_id: string
          party_no: number
          run_id: string
          scheduled_at: string
          short_name: string
        }[]
      }
      valid_digest_minutes: { Args: { p_minutes: number[] }; Returns: boolean }
      valid_reminder_minutes: {
        Args: { p_minutes: number[] }
        Returns: boolean
      }
      week_key: { Args: { ts: string }; Returns: string }
      week_start: { Args: { ts: string }; Returns: string }
      weekly_crystal_sell_limit: { Args: never; Returns: number }
      world_crystal_sell_limit: { Args: never; Returns: number }
    }
    Enums: {
      account_status: "active" | "suspended" | "deleted"
      availability_mode: "weekly" | "shift"
      boss_cycle: "daily" | "weekly" | "monthly" | "season"
      boss_difficulty_tier: "easy" | "normal" | "chaos" | "hard" | "extreme"
      boss_generation: "classic" | "modern" | "event"
      bot_channel_kind: "party_room" | "direct"
      bot_channel_status: "active" | "degraded" | "paused"
      bot_link_code_kind: "channel_pair" | "member_link" | "direct_pair"
      bot_outbox_state: "pending" | "delivering" | "sent" | "failed" | "expired"
      character_sync_state: "syncable" | "no_valid_key"
      chore_scope: "daily" | "weekly"
      clear_source: "manual" | "nexon_api" | "bot"
      drop_share_mode: "party_default" | "custom" | "solo"
      friendship_status: "pending" | "accepted" | "blocked"
      nexon_mapping_resolution:
        | "unknown"
        | "intentionally_excluded"
        | "pending_release"
      party_member_role: "owner" | "organizer" | "member"
      party_visibility: "private" | "link" | "public"
      run_share_mode: "auto_equal" | "manual"
      run_status: "proposed" | "confirmed" | "done" | "cancelled"
      signup_status: "going" | "maybe" | "declined"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: ["active", "suspended", "deleted"],
      availability_mode: ["weekly", "shift"],
      boss_cycle: ["daily", "weekly", "monthly", "season"],
      boss_difficulty_tier: ["easy", "normal", "chaos", "hard", "extreme"],
      boss_generation: ["classic", "modern", "event"],
      bot_channel_kind: ["party_room", "direct"],
      bot_channel_status: ["active", "degraded", "paused"],
      bot_link_code_kind: ["channel_pair", "member_link", "direct_pair"],
      bot_outbox_state: ["pending", "delivering", "sent", "failed", "expired"],
      character_sync_state: ["syncable", "no_valid_key"],
      chore_scope: ["daily", "weekly"],
      clear_source: ["manual", "nexon_api", "bot"],
      drop_share_mode: ["party_default", "custom", "solo"],
      friendship_status: ["pending", "accepted", "blocked"],
      nexon_mapping_resolution: [
        "unknown",
        "intentionally_excluded",
        "pending_release",
      ],
      party_member_role: ["owner", "organizer", "member"],
      party_visibility: ["private", "link", "public"],
      run_share_mode: ["auto_equal", "manual"],
      run_status: ["proposed", "confirmed", "done", "cancelled"],
      signup_status: ["going", "maybe", "declined"],
    },
  },
} as const
