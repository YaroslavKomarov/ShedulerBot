export type { Database } from './database.types.js'
import type { Database } from './database.types.js'

export type DbUser = Database['public']['Tables']['sch_users']['Row']
export type DbUserInsert = Database['public']['Tables']['sch_users']['Insert']
export type DbUserUpdate = Database['public']['Tables']['sch_users']['Update']

export type DbPeriod = Database['public']['Tables']['sch_periods']['Row']
export type DbPeriodInsert = Database['public']['Tables']['sch_periods']['Insert']

export type DbTask = Database['public']['Tables']['sch_tasks']['Row']
export type DbTaskInsert = Database['public']['Tables']['sch_tasks']['Insert']
export type DbTaskUpdate = Database['public']['Tables']['sch_tasks']['Update']
