import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveUserPath } from "../utils.js";
import { createLlmInputLog } from "./llm-input-log.js";

describe("createLlmInputLog", () => {
  it("returns null when disabled", () => {
    const log = createLlmInputLog({ env: {} });
    expect(log).toBeNull();
  });

  it("logs final outbound messages and honors file overrides", () => {
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

    const wrapped = log?.wrapStreamFn(((model, context, _options) => {
      expect(model.id).toBe("gpt-5.2");
      expect((context as { messages?: unknown[] }).messages).toHaveLength(1);
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
    expect(event.kind).toBe("llm_input");
    expect(event.messagesDigest).toBeTypeOf("string");
    expect(event.messageCount).toBe(1);
    expect(event.messageRoles).toEqual(["user"]);
    expect(event.system).toBeUndefined();
    expect(event.options).toBeUndefined();
    expect(((event.messages as Array<Record<string, unknown>> | undefined) ?? [])[0]?.content).toBe(
      "hello",
    );
  });

  it("optionally includes system and options with redaction", () => {
    const lines: string[] = [];
    const log = createLlmInputLog({
      env: {
        OPENCLAW_LLM_INPUT_LOG: "1",
        OPENCLAW_LLM_INPUT_LOG_SYSTEM: "1",
        OPENCLAW_LLM_INPUT_LOG_OPTIONS: "1",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const wrapped = log?.wrapStreamFn(((model, _context, options) => {
      expect(model.id).toBe("claude-sonnet-4");
      expect(options).toBeDefined();
      return {} as never;
    }) as never);

    void wrapped?.(
      { id: "claude-sonnet-4", provider: "anthropic", api: "anthropic-messages" } as never,
      {
        system: "be concise",
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
      } as never,
      {
        images: [{ type: "image", mimeType: "image/jpeg", data: "U0VDUkVU" }],
      } as never,
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.system).toBe("be concise");
    expect(event.systemDigest).toBe(
      crypto.createHash("sha256").update('"be concise"').digest("hex"),
    );

    const optionsImage = (
      ((event.options as { images?: unknown[] } | undefined)?.images ?? []) as Array<
        Record<string, unknown>
      >
    )[0];
    expect(optionsImage?.data).toBe("<redacted>");
    expect(optionsImage?.bytes).toBe(6);

    const firstMessage = ((event.messages as Array<Record<string, unknown>> | undefined) ?? [])[0];
    const source = (((firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
  });
});
