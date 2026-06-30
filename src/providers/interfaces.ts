import type { ZodType } from "zod";

/**
 * Provider abstraction (locked decision: provider-swappable LLM/embeddings).
 * Business logic and pipeline code depend ONLY on these interfaces; the
 * `openai` SDK is imported solely inside the LM Studio implementation files.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** for role "assistant" carrying tool calls */
  tool_calls?: ToolCall[];
  /** for role "tool" responses */
  tool_call_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod schema for the tool arguments — doubles as validation and, later, as
   *  an Agents-SDK function tool definition (locked decision #1). */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool arg schemas
  parameters: ZodType<any>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatResult<T = unknown> {
  /** Present when a `schema` was supplied and the output validated. */
  parsed?: T;
  /** Raw assistant text (may be empty when only tool calls were emitted). */
  text: string;
  /** Tool calls the model wants to make (only when `tools` were supplied). */
  toolCalls: ToolCall[];
}

export interface ChatCompleteArgs<T> {
  system?: string;
  messages: ChatMessage[];
  /** When present, the provider must return output that validates against this
   *  schema (structured-output mode if available, else prompt+parse+retry). */
  schema?: ZodType<T>;
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface ChatProvider {
  complete<T = unknown>(args: ChatCompleteArgs<T>): Promise<ChatResult<T>>;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimension: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastRaw: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
