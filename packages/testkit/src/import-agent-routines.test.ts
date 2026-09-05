import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyImport,
  buildImportPlan,
  isLocalDatabaseUrl,
  loadSkill,
  parseArgs,
  readManifest,
  resolveRoutine,
  rewriteCurrentWeekSnapshots,
  sanitizedDatabaseTarget,
} from "../../../scripts/import-agent-routines.ts";

const NOW = new Date("2026-09-05T13:00:00.000Z");

function validManifest() {
  return {
    schemaVersion: 1,
    migration: "arthur-to-james",
    exportedAt: "2026-09-05T12:00:00.000Z",
    expiresAt: "2026-09-05T14:00:00.000Z",
    source: { botId: "source-arthur-id", botName: "Arthur" },
    destination: {
      botId: "destination-james-id",
      botName: "James Baker",
      spaceId: "audienti-space-id",
      userId: "owner-user-id",
    },
    routines: [
      {
        sourceRoutineId: "source-routine-id",
        destinationRoutineId: "destination-routine-id",
        name: "Meeting Action Capture",
        prompt: "Capture meeting actions from the verified source window.",
        crons: ["0 8 * * *", "0 18 * * *"],
        timezone: "America/New_York",
        active: true,
      },
    ],
  };
}

function writeManifest(contents: object) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rakazo-routine-manifest-"));
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe("import-agent-routines cli parsing", () => {
  it("defaults to dry-run and inactive staging", () => {
    expect(parseArgs(["--manifest", "plan.json"])).toMatchObject({
      manifestPath: "plan.json",
      apply: false,
      allowRemoteDb: false,
      allowActive: false,
    });
  });

  it("requires a manifest", () => {
    expect(() => parseArgs([])).toThrow(/--manifest is required/);
  });
});

describe("Arthur-only manifest safety", () => {
  it("requires exact source, destination, and routine ids", () => {
    const omissions = [
      {
        remove: (manifest: ReturnType<typeof validManifest>) => {
          manifest.source.botId = "";
        },
        error: /exact source bot id/,
      },
      {
        remove: (manifest: ReturnType<typeof validManifest>) => {
          manifest.destination.botId = "";
        },
        error: /exact destination bot id/,
      },
      {
        remove: (manifest: ReturnType<typeof validManifest>) => {
          manifest.routines[0]!.sourceRoutineId = "";
        },
        error: /exact source routine id/,
      },
      {
        remove: (manifest: ReturnType<typeof validManifest>) => {
          manifest.routines[0]!.destinationRoutineId = "";
        },
        error: /exact destination routine id/,
      },
    ];

    for (const omission of omissions) {
      const manifest = validManifest();
      omission.remove(manifest);
      expect(() => readManifest(writeManifest(manifest), NOW)).toThrow(omission.error);
    }
  });

  it("rejects a stale source export", () => {
    const manifest = validManifest();
    manifest.expiresAt = "2026-09-05T12:59:59.000Z";

    expect(() => readManifest(writeManifest(manifest), NOW)).toThrow(/expired/);
  });
});

describe("database target safety", () => {
  it("recognizes local database hosts", () => {
    expect(isLocalDatabaseUrl("postgres://user:pass@127.0.0.1:5433/rakazo")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://user:pass@localhost:5433/rakazo")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://user:pass@db.example.com/rakazo")).toBe(false);
  });

  it("does not include passwords in printed database target", () => {
    expect(sanitizedDatabaseTarget("postgres://user:secret@db.example.com/rakazo")).toEqual({
      protocol: "postgres:",
      host: "db.example.com",
      database: "rakazo",
      username: "user",
    });
  });
});

describe("routine resolution", () => {
  it("forces routines inactive unless allowActive is true", () => {
    const routine = resolveRoutine(
      {
        sourceRoutineId: "source-routine-id",
        destinationRoutineId: "destination-routine-id",
        name: "Morning review",
        prompt: "Review the day.",
        crons: ["0 8 * * *"],
        timezone: "America/New_York",
        active: true,
      },
      false,
    );

    expect(routine.active).toBe(false);
    expect(routine.nextRunAt).toBeNull();
  });

  it("computes the next run only when active staging is allowed", () => {
    const routine = resolveRoutine(
      {
        sourceRoutineId: "source-routine-id",
        destinationRoutineId: "destination-routine-id",
        name: "Morning review",
        prompt: "Review the day.",
        crons: ["0 8 * * *"],
        timezone: "America/New_York",
        active: true,
      },
      true,
    );

    expect(routine.active).toBe(true);
    expect(routine.nextRunAt).toBeInstanceOf(Date);
  });

  it("rejects mixed one-shot schedules", () => {
    expect(() =>
      resolveRoutine(
        {
          sourceRoutineId: "source-routine-id",
          destinationRoutineId: "destination-routine-id",
          name: "Bad",
          prompt: "Run.",
          crons: ["@once", "0 8 * * *"],
        },
        true,
      ),
    ).toThrow(/cannot combine/);
  });
});

describe("Arthur-only routine import", () => {
  it("is idempotent, stages inactive, preserves unrelated rows, and plans rollback", async () => {
    const unrelated = {
      id: "unrelated-routine-id",
      botId: "another-bot-id",
      spaceId: "audienti-space-id",
      userId: "owner-user-id",
      name: "Unrelated",
      prompt: "Leave me alone.",
      crons: ["0 1 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
      webhookEnabled: false,
      nextRunAt: new Date("2026-09-06T01:00:00.000Z"),
    };
    const routines = [unrelated];
    const prisma = {
      bot: {
        findUnique: async () => ({
          id: "destination-james-id",
          name: "James Baker",
          spaceId: "audienti-space-id",
          userId: "owner-user-id",
        }),
      },
      agentSkill: { findFirst: async () => null },
      routine: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          routines.find((routine) => routine.id === where.id) ?? null,
        create: async ({ data }: { data: (typeof routines)[number] }) => {
          routines.push(data);
          return data;
        },
        update: async ({ where, data }: { where: { id: string }; data: object }) => {
          const index = routines.findIndex((routine) => routine.id === where.id);
          routines[index] = { ...routines[index]!, ...data };
          return routines[index];
        },
      },
      $transaction: async (callback: (tx: unknown) => Promise<void>) => callback(prisma),
    };
    const manifest = readManifest(writeManifest(validManifest()), NOW);

    const first = await buildImportPlan(prisma as never, manifest, { allowActive: false });
    expect(first.plan.routines).toEqual([
      expect.objectContaining({
        sourceRoutineId: "source-routine-id",
        destinationRoutineId: "destination-routine-id",
        action: "create",
        active: false,
        rollback: { action: "delete-created", routineId: "destination-routine-id" },
      }),
    ]);
    await applyImport(prisma as never, first.plan, first.skills, first.routines);

    const second = await buildImportPlan(prisma as never, manifest, { allowActive: false });
    await applyImport(prisma as never, second.plan, second.skills, second.routines);

    expect(routines).toHaveLength(2);
    expect(routines[0]).toEqual(unrelated);
    expect(routines[1]).toMatchObject({
      id: "destination-routine-id",
      botId: "destination-james-id",
      active: false,
    });
    expect(second.plan.routines[0]?.rollback).toEqual({
      action: "restore-existing",
      routineId: "destination-routine-id",
      before: expect.objectContaining({ name: "Meeting Action Capture", active: false }),
    });
  });

  it("refuses to overwrite a destination routine id owned by another bot", async () => {
    const prisma = {
      bot: {
        findUnique: async () => ({
          id: "destination-james-id",
          name: "James Baker",
          spaceId: "audienti-space-id",
          userId: "owner-user-id",
        }),
      },
      agentSkill: { findFirst: async () => null },
      routine: {
        findUnique: async () => ({
          id: "destination-routine-id",
          botId: "another-bot-id",
          spaceId: "audienti-space-id",
          userId: "owner-user-id",
          name: "Collision",
          prompt: "Do not overwrite.",
          crons: ["0 1 * * *"],
          timezone: "UTC",
          active: true,
          notify: true,
          webhookEnabled: false,
          nextRunAt: null,
        }),
      },
    };
    const manifest = readManifest(writeManifest(validManifest()), NOW);

    await expect(
      buildImportPlan(prisma as never, manifest, { allowActive: false }),
    ).rejects.toThrow(/belongs to another bot/);
  });
});

describe("skill loading", () => {
  it("normalizes SKILL.md content from disk", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rakazo-skill-"));
    const file = path.join(dir, "SKILL.md");
    writeFileSync(
      file,
      [
        "---",
        "description: A repeatable operating playbook.",
        "name: sample-skill",
        "---",
        "",
        "# Sample",
        "",
        "Do the work.",
        "",
      ].join("\n"),
    );

    const skill = loadSkill(file);

    expect(skill.name).toBe("sample-skill");
    expect(skill.description).toBe("A repeatable operating playbook.");
    expect(skill.content).toContain("name: sample-skill");
  });

  it("can rewrite hardcoded current-week snapshots", () => {
    expect(
      rewriteCurrentWeekSnapshots(
        "Current week is **W36** (2026-08-31 -> 2026-09-06).\n**Current week: W36 (2026-08-31 -> 2026-09-06).**",
      ),
    ).toBe(
      "Read the current COS context/week file before using week-specific values.\n**Read the current COS context/week file before using week-specific values.**",
    );
  });
});
