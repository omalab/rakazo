import { describe, expect, it } from "vitest";
import { configuredWorkerModel } from "./worker-model.js";

describe("configured tactical worker model", () => {
  it("falls back to the manager only when no worker profile is configured", () => {
    expect(configuredWorkerModel({})).toBeUndefined();
  });

  it("returns a provider-neutral independent model with low reasoning by default", () => {
    expect(
      configuredWorkerModel({
        PI_WORKER_PROVIDER: " openai-codex ",
        PI_WORKER_MODEL: " gpt-5.1-codex-mini ",
      }),
    ).toEqual({
      provider: "openai-codex",
      id: "gpt-5.1-codex-mini",
      thinkingLevel: "low",
    });
  });

  it("fails closed instead of silently using the manager for a partial profile", () => {
    expect(() => configuredWorkerModel({ PI_WORKER_PROVIDER: "openai-codex" })).toThrow(
      "PI_WORKER_PROVIDER and PI_WORKER_MODEL must be set together",
    );
  });
});
