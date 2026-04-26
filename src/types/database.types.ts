export type Database = {
  public: {
    Tables: {
      sch_users: {
        Row: {
          id: string
          telegram_id: number
          timezone: string
          morning_time: string
          end_of_day_time: string
          google_access_token: string | null
          google_refresh_token: string | null
          google_token_expiry: string | null
          solo_leveling_token: string | null
          created_at: string
        }
        Insert: {
          id?: string
          telegram_id: number
          timezone?: string
          morning_time?: string
          end_of_day_time?: string
          google_access_token?: string | null
          google_refresh_token?: string | null
          google_token_expiry?: string | null
          solo_leveling_token?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          telegram_id?: number
          timezone?: string
          morning_time?: string
          end_of_day_time?: string
          google_access_token?: string | null
          google_refresh_token?: string | null
          google_token_expiry?: string | null
          solo_leveling_token?: string | null
          created_at?: string
        }
        Relationships: []
      }
      sch_periods: {
        Row: {
          id: string
          user_id: string
          name: string
          slug: string
          queue_slug: string
          start_time: string
          end_time: string
          days_of_week: number[]
          order_index: number
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          slug: string
          queue_slug?: string
          start_time: string
          end_time: string
          days_of_week: number[]
          order_index?: number
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          slug?: string
          queue_slug?: string
          start_time?: string
          end_time?: string
          days_of_week?: number[]
          order_index?: number
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'sch_periods_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'sch_users'
            referencedColumns: ['id']
          }
        ]
      }
      sch_chat_history: {
        Row: {
          id: string
          user_id: string
          role: 'user' | 'assistant'
          content: string
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          role: 'user' | 'assistant'
          content: string
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          role?: 'user' | 'assistant'
          content?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'sch_chat_history_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'sch_users'
            referencedColumns: ['id']
          }
        ]
      }
      sch_tasks: {
        Row: {
          id: string
          user_id: string
          period_slug: string | null
          title: string
          description: string | null
          is_urgent: boolean
          is_overflow: boolean
          deadline_date: string | null
          estimated_minutes: number | null
          status: 'pending' | 'done' | 'cancelled'
          scheduled_date: string | null
          source: 'user' | 'external' | 'generated'
          external_id: string | null
          progress_note: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          period_slug?: string | null
          title: string
          description?: string | null
          is_urgent?: boolean
          is_overflow?: boolean
          deadline_date?: string | null
          estimated_minutes?: number | null
          status?: 'pending' | 'done' | 'cancelled'
          scheduled_date?: string | null
          source?: 'user' | 'external' | 'generated'
          external_id?: string | null
          progress_note?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          period_slug?: string | null
          title?: string
          description?: string | null
          is_urgent?: boolean
          is_overflow?: boolean
          deadline_date?: string | null
          estimated_minutes?: number | null
          status?: 'pending' | 'done' | 'cancelled'
          scheduled_date?: string | null
          source?: 'user' | 'external' | 'generated'
          external_id?: string | null
          progress_note?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'sch_tasks_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'sch_users'
            referencedColumns: ['id']
          }
        ]
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}
