import { Box, Text, Static } from "ink";
import Spinner from "ink-spinner";
import { ReasoningBar } from "./ReasoningBar.js";
import { InputLine } from "./InputLine.js";
import { useEventHandler } from "./hooks/useEventHandler.js";
import { useKeyboard } from "./hooks/useKeyboard.js";
import { useRepl } from "./hooks/useRepl.js";
import { BridgeSession } from "../bridge.js";
import type { Config } from "../config.js";

type AppProps = {
  session: BridgeSession;
  config: Config;
  mode: "repl" | "single-shot";
  initialQuery?: string;
};

export function App({ session, config, mode, initialQuery }: AppProps) {
  const { state, dispatch, approvalRespondRef } = useEventHandler(
    session,
    config,
    mode,
    initialQuery,
  );
  useKeyboard(session, state, dispatch, approvalRespondRef);
  const handleSubmit = useRepl(session, dispatch);

  return (
    <>
      <Static items={state.outputItems}>
        {(item) => <Text key={item.id}>{item.text}</Text>}
      </Static>

      {state.phase === "connecting" && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Connecting to codex...</Text>
        </Text>
      )}

      {state.phase === "waiting" && !state.showReasoning && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Waiting for response...</Text>
        </Text>
      )}

      {state.phase === "streaming" && state.streamingLine ? (
        <Text>{state.streamingLine}</Text>
      ) : null}

      {state.phase === "approval" && (
        <Box flexDirection="column">
          <Text color="yellow">
            {"  [approval required] "}
            {state.approvalDetails}
          </Text>
          <Text dimColor> Press y to approve, n to decline</Text>
        </Box>
      )}

      {state.phase === "idle" && <InputLine onSubmit={handleSubmit} />}

      {state.showReasoning && (
        <ReasoningBar text={state.reasoningText} debug={config.debug ?? false} />
      )}
    </>
  );
}
