/**
 * Protocol helpers for parsing codex app-server JSON-RPC messages.
 * Reimplemented locally since the monorepo's apps/shared/ is not published.
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
  return JSON.parse(payloadJson) as unknown;
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

/**
 * Generic delta extractor — pulls `params.delta` from any JSON-RPC payload.
 * Use this after already matching on `event.kind` in the bridge, so we don't
 * need per-method extraction functions.
 */
export function extractDelta(payloadJson: string): string | null {
  const msg = parseServerMessage(payloadJson) as Record<string, unknown>;
  const params =
    typeof msg?.params === "object" && msg.params !== null
      ? (msg.params as Record<string, unknown>)
      : null;
  return typeof params?.delta === "string" ? params.delta : null;
}

// ---------------------------------------------------------------------------
// Event kind constants — single source of truth for protocol path strings
// ---------------------------------------------------------------------------

export const EventKind = {
  ThreadStarted: "thread/started",
  TurnStarted: "turn/started",
  TurnCompleted: "turn/completed",

  AgentMessageDelta: "item/agentMessage/delta",

  ReasoningSummaryDelta: "item/reasoning/summaryTextDelta",
  ReasoningSectionBreak: "item/reasoning/summaryPartAdded",
  ReasoningRawDelta: "item/reasoning/textDelta",

  CommandOutputDelta: "item/commandExecution/outputDelta",
  CommandApproval: "item/commandExecution/requestApproval",
  FileChangeApproval: "item/fileChange/requestApproval",
} as const;

export const REASONING_EVENT_KINDS: Set<string> = new Set([
  EventKind.ReasoningSummaryDelta,
  EventKind.ReasoningSectionBreak,
  EventKind.ReasoningRawDelta,
]);

export const APPROVAL_KINDS: Set<string> = new Set([
  EventKind.CommandApproval,
  EventKind.FileChangeApproval,
]);
