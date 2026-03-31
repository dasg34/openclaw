import type { AgentMessage } from "@mariozechner/pi-agent-core";
import crypto from "node:crypto";

function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return JSON.stringify(String(value));
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (seen.has(value)) {
    return JSON.stringify("[Circular]");
  }
  seen.add(value);
  if (value instanceof Error) {
    return stableStringify(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      seen,
    );
  }
  if (value instanceof Uint8Array) {
    return stableStringify(
      {
        type: "Uint8Array",
        data: Buffer.from(value).toString("base64"),
      },
      seen,
    );
  }
  if (Array.isArray(value)) {
    const serializedEntries: string[] = [];
    for (const entry of value) {
      serializedEntries.push(stableStringify(entry, seen));
    }
    return `[${serializedEntries.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const serializedFields: string[] = [];
  for (const key of Object.keys(record).toSorted()) {
    serializedFields.push(`${JSON.stringify(key)}:${stableStringify(record[key], seen)}`);
  }
  return `{${serializedFields.join(",")}}`;
}

export function digestTraceValue(value: unknown): string {
  const serialized = stableStringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function summarizeTraceMessages(messages: AgentMessage[]): {
  messageCount: number;
  messageRoles: Array<string | undefined>;
  messageFingerprints: string[];
  messagesDigest: string;
} {
  const messageFingerprints = messages.map((msg) => digestTraceValue(msg));
  return {
    messageCount: messages.length,
    messageRoles: messages.map((msg) => (msg as { role?: string }).role),
    messageFingerprints,
    messagesDigest: digestTraceValue(messageFingerprints.join("|")),
  };
}
