/**
 * Live-stack smoke test (not for CI).
 *
 * Requires:
 *   - supabase start + db push + vector index applied
 *   - LM Studio with chat + embedding models matching .env
 *   - SUPABASE_SERVICE_ROLE_KEY set (not the placeholder)
 *
 * Run: pnpm smoke:live
 */
import { loadConfig } from "../src/config/index.js";
import { getSupabaseClient } from "../src/db/client.js";
import { defaultKbConfig } from "../src/kb/index.js";
import { buildPipeline } from "../src/pipeline/index.js";
import { LmStudioChatProvider, LmStudioEmbeddingProvider } from "../src/providers/lmstudio.js";
import { createSupabaseRepositories } from "../src/repositories/supabase/index.js";

function fail(msg: string): never {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

const cfg = loadConfig();
if (!cfg.SUPABASE_SERVICE_ROLE_KEY || cfg.SUPABASE_SERVICE_ROLE_KEY === "replace-me") {
  fail("Set SUPABASE_SERVICE_ROLE_KEY (from `supabase status`) before running smoke:live");
}

const repos = createSupabaseRepositories(getSupabaseClient());
const pipeline = buildPipeline({
  repos,
  chat: new LmStudioChatProvider(cfg),
  embeddings: new LmStudioEmbeddingProvider(cfg),
  cfg,
});

const slug = `smoke-${Date.now()}`;
const kb = await pipeline.kbService.createKnowledgeBase({
  name: "Smoke Test KB",
  slug,
  config: defaultKbConfig({
    page_eligibility_rules: {
      version: 1,
      min_statements: 1,
      min_total_words: 0,
      use_llm_judgment: false,
      always_page_kinds: [],
      judgment_guidance: "",
    },
  }),
});
console.log(`created KB ${kb.id}`);

const note = "Thornwick is a river town ruled by Mayor Aldra Venn.";
const job = await pipeline.ingest(kb.id, {
  raw_text: note,
  metadata: { smoke: true },
  storage_ref: null,
});
const result = await pipeline.machine.runToCompletion(job.id);
if (result.state !== "completed") {
  fail(`ingestion ended in state ${result.state}${result.error ? `: ${result.error}` : ""}`);
}

const docs = await repos.documents.list(kb.id);
if (docs.length === 0) fail("no documents created after ingestion");
console.log(`documents: ${docs.map((d) => d.title).join(", ")}`);

const hits = await pipeline.search.search(kb.id, "who rules Thornwick", 5);
if (hits.length === 0) fail("search returned no hits");
console.log(`search top hit: ${hits[0]!.document_id} score=${hits[0]!.score.toFixed(3)}`);

console.log("PASS  live stack smoke");
