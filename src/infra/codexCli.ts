import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve from this package, rather than PATH, npx, or the caller's cwd.
export const codexCliInvocation = (args: string[]): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [require.resolve("@openai/codex/bin/codex.js"), ...args]
});
