declare module "*.mjs" {
  export function loadRuntimeEnv(root?: string): Record<string, string>;
  export function childRuntimeEnv(root?: string): Record<string, string>;
}
