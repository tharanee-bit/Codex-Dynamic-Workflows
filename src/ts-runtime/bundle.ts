import { builtinModules } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { build } from "esbuild";

import { canonicalPath } from "../util/path.js";
import type {
  BundleTypeScriptWorkflowOptions,
  TypeScriptWorkflowBundle,
} from "./types.js";

const NETWORK_BUILTINS = new Set([
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_tls_common",
  "_tls_wrap",
  "dgram",
  "dns",
  "dns/promises",
  "http",
  "http2",
  "https",
  "net",
  "quic",
  "tls",
]);
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const CODE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Bundle a TypeScript coordinator into one ESM file before it enters the
 * constrained child. Built-in Node modules intentionally remain external so
 * Node's permission model can deny their sensitive operations at runtime.
 */
export async function bundleTypeScriptWorkflow(
  options: BundleTypeScriptWorkflowOptions,
): Promise<TypeScriptWorkflowBundle> {
  const entry = await realpath(resolve(options.workflowPath));
  const importRoot = dirname(entry);
  const temporaryDirectory = options.outputDirectory
    ? undefined
    : await canonicalPath(await mkdtemp(join(tmpdir(), "codex-dw-ts-")));
  const outputDirectory = await canonicalPath(resolve(options.outputDirectory ?? temporaryDirectory!));
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

  const outputName = `${basename(entry).replace(/\.[^.]+$/, "")}.bundle.mjs`;
  const bundlePath = join(outputDirectory, outputName);

  try {
    await build({
      entryPoints: [entry],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "bundle",
      sourcemap: false,
      legalComments: "none",
      logLevel: "silent",
      plugins: [{
        name: "codex-dw-confine-coordinator-imports",
        setup(buildContext) {
          buildContext.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            const contents = await readFile(args.path, "utf8");
            if (/\bimport\s*\(/u.test(contents)) {
              return { errors: [{ text: "TypeScript workflow coordinators may not use dynamic import()" }] };
            }
            const extension = extname(args.path).toLowerCase();
            return {
              contents,
              loader: extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts" : "js",
              resolveDir: dirname(args.path),
            };
          });
          buildContext.onResolve({ filter: /.*/ }, async (args) => {
            if (args.kind === "entry-point") return { path: entry };
            const name = args.path.replace(/^node:/, "");
            if (NODE_BUILTINS.has(name)) {
              if (NETWORK_BUILTINS.has(name)) {
                return { errors: [{ text: `TypeScript workflow coordinators may not import network module '${args.path}'` }] };
              }
              return { path: args.path.startsWith("node:") ? args.path : `node:${name}`, external: true };
            }
            if (!args.path.startsWith("./") && !args.path.startsWith("../")) {
              return { errors: [{ text: `TypeScript workflow imports must be relative code files; package or URL import '${args.path}' is not allowed` }] };
            }
            const extension = extname(args.path).toLowerCase();
            if (!CODE_EXTENSIONS.has(extension)) {
              return { errors: [{ text: `TypeScript workflow import '${args.path}' must use an explicit code extension` }] };
            }
            let target: string;
            try {
              target = await realpath(resolve(args.resolveDir, args.path));
            } catch {
              return { errors: [{ text: `TypeScript workflow import '${args.path}' could not be resolved` }] };
            }
            if (!isInside(importRoot, target)) {
              return { errors: [{ text: `TypeScript workflow import '${args.path}' escapes the workflow directory` }] };
            }
            return { path: target };
          });
        },
      }],
    });
    const generated = await readFile(bundlePath, "utf8");
    if (/\bimport\s*\(/u.test(generated)) {
      throw new Error("TypeScript workflow coordinators may not use dynamic import()");
    }
  } catch (error) {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    bundlePath,
    ...(temporaryDirectory === undefined ? {} : { temporaryDirectory }),
  };
}
