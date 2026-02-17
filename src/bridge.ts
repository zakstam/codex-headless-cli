import { CodexLocalBridge } from "@zakstam/codex-local-component/host";
import {
  buildCommandExecutionApprovalResponse,
  buildFileChangeApprovalResponse,
} from "@zakstam/codex-local-component/host";
import type {
  ClientNotification,
  ClientRequest,
} from "@zakstam/codex-local-component/protocol";
import {
  extractDelta,
  EventKind,
  REASONING_EVENT_KINDS,
  APPROVAL_KINDS,
  isResponse,
  isServerNotification,
} from "./protocol.js";
import { parseApprovalPayload } from "./approvals.js";
import type { AppEventBus } from "./events.js";
import type { Config } from "./config.js";

export type BridgeSession = {
  bridge: CodexLocalBridge;
  waitForThreadStart: () => Promise<string>;
  runTurn: (text: string) => Promise<void>;
  interruptTurn: () => void;
  stop: () => void;
};

/** Map our config approval mode to the codex protocol's AskForApproval. */
function toProtocolApprovalPolicy(
  mode: Config["approvalMode"],
): "never" | "untrusted" {
  return mode === "auto-approve" ? "never" : "untrusted";
}

/** Map our config sandbox mode to the protocol's SandboxMode. */
function toProtocolSandbox(
  mode: Config["sandbox"],
): "read-only" | "workspace-write" | "danger-full-access" {
  switch (mode) {
    case "full-access":
      return "danger-full-access";
    case "read-only":
      return "read-only";
    default:
      return "workspace-write";
  }
}

export function createBridgeSession(
  config: Config,
  bus: AppEventBus,
): BridgeSession {
  let nextId = 1;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnInFlight = false;
  let turnSettled = false;
  let assistantLineOpen = false;
  let commandOutputOpen = false;
  let gotFirstToken = false;
  let reasoningStarted = false;

  let resolveThreadReady: ((id: string) => void) | null = null;
  let rejectThreadReady: ((error: Error) => void) | null = null;
  let resolveTurnDone: (() => void) | null = null;
  let rejectTurnDone: ((error: Error) => void) | null = null;

  let stopped = false;

  type PendingRequest = { method: string };
  const pendingRequests = new Map<number, PendingRequest>();

  function requestId(): number {
    return nextId++;
  }

  function sendMessage(
    message: ClientRequest | ClientNotification,
    trackedMethod?: string,
  ): void {
    bridge.send(message);
    if ("id" in message && typeof message.id === "number" && trackedMethod) {
      pendingRequests.set(message.id, { method: trackedMethod });
    }
  }

  /** Called on the very first content token of any kind for this turn. */
  function onFirstToken(): void {
    if (!gotFirstToken) {
      gotFirstToken = true;
      bus.emitApp({ type: "waiting-stop" });
    }
  }

  function cleanupTurn(): void {
    bus.emitApp({ type: "turn-complete" });
  }

  /** Send an approval decision back through the protocol. */
  function sendApprovalDecision(
    kind: string,
    approvalRequestId: number | string,
    decision: "accept" | "decline",
  ): void {
    if (kind === "item/commandExecution/requestApproval") {
      bridge.send(
        buildCommandExecutionApprovalResponse(approvalRequestId, decision),
      );
    } else if (kind === "item/fileChange/requestApproval") {
      bridge.send(
        buildFileChangeApprovalResponse(approvalRequestId, decision),
      );
    }
  }

  const bridge = new CodexLocalBridge(
    {
      ...(config.codexBin ? { codexBin: config.codexBin } : {}),
      cwd: process.cwd(),
    },
    {
      onEvent: async (event) => {
        // Thread started
        if (event.kind === EventKind.ThreadStarted && threadId === null) {
          threadId = event.threadId;
          bus.emitApp({ type: "thread-ready", threadId });
          resolveThreadReady?.(threadId);
          resolveThreadReady = null;
          rejectThreadReady = null;
          return;
        }

        // Turn started
        if (
          event.kind === EventKind.TurnStarted &&
          event.turnId &&
          turnId === null
        ) {
          turnId = event.turnId;
          return;
        }

        // Reasoning deltas
        if (REASONING_EVENT_KINDS.has(event.kind)) {
          onFirstToken();

          if (!reasoningStarted) {
            reasoningStarted = true;
          }

          if (event.kind === EventKind.ReasoningSectionBreak) {
            bus.emitApp({ type: "reasoning-section-break" });
            return;
          }

          const delta = extractDelta(event.payloadJson);
          if (delta) {
            bus.emitApp({ type: "reasoning-delta", delta });
          }
          return;
        }

        // Assistant streaming delta
        if (event.kind === EventKind.AgentMessageDelta) {
          onFirstToken();

          if (config.reasoningOnly) {
            return;
          }

          const delta = extractDelta(event.payloadJson);
          if (!delta) {
            return;
          }
          if (!assistantLineOpen) {
            assistantLineOpen = true;
            if (config.debug) {
              bus.emitApp({ type: "debug-tag", tag: "response" });
            }
          }
          bus.emitApp({ type: "response-delta", delta });
          return;
        }

        // Command execution output delta
        if (event.kind === EventKind.CommandOutputDelta) {
          onFirstToken();

          const delta = extractDelta(event.payloadJson);
          if (delta) {
            if (config.debug && !commandOutputOpen) {
              commandOutputOpen = true;
              bus.emitApp({ type: "debug-tag", tag: "command" });
            }
            bus.emitApp({ type: "command-output-delta", delta });
          }
          return;
        }

        // Approval requests
        if (APPROVAL_KINDS.has(event.kind)) {
          onFirstToken();

          const payload = parseApprovalPayload(event.payloadJson);
          if (!payload) {
            return;
          }

          await new Promise<void>((resolve) => {
            bus.emitApp({
              type: "approval-request",
              kind: event.kind,
              payloadJson: event.payloadJson,
              respond: (decision) => {
                sendApprovalDecision(event.kind, payload.id, decision);
                resolve();
              },
            });
          });

          return;
        }

        // Turn completed
        if (event.kind === EventKind.TurnCompleted) {
          if (!turnInFlight || turnSettled) {
            return;
          }
          turnSettled = true;
          turnInFlight = false;
          turnId = null;
          cleanupTurn();
          resolveTurnDone?.();
          resolveTurnDone = null;
          rejectTurnDone = null;
          return;
        }
      },

      onGlobalMessage: async (message) => {
        if (isResponse(message)) {
          if (typeof message.id === "number") {
            const pending = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);
            if (message.error) {
              const error = new Error(
                `Request failed (${pending?.method ?? "unknown"}): ${message.error.message} (${message.error.code})`,
              );
              if (pending?.method === "thread/start") {
                rejectThreadReady?.(error);
                resolveThreadReady = null;
                rejectThreadReady = null;
                return;
              }
              if (
                pending?.method === "turn/start" &&
                turnInFlight &&
                !turnSettled
              ) {
                turnSettled = true;
                turnInFlight = false;
                turnId = null;
                cleanupTurn();
                rejectTurnDone?.(error);
                resolveTurnDone = null;
                rejectTurnDone = null;
                return;
              }
              bus.emitApp({ type: "error", message: error.message });
              return;
            }
          }
          return;
        }

        if (isServerNotification(message)) {
          if (message.method === "error") {
            bus.emitApp({
              type: "error",
              message: `server: ${JSON.stringify(message.params)}`,
            });
            return;
          }
          if (message.method === "account/rateLimits/updated") {
            return;
          }
        }
      },

      onProtocolError: async ({ error }) => {
        cleanupTurn();
        bus.emitApp({
          type: "error",
          message: `protocol: ${error.message}`,
        });
        rejectThreadReady?.(error);
        rejectTurnDone?.(error);
        bridge.stop();
        process.exit(1);
      },

      onProcessExit: (code) => {
        cleanupTurn();
        if (turnInFlight && !turnSettled) {
          const error = new Error(
            `codex app-server exited unexpectedly (code=${String(code)})`,
          );
          rejectTurnDone?.(error);
        }
      },
    },
  );

  function startFlow(): void {
    bridge.start();

    const initReq: ClientRequest = {
      method: "initialize",
      id: requestId(),
      params: {
        clientInfo: {
          name: "codex_headless_cli",
          title: "Codex Headless CLI",
          version: "0.1.0",
        },
        capabilities: null,
      },
    };
    const initialized: ClientNotification = { method: "initialized" };
    const threadStart: ClientRequest = {
      method: "thread/start",
      id: requestId(),
      params: {
        model: config.model ?? null,
        cwd: process.cwd(),
        approvalPolicy: toProtocolApprovalPolicy(config.approvalMode),
        sandbox: toProtocolSandbox(config.sandbox),
        experimentalRawEvents: false,
      },
    };

    sendMessage(initReq, "initialize");
    sendMessage(initialized);
    sendMessage(threadStart, "thread/start");
  }

  function waitForThreadStart(): Promise<string> {
    if (threadId) {
      return Promise.resolve(threadId);
    }
    startFlow();
    return new Promise<string>((resolve, reject) => {
      resolveThreadReady = resolve;
      rejectThreadReady = reject;
    });
  }

  function runTurn(text: string): Promise<void> {
    if (!threadId) {
      throw new Error("Thread not ready.");
    }
    if (turnInFlight) {
      throw new Error(
        "A turn is already in progress. Wait for completion or use /interrupt.",
      );
    }

    const activeThreadId = threadId;
    turnInFlight = true;
    turnSettled = false;
    turnId = null;
    assistantLineOpen = false;
    commandOutputOpen = false;
    gotFirstToken = false;
    reasoningStarted = false;

    bus.emitApp({ type: "waiting-start" });

    return new Promise<void>((resolve, reject) => {
      resolveTurnDone = resolve;
      rejectTurnDone = reject;

      const turnStart: ClientRequest = {
        method: "turn/start",
        id: requestId(),
        params: {
          threadId: activeThreadId,
          input: [{ type: "text", text, text_elements: [] }],
        },
      };
      sendMessage(turnStart, "turn/start");
    });
  }

  function interruptTurn(): void {
    if (!threadId || !turnId || !turnInFlight) {
      return;
    }
    const interruptReq: ClientRequest = {
      method: "turn/interrupt",
      id: requestId(),
      params: { threadId, turnId },
    };
    sendMessage(interruptReq, "turn/interrupt");
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    bridge.stop();
  }

  return { bridge, waitForThreadStart, runTurn, interruptTurn, stop };
}
