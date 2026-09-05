import { describe, expect, it } from "vitest";
import { boundWorkerContext, workerExecutionBudget } from "./pi-runtime.js";

describe("native tactical worker boundaries", () => {
  it("bounds delegated task and instruction context before the worker model sees it", () => {
    const task = `objective:${"x".repeat(20_000)}`;
    const instructions = `evidence:${"y".repeat(20_000)}`;

    const bounded = boundWorkerContext(task, instructions);

    expect(bounded.task).toContain("objective:");
    expect(bounded.instructions).toContain("evidence:");
    expect(bounded.task.length + bounded.instructions.length).toBeLessThanOrEqual(12_000);
    expect(`${bounded.task}${bounded.instructions}`).toContain("[worker context truncated]");
  });

  it("requires finite per-worker budgets and clamps them to deployment ceilings", () => {
    expect(workerExecutionBudget({})).toEqual({ maxToolCalls: 12, maxDurationMs: 120_000 });
    expect(workerExecutionBudget({ max_tool_calls: 0.5, max_duration_seconds: 1 })).toEqual({
      maxToolCalls: 12,
      maxDurationMs: 120_000,
    });
    expect(workerExecutionBudget({ max_tool_calls: 3, max_duration_seconds: 15 })).toEqual({
      maxToolCalls: 3,
      maxDurationMs: 15_000,
    });
    expect(workerExecutionBudget({ max_tool_calls: 50_000, max_duration_seconds: 50_000 })).toEqual(
      { maxToolCalls: 40, maxDurationMs: 600_000 },
    );
  });
});
