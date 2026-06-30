import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { logger } from "../logging/index.js";
import {
  type ChatCompleteArgs,
  type ChatMessage,
  type ChatProvider,
  type ChatResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  StructuredOutputError,
  type ToolCall,
} from "./interfaces.js";

/**
 * LM Studio implementations (locked decision #2): the `openai` Node SDK with
 * `baseURL` pointed at the local LM Studio server and a dummy/local API key.
 * Model names come from config. This is the ONLY place `openai` is imported
 * for chat/embeddings.
 *
 * Structured output strategy: LM Studio's OpenAI-compatible server supports
 * `response_format: { type: "json_schema" }` for many models; we request it
 * and ALWAYS validate with the Zod schema afterwards, retrying on parse or
 * validation failure up to STRUCTURED_OUTPUT_MAX_RETRIES (bounded, logged).
 */

function extractJson(text: string): string {
  // Models sometimes wrap JSON in fences or prose; pull the outermost object/array.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return candidate.trim();
  // walk to the matching close
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return candidate.slice(start).trim();
}

function toOpenAiMessages(
  system: string | undefined,
  messages: ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: m.tool_call_id ?? "" });
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: m.role as "user" | "assistant" | "system", content: m.content });
    }
  }
  return out;
}

export class LmStudioChatProvider implements ChatProvider {
  private client: OpenAI;

  constructor(private cfg: AppConfig) {
    this.client = new OpenAI({ baseURL: cfg.CHAT_BASE_URL, apiKey: cfg.CHAT_API_KEY });
  }

  async complete<T = unknown>(args: ChatCompleteArgs<T>): Promise<ChatResult<T>> {
    const tools = args.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.parameters),
      },
    }));

    const maxRetries = args.schema ? this.cfg.STRUCTURED_OUTPUT_MAX_RETRIES : 0;
    let lastRaw = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const messages = toOpenAiMessages(args.system, args.messages);
      if (args.schema && attempt > 0) {
        messages.push({
          role: "user",
          content:
            "Your previous answer was not valid JSON for the required schema. " +
            "Respond with ONLY a single JSON value matching the schema — no prose, no fences.",
        });
      }

      const res = await this.client.chat.completions.create({
        model: this.cfg.CHAT_MODEL,
        messages,
        temperature: args.temperature ?? 0.2,
        ...(tools ? { tools } : {}),
        ...(args.schema
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: "structured_output",
                  schema: z.toJSONSchema(args.schema),
                },
              },
            }
          : {}),
      });

      const choice = res.choices[0];
      const text = choice?.message?.content ?? "";
      const rawToolCalls = (choice?.message?.tool_calls ?? []) as Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
      const toolCalls: ToolCall[] = rawToolCalls.flatMap((tc) => {
        if (tc.type !== "function") return [];
        let parsedArgs: unknown = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedArgs = { _raw: tc.function.arguments };
        }
        return [{ id: tc.id, name: tc.function.name, arguments: parsedArgs }];
      });

      if (!args.schema) return { text, toolCalls };
      if (toolCalls.length > 0) return { text, toolCalls }; // tool turn takes precedence

      lastRaw = text;
      try {
        const parsed = args.schema.parse(JSON.parse(extractJson(text)));
        return { parsed, text, toolCalls };
      } catch (err) {
        logger.warn("structured output failed validation; retrying", {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw new StructuredOutputError(
      `structured output failed after ${maxRetries + 1} attempts`,
      maxRetries + 1,
      lastRaw,
    );
  }
}

export class LmStudioEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;

  constructor(private cfg: AppConfig) {
    this.client = new OpenAI({ baseURL: cfg.EMBEDDING_BASE_URL, apiKey: cfg.EMBEDDING_API_KEY });
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        model: this.cfg.EMBEDDING_MODEL,
        dimension: this.cfg.EMBEDDING_DIMENSION,
      };
    }
    const res = await this.client.embeddings.create({
      model: this.cfg.EMBEDDING_MODEL,
      input: texts,
    });
    const vectors = [...res.data]
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
      .map((d: { embedding: unknown }) => d.embedding as number[]);
    const dimension = vectors[0]?.length ?? this.cfg.EMBEDDING_DIMENSION;
    if (dimension !== this.cfg.EMBEDDING_DIMENSION) {
      // Every chunk records its real model+dimension (locked decision #2), but a
      // mismatch with config is almost always a misconfigured model — fail loud.
      throw new Error(
        `embedding dimension ${dimension} != configured ${this.cfg.EMBEDDING_DIMENSION}`,
      );
    }
    return { vectors, model: this.cfg.EMBEDDING_MODEL, dimension };
  }
}
