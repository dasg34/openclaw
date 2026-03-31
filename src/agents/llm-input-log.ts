import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { redactImageDataForDiagnostics } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import { buildAgentTraceBase } from "./trace-base.js";
import { digestTraceValue, summarizeTraceMessages } from "./trace-message-summary.js";

export type LlmInputLogEvent = {
  ts: string;
  seq: number;
  kind: "llm_input";
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  model?: Record<string, unknown>;
  messages: AgentMessage[];
  messageCount: number;
  messageRoles: Array<string | undefined>;
  messagesDigest: string;
  system?: unknown;
  systemDigest?: string;
  options?: Record<string, unknown>;
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
  includeSystem: boolean;
  includeOptions: boolean;
};

const writers = new Map<string, QueuedFileWriter>();

function resolveLlmInputLogConfig(params: LlmInputLogInit): LlmInputLogConfig {
  const env = params.env ?? process.env;
  const enabled = parseBooleanValue(env.OPENCLAW_LLM_INPUT_LOG) ?? false;
  const fileOverride = env.OPENCLAW_LLM_INPUT_LOG_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "llm-input.jsonl");
  const includeSystem = parseBooleanValue(env.OPENCLAW_LLM_INPUT_LOG_SYSTEM) ?? false;
  const includeOptions = parseBooleanValue(env.OPENCLAW_LLM_INPUT_LOG_OPTIONS) ?? false;
  return {
    enabled,
    filePath,
    includeSystem,
    includeOptions,
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
  const base: Omit<
    LlmInputLogEvent,
    "ts" | "seq" | "kind" | "messages" | "messageCount" | "messageRoles" | "messagesDigest"
  > = buildAgentTraceBase(params);

  const wrapStreamFn: LlmInputLog["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const contextRecord = context as {
        system?: unknown;
        messages?: AgentMessage[];
      };
      const messages = Array.isArray(contextRecord.messages) ? contextRecord.messages : [];
      const summary = summarizeTraceMessages(messages);
      const event: LlmInputLogEvent = {
        ...base,
        ts: new Date().toISOString(),
        seq: (seq += 1),
        kind: "llm_input",
        model: {
          id: model?.id,
          provider: model?.provider,
          api: model?.api,
        },
        messages: redactImageDataForDiagnostics(messages) as AgentMessage[],
        messageCount: summary.messageCount,
        messageRoles: summary.messageRoles,
        messagesDigest: summary.messagesDigest,
      };
      if (cfg.includeSystem && contextRecord.system !== undefined) {
        event.system = redactImageDataForDiagnostics(contextRecord.system);
        event.systemDigest = digestTraceValue(contextRecord.system);
      }
      if (cfg.includeOptions && options) {
        event.options = redactImageDataForDiagnostics(options) as Record<string, unknown>;
      }
      const line = safeJsonStringify(event);
      if (line) {
        writer.write(`${line}\n`);
      }
      return streamFn(model, context, options);
    };
    return wrapped;
  };

  return {
    enabled: true,
    filePath: cfg.filePath,
    wrapStreamFn,
  };
}
