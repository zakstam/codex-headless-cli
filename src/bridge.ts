import { stdin } from "node:process";
import { CodexLocalBridge } from "@zakstam/codex-local-component/host";
import type { ClientNotification, ClientRequest } from "@zakstam/codex-local-component/protocol";
import {
  extractDelta,
  EventKind,
  REASONING_EVENT_KINDS,
  APPROVAL_KINDS,
  isResponse,
  isServerNotification,
} from "./protocol.js";
import {
  writeCommandOutput,
  writeDebugTag,
  printError,
  ReasoningDisplay,
  WaitingSpinner,
} from "./ui.js";
import { MarkdownWriter } from "./markdown.js";
import { handleApproval } from "./approvals.js";
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

export function createBridgeSession(config: Config): BridgeSession {
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

  const reasoning = new ReasoningDisplay(config.debug);
  const waiting = new WaitingSpinner();
  const md = new MarkdownWriter();

  // --- Key listener for interrupt during turns ---
  let keyHandler: ((data: Buffer) => void) | null = null;
  let stdinWasRaw = false;
  let lastCtrlC = 0;

  function startKeyListener(): void {
    if (!stdin.isTTY) return;
    stdinWasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    lastCtrlC = 0;
    keyHandler = (data: Buffer) => {
      const byte = data[0];
      if (byte === 0x69) {
        // 'i' key — interrupt turn
        interruptTurn();
      } else if (byte === 0x03) {
        // Ctrl+C — interrupt turn, or force exit on double-press
        const now = Date.now();
        if (now - lastCtrlC < 1000) {
          stop();
          process.exit(130);
        }
        lastCtrlC = now;
        interruptTurn();
      }
    };
    stdin.on("data", keyHandler);
  }

  function stopKeyListener(): void {
    if (keyHandler) {
      stdin.off("data", keyHandler);
      keyHandler = null;
    }
    if (stdin.isTTY && stdin.isRaw !== stdinWasRaw) {
      stdin.setRawMode(stdinWasRaw);
    }
    stdin.pause();
  }

  function pauseKeyListener(): void {
    if (!keyHandler) return;
    stdin.off("data", keyHandler);
    if (stdin.isTTY && stdin.isRaw) {
      stdin.setRawMode(false);
    }
  }

  function resumeKeyListener(): void {
    if (!keyHandler || !stdin.isTTY) return;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", keyHandler);
  }

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
      waiting.stop();
    }
  }

  /** Transition from reasoning to response output. */
  function endReasoning(): void {
    reasoning.stop();
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
          resolveThreadReady?.(threadId);
          resolveThreadReady = null;
          rejectThreadReady = null;
          return;
        }

        // Turn started
        if (event.kind === EventKind.TurnStarted && event.turnId && turnId === null) {
          turnId = event.turnId;
          return;
        }

        // Reasoning deltas — animated single-line display
        if (REASONING_EVENT_KINDS.has(event.kind)) {
          onFirstToken();

          if (!reasoningStarted) {
            reasoningStarted = true;
            reasoning.start();
          }

          if (event.kind === EventKind.ReasoningSectionBreak) {
            reasoning.sectionBreak();
            return;
          }

          const delta = extractDelta(event.payloadJson);
          if (delta) {
            reasoning.addDelta(delta);
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
              writeDebugTag("response");
            }
          }
          md.addDelta(delta);
          return;
        }

        // Command execution output delta
        if (event.kind === EventKind.CommandOutputDelta) {
          onFirstToken();

          const delta = extractDelta(event.payloadJson);
          if (delta) {
            if (config.debug && !commandOutputOpen) {
              commandOutputOpen = true;
              writeDebugTag("command");
            }
            writeCommandOutput(delta);
          }
          return;
        }

        // Approval requests — pause reasoning display and key listener so prompts work
        if (APPROVAL_KINDS.has(event.kind)) {
          onFirstToken();
          reasoning.pause();
          pauseKeyListener();

          await handleApproval(
            bridge,
            event.kind,
            event.payloadJson,
            config.approvalMode,
          );

          resumeKeyListener();
          reasoning.resume();
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
          waiting.stop();
          endReasoning();
          stopKeyListener();
          if (assistantLineOpen) {
            md.flush();
            assistantLineOpen = false;
          }
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
                waiting.stop();
                endReasoning();
                stopKeyListener();
                rejectTurnDone?.(error);
                resolveTurnDone = null;
                rejectTurnDone = null;
                return;
              }
              printError(error.message);
              return;
            }
          }
          return;
        }

        if (isServerNotification(message)) {
          if (message.method === "error") {
            printError(`server: ${JSON.stringify(message.params)}`);
            return;
          }
          if (message.method === "account/rateLimits/updated") {
            return;
          }
        }
      },

      onProtocolError: async ({ line, error }) => {
        waiting.stop();
        endReasoning();
        stopKeyListener();
        if (assistantLineOpen) {
          md.flush();
          assistantLineOpen = false;
        }
        printError(`protocol: ${error.message}`);
        rejectThreadReady?.(error);
        rejectTurnDone?.(error);
        bridge.stop();
        process.exit(1);
      },

      onProcessExit: (code) => {
        waiting.stop();
        endReasoning();
        stopKeyListener();
        if (assistantLineOpen) {
          md.flush();
          assistantLineOpen = false;
        }
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
    md.reset();

    waiting.start();
    startKeyListener();

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
      console.log("No active turn to interrupt.");
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
    waiting.stop();
    reasoning.stop();
    stopKeyListener();
    bridge.stop();
  }

  return { bridge, waitForThreadStart, runTurn, interruptTurn, stop };
}
