import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchAvailableModels } from "./models.js";

const CONFIG_DIR = join(homedir(), ".config", "zz");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type ApprovalMode = "auto-approve" | "prompt" | "deny";
export type SandboxMode = "read-only" | "workspace-write" | "full-access";

export type Config = {
  model?: string;
  approvalMode: ApprovalMode;
  sandbox: SandboxMode;
  reasoningOnly: boolean;
  codexBin?: string;
  debug?: boolean;
};

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      sandbox: "workspace-write",
      reasoningOnly: false,
      ...parsed,
      approvalMode: parsed.approvalMode ?? "prompt",
    } as Config;
  } catch {
    console.error(`Error reading config at ${CONFIG_PATH}`);
    return null;
  }
}

export async function createConfig(): Promise<Config> {
  const { default: inquirer } = await import("inquirer");

  // Ask for codex binary path first so we can use it to fetch models
  const { codexBin } = await inquirer.prompt([
    {
      type: "input",
      name: "codexBin",
      message: "Path to codex binary (leave blank for default):",
      default: "",
    },
  ]);

  // Fetch available models from the codex server
  console.log("Fetching available models from codex...");
  const models = await fetchAvailableModels(codexBin || undefined);

  let modelChoices: Array<{ name: string; value: string }>;

  if (models.length > 0) {
    modelChoices = models.map((m) => ({
      name: m.isDefault
        ? `${m.displayName} — ${m.description} (default)`
        : `${m.displayName} — ${m.description}`,
      value: m.model,
    }));
    // Put default model first
    modelChoices.sort((a, b) => {
      const aDefault = models.find((m) => m.model === a.value)?.isDefault;
      const bDefault = models.find((m) => m.model === b.value)?.isDefault;
      if (aDefault && !bDefault) return -1;
      if (!aDefault && bDefault) return 1;
      return 0;
    });
    modelChoices.push({ name: "Custom (enter manually)", value: "__custom__" });
  } else {
    console.log(
      "Could not fetch models from codex. Showing manual entry instead.",
    );
    modelChoices = [{ name: "Enter model name manually", value: "__custom__" }];
  }

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "model",
      message: "Choose a model:",
      choices: modelChoices,
    },
    {
      type: "input",
      name: "customModel",
      message: "Enter custom model name:",
      when: (ans: Record<string, unknown>) => ans.model === "__custom__",
    },
    {
      type: "list",
      name: "approvalMode",
      message: "Approval mode for commands/file changes:",
      choices: [
        {
          name: "Prompt — ask before each action",
          value: "prompt",
        },
        {
          name: "Auto-approve — allow all actions automatically",
          value: "auto-approve",
        },
        {
          name: "Deny — reject all actions",
          value: "deny",
        },
      ],
    },
    {
      type: "list",
      name: "sandbox",
      message: "Sandbox mode for command execution:",
      choices: [
        {
          name: "Workspace write — can read/write within the project",
          value: "workspace-write",
        },
        {
          name: "Full access — no sandbox (needed for GUI apps, system commands)",
          value: "full-access",
        },
        {
          name: "Read only — can only read files",
          value: "read-only",
        },
      ],
    },
    {
      type: "confirm",
      name: "reasoningOnly",
      message: "Reasoning-only mode? (show thinking but omit the response text)",
      default: false,
    },
  ]);

  const config: Config = {
    model:
      answers.model === "__custom__" ? answers.customModel : answers.model,
    approvalMode: answers.approvalMode as ApprovalMode,
    sandbox: answers.sandbox as SandboxMode,
    reasoningOnly: answers.reasoningOnly as boolean,
    ...(codexBin ? { codexBin } : {}),
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`Config saved to ${CONFIG_PATH}`);
  return config;
}
