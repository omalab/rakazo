#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSkillMd,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
  parseSkillMd,
} from "../packages/core/src/index.ts";
import { loadRootEnv } from "../packages/core/src/node/load-root-env.ts";
import { createDb, type PrismaClient } from "../packages/db/src/client.ts";

type SkillManifest = {
  path: string;
  rewriteCurrentWeek?: boolean;
};

type RoutineManifest = {
  sourceRoutineId: string;
  destinationRoutineId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone?: string;
  active?: boolean;
  notify?: boolean;
  webhookEnabled?: boolean;
};

type ImportManifest = {
  schemaVersion: 1;
  migration: "arthur-to-james";
  exportedAt: string;
  expiresAt: string;
  source: {
    botId: string;
    botName: "Arthur";
  };
  destination: {
    botId: string;
    botName: string;
    spaceId: string;
    userId: string;
  };
  skills?: SkillManifest[];
  routines: RoutineManifest[];
};

type CliOptions = {
  manifestPath: string;
  apply: boolean;
  allowRemoteDb: boolean;
  allowActive: boolean;
  databaseUrl?: string;
};

type ResolvedSkill = {
  name: string;
  description: string;
  content: string;
};

type ResolvedRoutine = {
  sourceRoutineId: string;
  destinationRoutineId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  nextRunAt: Date | null;
};

type ImportPlan = {
  source: { botId: string; botName: "Arthur"; exportedAt: string; expiresAt: string };
  bot: { id: string; name: string; spaceId: string; userId: string };
  skills: Array<{ name: string; action: "create" | "update" }>;
  routines: Array<{
    sourceRoutineId: string;
    destinationRoutineId: string;
    name: string;
    action: "create" | "update";
    active: boolean;
    nextRunAt: string | null;
    rollback:
      | { action: "delete-created"; routineId: string }
      | {
          action: "restore-existing";
          routineId: string;
          before: {
            name: string;
            prompt: string;
            crons: string[];
            timezone: string;
            active: boolean;
            notify: boolean;
            webhookEnabled: boolean;
            nextRunAt: string | null;
          };
        };
  }>;
};

const USAGE = `Usage:
  pnpm admin:import-routines --manifest <file> [--apply] [--allow-remote-db] [--allow-active]

Defaults:
  Dry-run only unless --apply is present.
  Remote DATABASE_URL values are refused on --apply unless --allow-remote-db is present.
  Routines are staged inactive unless --allow-active is present.

Optional connection override:
  --database-url <postgres-url>
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    apply: false,
    allowRemoteDb: false,
    allowActive: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.\n\n${USAGE}`);
      index += 1;
      return value;
    };
    if (arg === "--manifest") options.manifestPath = next();
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--allow-remote-db") options.allowRemoteDb = true;
    else if (arg === "--allow-active") options.allowActive = true;
    else if (arg === "--database-url") options.databaseUrl = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  if (!options.manifestPath) throw new Error(`--manifest is required.\n\n${USAGE}`);
  return options as CliOptions;
}

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  const parsed = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
}

export function sanitizedDatabaseTarget(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  return {
    protocol: parsed.protocol,
    host: parsed.host,
    database: parsed.pathname.replace(/^\//, ""),
    username: parsed.username,
  };
}

export function readManifest(manifestPath: string, now = new Date()): ImportManifest {
  const resolved = path.resolve(manifestPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as ImportManifest;
  validateManifest(parsed, now);
  return parsed;
}

function requireExactId(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Manifest must include an exact ${label}.`);
  }
}

function parseManifestDate(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Manifest ${label} must be an ISO date.`);
  return date;
}

function validateManifest(manifest: ImportManifest, now: Date) {
  if (manifest.schemaVersion !== 1) throw new Error("Manifest schemaVersion must be 1.");
  if (manifest.migration !== "arthur-to-james") {
    throw new Error("Manifest migration must be arthur-to-james.");
  }
  if (manifest.source?.botName !== "Arthur") {
    throw new Error("Manifest source bot must be Arthur.");
  }
  requireExactId(manifest.source?.botId, "source bot id");
  requireExactId(manifest.destination?.botId, "destination bot id");
  requireExactId(manifest.destination?.botName, "destination bot name");
  requireExactId(manifest.destination?.spaceId, "destination space id");
  requireExactId(manifest.destination?.userId, "destination user id");
  if (manifest.source.botId === manifest.destination.botId) {
    throw new Error("Source Arthur and destination James must have different bot ids.");
  }
  const exportedAt = parseManifestDate(manifest.exportedAt, "exportedAt");
  const expiresAt = parseManifestDate(manifest.expiresAt, "expiresAt");
  if (expiresAt <= exportedAt) throw new Error("Manifest expiresAt must be after exportedAt.");
  if (expiresAt <= now)
    throw new Error("Manifest has expired; export and reconcile a fresh source snapshot.");
  if (manifest.skills && !Array.isArray(manifest.skills))
    throw new Error("Manifest skills must be an array.");
  if (!Array.isArray(manifest.routines)) {
    throw new Error("Manifest routines must be an array.");
  }
  for (const skill of manifest.skills ?? []) {
    if (!skill.path || typeof skill.path !== "string") throw new Error("Each skill needs a path.");
  }
  const sourceRoutineIds = new Set<string>();
  const destinationRoutineIds = new Set<string>();
  for (const routine of manifest.routines) {
    requireExactId(
      routine.sourceRoutineId,
      `source routine id for ${routine.name || "unnamed routine"}`,
    );
    requireExactId(
      routine.destinationRoutineId,
      `destination routine id for ${routine.name || "unnamed routine"}`,
    );
    if (sourceRoutineIds.has(routine.sourceRoutineId)) {
      throw new Error(`Duplicate source routine id: ${routine.sourceRoutineId}.`);
    }
    if (destinationRoutineIds.has(routine.destinationRoutineId)) {
      throw new Error(`Duplicate destination routine id: ${routine.destinationRoutineId}.`);
    }
    sourceRoutineIds.add(routine.sourceRoutineId);
    destinationRoutineIds.add(routine.destinationRoutineId);
    if (!routine.name?.trim()) throw new Error("Each routine needs a name.");
    if (!routine.prompt?.trim()) throw new Error(`Routine ${routine.name} needs a prompt.`);
    if (!Array.isArray(routine.crons)) throw new Error(`Routine ${routine.name} needs crons.`);
    if (routine.crons.length === 0 && !routine.webhookEnabled) {
      throw new Error(`Routine ${routine.name} needs a schedule or webhook trigger.`);
    }
  }
}

export function rewriteCurrentWeekSnapshots(content: string): string {
  return content
    .replace(
      /Current week is \*\*W\d+\*\* \([^)]*\)\./g,
      "Read the current COS context/week file before using week-specific values.",
    )
    .replace(
      /\*\*Current week: W\d+ \([^)]*\)\.\*\*/g,
      "**Read the current COS context/week file before using week-specific values.**",
    );
}

export function loadSkill(
  skillPath: string,
  options: { rewriteCurrentWeek?: boolean } = {},
): ResolvedSkill {
  const rawContent = fs.readFileSync(path.resolve(skillPath), "utf8");
  const content = options.rewriteCurrentWeek ? rewriteCurrentWeekSnapshots(rawContent) : rawContent;
  const parsed = parseSkillMd(content);
  if ("error" in parsed) throw new Error(`${skillPath}: ${parsed.error}`);
  const normalized = buildSkillMd(parsed);
  if (normalized.length > 100_000)
    throw new Error(`${skillPath}: skill content exceeds 100000 characters.`);
  return {
    name: parsed.name,
    description: parsed.description,
    content: normalized,
  };
}

export function resolveRoutine(routine: RoutineManifest, allowActive: boolean): ResolvedRoutine {
  const crons = routine.crons.map((cron) => cron.trim()).filter(Boolean);
  const webhookEnabled = routine.webhookEnabled ?? false;
  if (crons.length === 0 && !webhookEnabled) {
    throw new Error(`Routine ${routine.name} needs a schedule or webhook trigger.`);
  }
  if (hasMixedOneShotSchedule(crons)) {
    throw new Error(`Routine ${routine.name} cannot combine @once with recurring schedules.`);
  }
  const active = allowActive ? (routine.active ?? false) : false;
  const timezone = routine.timezone ?? "UTC";
  let nextRunAt: Date | null = null;
  if (crons.length > 0 && !isOneShotRoutineCrons(crons)) {
    const next = nextCronDateAcrossStrict(crons, new Date(), timezone);
    if (!next) throw new Error(`Routine ${routine.name} has no future cron run.`);
    nextRunAt = active ? next : null;
  }
  if (active && isOneShotRoutineCrons(crons)) {
    throw new Error(
      `Routine ${routine.name} uses @once; create and arm one-shot routines from chat.`,
    );
  }
  return {
    sourceRoutineId: routine.sourceRoutineId,
    destinationRoutineId: routine.destinationRoutineId,
    name: routine.name.trim(),
    prompt: routine.prompt.trim(),
    crons,
    timezone,
    active,
    notify: routine.notify ?? true,
    webhookEnabled,
    nextRunAt,
  };
}

export async function buildImportPlan(
  prisma: PrismaClient,
  manifest: ImportManifest,
  options: Pick<CliOptions, "allowActive">,
): Promise<{ plan: ImportPlan; skills: ResolvedSkill[]; routines: ResolvedRoutine[] }> {
  const bot = await prisma.bot.findUnique({
    where: { id: manifest.destination.botId },
    select: { id: true, name: true, spaceId: true, userId: true, archivedAt: true },
  });
  if (
    !bot ||
    bot.archivedAt ||
    bot.name !== manifest.destination.botName ||
    bot.spaceId !== manifest.destination.spaceId ||
    bot.userId !== manifest.destination.userId
  ) {
    throw new Error("Exact destination James bot identity was not found in the declared scope.");
  }

  const skills = (manifest.skills ?? []).map((skill) =>
    loadSkill(skill.path, { rewriteCurrentWeek: skill.rewriteCurrentWeek }),
  );
  const routines = manifest.routines.map((routine) => resolveRoutine(routine, options.allowActive));

  const skillPlan = [];
  for (const skill of skills) {
    const existing = await prisma.agentSkill.findFirst({
      where: {
        spaceId: bot.spaceId,
        userId: bot.userId,
        name: { equals: skill.name, mode: "insensitive" },
      },
      select: { id: true },
    });
    skillPlan.push({ name: skill.name, action: existing ? "update" : "create" } as const);
  }

  const routinePlan = [];
  for (const routine of routines) {
    const existing = await prisma.routine.findUnique({
      where: { id: routine.destinationRoutineId },
      select: {
        id: true,
        botId: true,
        spaceId: true,
        userId: true,
        name: true,
        prompt: true,
        crons: true,
        timezone: true,
        active: true,
        notify: true,
        webhookEnabled: true,
        nextRunAt: true,
      },
    });
    if (
      existing &&
      (existing.botId !== bot.id ||
        existing.spaceId !== bot.spaceId ||
        existing.userId !== bot.userId)
    ) {
      throw new Error(
        `Destination routine id ${routine.destinationRoutineId} belongs to another bot or scope.`,
      );
    }
    routinePlan.push({
      sourceRoutineId: routine.sourceRoutineId,
      destinationRoutineId: routine.destinationRoutineId,
      name: routine.name,
      action: existing ? "update" : "create",
      active: routine.active,
      nextRunAt: routine.nextRunAt?.toISOString() ?? null,
      rollback: existing
        ? {
            action: "restore-existing" as const,
            routineId: existing.id,
            before: {
              name: existing.name,
              prompt: existing.prompt,
              crons: existing.crons,
              timezone: existing.timezone,
              active: existing.active,
              notify: existing.notify,
              webhookEnabled: existing.webhookEnabled,
              nextRunAt: existing.nextRunAt?.toISOString() ?? null,
            },
          }
        : {
            action: "delete-created" as const,
            routineId: routine.destinationRoutineId,
          },
    } as const);
  }

  return {
    plan: {
      source: {
        botId: manifest.source.botId,
        botName: manifest.source.botName,
        exportedAt: manifest.exportedAt,
        expiresAt: manifest.expiresAt,
      },
      bot,
      skills: skillPlan,
      routines: routinePlan,
    },
    skills,
    routines,
  };
}

export async function applyImport(
  prisma: PrismaClient,
  plan: ImportPlan,
  skills: ResolvedSkill[],
  routines: ResolvedRoutine[],
) {
  await prisma.$transaction(async (tx) => {
    for (const skill of skills) {
      const existing = await tx.agentSkill.findFirst({
        where: {
          spaceId: plan.bot.spaceId,
          userId: plan.bot.userId,
          name: { equals: skill.name, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (existing) {
        await tx.agentSkill.update({
          where: { id: existing.id },
          data: {
            name: skill.name,
            description: skill.description,
            content: skill.content,
          },
        });
      } else {
        await tx.agentSkill.create({
          data: {
            spaceId: plan.bot.spaceId,
            userId: plan.bot.userId,
            name: skill.name,
            description: skill.description,
            content: skill.content,
            source: "user",
          },
        });
      }
    }

    for (const routine of routines) {
      const planned = plan.routines.find(
        (item) => item.destinationRoutineId === routine.destinationRoutineId,
      );
      if (!planned) {
        throw new Error(`Routine ${routine.destinationRoutineId} is missing from the import plan.`);
      }
      const existing = await tx.routine.findUnique({
        where: { id: routine.destinationRoutineId },
        select: { id: true, botId: true, spaceId: true, userId: true },
      });
      if (
        existing &&
        (existing.botId !== plan.bot.id ||
          existing.spaceId !== plan.bot.spaceId ||
          existing.userId !== plan.bot.userId)
      ) {
        throw new Error(
          `Destination routine id ${routine.destinationRoutineId} belongs to another bot or scope.`,
        );
      }
      if (planned.action === "create" && existing) {
        throw new Error(
          `Destination routine ${routine.destinationRoutineId} changed after planning; rebuild the plan.`,
        );
      }
      if (planned.action === "update" && !existing) {
        throw new Error(
          `Destination routine ${routine.destinationRoutineId} changed after planning; rebuild the plan.`,
        );
      }
      const data = {
        name: routine.name,
        prompt: routine.prompt,
        crons: routine.crons,
        timezone: routine.timezone,
        active: routine.active,
        notify: routine.notify,
        webhookEnabled: routine.webhookEnabled,
        nextRunAt: routine.nextRunAt,
      };
      if (existing) {
        await tx.routine.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await tx.routine.create({
          data: {
            id: routine.destinationRoutineId,
            ...data,
            spaceId: plan.bot.spaceId,
            botId: plan.bot.id,
            userId: plan.bot.userId,
          },
        });
      }
    }
  });
}

async function main() {
  loadRootEnv();
  const options = parseArgs(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required, or pass --database-url.");
  if (options.apply && !options.allowRemoteDb && !isLocalDatabaseUrl(databaseUrl)) {
    throw new Error("Refusing to apply to a remote database without --allow-remote-db.");
  }

  const { prisma, pool } = createDb(databaseUrl);
  try {
    const { plan, skills, routines } = await buildImportPlan(prisma, manifest, options);
    const output = {
      mode: options.apply ? "apply" : "dry-run",
      database: sanitizedDatabaseTarget(databaseUrl),
      plan,
    };
    console.log(JSON.stringify(output, null, 2));
    if (options.apply) {
      await applyImport(prisma, plan, skills, routines);
      console.log(JSON.stringify({ ok: true, applied: true }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
