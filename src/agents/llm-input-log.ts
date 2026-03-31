import type { StreamFn } from "@mariozechner/pi-agent-core";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { redactImageDataForDiagnostics } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import { buildAgentTraceBase } from "./trace-base.js";
import { digestTraceValue } from "./trace-message-summary.js";

export type LlmInputLogEvent = {
  ts: string;
  seq: number;
  kind: "llm_wire_payload";
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  model?: Record<string, unknown>;
  payload: unknown;
  payloadDigest: string;
};

export type LlmInputLog = {
  enabled: true;
  filePath: string;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

type LlmInputLogInit = {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
};

type LlmInputLogConfig = {
  enabled: boolean;
  filePath: string;
};

const writers = new Map<string, QueuedFileWriter>();

function resolveLlmInputLogConfig(params: LlmInputLogInit): LlmInputLogConfig {
  const env = params.env ?? process.env;
  const enabled = parseBooleanValue(env.OPENCLAW_LLM_INPUT_LOG) ?? false;
  const fileOverride = env.OPENCLAW_LLM_INPUT_LOG_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "llm-input.jsonl");
  return {
    enabled,
    filePath,
  };
}

function getWriter(filePath: string): QueuedFileWriter {
  return getQueuedFileWriter(writers, filePath);
}

export function createLlmInputLog(params: LlmInputLogInit): LlmInputLog | null {
  const cfg = resolveLlmInputLogConfig(params);
  if (!cfg.enabled) {
    return null;
  }

  const writer = params.writer ?? getWriter(cfg.filePath);
  let seq = 0;
  const base: Omit<LlmInputLogEvent, "ts" | "seq" | "kind" | "payload" | "payloadDigest"> =
    buildAgentTraceBase(params);

  const wrapStreamFn: LlmInputLog["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const originalOnPayload = options?.onPayload;
      return streamFn(model, context, {
        ...options,
        onPayload: (payload, payloadModel) => {
          const effectiveModel = payloadModel ?? model;
          const redactedPayload = redactImageDataForDiagnostics(payload);
          const event: LlmInputLogEvent = {
            ...base,
            provider:
              typeof effectiveModel?.provider === "string"
                ? effectiveModel.provider
                : base.provider,
            modelId: typeof effectiveModel?.id === "string" ? effectiveModel.id : base.modelId,
            modelApi: typeof effectiveModel?.api === "string" ? effectiveModel.api : base.modelApi,
            ts: new Date().toISOString(),
            seq: (seq += 1),
            kind: "llm_wire_payload",
            model: {
              id: effectiveModel?.id,
              provider: effectiveModel?.provider,
              api: effectiveModel?.api,
            },
            payload: redactedPayload,
            payloadDigest: digestTraceValue(redactedPayload),
          };
          const line = safeJsonStringify(event);
          if (line) {
            writer.write(`${line}\n`);
          }
          return originalOnPayload?.(payload, payloadModel);
        },
      });
    };
    return wrapped;
  };

  return {
    enabled: true,
    filePath: cfg.filePath,
    wrapStreamFn,
  };
}
