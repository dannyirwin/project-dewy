import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";

/**
 * The only module in the codebase that imports @supabase/supabase-js
 * (locked decision #4). Everything else goes through src/repositories.
 * Enforced by the lint guard in test/architecture.test.ts.
 */
let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    const cfg = config();
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}
