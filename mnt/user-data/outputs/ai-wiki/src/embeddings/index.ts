import "dotenv/config";
import { embed as aiEmbed, embedMany as aiEmbedMany, type EmbeddingModelV1 } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// ---------------------------------------------------------------
// Embeddings are *not* freely swappable like LLMs.
//
// Each provider produces vectors in its own space with its own
// dimension. You cannot mix them in one pgvector column. So:
//   - Pick one embedding provider and model.
//   - If you ever change it, re-embed everything and update
//     vector(N) in sql/schema.sql.
//
// The code here is still provider-aware so you can choose at
// project start without editing source files.
// ---------------------------------------------------------------

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1536);
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER ?? "openai") as
  | "openai"
  | "openai-compatible";

function embeddingModel(): EmbeddingModelV1<string> {
  switch (EMBEDDING_PROVIDER) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireEnv("OPENAI_API_KEY"),
      });
      return client.embedding(EMBEDDING_MODEL);
    }
    case "openai-compatible": {
      const client = createOpenAICompatible({
        name: "compat-embed",
        baseURL: requireEnv("EMBEDDING_BASE_URL"),
        apiKey: process.env.EMBEDDING_API_KEY,
      });
      return client.textEmbeddingModel(EMBEDDING_MODEL);
    }
  }
}

export async function embed(text: string): Promise<number[]> {
  const { embedding } = await aiEmbed({ model: embeddingModel(), value: text });
  assertDim(embedding);
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await aiEmbedMany({
    model: embeddingModel(),
    values: texts,
  });
  for (const e of embeddings) assertDim(e);
  return embeddings;
}

function assertDim(v: number[]) {
  if (v.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: got ${v.length}, expected ${EMBEDDING_DIM}. ` +
        `Update EMBEDDING_DIM in .env and vector(N) in sql/schema.sql.`,
    );
  }
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}
