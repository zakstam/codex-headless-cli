import { useRef, type Dispatch, type RefObject } from "react";
import { useApp, useInput } from "ink";
import { BridgeSession } from "../../bridge.js";
import type { AppState, AppAction } from "./useAppReducer.js";

export function useKeyboard(
  session: BridgeSession,
  state: AppState,
  dispatch: Dispatch<AppAction>,
  approvalRespondRef: RefObject<((d: "accept" | "decline") => void) | null>,
): void {
  const { exit } = useApp();
  const lastCtrlCRef = useRef(0);

  const turnActive =
    state.phase === "waiting" ||
    state.phase === "streaming" ||
    state.phase === "approval";

  useInput(
    (input, key) => {
      const phase = state.phase;

      if (key.ctrl && input === "c") {
        const now = Date.now();
        if (now - lastCtrlCRef.current < 1000) {
          session.stop();
          exit();
          return;
        }
        lastCtrlCRef.current = now;

        if (phase === "waiting" || phase === "streaming") {
          session.interruptTurn();
        } else {
          session.stop();
          exit();
        }
        return;
      }

      if (input === "i" && (phase === "waiting" || phase === "streaming")) {
        session.interruptTurn();
        return;
      }

      if (phase === "approval") {
        if (input === "y") {
          approvalRespondRef.current?.("accept");
          dispatch({
            type: "approve-decision",
            decision: "accept",
            details: state.approvalDetails,
          });
          approvalRespondRef.current = null;
        } else if (input === "n") {
          approvalRespondRef.current?.("decline");
          dispatch({
            type: "approve-decision",
            decision: "decline",
            details: state.approvalDetails,
          });
          approvalRespondRef.current = null;
        }
      }
    },
    { isActive: turnActive },
  );
}
