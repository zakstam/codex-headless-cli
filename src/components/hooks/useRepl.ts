import { useCallback, type Dispatch } from "react";
import { useApp } from "ink";
import chalk from "chalk";
import { BridgeSession } from "../../bridge.js";
import type { AppAction } from "./useAppReducer.js";

export function useRepl(
  session: BridgeSession,
  dispatch: Dispatch<AppAction>,
): (text: string) => void {
  const { exit } = useApp();

  return useCallback(
    (text: string) => {
      if (!text.trim()) return;

      if (text === "/exit") {
        session.stop();
        exit();
        return;
      }

      if (text === "/help") {
        dispatch({ type: "md-line", line: chalk.gray("\nCommands:") });
        dispatch({ type: "md-line", line: chalk.gray("  /help       — show this help") });
        dispatch({ type: "md-line", line: chalk.gray("  /interrupt  — interrupt current turn (or press 'i')") });
        dispatch({ type: "md-line", line: chalk.gray("  /exit       — exit the REPL\n") });
        return;
      }

      if (text === "/interrupt") {
        session.interruptTurn();
        return;
      }

      dispatch({ type: "submit", text });

      session.runTurn(text).catch((err: Error) => {
        dispatch({ type: "error", message: err.message });
      });
    },
    [session, exit, dispatch],
  );
}
