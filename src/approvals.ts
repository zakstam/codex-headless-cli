import chalk from "chalk";
import type { CodexLocalBridge } from "@zakstam/codex-local-component/host";
import {
  buildCommandExecutionApprovalResponse,
  buildFileChangeApprovalResponse,
} from "@zakstam/codex-local-component/host";
import type { ApprovalMode } from "./config.js";
import { parseServerMessage } from "./protocol.js";

type ApprovalPayload = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

function parseApprovalPayload(payloadJson: string): ApprovalPayload | null {
  const msg = parseServerMessage(payloadJson) as Record<string, unknown>;
  if (
    !msg ||
    typeof msg.id === "undefined" ||
    typeof msg.method !== "string"
  ) {
    return null;
  }
  return msg as unknown as ApprovalPayload;
}

function describeCommandApproval(params: Record<string, unknown>): string {
  // The v2 approval params include `command` (the actual command string),
  // `cwd`, and optionally `commandActions` for friendly display.
  const command =
    typeof params.command === "string" ? params.command : null;
  const cwd = typeof params.cwd === "string" ? params.cwd : null;
  const reason = typeof params.reason === "string" ? params.reason : null;

  const parts: string[] = [];
  if (command) {
    parts.push(chalk.bold.white(command));
  }
  if (cwd) {
    parts.push(chalk.gray(`(in ${cwd})`));
  }
  if (reason) {
    parts.push(chalk.dim(`— ${reason}`));
  }
  return parts.length > 0 ? parts.join(" ") : "command execution";
}

function describeFileChangeApproval(params: Record<string, unknown>): string {
  const reason = typeof params.reason === "string" ? params.reason : null;
  const itemId = typeof params.itemId === "string" ? params.itemId : null;

  const parts: string[] = ["File change"];
  if (itemId) {
    parts.push(chalk.bold.white(itemId));
  }
  if (reason) {
    parts.push(chalk.dim(`— ${reason}`));
  }
  return parts.join(" ");
}

function describeApproval(payload: ApprovalPayload): string {
  const params = payload.params ?? {};
  if (payload.method === "item/commandExecution/requestApproval") {
    return describeCommandApproval(params);
  }
  if (payload.method === "item/fileChange/requestApproval") {
    return describeFileChangeApproval(params);
  }
  return `Unknown approval: ${payload.method}`;
}

export async function handleApproval(
  bridge: CodexLocalBridge,
  kind: string,
  payloadJson: string,
  approvalMode: ApprovalMode,
): Promise<void> {
  const payload = parseApprovalPayload(payloadJson);
  if (!payload) {
    return;
  }

  const description = describeApproval(payload);

  if (approvalMode === "auto-approve") {
    console.log(chalk.green(`  [auto-approved] `) + description);
    sendApprovalResponse(bridge, kind, payload.id, "accept");
    return;
  }

  if (approvalMode === "deny") {
    console.log(chalk.red(`  [denied] `) + description);
    sendApprovalResponse(bridge, kind, payload.id, "decline");
    return;
  }

  // Prompt mode — show full details and ask
  console.log(chalk.yellow(`\n  [approval required] `) + description);
  const { default: inquirer } = await import("inquirer");
  const { approved } = await inquirer.prompt([
    {
      type: "confirm",
      name: "approved",
      message: "Approve this action?",
      default: true,
    },
  ]);

  sendApprovalResponse(
    bridge,
    kind,
    payload.id,
    approved ? "accept" : "decline",
  );
}

function sendApprovalResponse(
  bridge: CodexLocalBridge,
  kind: string,
  requestId: number | string,
  decision: "accept" | "decline",
): void {
  if (kind === "item/commandExecution/requestApproval") {
    bridge.send(buildCommandExecutionApprovalResponse(requestId, decision));
  } else if (kind === "item/fileChange/requestApproval") {
    bridge.send(buildFileChangeApprovalResponse(requestId, decision));
  }
}
