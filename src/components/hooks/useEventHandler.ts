import { useEffect, useRef, type Dispatch } from "react";
import { useApp } from "ink";
import chalk from "chalk";
import { BridgeSession } from "../../bridge.js";
import type { AppEvent } from "../../bridge.js";
import { MarkdownWriter } from "../../markdown.js";
import { parseApprovalPayload } from "../../approvals.js";
import { useAppReducer, type AppAction, type AppState } from "./useAppReducer.js";
import type { Config } from "../../config.js";

export function useEventHandler(
  session: BridgeSession,
  config: Config,
  mode: "repl" | "single-shot",
  initialQuery?: string,
): { state: AppState; dispatch: Dispatch<AppAction>; approvalRespondRef: React.RefObject<((d: "accept" | "decline") => void) | null> } {
  const { exit } = useApp();
  const [state, dispatch] = useAppReducer(config, mode);
  const approvalRespondRef = useRef<((d: "accept" | "decline") => void) | null>(null);

  // Initialize MarkdownWriter
  const mdRef = useRef<MarkdownWriter | null>(null);
  if (!mdRef.current) {
    mdRef.current = new MarkdownWriter((line: string) => {
      dispatch({ type: "md-line", line });
    });
  }
  const md = mdRef.current;

  // Subscribe to bridge events
  useEffect(() => {
    const handler = (event: AppEvent) => {
      switch (event.type) {
        case "thread-ready":
          dispatch(event);
          if (mode === "single-shot" && initialQuery) {
            session.runTurn(initialQuery).catch((err: Error) => {
              dispatch({ type: "error", message: err.message });
              exit();
            });
          }
          break;

        case "response-delta":
          dispatch(event);
          if (!config.reasoningOnly) {
            md.addDelta(event.delta);
            dispatch({ type: "md-buffer", buffer: md.getBuffer() });
          }
          break;

        case "reasoning-delta":
          // If currently streaming, flush markdown first
          md.flush();
          dispatch(event);
          break;

        case "turn-complete":
          md.flush();
          dispatch(event);
          if (mode === "single-shot") {
            exit();
          }
          break;

        case "approval-request": {
          const payload = parseApprovalPayload(event.payloadJson);
          if (!payload) {
            event.respond("decline");
            dispatch(event);
            break;
          }

          if (config.approvalMode === "auto-approve") {
            event.respond("accept");
            dispatch(event);
            break;
          }
          if (config.approvalMode === "deny") {
            event.respond("decline");
            dispatch(event);
            break;
          }

          // Prompt mode — store respond callback for keyboard handler
          approvalRespondRef.current = event.respond;
          dispatch(event);
          break;
        }

        default:
          dispatch(event);
          break;
      }
    };

    session.setEventCallback(handler);
    return () => {
      session.setEventCallback(() => {});
    };
  }, [session, config, mode, initialQuery, md, exit, dispatch]);

  // Start connection on mount
  useEffect(() => {
    session.waitForThreadStart().catch((err: Error) => {
      dispatch({ type: "error", message: `Connection failed: ${err.message}` });
      if (mode === "single-shot") exit();
    });
  }, [session, mode, exit, dispatch]);

  return { state, dispatch, approvalRespondRef };
}
