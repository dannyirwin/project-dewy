import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config/index.js";
import { StructuredOutputError } from "../src/providers/interfaces.js";
import { LmStudioChatProvider } from "../src/providers/lmstudio.js";

/** Stub the underlying OpenAI client so retry behavior is testable offline. */
function stubCompletions(provider: LmStudioChatProvider, replies: string[]) {
  let call = 0;
  const requests: unknown[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  (provider as any).client = {
    chat: {
      completions: {
        create: async (req: unknown) => {
          requests.push(req);
          const content = replies[Math.min(call, replies.length - 1)];
          call++;
          return { choices: [{ message: { content, tool_calls: [] } }] };
        },
      },
    },
  };
  return requests;
}

const schema = z.object({ name: z.string(), count: z.number() }).strict();

describe("structured output enforcement (Phase 2)", () => {
  it("parses valid JSON on first attempt", async () => {
    const provider = new LmStudioChatProvider(loadConfig({}));
    stubCompletions(provider, ['{"name":"ok","count":2}']);
    const res = await provider.complete({ messages: [{ role: "user", content: "go" }], schema });
    expect(res.parsed).toEqual({ name: "ok", count: 2 });
  });

  it("retries with a corrective message on invalid output, then succeeds", async () => {
    const provider = new LmStudioChatProvider(loadConfig({ STRUCTURED_OUTPUT_MAX_RETRIES: "3" }));
    const requests = stubCompletions(provider, [
      "definitely not json",
      '{"name":"ok"}', // missing count → schema failure
      'Here you go:\n```json\n{"name":"ok","count":7}\n```', // fenced → extracted
    ]);
    const res = await provider.complete({ messages: [{ role: "user", content: "go" }], schema });
    expect(res.parsed).toEqual({ name: "ok", count: 7 });
    expect(requests).toHaveLength(3);
    // corrective message appended on retries
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    const lastReq = requests[2] as any;
    expect(JSON.stringify(lastReq.messages)).toMatch(/not valid JSON/);
  });

  it("throws StructuredOutputError after exhausting the bounded retries", async () => {
    const provider = new LmStudioChatProvider(loadConfig({ STRUCTURED_OUTPUT_MAX_RETRIES: "2" }));
    const requests = stubCompletions(provider, ["nope"]);
    await expect(
      provider.complete({ messages: [{ role: "user", content: "go" }], schema }),
    ).rejects.toThrow(StructuredOutputError);
    expect(requests).toHaveLength(3); // 1 + 2 retries, bounded
  });
});
