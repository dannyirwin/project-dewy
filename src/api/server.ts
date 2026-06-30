import "../load-env.js";
import { serve } from "@hono/node-server";
import { config } from "../config/index.js";
import { getSupabaseClient } from "../db/client.js";
import { JobRunner } from "../jobs/runner.js";
import { logger } from "../logging/index.js";
import { buildPipeline } from "../pipeline/index.js";
import { LmStudioChatProvider, LmStudioEmbeddingProvider } from "../providers/lmstudio.js";
import { createSupabaseRepositories } from "../repositories/supabase/index.js";
import { createApp } from "./app.js";

/**
 * Production entrypoint: Supabase repositories + LM Studio providers.
 * (Tests build the same app with in-memory repos + mocks — see test/api.test.ts.)
 */
const cfg = config();
const repos = createSupabaseRepositories(getSupabaseClient());
const chat = new LmStudioChatProvider(cfg);
const embeddings = new LmStudioEmbeddingProvider(cfg);
const pipeline = buildPipeline({ repos, chat, embeddings, cfg });
const runner = new JobRunner(repos, pipeline, 2000);

const app = createApp({
  repos,
  pipeline,
  runner,
  auth: { mcpToken: cfg.MCP_TOKEN, apiToken: cfg.API_TOKEN },
});

runner.start();
serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  logger.info("kms api listening", { port: info.port });
});
