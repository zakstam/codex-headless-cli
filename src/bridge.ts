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
import { buildInitSequence } from "./bridge-init.js";
import type { Config } from "./config.js";

// ── AppEvent (moved from events.ts) ──────────────────────────────────────────

export type AppEvent =
  | { type: "thread-ready"; threadId: string }
  | { type: "waiting-start" }
  | { type: "waiting-stop" }
  | { type: "reasoning-delta"; delta: string }
  | { type: "reasoning-section-break" }
  | { type: "response-delta"; delta: string }
  | { type: "command-output-delta"; delta: string }
  | {
      type: "approval-request";
      kind: string;
      payloadJson: string;
      respond: (decision: "accept" | "decline") => void;
    }
  | { type: "turn-complete" }
  | { type: "error"; message: string }
  | { type: "debug-tag"; tag: string };

export type EventCallback = (event: AppEvent) => void;

// ── State machines ───────────────────────────────────────────────────────────

type ThreadState =
  | { status: "init" }
  | { status: "starting"; resolve: (id: string) => void; reject: (err: Error) => void }
  | { status: "ready"; threadId: string };

type TurnState =
  | { status: "idle" }
  | {
      status: "active";
      turnId: string | null;
      gotFirstToken: boolean;
      assistantLineOpen: boolean;
      commandOutputOpen: boolean;
      reasoningStarted: boolean;
      resolve: () => void;
      reject: (err: Error) => void;
    };

// ── Protocol helpers ─────────────────────────────────────────────────────────

function toProtocolApprovalPolicy(
  mode: Config["approvalMode"],
): "never" | "untrusted" {
  return mode === "auto-approve" ? "never" : "untrusted";
}

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

// ── BridgeSession class ──────────────────────────────────────────────────────

export class BridgeSession {
  readonly bridge: CodexLocalBridge;
  private readonly config: Config;

  private nextId = 1;
  private threadState: ThreadState = { status: "init" };
  private turnState: TurnState = { status: "idle" };
  private stopped = false;
  private eventCallback: EventCallback | null = null;

  private readonly pendingRequests = new Map<number, { method: string }>();

  constructor(config: Config) {
    this.config = config;

    this.bridge = new CodexLocalBridge(
      {
        ...(config.codexBin ? { codexBin: config.codexBin } : {}),
        cwd: process.cwd(),
      },
      {
        onEvent: async (event) => this.handleEvent(event),
        onGlobalMessage: async (message) => this.handleGlobalMessage(message),
        onProtocolError: async ({ error }) => this.handleProtocolError(error),
        onProcessExit: (code) => this.handleProcessExit(code),
      },
    );
  }

  setEventCallback(cb: EventCallback): void {
    this.eventCallback = cb;
  }

  private emit(event: AppEvent): void {
    this.eventCallback?.(event);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  waitForThreadStart(): Promise<string> {
    if (this.threadState.status === "ready") {
      return Promise.resolve(this.threadState.threadId);
    }
    this.bridge.start();
    const [initReq, initialized] = buildInitSequence(() => this.requestId());
    this.sendMessage(initReq, "initialize");
    this.sendMessage(initialized);

    const threadStart: ClientRequest = {
      method: "thread/start",
      id: this.requestId(),
      params: {
        model: this.config.model ?? null,
        cwd: process.cwd(),
        approvalPolicy: toProtocolApprovalPolicy(this.config.approvalMode),
        sandbox: toProtocolSandbox(this.config.sandbox),
        experimentalRawEvents: false,
      },
    };
    this.sendMessage(threadStart, "thread/start");

    return new Promise<string>((resolve, reject) => {
      this.threadState = { status: "starting", resolve, reject };
    });
  }

  runTurn(text: string): Promise<void> {
    if (this.threadState.status !== "ready") {
      throw new Error("Thread not ready.");
    }
    if (this.turnState.status === "active") {
      throw new Error(
        "A turn is already in progress. Wait for completion or use /interrupt.",
      );
    }

    const threadId = this.threadState.threadId;
    this.emit({ type: "waiting-start" });

    return new Promise<void>((resolve, reject) => {
      this.turnState = {
        status: "active",
        turnId: null,
        gotFirstToken: false,
        assistantLineOpen: false,
        commandOutputOpen: false,
        reasoningStarted: false,
        resolve,
        reject,
      };

      const turnStart: ClientRequest = {
        method: "turn/start",
        id: this.requestId(),
        params: {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
        },
      };
      this.sendMessage(turnStart, "turn/start");
    });
  }

  interruptTurn(): void {
    if (
      this.threadState.status !== "ready" ||
      this.turnState.status !== "active" ||
      !this.turnState.turnId
    ) {
      return;
    }
    const interruptReq: ClientRequest = {
      method: "turn/interrupt",
      id: this.requestId(),
      params: {
        threadId: this.threadState.threadId,
        turnId: this.turnState.turnId,
      },
    };
    this.sendMessage(interruptReq, "turn/interrupt");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bridge.stop();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private requestId(): number {
    return this.nextId++;
  }

  private sendMessage(
    message: ClientRequest | ClientNotification,
    trackedMethod?: string,
  ): void {
    this.bridge.send(message);
    if ("id" in message && typeof message.id === "number" && trackedMethod) {
      this.pendingRequests.set(message.id, { method: trackedMethod });
    }
  }

  private onFirstToken(): void {
    if (this.turnState.status === "active" && !this.turnState.gotFirstToken) {
      this.turnState.gotFirstToken = true;
      this.emit({ type: "waiting-stop" });
    }
  }

  /** Settle the current turn — emits turn-complete and resets turnState to idle. */
  private settleTurn(outcome: "resolve" | "reject", error?: Error): void {
    if (this.turnState.status !== "active") return;
    const { resolve, reject } = this.turnState;
    this.turnState = { status: "idle" };
    this.emit({ type: "turn-complete" });
    if (outcome === "resolve") {
      resolve();
    } else {
      reject(error!);
    }
  }

  private sendApprovalDecision(
    kind: string,
    approvalRequestId: number | string,
    decision: "accept" | "decline",
  ): void {
    if (kind === "item/commandExecution/requestApproval") {
      this.bridge.send(
        buildCommandExecutionApprovalResponse(approvalRequestId, decision),
      );
    } else if (kind === "item/fileChange/requestApproval") {
      this.bridge.send(
        buildFileChangeApprovalResponse(approvalRequestId, decision),
      );
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async handleEvent(event: { kind: string; threadId: string; turnId?: string; payloadJson: string }): Promise<void> {
    // Thread started
    if (event.kind === EventKind.ThreadStarted && this.threadState.status === "starting") {
      const { resolve } = this.threadState;
      this.threadState = { status: "ready", threadId: event.threadId };
      this.emit({ type: "thread-ready", threadId: event.threadId });
      resolve(event.threadId);
      return;
    }

    // Turn started
    if (
      event.kind === EventKind.TurnStarted &&
      event.turnId &&
      this.turnState.status === "active" &&
      this.turnState.turnId === null
    ) {
      this.turnState.turnId = event.turnId;
      return;
    }

    // Reasoning deltas
    if (REASONING_EVENT_KINDS.has(event.kind)) {
      this.onFirstToken();

      if (this.turnState.status === "active" && !this.turnState.reasoningStarted) {
        this.turnState.reasoningStarted = true;
      }

      if (event.kind === EventKind.ReasoningSectionBreak) {
        this.emit({ type: "reasoning-section-break" });
        return;
      }

      const delta = extractDelta(event.payloadJson);
      if (delta) {
        this.emit({ type: "reasoning-delta", delta });
      }
      return;
    }

    // Assistant streaming delta
    if (event.kind === EventKind.AgentMessageDelta) {
      this.onFirstToken();

      if (this.config.reasoningOnly) return;

      const delta = extractDelta(event.payloadJson);
      if (!delta) return;

      if (this.turnState.status === "active" && !this.turnState.assistantLineOpen) {
        this.turnState.assistantLineOpen = true;
        if (this.config.debug) {
          this.emit({ type: "debug-tag", tag: "response" });
        }
      }
      this.emit({ type: "response-delta", delta });
      return;
    }

    // Command execution output delta
    if (event.kind === EventKind.CommandOutputDelta) {
      this.onFirstToken();

      const delta = extractDelta(event.payloadJson);
      if (delta) {
        if (this.config.debug && this.turnState.status === "active" && !this.turnState.commandOutputOpen) {
          this.turnState.commandOutputOpen = true;
          this.emit({ type: "debug-tag", tag: "command" });
        }
        this.emit({ type: "command-output-delta", delta });
      }
      return;
    }

    // Approval requests
    if (APPROVAL_KINDS.has(event.kind)) {
      this.onFirstToken();

      const payload = parseApprovalPayload(event.payloadJson);
      if (!payload) return;

      await new Promise<void>((resolve) => {
        this.emit({
          type: "approval-request",
          kind: event.kind,
          payloadJson: event.payloadJson,
          respond: (decision) => {
            this.sendApprovalDecision(event.kind, payload.id, decision);
            resolve();
          },
        });
      });
      return;
    }

    // Turn completed
    if (event.kind === EventKind.TurnCompleted) {
      this.settleTurn("resolve");
      return;
    }
  }

  private async handleGlobalMessage(message: unknown): Promise<void> {
    if (isResponse(message)) {
      if (typeof message.id === "number") {
        const pending = this.pendingRequests.get(message.id);
        this.pendingRequests.delete(message.id);
        if (message.error) {
          const error = new Error(
            `Request failed (${pending?.method ?? "unknown"}): ${message.error.message} (${message.error.code})`,
          );
          if (pending?.method === "thread/start" && this.threadState.status === "starting") {
            const { reject } = this.threadState;
            this.threadState = { status: "init" };
            reject(error);
            return;
          }
          if (pending?.method === "turn/start") {
            this.settleTurn("reject", error);
            return;
          }
          this.emit({ type: "error", message: error.message });
          return;
        }
      }
      return;
    }

    if (isServerNotification(message)) {
      if (message.method === "error") {
        this.emit({
          type: "error",
          message: `server: ${JSON.stringify(message.params)}`,
        });
        return;
      }
      if (message.method === "account/rateLimits/updated") {
        return;
      }
    }
  }

  private handleProtocolError(error: Error): void {
    this.settleTurn("reject", error);
    this.emit({
      type: "error",
      message: `protocol: ${error.message}`,
    });
    if (this.threadState.status === "starting") {
      const { reject } = this.threadState;
      this.threadState = { status: "init" };
      reject(error);
    }
    this.bridge.stop();
    process.exit(1);
  }

  private handleProcessExit(code: number | null): void {
    if (this.turnState.status === "active") {
      const error = new Error(
        `codex app-server exited unexpectedly (code=${String(code)})`,
      );
      this.settleTurn("reject", error);
    }
  }
}
