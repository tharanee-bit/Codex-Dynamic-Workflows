import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RunEvent, RunState } from "../types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RunStateStoreOptions {
  codexHome?: string;
  processId?: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
}

export interface RunLock {
  readonly runId: string;
  readonly pid: number;
  readonly acquiredAt: string;
  release(): Promise<void>;
}

interface LockFile {
  pid: number;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
}

const LOCK_HEARTBEAT_MS = 1_000;
const LOCK_STALE_AFTER_MS = 5_000;

export class InvalidRunIdError extends Error {
  constructor(runId: string) {
    super(`Invalid run id ${JSON.stringify(runId)}`);
    this.name = "InvalidRunIdError";
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${JSON.stringify(runId)} was not found`);
    this.name = "RunNotFoundError";
  }
}

export class RunStateCorruptError extends Error {
  constructor(runId: string, detail: string) {
    super(`Run ${JSON.stringify(runId)} has invalid persisted state: ${detail}`);
    this.name = "RunStateCorruptError";
  }
}

export class RunLockedError extends Error {
  readonly pid: number;

  constructor(runId: string, pid: number) {
    super(`Run ${JSON.stringify(runId)} is locked by live process ${pid}`);
    this.name = "RunLockedError";
    this.pid = pid;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function enforceMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (
      !isNodeError(error, "EPERM")
      && !isNodeError(error, "ENOTSUP")
      && !isNodeError(error, "EINVAL")
    ) {
      throw error;
    }
  }
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function parseLockFile(source: string): LockFile | undefined {
  try {
    const value = JSON.parse(source) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || !("pid" in value)
      || !("token" in value)
      || !("acquiredAt" in value)
      || !("heartbeatAt" in value)
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.token !== "string"
      || typeof value.acquiredAt !== "string"
      || typeof value.heartbeatAt !== "string"
    ) {
      return undefined;
    }
    return value as LockFile;
  } catch {
    return undefined;
  }
}

function assertRunState(value: unknown, expectedId: string): asserts value is RunState {
  if (
    typeof value !== "object"
    || value === null
    || !("schemaVersion" in value)
    || value.schemaVersion !== 1
    || !("id" in value)
    || value.id !== expectedId
    || !("agentCallsUsed" in value)
    || !Number.isSafeInteger(value.agentCallsUsed)
    || (value.agentCallsUsed as number) < 0
  ) {
    throw new RunStateCorruptError(expectedId, "schemaVersion, id, or agentCallsUsed is invalid");
  }
  if (!("reviewArtifacts" in value) || value.reviewArtifacts === undefined) return;
  if (!Array.isArray(value.reviewArtifacts) || value.reviewArtifacts.length > 16) {
    throw new RunStateCorruptError(expectedId, "reviewArtifacts must be a bounded array");
  }
  for (const artifact of value.reviewArtifacts) {
    if (
      typeof artifact !== "object"
      || artifact === null
      || !("protocol" in artifact)
      || artifact.protocol !== "codex-dw.review-artifact/v1"
      || !("id" in artifact)
      || typeof artifact.id !== "string"
      || !ARTIFACT_ID_PATTERN.test(artifact.id)
      || !("reviewSessionId" in artifact)
      || typeof artifact.reviewSessionId !== "string"
      || !SESSION_ID_PATTERN.test(artifact.reviewSessionId)
      || !("kind" in artifact)
      || artifact.kind !== "git-range"
      || !("repositoryRoot" in artifact)
      || typeof artifact.repositoryRoot !== "string"
      || artifact.repositoryRoot.length === 0
      || artifact.repositoryRoot.length > 4096
      || !("baseCommit" in artifact)
      || typeof artifact.baseCommit !== "string"
      || !GIT_COMMIT_PATTERN.test(artifact.baseCommit)
      || !("headCommit" in artifact)
      || typeof artifact.headCommit !== "string"
      || !GIT_COMMIT_PATTERN.test(artifact.headCommit)
      || !("branch" in artifact)
      || typeof artifact.branch !== "string"
      || artifact.branch.length === 0
      || artifact.branch.length > 512
      || !("runStatus" in artifact)
      || !["completed", "failed", "stopped"].includes(String(artifact.runStatus))
      || !("publishedAt" in artifact)
      || typeof artifact.publishedAt !== "string"
      || !Number.isFinite(Date.parse(artifact.publishedAt))
    ) {
      throw new RunStateCorruptError(expectedId, "reviewArtifacts contains an invalid artifact");
    }
  }
}

export function validateRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new InvalidRunIdError(runId);
  }
  return runId;
}

export class RunStateStore {
  readonly codexHome: string;
  readonly runsRoot: string;
  private readonly processId: number;
  private readonly now: () => Date;
  private readonly processAlive: (pid: number) => boolean;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(options: RunStateStoreOptions = {}) {
    this.codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
    this.runsRoot = join(this.codexHome, "dynamic-workflows", "runs");
    this.processId = options.processId ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.processAlive = options.isProcessAlive ?? defaultProcessAlive;
  }

  runDirectory(runId: string): string {
    return join(this.runsRoot, validateRunId(runId));
  }

  statePath(runId: string): string {
    return join(this.runDirectory(runId), "state.json");
  }

  eventsPath(runId: string): string {
    return join(this.runDirectory(runId), "events.jsonl");
  }

  lockPath(runId: string): string {
    return join(this.runDirectory(runId), "run.lock");
  }

  stopRequestPath(runId: string): string {
    return join(this.runDirectory(runId), "stop.request");
  }

  private lockIsLive(lock: LockFile): boolean {
    const heartbeat = Date.parse(lock.heartbeatAt);
    const age = this.now().getTime() - heartbeat;
    return Number.isFinite(heartbeat)
      && age >= 0
      && age <= LOCK_STALE_AFTER_MS
      && this.processAlive(lock.pid);
  }

  private async ensureRunsRoot(): Promise<void> {
    const workflowRoot = join(this.codexHome, "dynamic-workflows");
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    await mkdir(workflowRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.runsRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      enforceMode(workflowRoot, 0o700),
      enforceMode(this.runsRoot, 0o700),
    ]);
  }

  private async ensureRunDirectory(runId: string): Promise<string> {
    await this.ensureRunsRoot();
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await enforceMode(directory, 0o700);
    return directory;
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.${this.processId}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      await enforceMode(path, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }

  async initializeRun(state: RunState): Promise<void> {
    validateRunId(state.id);
    assertRunState(state, state.id);
    await this.ensureRunDirectory(state.id);
    try {
      await stat(this.statePath(state.id));
      throw new Error(`Run ${JSON.stringify(state.id)} already exists`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    await this.writeRun(state);
  }

  async writeRun(state: RunState): Promise<void> {
    validateRunId(state.id);
    assertRunState(state, state.id);
    const previous = this.writeChains.get(state.id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await this.ensureRunDirectory(state.id);
      await this.atomicWrite(this.statePath(state.id), `${JSON.stringify(state, null, 2)}\n`);
    });
    this.writeChains.set(state.id, write);
    try {
      await write;
    } finally {
      if (this.writeChains.get(state.id) === write) this.writeChains.delete(state.id);
    }
  }

  async save(state: RunState): Promise<void> {
    await this.writeRun(state);
  }

  async readRun(runId: string): Promise<RunState> {
    const path = this.statePath(runId);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new RunNotFoundError(runId);
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RunStateCorruptError(runId, message);
    }
    assertRunState(value, runId);
    return value;
  }

  async appendEvent(event: RunEvent): Promise<void>;
  async appendEvent(runId: string, event: RunEvent): Promise<void>;
  async appendEvent(eventOrRunId: RunEvent | string, suppliedEvent?: RunEvent): Promise<void> {
    const event = typeof eventOrRunId === "string" ? suppliedEvent : eventOrRunId;
    if (event === undefined) {
      throw new TypeError("appendEvent(runId, event) requires an event");
    }
    if (typeof eventOrRunId === "string" && event.runId !== eventOrRunId) {
      throw new TypeError(`Event runId ${JSON.stringify(event.runId)} does not match ${JSON.stringify(eventOrRunId)}`);
    }
    await this.ensureRunDirectory(event.runId);
    const handle = await open(this.eventsPath(event.runId), "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await enforceMode(this.eventsPath(event.runId), 0o600);
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    let source: string;
    try {
      source = await readFile(this.eventsPath(runId), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    return source
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line, index) => {
        try {
          const event = JSON.parse(line) as RunEvent;
          if (event.runId !== runId) {
            throw new Error(`event runId is ${JSON.stringify(event.runId)}`);
          }
          return event;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new RunStateCorruptError(runId, `events.jsonl line ${index + 1}: ${message}`);
        }
      });
  }

  async listRuns(): Promise<RunState[]> {
    try {
      const entries = await readdir(this.runsRoot, { withFileTypes: true });
      const states: RunState[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) {
          continue;
        }
        try {
          states.push(await this.readRun(entry.name));
        } catch (error) {
          if (!(error instanceof RunNotFoundError)) {
            throw error;
          }
        }
      }
      return states.sort((left, right) => {
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        return byCreatedAt !== 0 ? byCreatedAt : right.id.localeCompare(left.id);
      });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  async getLatestRun(): Promise<RunState | undefined> {
    return (await this.listRuns())[0];
  }

  async requestStop(runId: string): Promise<void> {
    await this.ensureRunDirectory(runId);
    await this.atomicWrite(this.stopRequestPath(runId), `${JSON.stringify({ requestedAt: this.now().toISOString() })}\n`);
  }

  async hasStopRequest(runId: string): Promise<boolean> {
    try {
      await access(this.stopRequestPath(runId));
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async clearStopRequest(runId: string): Promise<void> {
    await unlink(this.stopRequestPath(runId)).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }

  async isRunLocked(runId: string): Promise<boolean> {
    const source = await readFile(this.lockPath(runId), "utf8").catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (source === undefined) return false;
    const lock = parseLockFile(source);
    return lock !== undefined && this.lockIsLive(lock);
  }

  async acquireLock(runId: string): Promise<RunLock> {
    await this.ensureRunDirectory(runId);
    const path = this.lockPath(runId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const acquiredAt = this.now().toISOString();
      const lock: LockFile = {
        pid: this.processId,
        token: randomUUID(),
        acquiredAt,
        heartbeatAt: acquiredAt,
      };
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await enforceMode(path, 0o600);

        let released = false;
        let heartbeatWrite = Promise.resolve();
        const heartbeat = setInterval(() => {
          heartbeatWrite = heartbeatWrite.then(async () => {
            if (released) return;
            const source = await readFile(path, "utf8").catch(() => undefined);
            if (source === undefined || parseLockFile(source)?.token !== lock.token) return;
            lock.heartbeatAt = this.now().toISOString();
            await this.atomicWrite(path, `${JSON.stringify(lock)}\n`);
          }).catch(() => undefined);
        }, LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        return {
          runId,
          pid: lock.pid,
          acquiredAt: lock.acquiredAt,
          release: async () => {
            if (released) {
              return;
            }
            clearInterval(heartbeat);
            released = true;
            await heartbeatWrite;
            let currentSource: string;
            try {
              currentSource = await readFile(path, "utf8");
            } catch (error) {
              if (isNodeError(error, "ENOENT")) {
                return;
              }
              throw error;
            }
            if (parseLockFile(currentSource)?.token !== lock.token) {
              throw new Error(`Refusing to release a lock for run ${JSON.stringify(runId)} that this process no longer owns`);
            }
            await unlink(path);
          },
        };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }

        const existingSource = await readFile(path, "utf8").catch((readError: unknown) => {
          if (isNodeError(readError, "ENOENT")) {
            return undefined;
          }
          throw readError;
        });
        if (existingSource === undefined) {
          continue;
        }
        const existing = parseLockFile(existingSource);
        if (existing !== undefined && this.lockIsLive(existing)) {
          throw new RunLockedError(runId, existing.pid);
        }

        const currentSource = await readFile(path, "utf8").catch(() => undefined);
        if (currentSource === existingSource) {
          await unlink(path).catch((unlinkError: unknown) => {
            if (!isNodeError(unlinkError, "ENOENT")) {
              throw unlinkError;
            }
          });
        }
      }
    }

    throw new Error(`Could not acquire run lock for ${JSON.stringify(runId)} after clearing stale locks`);
  }

  async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(runId);
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }
}
