import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadRuntimeEnv } from "./runtime-env.mjs";

const root = resolve(import.meta.dirname, "..");
const env = {
  ...process.env,
  NOVEL_RUNTIME_PROFILE: "container",
  NOVEL_RUNTIME_ID: "creative-studio-container",
  NOVEL_POSTGRES_VOLUME: "creative_studio_container_postgres",
  NOVEL_QDRANT_VOLUME: "creative_studio_container_qdrant",
  NOVEL_MINIO_VOLUME: "creative_studio_container_minio",
  NOVEL_TEI_VOLUME: "creative_studio_container_tei_cache",
  MINIO_BUCKET: "ymcp-novel-container",
};
// Resolve the normal defaults first so the wrapper has the same credentials and
// database contract as every other entrypoint, then override container identity.
Object.assign(env, loadRuntimeEnv(root), {
  NOVEL_RUNTIME_PROFILE: "container",
  NOVEL_RUNTIME_ID: "creative-studio-container",
  NOVEL_POSTGRES_VOLUME: "creative_studio_container_postgres",
  NOVEL_QDRANT_VOLUME: "creative_studio_container_qdrant",
  NOVEL_MINIO_VOLUME: "creative_studio_container_minio",
  NOVEL_TEI_VOLUME: "creative_studio_container_tei_cache",
  MINIO_BUCKET: "ymcp-novel-container",
});

await new Promise((resolveRun, rejectRun) => {
  const docker = spawn(process.platform === "win32" ? "docker.exe" : "docker", [
    "compose", "-f", resolve(root, "docker-compose.v2.yml"), "--project-name", "creative-studio-container", "--profile", "container", "up", "-d", "--wait", "--wait-timeout", "180",
  ], { cwd: root, stdio: "inherit", windowsHide: true, env });
  docker.once("error", rejectRun);
  docker.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Docker Compose exited with ${code}`)));
});
