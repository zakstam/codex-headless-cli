import chalk from "chalk";
import { parseServerMessage } from "./protocol.js";

export type ApprovalPayload = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

export function parseApprovalPayload(
  payloadJson: string,
): ApprovalPayload | null {
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
  const command = typeof params.command === "string" ? params.command : null;
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

export function describeApproval(payload: ApprovalPayload): string {
  const params = payload.params ?? {};
  if (payload.method === "item/commandExecution/requestApproval") {
    return describeCommandApproval(params);
  }
  if (payload.method === "item/fileChange/requestApproval") {
    return describeFileChangeApproval(params);
  }
  return `Unknown approval: ${payload.method}`;
}
