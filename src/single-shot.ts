import { createBridgeSession } from "./bridge.js";
import { createSpinner, printError } from "./ui.js";
import type { Config } from "./config.js";

export async function runSingleShot(
  config: Config,
  query: string,
): Promise<void> {
  const session = createBridgeSession(config);
  const spinner = createSpinner("Connecting to codex...");
  spinner.start();

  // Ctrl+C during connecting phase exits cleanly
  const sigintHandler = () => {
    spinner.stop();
    session.stop();
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  try {
    await session.waitForThreadStart();
    spinner.stop();
  } catch (error) {
    spinner.fail("Failed to start thread");
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    // During the turn, raw-mode key listener in bridge handles Ctrl+C
    process.off("SIGINT", sigintHandler);
  }

  try {
    await session.runTurn(query);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  } finally {
    session.stop();
  }
}
