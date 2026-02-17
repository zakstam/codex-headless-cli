import React from "react";
import { render } from "ink";
import { App } from "./components/App.js";
import { AppEventBus } from "./events.js";
import { createBridgeSession } from "./bridge.js";
import type { Config } from "./config.js";

export async function runRepl(config: Config): Promise<void> {
  const bus = new AppEventBus();
  const session = createBridgeSession(config, bus);
  const { waitUntilExit } = render(
    React.createElement(App, { bus, session, config, mode: "repl" as const }),
  );
  await waitUntilExit();
  session.stop();
}
