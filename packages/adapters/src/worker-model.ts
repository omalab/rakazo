import type { AgentRunRequest } from "@rakazo/adapter-kit";

const THINKING_LEVELS = new Set<NonNullable<AgentRunRequest["model"]["thinkingLevel"]>>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function configuredWorkerModel(
  env: NodeJS.ProcessEnv = process.env,
): Pick<AgentRunRequest["model"], "provider" | "id" | "thinkingLevel"> | undefined {
  const provider = env.PI_WORKER_PROVIDER?.trim();
  const id = env.PI_WORKER_MODEL?.trim();
  if (!provider && !id) return undefined;
  if (!provider || !id) {
    throw new Error("PI_WORKER_PROVIDER and PI_WORKER_MODEL must be set together");
  }
  const configuredThinking = env.PI_WORKER_THINKING_LEVEL?.trim();
  if (configuredThinking && !THINKING_LEVELS.has(configuredThinking as never)) {
    throw new Error(`Unsupported PI_WORKER_THINKING_LEVEL: ${configuredThinking}`);
  }
  return {
    provider,
    id,
    thinkingLevel: (configuredThinking as AgentRunRequest["model"]["thinkingLevel"]) || "low",
  };
}
