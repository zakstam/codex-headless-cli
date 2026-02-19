import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAssistantDelta,
  extractCommandOutputDelta,
  extractReasoningEvent,
  getLifecycleEventType,
  isGlobalNoopNotification,
  isServerErrorMethod,
} from "./protocol.js";

test("extractAssistantDelta returns agent message delta", () => {
  const payload = JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_1",
      delta: "Hello",
    },
  });

  assert.equal(extractAssistantDelta("item/agentMessage/delta", payload), "Hello");
});

test("extractReasoningEvent returns section break and text delta", () => {
  const sectionBreakPayload = JSON.stringify({
    method: "item/reasoning/summaryPartAdded",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_1",
      summaryIndex: 1,
    },
  });
  const textDeltaPayload = JSON.stringify({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_1",
      summaryIndex: 1,
      delta: "Thinking",
    },
  });

  assert.deepEqual(extractReasoningEvent("item/reasoning/summaryPartAdded", sectionBreakPayload), {
    type: "section-break",
  });
  assert.deepEqual(extractReasoningEvent("item/reasoning/summaryTextDelta", textDeltaPayload), {
    type: "delta",
    delta: "Thinking",
  });
});

test("extractCommandOutputDelta returns output text", () => {
  const payload = JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_1",
      delta: "stdout line",
    },
  });

  assert.equal(extractCommandOutputDelta("item/commandExecution/outputDelta", payload), "stdout line");
});

test("getLifecycleEventType maps known lifecycle kinds", () => {
  assert.equal(getLifecycleEventType("thread/started"), "thread-started");
  assert.equal(getLifecycleEventType("turn/started"), "turn-started");
  assert.equal(getLifecycleEventType("turn/completed"), "turn-completed");
  assert.equal(getLifecycleEventType("item/completed"), "item-completed");
  assert.equal(getLifecycleEventType("item/agentMessage/delta"), null);
});

test("global notification helpers classify known methods", () => {
  assert.equal(isServerErrorMethod("error"), true);
  assert.equal(isServerErrorMethod("account/rateLimits/updated"), false);
  assert.equal(isGlobalNoopNotification("account/rateLimits/updated"), true);
  assert.equal(isGlobalNoopNotification("error"), false);
});
