import { z } from "zod";

/**
 * Single validated config module (locked decision: no scattered process.env reads).
 * Every value has a dev-safe default so unit tests run with zero env setup;
 * production deploys override via environment.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  SUPABASE_URL: z.string().default("http://127.0.0.1:54321"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default("local-dev-key"),
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@127.0.0.1:54322/postgres"),

  CHAT_BASE_URL: z.string().default("http://127.0.0.1:1234/v1"),
  CHAT_API_KEY: z.string().default("lm-studio"),
  CHAT_MODEL: z.string().default("qwen2.5-14b-instruct"),

  EMBEDDING_BASE_URL: z.string().default("http://127.0.0.1:1234/v1"),
  EMBEDDING_API_KEY: z.string().default("lm-studio"),
  EMBEDDING_MODEL: z.string().default("text-embedding-nomic-embed-text-v1.5"),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(768),

  RECONCILIATION_STEP_BUDGET: z.coerce.number().int().positive().default(12),
  STRUCTURED_OUTPUT_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  AUTO_APPLY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  CHUNK_TARGET_TOKENS: z.coerce.number().int().positive().default(400),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).default(60),
  SEARCH_SEMANTIC_WEIGHT: z.coerce.number().min(0).default(1.0),
  SEARCH_KEYWORD_WEIGHT: z.coerce.number().min(0).default(1.0),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Lazily-loaded singleton for normal app use; tests call loadConfig() directly. */
let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
