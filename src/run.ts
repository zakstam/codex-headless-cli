import React from "react";
import { render } from "ink";
import { App } from "./components/App.js";
import { BridgeSession } from "./bridge.js";
import type { Config } from "./config.js";

type RunOptions =
  | { mode: "repl" }
  | { mode: "single-shot"; query: string };

export async function run(config: Config, options: RunOptions): Promise<void> {
  const session = new BridgeSession(config);
  const { waitUntilExit } = render(
    React.createElement(App, {
      session,
      config,
      mode: options.mode,
      ...(options.mode === "single-shot" ? { initialQuery: options.query } : {}),
    }),
  );
  await waitUntilExit();
  session.stop();
}
