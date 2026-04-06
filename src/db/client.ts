import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/index.js'
import { logger } from '../lib/logger.js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  throw new Error(
    'Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set'
  )
}

export const supabase = createClient<Database>(url, key, {
  auth: { persistSession: false },
})

logger.info('[db/client] Supabase client initialized')
