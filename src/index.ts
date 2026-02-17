#!/usr/bin/env node

import { execSync } from "node:child_process";
import { loadConfig, createConfig } from "./config.js";
import { run } from "./run.js";

// Global error handlers — prevent silent crashes
process.on("unhandledRejection", (reason) => {
  console.error(
    `error: Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error(`error: Uncaught exception: ${error.message}`);
  process.exit(1);
});

// Graceful shutdown on SIGTERM (e.g. from process managers)
process.on("SIGTERM", () => {
  process.exit(0);
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
    console.error(
      `error: codex binary not found: "${bin}". Install the codex CLI or set codexBin in config.`,
    );
    process.exit(1);
  }

  const isDebug = args.includes("--debug");
  const isReasoningOnly = args.includes("--reasoning-only");
  const flagsToStrip = new Set(["--debug", "--reasoning-only"]);
  const query = args.filter((a) => !flagsToStrip.has(a)).join(" ");

  if (isReasoningOnly) {
    config.reasoningOnly = true;
  }

  if (isDebug) {
    config.debug = true;
    const debugPrompt = `Do the following steps one at a time, explaining your reasoning at each step:
1. List the files in the current directory
2. Pick 3 files.
3. For each file, determine if it is a text file or a binary file.
4. Reason and Wait for 1 second on each step.`;
    await run(config, { mode: "single-shot", query: debugPrompt });
  } else if (query) {
    await run(config, { mode: "single-shot", query });
  } else {
    await run(config, { mode: "repl" });
  }
}

main().catch((error) => {
  console.error(
    `error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
