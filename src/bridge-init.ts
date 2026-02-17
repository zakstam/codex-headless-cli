import type { ClientNotification, ClientRequest } from "@zakstam/codex-local-component/protocol";

export const CLIENT_INFO = {
  name: "codex_headless_cli",
  title: "Codex Headless CLI",
  version: "0.1.0",
} as const;

/**
 * Build the initialize + initialized handshake messages.
 * Shared between bridge.ts (session startup) and models.ts (model discovery).
 */
export function buildInitSequence(nextId: () => number): [ClientRequest, ClientNotification] {
  const initReq: ClientRequest = {
    method: "initialize",
    id: nextId(),
    params: {
      clientInfo: { ...CLIENT_INFO },
      capabilities: null,
    },
  };
  const initialized: ClientNotification = { method: "initialized" };
  return [initReq, initialized];
}
