import "../src/load-env.js";
import { loadConfig } from "../src/config/index.js";
import { getSupabaseClient } from "../src/db/client.js";
import { defaultKbConfig } from "../src/kb/index.js";
import { buildPipeline } from "../src/pipeline/index.js";
import { LmStudioChatProvider, LmStudioEmbeddingProvider } from "../src/providers/lmstudio.js";
import { createSupabaseRepositories } from "../src/repositories/supabase/index.js";

/**
 * Seed a demo knowledge base against the live stack (requires `supabase start`
 * and LM Studio running — see README).
 */
const cfg = loadConfig();
const repos = createSupabaseRepositories(getSupabaseClient());
const pipeline = buildPipeline({
  repos,
  chat: new LmStudioChatProvider(cfg),
  embeddings: new LmStudioEmbeddingProvider(cfg),
  cfg,
});

const kb = await pipeline.kbService.createKnowledgeBase({
  name: "Campaign Notes",
  slug: "campaign-notes",
  config: defaultKbConfig(),
});
console.log(`created KB ${kb.id} (${kb.slug})`);

const job = await pipeline.ingest(kb.id, {
  raw_text:
    "Thornwick is a fortified river town ruled by Mayor Aldra Venn. " +
    "The Gilded Anchor is the main tavern in Thornwick, run by a retired sailor named Bosun Pike. " +
    "Aldra Venn secretly owes money to the Ironmongers Guild.",
  metadata: {},
  storage_ref: null,
});
console.log(`ingestion job ${job.id} created — advancing…`);
const result = await pipeline.machine.runToCompletion(job.id);
console.log(`job finished in state: ${result.state}`);
