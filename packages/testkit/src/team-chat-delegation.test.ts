import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  TeamChatInboundMessage,
  TeamChatProvider,
  TeamChatSendRequest,
} from "@rakazo/adapter-kit";
import { messageBot, returnBotMessageOutcome } from "@rakazo/adapters";
import { createDb, createThreadEvents, createThreadMessage, pauseRunForInput } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TeamChatBridge } from "../../../apps/api/src/team-chat-bridge.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("Slack to Arthur to James delegation", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-team-chat-delegation-"));
  const provider = new FakeTeamChatProvider();
  const jobs = { enqueue: vi.fn(async () => undefined) };
  let prisma: ReturnType<typeof createDb>["prisma"];
  let pool: ReturnType<typeof createDb>["pool"];
  let bridge: TeamChatBridge;
  let arthur: { id: string };
  let james: { id: string };

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.js");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      signupsEnabled: "true",
    });
    const cookie = await signup(
      handles.app,
      `arthur-james-${Date.now()}@rakazo.test`,
      "Migration Owner",
    );
    arthur = await rpc(handles.app, cookie, "bots/create", botInput("Arthur"));
    james = await rpc(handles.app, cookie, "bots/create", botInput("James Baker"));
    await handles.stop();

    ({ prisma, pool } = createDb(process.env.DATABASE_URL!));
    bridge = new TeamChatBridge({
      prisma,
      events: createThreadEvents(prisma),
      jobs,
      provider,
      botId: arthur.id,
      reconcileIntervalMs: 60_000,
    });
    await bridge.start();
  });

  afterAll(async () => {
    await bridge?.stop();
    await prisma?.$disconnect();
    await pool?.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists two joined handoffs and returns each result to its original Slack thread", async () => {
    await dispatch("Ev-1", "100.1", "Review the launch plan", "JB", "Launch is ready.");
    await dispatch("Ev-2", "200.2", "Review the renewal plan", "James", "Renewal is ready.");

    expect(provider.sent).toEqual([
      { conversationId: "C-1", replyThreadId: "100.1", content: "Launch is ready." },
      { conversationId: "C-1", replyThreadId: "200.2", content: "Renewal is ready." },
    ]);
    expect(
      await prisma.externalMessage.count({
        where: { status: "running", externalConversation: { botId: arthur.id } },
      }),
    ).toBe(2);
    expect(
      await prisma.run.count({
        where: {
          botId: { in: [arthur.id, james.id] },
          trigger: "bot_message",
          status: "completed",
        },
      }),
    ).toBe(4);
  });

  it("delivers a James question and resumes the exact persisted objective once", async () => {
    const { jamesRun } = await handoff(
      "Ev-question",
      "300.3",
      "Build the launch plan and preserve this objective",
      "JB",
    );
    await prisma.run.update({
      where: { id: jamesRun.id },
      data: { status: "running", leaseOwner: "test-worker", leaseFence: 1 },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: jamesRun.id, fence: 1, status: "running" },
    });
    expect(
      await pauseRunForInput(prisma, {
        spaceId: jamesRun.spaceId,
        threadId: jamesRun.threadId,
        botId: james.id,
        runId: jamesRun.id,
        attemptId: attempt.id,
        leaseOwner: "test-worker",
        leaseFence: 1,
        blocks: [
          {
            kind: "ask",
            text: "Which launch date should I use?",
            status: "pending",
            actions: [
              { id: "monday", label: "Monday" },
              { id: "tuesday", label: "Tuesday" },
            ],
          },
        ],
        offeredActions: [
          { id: "monday", label: "Monday" },
          { id: "tuesday", label: "Tuesday" },
        ],
      }),
    ).toBe(true);

    await bridge.reconcileOnce();
    expect(provider.sent.at(-1)).toEqual({
      conversationId: "C-1",
      replyThreadId: "300.3",
      content: "Which launch date should I use?\n\nReply with one of:\n- Monday\n- Tuesday",
    });

    const answer: TeamChatInboundMessage = {
      eventId: "Ev-answer",
      workspaceId: "T-1",
      kind: "mention",
      conversationType: "channel",
      conversationKey: "channel:C-1",
      conversationId: "C-1",
      replyThreadId: "300.3",
      senderId: "U-1",
      senderName: "Ada",
      content: "Tuesday",
    };
    await provider.emit(answer);
    await provider.emit(answer);

    const resumed = await prisma.run.findUniqueOrThrow({
      where: { id: jamesRun.id },
      include: { task: true },
    });
    expect(resumed.status).toBe("queued");
    expect(resumed.task.prompt).toContain("Build the launch plan and preserve this objective");
    expect(resumed.task.prompt).toContain("Human answer: Selected choice tuesday: Tuesday");
    expect(jobs.enqueue).toHaveBeenCalledWith({
      name: "run.continue",
      payload: { runId: jamesRun.id },
      replaceKey: `run:${jamesRun.id}`,
    });
    const persistedAnswer = await prisma.externalMessage.findFirstOrThrow({
      where: { providerEventId: "Ev-answer" },
    });
    expect(persistedAnswer).toMatchObject({
      status: "answered",
      answerRunId: jamesRun.id,
    });
    expect(await prisma.externalMessage.count({ where: { providerEventId: "Ev-answer" } })).toBe(1);
  });

  async function dispatch(
    eventId: string,
    replyThreadId: string,
    request: string,
    alias: string,
    result: string,
  ) {
    const { jamesRun } = await handoff(eventId, replyThreadId, request, alias);
    await prisma.run.update({ where: { id: jamesRun.id }, data: { status: "completed" } });

    expect(
      await returnBotMessageOutcome(
        { prisma, events: createThreadEvents(prisma), jobs } as never,
        jamesRun,
        { id: james.id, name: "James Baker" },
        result,
      ),
    ).toBe(true);
    const arthurReturn = await prisma.run.findFirstOrThrow({
      where: {
        botId: arthur.id,
        trigger: "bot_message",
        status: "queued",
        sourceMessageId: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });
    await prisma.run.update({ where: { id: arthurReturn.id }, data: { status: "completed" } });
    await createThreadMessage(prisma, {
      threadId: arthurReturn.threadId,
      role: "bot",
      blocks: [{ kind: "text", text: result }],
      botId: arthur.id,
      runId: arthurReturn.id,
    });
    await bridge.reconcileOnce();
  }

  async function handoff(eventId: string, replyThreadId: string, request: string, alias: string) {
    await provider.emit({
      eventId,
      workspaceId: "T-1",
      kind: "mention",
      conversationType: "channel",
      conversationKey: "channel:C-1",
      conversationId: "C-1",
      replyThreadId,
      senderId: "U-1",
      senderName: "Ada",
      content: request,
    });
    const external = await prisma.externalMessage.findUniqueOrThrow({
      where: {
        externalConversationId_providerEventId: {
          externalConversationId: (
            await prisma.externalConversation.findUniqueOrThrow({
              where: {
                provider_workspaceId_externalKey: {
                  provider: "slack",
                  workspaceId: "T-1",
                  externalKey: "channel:C-1",
                },
              },
            })
          ).id,
          providerEventId: eventId,
        },
      },
      include: { run: true },
    });
    if (!external.run) throw new Error("Slack request did not create Arthur's run");
    await prisma.run.update({ where: { id: external.run.id }, data: { status: "running" } });

    const sent = await messageBot(
      { prisma, events: createThreadEvents(prisma), jobs } as never,
      external.run,
      { id: arthur.id, name: "Arthur" },
      { confirm_name: alias, message: request, intent: "request" },
    );
    if (!sent.ok) throw new Error(sent.error);
    const jamesRun = await prisma.run.findFirstOrThrow({
      where: { botId: james.id, trigger: "bot_message", status: "queued" },
      orderBy: { createdAt: "desc" },
    });
    expect(jamesRun.botId).toBe(james.id);
    return { external, jamesRun };
  }
});

class FakeTeamChatProvider implements TeamChatProvider {
  readonly id = "slack";
  readonly sent: TeamChatSendRequest[] = [];
  private handle: ((message: TeamChatInboundMessage) => Promise<void>) | undefined;

  async start(handle: (message: TeamChatInboundMessage) => Promise<void>): Promise<void> {
    this.handle = handle;
  }

  async stop(): Promise<void> {}

  async send(request: TeamChatSendRequest): Promise<{ handle: string }> {
    this.sent.push(request);
    return { handle: `reply-${this.sent.length}` };
  }

  async emit(message: TeamChatInboundMessage): Promise<void> {
    if (!this.handle) throw new Error("provider not started");
    await this.handle(message);
  }
}

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) throw new Error(`signup failed: ${await response.text()}`);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return payload.json as T;
}
