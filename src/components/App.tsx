import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import chalk from "chalk";
import { ReasoningBar } from "./ReasoningBar.js";
import { InputLine } from "./InputLine.js";
import { MarkdownWriter } from "../markdown.js";
import { describeApproval, parseApprovalPayload } from "../approvals.js";
import type { AppEvent, AppEventBus } from "../events.js";
import type { BridgeSession } from "../bridge.js";
import type { Config } from "../config.js";

type OutputItem = { id: number; text: string };

// Phase tracks content flow only — reasoning is independent.
type Phase =
  | "connecting"
  | "waiting"
  | "streaming"
  | "approval"
  | "idle"
  | "done";

type AppProps = {
  bus: AppEventBus;
  session: BridgeSession;
  config: Config;
  mode: "repl" | "single-shot";
  initialQuery?: string;
};

/** Render **bold** markers as chalk.bold within dim text. */
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

export function App({ bus, session, config, mode, initialQuery }: AppProps) {
  const { exit } = useApp();
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [phase, setPhaseState] = useState<Phase>("connecting");
  const [reasoningText, setReasoningTextState] = useState("");
  const [showReasoning, setShowReasoningState] = useState(false);
  const [streamingLine, setStreamingLine] = useState("");
  const [approvalDetails, setApprovalDetailsState] = useState("");

  const phaseRef = useRef<Phase>("connecting");
  const reasoningTextRef = useRef("");
  const reasoningAccumRef = useRef(""); // raw delta accumulator (reset on section boundaries)
  const showReasoningRef = useRef(false);
  const approvalDetailsRef = useRef("");
  const approvalRespondRef = useRef<
    ((decision: "accept" | "decline") => void) | null
  >(null);
  const nextIdRef = useRef(0);
  const lastCtrlCRef = useRef(0);
  const cmdBufferRef = useRef("");
  const reasoningLineBufferRef = useRef("");
  const reasoningSectionRef = useRef(0);
  const needsReasoningHeaderRef = useRef(true);

  function setPhase(p: Phase) {
    phaseRef.current = p;
    setPhaseState(p);
  }

  function setReasoningText(t: string) {
    reasoningTextRef.current = t;
    setReasoningTextState(t);
  }

  function setShowReasoning(v: boolean) {
    showReasoningRef.current = v;
    setShowReasoningState(v);
  }

  function setApprovalDetails(d: string) {
    approvalDetailsRef.current = d;
    setApprovalDetailsState(d);
  }

  const addOutputItem = useCallback((text: string) => {
    const id = nextIdRef.current++;
    setOutputItems((prev) => [...prev, { id, text }]);
  }, []);

  // Initialize MarkdownWriter with line callback
  const mdRef = useRef<MarkdownWriter | null>(null);
  if (!mdRef.current) {
    mdRef.current = new MarkdownWriter((line: string) => {
      addOutputItem(line);
    });
  }
  const md = mdRef.current;

  // Event subscription
  useEffect(() => {
    const handler = (event: AppEvent) => {
      switch (event.type) {
        case "thread-ready": {
          if (mode === "repl") {
            addOutputItem(
              chalk.bold.cyan("\n  zz") +
                chalk.gray(` — thread ${event.threadId}\n`),
            );
            addOutputItem(chalk.gray("  Type a message and press Enter."));
            addOutputItem(
              chalk.gray("  Commands: /interrupt, /help, /exit\n"),
            );
            setPhase("idle");
          } else if (initialQuery) {
            session.runTurn(initialQuery).catch((err: Error) => {
              addOutputItem(chalk.red(`error: ${err.message}`));
              setPhase("done");
              exit();
            });
          }
          break;
        }

        case "waiting-start":
          setPhase("waiting");
          reasoningSectionRef.current = 0;
          needsReasoningHeaderRef.current = true;
          break;

        case "waiting-stop":
          // Next delta event will set the appropriate phase
          break;

        // --- Reasoning is independent of phase ---

        case "reasoning-delta": {
          // Activate reasoning overlay (persists until turn-complete)
          if (!showReasoningRef.current) {
            setShowReasoning(true);
          }

          // If response was streaming, flush it — new reasoning cycle
          if (phaseRef.current === "streaming") {
            md.flush();
            setStreamingLine("");
            setPhase("waiting");
            reasoningAccumRef.current = "";
            needsReasoningHeaderRef.current = true;
          }

          // reasoning-only mode: stream full reasoning text to Static output
          if (config.reasoningOnly) {
            // Emit section header on the first delta of a new reasoning block
            if (needsReasoningHeaderRef.current) {
              needsReasoningHeaderRef.current = false;
              // Flush leftover from previous section
              if (reasoningLineBufferRef.current) {
                addOutputItem(
                  chalk.dim(renderReasoningLine(reasoningLineBufferRef.current)),
                );
                reasoningLineBufferRef.current = "";
              }
              reasoningSectionRef.current++;
              addOutputItem(reasoningSectionDivider(reasoningSectionRef.current));
            }

            const all = reasoningLineBufferRef.current + event.delta;
            const parts = all.split("\n");
            for (let i = 0; i < parts.length - 1; i++) {
              addOutputItem(chalk.dim(renderReasoningLine(parts[i]!)));
            }
            reasoningLineBufferRef.current = parts[parts.length - 1]!;
          }

          // Update the reasoning bar text (last line only)
          reasoningAccumRef.current += event.delta;
          const nl = reasoningAccumRef.current.lastIndexOf("\n");
          if (nl !== -1) {
            const afterNl = reasoningAccumRef.current.slice(nl + 1);
            // Keep last line as accumulator, show it if non-empty
            reasoningAccumRef.current = afterNl;
            if (afterNl) {
              setReasoningText(afterNl);
            }
            // else: keep previous display text visible until new text arrives
          } else {
            // No newline yet — show what we have
            setReasoningText(reasoningAccumRef.current);
          }
          break;
        }

        case "reasoning-section-break": {
          // Reset accumulator so next section starts fresh
          reasoningAccumRef.current = "";
          if (config.reasoningOnly) {
            // Flush current buffer, then mark next delta for a new header
            if (reasoningLineBufferRef.current) {
              addOutputItem(
                chalk.dim(renderReasoningLine(reasoningLineBufferRef.current)),
              );
              reasoningLineBufferRef.current = "";
            }
            needsReasoningHeaderRef.current = true;
          }
          break;
        }

        // --- Content phases ---

        case "response-delta": {
          if (config.reasoningOnly) break;

          if (phaseRef.current !== "streaming") {
            if (config.debug) {
              addOutputItem(chalk.bold.magenta("[response]"));
            }
            setPhase("streaming");
          }

          md.addDelta(event.delta);
          setStreamingLine(md.getBuffer());
          break;
        }

        case "command-output-delta": {
          if (
            phaseRef.current === "waiting"
          ) {
            setPhase("streaming");
          }
          const all = cmdBufferRef.current + event.delta;
          const parts = all.split("\n");
          for (let i = 0; i < parts.length - 1; i++) {
            addOutputItem(chalk.dim(parts[i]!));
          }
          cmdBufferRef.current = parts[parts.length - 1]!;
          break;
        }

        case "debug-tag":
          addOutputItem(chalk.bold.magenta(`[${event.tag}]`));
          break;

        case "approval-request": {
          const payload = parseApprovalPayload(event.payloadJson);
          if (!payload) {
            event.respond("decline");
            break;
          }

          const description = describeApproval(payload);

          if (config.approvalMode === "auto-approve") {
            addOutputItem(chalk.green("  [auto-approved] ") + description);
            event.respond("accept");
            break;
          }
          if (config.approvalMode === "deny") {
            addOutputItem(chalk.red("  [denied] ") + description);
            event.respond("decline");
            break;
          }

          // Prompt mode — show approval UI
          setApprovalDetails(description);
          approvalRespondRef.current = event.respond;
          setPhase("approval");
          break;
        }

        case "turn-complete": {
          md.flush();
          if (cmdBufferRef.current) {
            addOutputItem(chalk.dim(cmdBufferRef.current));
            cmdBufferRef.current = "";
          }
          if (reasoningLineBufferRef.current) {
            addOutputItem(
              chalk.dim(renderReasoningLine(reasoningLineBufferRef.current)),
            );
            reasoningLineBufferRef.current = "";
          }
          setStreamingLine("");
          setReasoningText("");
          reasoningAccumRef.current = "";
          setShowReasoning(false);
          if (mode === "single-shot") {
            setPhase("done");
            exit();
          } else {
            setPhase("idle");
          }
          break;
        }

        case "error":
          addOutputItem(chalk.red(`error: ${event.message}`));
          break;
      }
    };

    bus.onApp(handler);
    return () => {
      bus.offApp(handler);
    };
  }, [bus, session, config, mode, initialQuery, md, exit, addOutputItem]);

  // Start connection on mount
  useEffect(() => {
    session.waitForThreadStart().catch((err: Error) => {
      addOutputItem(chalk.red(`Connection failed: ${err.message}`));
      setPhase("done");
      if (mode === "single-shot") exit();
    });
  }, [session, mode, exit, addOutputItem]);

  // Keyboard handling during turns and approval
  const turnActive =
    phase === "waiting" || phase === "streaming" || phase === "approval";

  useInput(
    (input, key) => {
      const current = phaseRef.current;

      if (key.ctrl && input === "c") {
        const now = Date.now();
        if (now - lastCtrlCRef.current < 1000) {
          session.stop();
          exit();
          return;
        }
        lastCtrlCRef.current = now;

        if (current === "waiting" || current === "streaming") {
          session.interruptTurn();
        } else {
          session.stop();
          exit();
        }
        return;
      }

      if (
        input === "i" &&
        (current === "waiting" || current === "streaming")
      ) {
        session.interruptTurn();
        return;
      }

      if (current === "approval") {
        if (input === "y") {
          approvalRespondRef.current?.("accept");
          addOutputItem(
            chalk.green("  [approved] ") + approvalDetailsRef.current,
          );
          approvalRespondRef.current = null;
          setApprovalDetails("");
          setPhase("waiting");
        } else if (input === "n") {
          approvalRespondRef.current?.("decline");
          addOutputItem(
            chalk.red("  [declined] ") + approvalDetailsRef.current,
          );
          approvalRespondRef.current = null;
          setApprovalDetails("");
          setPhase("waiting");
        }
      }
    },
    { isActive: turnActive },
  );

  // REPL submit handler
  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      if (text === "/exit") {
        session.stop();
        exit();
        return;
      }

      if (text === "/help") {
        addOutputItem(chalk.gray("\nCommands:"));
        addOutputItem(chalk.gray("  /help       — show this help"));
        addOutputItem(
          chalk.gray("  /interrupt  — interrupt current turn (or press 'i')"),
        );
        addOutputItem(chalk.gray("  /exit       — exit the REPL\n"));
        return;
      }

      if (text === "/interrupt") {
        session.interruptTurn();
        return;
      }

      addOutputItem(chalk.green("you> ") + text);

      session.runTurn(text).catch((err: Error) => {
        addOutputItem(chalk.red(`error: ${err.message}`));
        setPhase("idle");
      });
    },
    [session, exit, addOutputItem],
  );

  return (
    <>
      <Static items={outputItems}>
        {(item) => <Text key={item.id}>{item.text}</Text>}
      </Static>

      {phase === "connecting" && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Connecting to codex...</Text>
        </Text>
      )}

      {phase === "waiting" && !showReasoning && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Waiting for response...</Text>
        </Text>
      )}

      {phase === "streaming" && streamingLine ? (
        <Text>{streamingLine}</Text>
      ) : null}

      {phase === "approval" && (
        <Box flexDirection="column">
          <Text color="yellow">
            {"  [approval required] "}
            {approvalDetails}
          </Text>
          <Text dimColor> Press y to approve, n to decline</Text>
        </Box>
      )}

      {phase === "idle" && <InputLine onSubmit={handleSubmit} />}

      {/* Reasoning bar — always pinned at the bottom while turn is active */}
      {showReasoning && (
        <ReasoningBar text={reasoningText} debug={config.debug ?? false} />
      )}
    </>
  );
}
