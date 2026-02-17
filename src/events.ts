import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "thread-ready"; threadId: string }
  | { type: "waiting-start" }
  | { type: "waiting-stop" }
  | { type: "reasoning-delta"; delta: string }
  | { type: "reasoning-section-break" }
  | { type: "response-delta"; delta: string }
  | { type: "command-output-delta"; delta: string }
  | {
      type: "approval-request";
      kind: string;
      payloadJson: string;
      respond: (decision: "accept" | "decline") => void;
    }
  | { type: "turn-complete" }
  | { type: "error"; message: string }
  | { type: "debug-tag"; tag: string };

export class AppEventBus extends EventEmitter {
  emitApp(data: AppEvent): void {
    this.emit("app", data);
  }
  onApp(listener: (data: AppEvent) => void): void {
    this.on("app", listener);
  }
  offApp(listener: (data: AppEvent) => void): void {
    this.off("app", listener);
  }
}
