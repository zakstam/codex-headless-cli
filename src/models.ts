import { CodexLocalBridge } from "@zakstam/codex-local-component/host";
import type { ClientRequest } from "@zakstam/codex-local-component/protocol";
import { isResponse } from "./protocol.js";
import { buildInitSequence } from "./bridge-init.js";

type ModelInfo = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
};

type ModelListResult = {
  data: ModelInfo[];
};

/**
 * Temporarily spin up a bridge, send initialize + model/list, return the
 * available models, then shut down.  Falls back to an empty list on failure.
 */
export async function fetchAvailableModels(
  codexBin?: string,
): Promise<ModelInfo[]> {
  return new Promise<ModelInfo[]>((resolveOuter) => {
    let nextId = 1;
    const requestId = () => nextId++;

    const modelListId = 3; // we'll use id 3 for the model/list request
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        bridge.stop();
        resolveOuter([]);
      }
    }, 15_000);

    const bridge = new CodexLocalBridge(
      {
        ...(codexBin ? { codexBin } : {}),
        cwd: process.cwd(),
      },
      {
        onEvent: async () => {
          // We don't care about thread events here
        },

        onGlobalMessage: async (message) => {
          if (!isResponse(message)) {
            return;
          }
          if (typeof message.id !== "number") {
            return;
          }

          // Response to model/list
          if (message.id === modelListId && !settled) {
            settled = true;
            clearTimeout(timeout);
            bridge.stop();

            if (message.error) {
              resolveOuter([]);
              return;
            }

            const result = (message as Record<string, unknown>)
              .result as ModelListResult | undefined;
            if (result?.data && Array.isArray(result.data)) {
              resolveOuter(
                result.data.map((m) => ({
                  id: m.id,
                  model: m.model,
                  displayName: m.displayName,
                  description: m.description,
                  isDefault: m.isDefault,
                })),
              );
            } else {
              resolveOuter([]);
            }
          }
        },

        onProtocolError: async () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            bridge.stop();
            resolveOuter([]);
          }
        },

        onProcessExit: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolveOuter([]);
          }
        },
      },
    );

    bridge.start();

    const [initReq, initialized] = buildInitSequence(requestId);
    bridge.send(initReq);
    bridge.send(initialized);

    // Fetch model list
    const modelListReq: ClientRequest = {
      method: "model/list" as string,
      id: modelListId,
      params: {},
    } as ClientRequest;
    bridge.send(modelListReq);
  });
}
