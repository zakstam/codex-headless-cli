import {
  durableMessageDeltaForPayload,
  reasoningDeltaForPayload,
} from "@zakstam/codex-local-component/protocol";

/**
 * Protocol helpers for parsing codex app-server JSON-RPC messages.
 */

type ProtocolNotification = {
  method: string;
  params?: unknown;
};

type ProtocolResponse = {
  id: number;
  error?: { message: string; code: number };
};

export function parseServerMessage(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    console.error(`Failed to parse server message: ${payloadJson.slice(0, 200)}`);
    return null;
  }
}

export function isServerNotification(
  message: unknown,
): message is ProtocolNotification {
  return typeof message === "object" && message !== null && "method" in message;
}

export function isResponse(message: unknown): message is ProtocolResponse {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  return "id" in message && !isServerNotification(message);
}

export const EventKind = {
  ThreadStarted: "thread/started",
  TurnStarted: "turn/started",
  TurnCompleted: "turn/completed",
  ItemCompleted: "item/completed",

  AgentMessageDelta: "item/agentMessage/delta",

  ReasoningSummaryDelta: "item/reasoning/summaryTextDelta",
  ReasoningSectionBreak: "item/reasoning/summaryPartAdded",
  ReasoningRawDelta: "item/reasoning/textDelta",

  CommandOutputDelta: "item/commandExecution/outputDelta",
  CommandApproval: "item/commandExecution/requestApproval",
  FileChangeApproval: "item/fileChange/requestApproval",

  ServerError: "error",
  AccountRateLimitsUpdated: "account/rateLimits/updated",
} as const;

export type LifecycleEventType =
  | "thread-started"
  | "turn-started"
  | "turn-completed"
  | "item-completed";

export function getLifecycleEventType(kind: string): LifecycleEventType | null {
  switch (kind) {
    case EventKind.ThreadStarted:
      return "thread-started";
    case EventKind.TurnStarted:
      return "turn-started";
    case EventKind.TurnCompleted:
      return "turn-completed";
    case EventKind.ItemCompleted:
      return "item-completed";
    default:
      return null;
  }
}

export function isServerErrorMethod(method: string): boolean {
  return method === EventKind.ServerError;
}

export function isGlobalNoopNotification(method: string): boolean {
  return method === EventKind.AccountRateLimitsUpdated;
}

export type ReasoningEvent =
  | { type: "delta"; delta: string }
  | { type: "section-break" };

export function extractReasoningEvent(
  kind: string,
  payloadJson: string,
): ReasoningEvent | null {
  const reasoning = reasoningDeltaForPayload(kind, payloadJson);
  if (!reasoning) {
    return null;
  }
  if (reasoning.segmentType === "sectionBreak") {
    return { type: "section-break" };
  }
  if (typeof reasoning.delta !== "string" || reasoning.delta.length === 0) {
    return null;
  }
  return { type: "delta", delta: reasoning.delta };
}

export function extractAssistantDelta(
  kind: string,
  payloadJson: string,
): string | null {
  const delta = durableMessageDeltaForPayload(kind, payloadJson)?.delta;
  return typeof delta === "string" && delta.length > 0 ? delta : null;
}

export function extractCommandOutputDelta(
  kind: string,
  payloadJson: string,
): string | null {
  if (kind !== EventKind.CommandOutputDelta) {
    return null;
  }
  const msg = parseServerMessage(payloadJson) as Record<string, unknown> | null;
  if (!msg || msg.method !== EventKind.CommandOutputDelta) {
    return null;
  }
  const params =
    typeof msg.params === "object" && msg.params !== null
      ? (msg.params as Record<string, unknown>)
      : null;
  return typeof params?.delta === "string" && params.delta.length > 0
    ? params.delta
    : null;
}

export function isApprovalKind(kind: string): boolean {
  return kind === EventKind.CommandApproval || kind === EventKind.FileChangeApproval;
}
