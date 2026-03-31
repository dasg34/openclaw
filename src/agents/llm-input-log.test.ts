import { describe, expect, it } from "vitest";
import { resolveUserPath } from "../utils.js";
import { createLlmInputLog } from "./llm-input-log.js";

describe("createLlmInputLog", () => {
  it("returns null when disabled", () => {
    const log = createLlmInputLog({ env: {} });
    expect(log).toBeNull();
  });

  it("logs final outbound payloads and honors file overrides", () => {
    const lines: string[] = [];
    const log = createLlmInputLog({
      env: {
        OPENCLAW_LLM_INPUT_LOG: "1",
        OPENCLAW_LLM_INPUT_LOG_FILE: "~/.openclaw/logs/llm-input.jsonl",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    expect(log).not.toBeNull();
    expect(log?.filePath).toBe(resolveUserPath("~/.openclaw/logs/llm-input.jsonl"));

    const wrapped = log?.wrapStreamFn(((model, _context, options) => {
      expect(model.id).toBe("gpt-5.2");
      options?.onPayload?.({ input: [{ role: "user", content: "hello" }] }, model);
      return {} as never;
    }) as never);

    void wrapped?.(
      { id: "gpt-5.2", provider: "openai", api: "openai-responses" } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: "system text",
      } as never,
      { temperature: 0.2 } as never,
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.kind).toBe("llm_wire_payload");
    expect(event.payloadDigest).toBeTypeOf("string");
    expect((event.payload as { input?: unknown[] } | undefined)?.input ?? []).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("captures the payload after upstream wrappers mutate it", () => {
    const lines: string[] = [];
    const log = createLlmInputLog({
      env: {
        OPENCLAW_LLM_INPUT_LOG: "1",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const mutatingStreamFn = ((model, _context, options) => {
      const payload = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
              },
            ],
          },
        ],
      };
      (payload as Record<string, unknown>).parallel_tool_calls = true;
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as never;

    const wrapped = log?.wrapStreamFn(mutatingStreamFn);

    void wrapped?.(
      { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages" } as never,
      { messages: [] } as never,
      undefined,
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.kind).toBe("llm_wire_payload");
    expect(event.provider).toBe("anthropic");
    expect(event.modelId).toBe("claude-sonnet-4");
    expect((event.payload as Record<string, unknown>).parallel_tool_calls).toBe(true);
    const firstMessage = ((
      event.payload as { messages?: Array<Record<string, unknown>> } | undefined
    )?.messages ?? [])[0];
    const source = (((firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
  });
});
