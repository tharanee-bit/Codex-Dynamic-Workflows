// This source is materialized beside the bundle so the child only needs read
// permission for two exact files. Keep this file dependency-free: imports in
// the child would expand the permission surface.
export const CHILD_BOOTSTRAP_SOURCE = String.raw`
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";

const pending = new Map();
let requestSequence = 0;
let shuttingDown = false;
const phaseContext = new AsyncLocalStorage();

const NETWORK_MODULES = new Set([
  "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing",
  "_http_server", "_tls_common", "_tls_wrap", "dgram", "dns", "dns/promises",
  "http", "http2", "https", "net", "quic", "tls",
]);

function accessDenied(resource) {
  const error = new Error("Network access is disabled for TypeScript workflow coordinators: " + resource);
  error.name = "PermissionError";
  error.code = "ERR_ACCESS_DENIED";
  return error;
}

async function installNetworkGuard() {
  // Current Node permissions cover files, processes, and workers but do not
  // expose a portable network permission. Block network module resolution and
  // web-platform network globals as an additional defense-in-depth layer.
  const moduleApi = await import("node:module");
  if (typeof moduleApi.registerHooks === "function") {
    moduleApi.registerHooks({
      resolve(specifier, context, nextResolve) {
        const name = specifier.replace(/^node:/, "");
        if (NETWORK_MODULES.has(name)) throw accessDenied(specifier);
        return nextResolve(specifier, context);
      },
    });
  }
  if (typeof process.getBuiltinModule === "function") {
    const getBuiltinModule = process.getBuiltinModule.bind(process);
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: false,
      enumerable: true,
      writable: false,
      value(specifier) {
        const name = String(specifier).replace(/^node:/, "");
        if (NETWORK_MODULES.has(name)) throw accessDenied(specifier);
        return getBuiltinModule(specifier);
      },
    });
  }
  for (const name of ["binding", "_linkedBinding"]) {
    if (typeof process[name] === "function") {
      Object.defineProperty(process, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => { throw accessDenied("process." + name); },
      });
    }
  }
  for (const name of ["fetch", "WebSocket", "EventSource"]) {
    if (name in globalThis) {
      Object.defineProperty(globalThis, name, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: () => Promise.reject(accessDenied(name)),
      });
    }
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack, code: error.code };
  }
  return { name: "Error", message: String(error) };
}

function send(message) {
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("TypeScript workflow IPC channel is unavailable");
  }
  process.send(message);
}

function rpc(request) {
  const requestId = String(++requestSequence);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({ type: "rpc", requestId, request });
  });
}

function assertStableId(id, kind) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)) {
    throw new TypeError(kind + " requires a stable id using letters, digits, '.', '_', ':', '/', or '-'");
  }
}

function assertJson(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new TypeError(label + " must be JSON-serializable");
  if (seen.has(value)) throw new TypeError(label + " must not contain cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, label, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (typeof key !== "string") throw new TypeError(label + " keys must be strings");
      assertJson(item, label, seen);
    }
  }
  seen.delete(value);
}

function validateMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new TypeError("TypeScript workflow must export a metadata object named 'meta'");
  }
  if (typeof meta.name !== "string" || meta.name.trim() === "") {
    throw new TypeError("Workflow meta.name must be a non-empty string");
  }
  if (typeof meta.description !== "string" || meta.description.trim() === "") {
    throw new TypeError("Workflow meta.description must be a non-empty string");
  }
  if (!meta.argsSchema || typeof meta.argsSchema !== "object" || Array.isArray(meta.argsSchema)) {
    throw new TypeError("Workflow meta.argsSchema must be an object");
  }
  assertJson(meta, "Workflow metadata");
}

function createContext(config) {
  const usedOperationIds = new Set();
  const claim = (kind, id) => {
    assertStableId(id, kind);
    const key = kind + ":" + id;
    if (usedOperationIds.has(key)) throw new Error("Duplicate " + kind + " id: " + id);
    usedOperationIds.add(key);
  };

  return Object.freeze({
    async phase(id, work) {
      claim("phase", id);
      if (typeof work !== "function") throw new TypeError("phase work must be a function");
      await rpc({ method: "phase", id, action: "start" });
      try {
        const value = await phaseContext.run(id, work);
        await rpc({ method: "phase", id, action: "complete" });
        return value;
      } catch (error) {
        try {
          await rpc({ method: "phase", id, action: "fail", error: serializeError(error).message });
        } catch {}
        throw error;
      }
    },

    async agent(id, prompt, options) {
      claim("agent", id);
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new TypeError("agent prompt must be a non-empty string");
      }
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError("agent options must be an object");
      }
      if (!options.outputSchema || typeof options.outputSchema !== "object" || Array.isArray(options.outputSchema)) {
        throw new TypeError("agent options.outputSchema must be an object");
      }
      assertJson(options, "Agent options");
      const phaseId = options.phaseId ?? phaseContext.getStore();
      const value = await rpc({
        method: "agent",
        id,
        prompt,
        options: { ...options, ...(phaseId === undefined ? {} : { phaseId }) },
      });
      assertJson(value, "Agent result");
      return value;
    },

    async parallel(id, branches) {
      claim("parallel", id);
      if (!branches || typeof branches !== "object" || Array.isArray(branches)) {
        throw new TypeError("parallel branches must be an object");
      }
      const entries = Object.entries(branches);
      if (entries.length === 0) return {};
      for (const [key, branch] of entries) {
        assertStableId(key, "parallel branch");
        if (typeof branch !== "function") throw new TypeError("parallel branch '" + key + "' must be a function");
      }
      const settled = await Promise.allSettled(entries.map(([, branch]) => branch()));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      return Object.fromEntries(entries.map(([key], index) => [key, settled[index].value]));
    },

    async pipeline(id, items, worker, options = {}) {
      claim("pipeline", id);
      if (!Array.isArray(items)) throw new TypeError("pipeline items must be an array");
      if (typeof worker !== "function") throw new TypeError("pipeline worker must be a function");
      const requested = options.concurrency ?? config.pipelineConcurrency;
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > config.pipelineConcurrency) {
        throw new RangeError("pipeline concurrency must be between 1 and " + config.pipelineConcurrency);
      }
      if (options.key !== undefined && typeof options.key !== "function") {
        throw new TypeError("pipeline key must be a function");
      }

      const keys = new Set();
      for (let index = 0; index < items.length; index += 1) {
        const key = options.key ? options.key(items[index], index) : String(index);
        assertStableId(key, "pipeline item key");
        if (keys.has(key)) throw new Error("Duplicate pipeline item key: " + key);
        keys.add(key);
      }

      const results = new Array(items.length);
      let nextIndex = 0;
      const consume = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      };
      const workers = Math.min(requested, items.length);
      const settled = await Promise.allSettled(Array.from({ length: workers }, consume));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      return results;
    },

    async loop(id, work, options) {
      claim("loop", id);
      if (typeof work !== "function") throw new TypeError("loop work must be a function");
      if (!options || typeof options.until !== "function") throw new TypeError("loop until must be a function");
      if (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1 || options.maxIterations > config.maxLoopIterations) {
        throw new RangeError("loop maxIterations must be between 1 and " + config.maxLoopIterations);
      }
      let value;
      for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
        value = await work(iteration);
        if (await options.until(value, iteration)) return value;
      }
      throw new Error("Loop " + id + " reached maxIterations without satisfying its stop condition");
    },

    async log(message, data) {
      if (typeof message !== "string" || message.trim() === "") {
        throw new TypeError("log message must be a non-empty string");
      }
      if (data !== undefined) assertJson(data, "Log data");
      await rpc({ method: "log", message, ...(data === undefined ? {} : { data }) });
    },
  });
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "rpc-result" || message.type === "rpc-error") {
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (message.type === "rpc-result") entry.resolve(message.value);
    else {
      const error = new Error(message.error?.message ?? "Parent RPC failed");
      error.name = message.error?.name ?? "Error";
      entry.reject(error);
    }
  }
});

process.on("disconnect", () => {
  if (!shuttingDown) process.exit(1);
});

async function main() {
  const config = JSON.parse(process.env.CODEX_DW_CHILD_CONFIG ?? "{}");
  delete process.env.CODEX_DW_CHILD_CONFIG;
  await installNetworkGuard();
  const module = await import(pathToFileURL(config.bundlePath).href);
  validateMeta(module.meta);
  if (typeof module.run !== "function") {
    throw new TypeError("TypeScript workflow must export a function named 'run'");
  }
  send({ type: "ready", meta: module.meta });
  const result = await module.run(createContext(config), config.args);
  assertJson(result, "Workflow result");
  shuttingDown = true;
  send({ type: "complete", result });
}

main().catch((error) => {
  shuttingDown = true;
  try { send({ type: "fatal", error: serializeError(error) }); } catch {}
  process.exitCode = 1;
});
`;
