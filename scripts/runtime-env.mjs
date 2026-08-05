import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[1].startsWith("#")) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function loadRuntimeEnv(root = process.cwd()) {
  const env = {};
  for (const file of [".env.example", ".env.local"]) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    Object.assign(env, parseEnvFile(readFileSync(path, "utf8")));
  }
  // Explicit process variables are the final authority. This keeps a shell,
  // CI job, or compose profile from being silently overridden by local files.
  Object.assign(env, process.env);
  env.NOVEL_PROJECT_ROOT ??= resolve(root);
  env.NOVEL_RUNTIME_PROFILE ??= "local-hybrid";
  env.NOVEL_RUNTIME_ID ??= `creative-studio-${env.NOVEL_RUNTIME_PROFILE}`;
  env.NOVEL_V2_MIGRATIONS_DIR = resolve(root, env.NOVEL_V2_MIGRATIONS_DIR ?? "deploy/postgres");
  env.NOVEL_MODEL_CONFIG_PATH = resolve(root, env.NOVEL_MODEL_CONFIG_PATH ?? "config/model-providers.local.yaml");
  if (env.NOVEL_OBJECT_ROOT) env.NOVEL_OBJECT_ROOT = resolve(root, env.NOVEL_OBJECT_ROOT);
  env.NOVEL_API_HOST ??= "127.0.0.1";
  env.WORKER_HEALTH_HOST ??= "127.0.0.1";
  env.NOVEL_V2_API_PORT ??= "4770";
  env.WORKER_HEALTH_PORT ??= "4771";
  return env;
}

export function childRuntimeEnv(root = process.cwd()) {
  const env = loadRuntimeEnv(root);
  if (env.NOVEL_RUNTIME_PROFILE !== "local-hybrid") throw new Error(`pnpm dev 只支持 local-hybrid，当前为 ${env.NOVEL_RUNTIME_PROFILE}`);
  return env;
}
