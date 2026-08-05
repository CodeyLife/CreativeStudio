import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { childRuntimeEnv } from "./runtime-env.mjs";

const service = process.argv[2];
if (service !== "api" && service !== "worker") {
  throw new Error("usage: node scripts/run-v2-service.mjs <api|worker>");
}

const root = resolve(import.meta.dirname, "..");
const env = childRuntimeEnv(root);
env.NOVEL_PROJECT_ROOT = root;

const child = spawn(process.execPath, ["--import", "tsx", `scripts/novel-v2-${service}.ts`], {
  stdio: "inherit",
  windowsHide: true,
  cwd: root,
  env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code) => process.exit(code ?? 0));
