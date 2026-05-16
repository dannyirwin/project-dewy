import "dotenv/config";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV1 } from "ai";

// ---------------------------------------------------------------
// Resolve a LanguageModel from env. The rest of the codebase
// never touches a provider SDK directly — it just imports model().
//
// To change providers in prod: change LLM_PROVIDER / LLM_MODEL.
// Same agent code, same prompts, same tool definitions.
// ---------------------------------------------------------------

export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

export function providerKind(): ProviderKind {
  const p = (process.env.LLM_PROVIDER ?? "anthropic") as ProviderKind;
  if (!["anthropic", "openai", "openai-compatible"].includes(p)) {
    throw new Error(`Unknown LLM_PROVIDER: ${p}`);
  }
  return p;
}

export function modelId(): string {
  const id = process.env.LLM_MODEL;
  if (!id) throw new Error("LLM_MODEL is required");
  return id;
}

export function model(): LanguageModelV1 {
  const kind = providerKind();
  const id = modelId();

  switch (kind) {
    case "anthropic": {
      const client = createAnthropic({
        apiKey: required("ANTHROPIC_API_KEY"),
      });
      return client(id);
    }
    case "openai": {
      const client = createOpenAI({
        apiKey: required("OPENAI_API_KEY"),
      });
      return client(id);
    }
    case "openai-compatible": {
      // Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, etc.
      const client = createOpenAICompatible({
        name: "compat",
        baseURL: required("LLM_BASE_URL"),
        apiKey: process.env.LLM_API_KEY,
      });
      return client(id);
    }
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}
