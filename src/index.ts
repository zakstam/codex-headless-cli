#!/usr/bin/env node

import { execSync } from "node:child_process";
import { stdout } from "node:process";
import { loadConfig, createConfig } from "./config.js";
import { runSingleShot } from "./single-shot.js";
import { runRepl } from "./repl.js";
import { printError } from "./ui.js";

// Safety net: always restore terminal state on exit (show cursor, reset scroll region)
process.on("exit", () => {
  try {
    stdout.write("\x1b[?25h\x1b[r");
  } catch {
    // stdout may already be closed
  }
});

function codexBinaryExists(bin?: string): boolean {
  const target = bin ?? "codex";
  try {
    execSync(`which ${target}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--setup")) {
    console.log("Running setup wizard...\n");
    await createConfig();
    return;
  }

  let config = loadConfig();

  if (!config) {
    console.log("No configuration found. Running setup wizard...\n");
    config = await createConfig();
    console.log("\nSetup complete. Run zz again to start.\n");
    return;
  }

  if (!codexBinaryExists(config.codexBin)) {
    const bin = config.codexBin ?? "codex";
    printError(
      `codex binary not found: "${bin}". Install the codex CLI or set codexBin in config.`,
    );
    process.exit(1);
  }

  const isDebug = args.includes("--debug");
  const query = args.filter((a) => a !== "--debug").join(" ");

  if (isDebug) {
    config.debug = true;
    const debugPrompt = `Do the following steps one at a time, explaining your reasoning at each step:
1. List the files in the current directory
2. Pick 3 files.
3. For each file, determine if it is a text file or a binary file.
4. Reason and Wait for 1 second on each step.`;
    await runSingleShot(config, debugPrompt);
  } else if (query) {
    await runSingleShot(config, query);
  } else {
    await runRepl(config);
  }
}

main().catch((error) => {
  printError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
