import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { createBridgeSession } from "./bridge.js";
import { createSpinner, printError, printWelcome } from "./ui.js";
import type { Config } from "./config.js";

function printHelp(): void {
  console.log(chalk.gray("\nCommands:"));
  console.log(chalk.gray("  /help       — show this help"));
  console.log(chalk.gray("  /interrupt  — interrupt current turn (or press 'i')"));
  console.log(chalk.gray("  /exit       — exit the REPL\n"));
}

export async function runRepl(config: Config): Promise<void> {
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

  let threadId: string;
  try {
    threadId = await session.waitForThreadStart();
    spinner.stop();
  } catch (error) {
    spinner.fail("Failed to start thread");
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    process.off("SIGINT", sigintHandler);
  }

  printWelcome(threadId);

  // Readline history (newest first, as readline expects)
  const history: string[] = [];

  while (true) {
    // Create a fresh readline per prompt so it doesn't conflict
    // with raw-mode key listener during turns
    const rl = createInterface({ input: stdin, output: stdout, history: [...history] });
    let line = "";
    try {
      line = (await rl.question(chalk.green("you> "))).trim();
    } catch (error) {
      rl.close();
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("readline was closed")) {
        break;
      }
      throw error;
    }
    rl.close();

    if (!line) {
      continue;
    }

    // Track history (newest first, dedup consecutive)
    if (history[0] !== line) {
      history.unshift(line);
      if (history.length > 100) history.pop();
    }

    if (line === "/exit") {
      break;
    }

    if (line === "/help") {
      printHelp();
      continue;
    }

    if (line === "/interrupt") {
      session.interruptTurn();
      continue;
    }

    try {
      await session.runTurn(line);
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
    }
  }

  session.stop();
}
