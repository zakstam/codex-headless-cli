import { useReducer } from "react";
import chalk from "chalk";
import type { AppEvent } from "../../bridge.js";
import { describeApproval, parseApprovalPayload } from "../../approvals.js";
import type { Config } from "../../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type OutputItem = { id: number; text: string };

export type Phase =
  | "connecting"
  | "waiting"
  | "streaming"
  | "approval"
  | "idle"
  | "done";

export type AppState = {
  phase: Phase;
  outputItems: OutputItem[];
  nextItemId: number;
  streamingLine: string;
  showReasoning: boolean;
  reasoningText: string;
  reasoningAccum: string;
  reasoningLineBuffer: string;
  reasoningSection: number;
  needsReasoningHeader: boolean;
  approvalDetails: string;
  cmdBuffer: string;
};

export type AppAction =
  | AppEvent
  | { type: "submit"; text: string }
  | { type: "approve-decision"; decision: "accept" | "decline"; details: string }
  | { type: "md-line"; line: string }
  | { type: "md-buffer"; buffer: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderReasoningLine(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, (_, content: string) =>
    chalk.reset.bold(content),
  );
}

function reasoningSectionDivider(n: number): string {
  const label = ` reasoning #${n} `;
  const cols = process.stdout.columns ?? 80;
  const pad = Math.max(0, cols - label.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return chalk.dim("─".repeat(left) + label + "─".repeat(right));
}

function addItem(state: AppState, text: string): { outputItems: OutputItem[]; nextItemId: number } {
  const id = state.nextItemId;
  return {
    outputItems: [...state.outputItems, { id, text }],
    nextItemId: id + 1,
  };
}

function addItems(state: AppState, texts: string[]): { outputItems: OutputItem[]; nextItemId: number } {
  let { nextItemId } = state;
  const newItems = texts.map((text) => ({ id: nextItemId++, text }));
  return {
    outputItems: [...state.outputItems, ...newItems],
    nextItemId,
  };
}

// ── Reducer factory ──────────────────────────────────────────────────────────

function createReducer(config: Config, mode: "repl" | "single-shot") {
  return function reducer(state: AppState, action: AppAction): AppState {
    switch (action.type) {
      case "thread-ready": {
        if (mode === "repl") {
          const items = addItems(state, [
            chalk.bold.cyan("\n  zz") + chalk.gray(` — thread ${action.threadId}\n`),
            chalk.gray("  Type a message and press Enter."),
            chalk.gray("  Commands: /interrupt, /help, /exit\n"),
          ]);
          return { ...state, ...items, phase: "idle" };
        }
        // single-shot: phase stays connecting, side effect (runTurn) handled by useEventHandler
        return state;
      }

      case "waiting-start":
        return {
          ...state,
          phase: "waiting",
          reasoningSection: 0,
          needsReasoningHeader: true,
        };

      case "waiting-stop":
        return state;

      case "reasoning-delta": {
        let next = { ...state, showReasoning: true };

        // If response was streaming, flush it (side effect handled externally, just reset state)
        if (next.phase === "streaming") {
          next = {
            ...next,
            streamingLine: "",
            phase: "waiting",
            reasoningAccum: "",
            needsReasoningHeader: true,
          };
        }

        // reasoning-only mode: stream full reasoning text to Static output
        if (config.reasoningOnly) {
          let { outputItems, nextItemId, reasoningLineBuffer, reasoningSection, needsReasoningHeader } = next;
          const newItems: OutputItem[] = [];

          if (needsReasoningHeader) {
            needsReasoningHeader = false;
            if (reasoningLineBuffer) {
              newItems.push({ id: nextItemId++, text: chalk.dim(renderReasoningLine(reasoningLineBuffer)) });
              reasoningLineBuffer = "";
            }
            reasoningSection++;
            newItems.push({ id: nextItemId++, text: reasoningSectionDivider(reasoningSection) });
          }

          const all = reasoningLineBuffer + action.delta;
          const parts = all.split("\n");
          for (let i = 0; i < parts.length - 1; i++) {
            newItems.push({ id: nextItemId++, text: chalk.dim(renderReasoningLine(parts[i]!)) });
          }
          reasoningLineBuffer = parts[parts.length - 1]!;

          next = {
            ...next,
            outputItems: [...outputItems, ...newItems],
            nextItemId,
            reasoningLineBuffer,
            reasoningSection,
            needsReasoningHeader,
          };
        }

        // Update reasoning bar text (last line only)
        let accum = next.reasoningAccum + action.delta;
        let reasoningText = next.reasoningText;
        const nl = accum.lastIndexOf("\n");
        if (nl !== -1) {
          const afterNl = accum.slice(nl + 1);
          accum = afterNl;
          if (afterNl) {
            reasoningText = afterNl;
          }
        } else {
          reasoningText = accum;
        }

        return { ...next, reasoningAccum: accum, reasoningText };
      }

      case "reasoning-section-break": {
        let next = { ...state, reasoningAccum: "" };
        if (config.reasoningOnly) {
          let { outputItems, nextItemId, reasoningLineBuffer } = next;
          const newItems: OutputItem[] = [];
          if (reasoningLineBuffer) {
            newItems.push({ id: nextItemId++, text: chalk.dim(renderReasoningLine(reasoningLineBuffer)) });
            reasoningLineBuffer = "";
          }
          next = {
            ...next,
            outputItems: [...outputItems, ...newItems],
            nextItemId,
            reasoningLineBuffer,
            needsReasoningHeader: true,
          };
        }
        return next;
      }

      case "response-delta": {
        if (config.reasoningOnly) return state;

        let next = state;
        if (next.phase !== "streaming") {
          if (config.debug) {
            const items = addItem(next, chalk.bold.magenta("[response]"));
            next = { ...next, ...items };
          }
          next = { ...next, phase: "streaming" };
        }
        // md-line and md-buffer actions handle actual content updates
        return next;
      }

      case "md-line": {
        const items = addItem(state, action.line);
        return { ...state, ...items };
      }

      case "md-buffer":
        return { ...state, streamingLine: action.buffer };

      case "command-output-delta": {
        let next = state;
        if (next.phase === "waiting") {
          next = { ...next, phase: "streaming" };
        }
        const all = next.cmdBuffer + action.delta;
        const parts = all.split("\n");
        const newItems: OutputItem[] = [];
        let { nextItemId } = next;
        for (let i = 0; i < parts.length - 1; i++) {
          newItems.push({ id: nextItemId++, text: chalk.dim(parts[i]!) });
        }
        return {
          ...next,
          outputItems: [...next.outputItems, ...newItems],
          nextItemId,
          cmdBuffer: parts[parts.length - 1]!,
        };
      }

      case "debug-tag": {
        const items = addItem(state, chalk.bold.magenta(`[${action.tag}]`));
        return { ...state, ...items };
      }

      case "approval-request": {
        const payload = parseApprovalPayload(action.payloadJson);
        if (!payload) {
          // Side effect (decline) handled by useEventHandler
          return state;
        }

        const description = describeApproval(payload);

        if (config.approvalMode === "auto-approve") {
          const items = addItem(state, chalk.green("  [auto-approved] ") + description);
          // Side effect (accept) handled by useEventHandler
          return { ...state, ...items };
        }
        if (config.approvalMode === "deny") {
          const items = addItem(state, chalk.red("  [denied] ") + description);
          // Side effect (decline) handled by useEventHandler
          return { ...state, ...items };
        }

        // Prompt mode
        return { ...state, approvalDetails: description, phase: "approval" };
      }

      case "approve-decision": {
        const items = addItem(
          state,
          action.decision === "accept"
            ? chalk.green("  [approved] ") + action.details
            : chalk.red("  [declined] ") + action.details,
        );
        return {
          ...state,
          ...items,
          approvalDetails: "",
          phase: "waiting",
        };
      }

      case "turn-complete": {
        // Flush remaining buffers
        let { outputItems, nextItemId, cmdBuffer, reasoningLineBuffer } = state;
        const newItems: OutputItem[] = [];

        if (cmdBuffer) {
          newItems.push({ id: nextItemId++, text: chalk.dim(cmdBuffer) });
          cmdBuffer = "";
        }
        if (reasoningLineBuffer) {
          newItems.push({ id: nextItemId++, text: chalk.dim(renderReasoningLine(reasoningLineBuffer)) });
          reasoningLineBuffer = "";
        }

        return {
          ...state,
          outputItems: [...outputItems, ...newItems],
          nextItemId,
          cmdBuffer,
          reasoningLineBuffer,
          streamingLine: "",
          reasoningText: "",
          reasoningAccum: "",
          showReasoning: false,
          phase: mode === "single-shot" ? "done" : "idle",
        };
      }

      case "error": {
        const items = addItem(state, chalk.red(`error: ${action.message}`));
        return { ...state, ...items };
      }

      case "submit": {
        const items = addItem(state, chalk.green("you> ") + action.text);
        return { ...state, ...items };
      }

      default:
        return state;
    }
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

const INITIAL_STATE: AppState = {
  phase: "connecting",
  outputItems: [],
  nextItemId: 0,
  streamingLine: "",
  showReasoning: false,
  reasoningText: "",
  reasoningAccum: "",
  reasoningLineBuffer: "",
  reasoningSection: 0,
  needsReasoningHeader: true,
  approvalDetails: "",
  cmdBuffer: "",
};

export function useAppReducer(config: Config, mode: "repl" | "single-shot") {
  return useReducer(createReducer(config, mode), INITIAL_STATE);
}
