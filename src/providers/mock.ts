import type {
  ChatCompleteArgs,
  ChatProvider,
  ChatResult,
  EmbeddingProvider,
  EmbeddingResult,
  ToolCall,
} from "./interfaces.js";

/**
 * Test doubles behind the provider interfaces (plan §3: LLM calls are mocked in
 * unit tests behind the provider interface — no live LLM required).
 */

export type ScriptedTurn =
  | { kind: "parsed"; value: unknown }
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; calls: Array<Omit<ToolCall, "id"> & { id?: string }> }
  | {
      kind: "fn";
      fn: (args: ChatCompleteArgs<unknown>) => ScriptedTurn | Promise<ScriptedTurn>;
    };

export class MockChatProvider implements ChatProvider {
  public calls: ChatCompleteArgs<unknown>[] = [];
  private queue: ScriptedTurn[];
  private counter = 0;

  constructor(turns: ScriptedTurn[] = []) {
    this.queue = [...turns];
  }

  push(turn: ScriptedTurn): void {
    this.queue.push(turn);
  }

  async complete<T = unknown>(args: ChatCompleteArgs<T>): Promise<ChatResult<T>> {
    this.calls.push(args as ChatCompleteArgs<unknown>);
    let turn = this.queue.shift();
    if (!turn) throw new Error("MockChatProvider: no scripted turn left");
    while (turn.kind === "fn") {
      turn = await turn.fn(args as ChatCompleteArgs<unknown>);
    }
    if (turn.kind === "parsed") {
      const parsed = args.schema ? args.schema.parse(turn.value) : (turn.value as T);
      return { parsed, text: JSON.stringify(turn.value), toolCalls: [] };
    }
    if (turn.kind === "tool_calls") {
      return {
        text: "",
        toolCalls: turn.calls.map((c, i) => ({
          id: c.id ?? `call_${++this.counter}_${i}`,
          name: c.name,
          arguments: c.arguments,
        })),
      };
    }
    return { text: turn.text, toolCalls: [] };
  }
}

/**
 * Deterministic fake embeddings: a stable hash of character n-grams projected
 * into `dimension` buckets. Similar texts → similar vectors, so similarity
 * search behaves sensibly in tests without a model.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private dimension = 64,
    private model = "fake-embedding-v1",
  ) {}

  private vectorFor(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    const norm = text.toLowerCase().replace(/\s+/g, " ");
    for (let i = 0; i < norm.length - 2; i++) {
      const tri = norm.slice(i, i + 3);
      let h = 2166136261;
      for (const ch of tri) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dimension;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / mag);
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((t) => this.vectorFor(t)),
      model: this.model,
      dimension: this.dimension,
    };
  }
}
