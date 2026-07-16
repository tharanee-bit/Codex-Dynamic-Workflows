import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandResult {
  command: string;
  args: readonly string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  maxOutputBytes?: number;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    const details = result.stderr.trim() || result.stdout.trim() || "no command output";
    super(`${result.command} exited with code ${result.exitCode}: ${details}`);
    this.name = "CommandError";
    this.result = result;
  }
}

/** Run a process directly with an argv array. A shell is never involved. */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const failOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        failOnce(new Error(`${command} exceeded the ${maxOutputBytes}-byte output limit`));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", failOnce);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const result: CommandResult = {
        command,
        args: [...args],
        cwd: options.cwd,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? (signal === null ? 1 : 128),
      };
      if (result.exitCode !== 0 && options.allowFailure !== true) {
        reject(new CommandError(result));
      } else {
        resolve(result);
      }
    });
  });
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: Omit<CommandOptions, "cwd"> = {},
): Promise<CommandResult> {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP",
  ] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (options.env?.GIT_INDEX_FILE !== undefined) {
    environment.GIT_INDEX_FILE = options.env.GIT_INDEX_FILE;
  }
  const disabledHooks = join(tmpdir(), `codex-dw-disabled-hooks-${process.pid}-${randomUUID()}`);
  return await runCommand("git", [
    "-c",
    `core.hooksPath=${disabledHooks}`,
    "-c",
    "core.fsmonitor=false",
    ...args,
  ], { ...options, env: environment, cwd });
}
