import { describe, expect, it } from "vitest";
import { resolveNovelRuntimeConfig } from "../runtime-config";

const baseEnv = {
  NOVEL_RUNTIME_PROFILE: "local-hybrid",
  NOVEL_RUNTIME_ID: "creative-studio-test",
  NOVEL_PROJECT_ROOT: "I:/Projects/CreativeStudio",
  DATABASE_URL: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp",
  TEMPORAL_ADDRESS: "127.0.0.1:7233",
  QDRANT_URL: "http://127.0.0.1:6333",
  NOVEL_OBJECT_BACKEND: "s3",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_BUCKET: "ymcp-novel",
  S3_ACCESS_KEY_ID: "ymcp",
  S3_SECRET_ACCESS_KEY: "test-secret",
} as NodeJS.ProcessEnv;

describe("novel runtime config", () => {
  it("normalizes paths and produces a non-secret identity fingerprint", () => {
    const config = resolveNovelRuntimeConfig(baseEnv);
    expect(config.migrationsDir).toBe("I:\\Projects\\CreativeStudio\\deploy\\postgres");
    expect(config.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(config.runtimeFingerprint).not.toContain("test-secret");
  });

  it("changes identity when a shared data dependency changes", () => {
    const local = resolveNovelRuntimeConfig(baseEnv);
    const otherObjectStore = resolveNovelRuntimeConfig({ ...baseEnv, S3_ENDPOINT: "http://host.docker.internal:9000" });
    expect(otherObjectStore.runtimeFingerprint).not.toBe(local.runtimeFingerprint);
  });

  it("rejects a relative file object root", () => {
    expect(() => resolveNovelRuntimeConfig({ ...baseEnv, NOVEL_OBJECT_BACKEND: "file", NOVEL_OBJECT_ROOT: ".data/objects" })).toThrow(/绝对路径/u);
  });
});
