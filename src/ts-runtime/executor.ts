import { fork, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import type { JsonValue } from "../types.js";
import type { WorkflowMetadata } from "../workflow-api.js";
import { CHILD_BOOTSTRAP_SOURCE } from "./bootstrap-source.js";
import { bundleTypeScriptWorkflow } from "./bundle.js";
import type {
  ExecuteTypeScriptWorkflowOptions,
  TypeScriptWorkflowExecution,
  TypeScriptWorkflowRpcRequest,
} from "./types.js";
import {
  assertJsonValue,
  assertTypeScriptRpcRequest,
  assertWorkflowMetadata,
} from "./validation.js";

const DEFAULT_WALL_TIME_MS = 15 * 60 * 1_000;
const DEFAULT_MEMORY_LIMIT_MB = 256;
const DEFAULT_PIPELINE_CONCURRENCY = 4;
const DEFAULT_MAX_LOOP_ITERATIONS = 100;
const MAX_STDERR_LENGTH = 16_384;
const RPC_DRAIN_GRACE_MS = 1_500;

interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
}

interface ChildMessage {
  type: "ready" | "rpc" | "complete" | "fatal";
  requestId?: string;
  request?: TypeScriptWorkflowRpcRequest;
  meta?: WorkflowMetadata;
  result?: JsonValue;
  error?: SerializedError;
}

export class TypeScriptWorkflowExecutionError extends Error {
  readonly code: string;

  constructor(message: string, code = "ERR_CODEX_DW_TYPESCRIPT") {
    super(message);
    this.name = "TypeScriptWorkflowExecutionError";
    this.code = code;
  }
}

export function nodePermissionFlag(
  allowedFlags: Pick<ReadonlySet<string>, "has"> = process.allowedNodeEnvironmentFlags,
): "--permission" | "--experimental-permission" | undefined {
  if (allowedFlags.has("--permission")) return "--permission";
  if (allowedFlags.has("--experimental-permission")) return "--experimental-permission";
  return undefined;
}

export function supportsNodePermissions(): boolean {
  return nodePermissionFlag() !== undefined;
}

function requirePositiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function sanitizedEnvironment(config: Record<string, unknown>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.NODE_NO_WARNINGS = "1";
  environment.CODEX_DW_CHILD_CONFIG = JSON.stringify(config);
  return environment;
}

function permissionArguments(bootstrapPath: string, bundlePath: string): string[] {
  const flag = nodePermissionFlag();
  if (flag === undefined) return [];
  return [
    flag,
    `--allow-fs-read=${bootstrapPath}`,
    `--allow-fs-read=${bundlePath}`,
  ];
}

function serializedError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(code === undefined ? {} : { code }),
    };
  }
  return { name: "Error", message: String(error) };
}

function childError(error: SerializedError | undefined, stderr: string): TypeScriptWorkflowExecutionError {
  const suffix = stderr.trim() === "" ? "" : `\nChild stderr:\n${stderr.trim()}`;
  const message = error?.message ?? "TypeScript workflow child exited unexpectedly";
  const result = new TypeScriptWorkflowExecutionError(
    `${message}${suffix}\nTypeScript workflow containment is defense-in-depth, not a complete security boundary.`,
    error?.code ?? "ERR_CODEX_DW_TYPESCRIPT_CHILD",
  );
  if (error?.stack !== undefined) result.stack = error.stack;
  return result;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const hardStop = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 500);
  hardStop.unref();
}

/**
 * Execute an explicitly requested TypeScript workflow without a trust prompt.
 *
 * The workflow is bundled, then loaded in a separate Node process with a
 * minimal environment, memory/time limits, and Node permissions where the host
 * supports them. These controls are defense-in-depth only; they are not a
 * complete JavaScript sandbox or a substitute for reviewing untrusted code.
 */
export async function executeTypeScriptWorkflow(
  options: ExecuteTypeScriptWorkflowOptions,
): Promise<TypeScriptWorkflowExecution> {
  const wallTimeMs = options.wallTimeMs ?? DEFAULT_WALL_TIME_MS;
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const pipelineConcurrency = options.pipelineConcurrency ?? DEFAULT_PIPELINE_CONCURRENCY;
  const maxLoopIterations = options.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
  requirePositiveInteger(wallTimeMs, "wallTimeMs", 24 * 60 * 60 * 1_000);
  requirePositiveInteger(memoryLimitMb, "memoryLimitMb", 16_384);
  requirePositiveInteger(pipelineConcurrency, "pipelineConcurrency", 16);
  requirePositiveInteger(maxLoopIterations, "maxLoopIterations", 10_000);
  if (isAborted(options.signal)) {
    throw new TypeScriptWorkflowExecutionError("TypeScript workflow was aborted before launch", "ABORT_ERR");
  }

  const bundle = await bundleTypeScriptWorkflow({ workflowPath: options.workflowPath });
  const temporaryDirectory = bundle.temporaryDirectory;
  if (temporaryDirectory === undefined) {
    throw new TypeScriptWorkflowExecutionError("Bundler did not create an isolated directory");
  }
  const bootstrapPath = join(temporaryDirectory, "bootstrap.mjs");
  await mkdir(dirname(bootstrapPath), { recursive: true, mode: 0o700 });
  await writeFile(bootstrapPath, CHILD_BOOTSTRAP_SOURCE, { encoding: "utf8", mode: 0o600 });
  if (isAborted(options.signal)) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw new TypeScriptWorkflowExecutionError("TypeScript workflow was aborted before launch", "ABORT_ERR");
  }

  const permissionIsolation = supportsNodePermissions();
  const started = Date.now();
  let child: ChildProcess | undefined;

  try {
    return await new Promise<TypeScriptWorkflowExecution>((resolvePromise, rejectPromise) => {
      let settled = false;
      let metadata: WorkflowMetadata | undefined;
      let stderr = "";
      const requestIds = new Set<string>();
      const inFlightRpc = new Set<Promise<void>>();
      const controller = new AbortController();

      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        controller.abort();
        if (child !== undefined) stopChild(child);
        const pending = [...inFlightRpc];
        if (pending.length === 0) {
          operation();
        } else {
          const drain = Promise.allSettled(pending).then(() => undefined);
          const grace = new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, RPC_DRAIN_GRACE_MS);
          });
          void Promise.race([
            drain.then(() => true),
            grace.then(() => false),
          ]).then((drained) => {
            if (!drained) options.onLateRpcDrain?.(drain);
            operation();
          });
        }
      };

      const abort = (): void => {
        settle(() => rejectPromise(new TypeScriptWorkflowExecutionError("TypeScript workflow was aborted", "ABORT_ERR")));
      };

      const timeout = setTimeout(() => {
        settle(() => rejectPromise(new TypeScriptWorkflowExecutionError(
          `TypeScript workflow exceeded its ${wallTimeMs}ms wall-time limit`,
          "ERR_CODEX_DW_TYPESCRIPT_TIMEOUT",
        )));
      }, wallTimeMs);

      const config = {
        bundlePath: resolve(bundle.bundlePath),
        args: options.args,
        pipelineConcurrency,
        maxLoopIterations,
      };
      child = fork(bootstrapPath, [], {
        cwd: resolve(options.workingDirectory ?? process.cwd()),
        env: sanitizedEnvironment(config),
        execArgv: [
          `--max-old-space-size=${memoryLimitMb}`,
          ...permissionArguments(bootstrapPath, bundle.bundlePath),
        ],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "advanced",
      });

      options.signal?.addEventListener("abort", abort, { once: true });
      if (isAborted(options.signal)) {
        abort();
        return;
      }
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR_LENGTH);
      });

      child.on("message", (raw: unknown) => {
        if (settled) return;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          settle(() => rejectPromise(childError({ message: "Malformed workflow child message" }, stderr)));
          return;
        }
        const message = raw as ChildMessage;
        if (message.type === "ready") {
          if (message.meta === undefined || metadata !== undefined) {
            settle(() => rejectPromise(childError({ message: "Workflow provided missing or duplicate metadata" }, stderr)));
            return;
          }
          try {
            assertWorkflowMetadata(message.meta);
            options.onMetadata?.(message.meta);
            metadata = message.meta;
          } catch (error) {
            settle(() => rejectPromise(childError(serializedError(error), stderr)));
          }
          return;
        }
        if (message.type === "rpc") {
          const requestId = message.requestId;
          const request = message.request;
          if (metadata === undefined || typeof requestId !== "string" || !/^[1-9][0-9]{0,15}$/.test(requestId) || requestIds.has(requestId) || request === undefined) {
            settle(() => rejectPromise(childError({ message: "Malformed workflow RPC request" }, stderr)));
            return;
          }
          try {
            assertTypeScriptRpcRequest(request);
          } catch (error) {
            settle(() => rejectPromise(childError(serializedError(error), stderr)));
            return;
          }
          requestIds.add(requestId);
          if (requestIds.size > 10_000) {
            settle(() => rejectPromise(childError({ message: "Workflow exceeded the coordinator RPC message limit" }, stderr)));
            return;
          }
          const rpcWork = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw controller.signal.reason;
            return options.rpc(request, controller.signal);
          }).then(
            (value) => {
              if (!settled && child?.connected === true) {
                child.send({ type: "rpc-result", requestId, value: value ?? null });
              }
            },
            (error: unknown) => {
              if (!settled && child?.connected === true) {
                child.send({ type: "rpc-error", requestId, error: serializedError(error) });
              }
            },
          ).finally(() => inFlightRpc.delete(rpcWork));
          inFlightRpc.add(rpcWork);
          return;
        }
        if (message.type === "fatal") {
          settle(() => rejectPromise(childError(message.error, stderr)));
          return;
        }
        if (message.type === "complete") {
          if (inFlightRpc.size > 0) {
            settle(() => rejectPromise(childError({ message: "Workflow completed while parent RPC calls were still running" }, stderr)));
            return;
          }
          if (metadata === undefined || message.result === undefined) {
            settle(() => rejectPromise(childError({ message: "Workflow completed without metadata or result" }, stderr)));
            return;
          }
          const result = message.result;
          try {
            assertJsonValue(result, "Workflow result");
          } catch (error) {
            settle(() => rejectPromise(childError(serializedError(error), stderr)));
            return;
          }
          settle(() => resolvePromise({
            meta: metadata!,
            result,
            durationMs: Date.now() - started,
            permissionIsolation,
          }));
          return;
        }
        settle(() => rejectPromise(childError({ message: "Unknown workflow child message type" }, stderr)));
      });

      child.once("error", (error) => {
        settle(() => rejectPromise(childError(serializedError(error), stderr)));
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settle(() => rejectPromise(childError({
          message: `TypeScript workflow child exited before completion (code=${String(code)}, signal=${String(signal)})`,
        }, stderr)));
      });
    });
  } finally {
    if (child !== undefined) stopChild(child);
    if (options.keepArtifacts !== true) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
