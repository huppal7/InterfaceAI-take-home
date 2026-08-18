/**
 * Start the mock console as a child process. Used by e2e tests and evidence capture.
 * Spawns Node + local tsx (not `npx`) so it works on Windows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

export async function waitForUrl(url: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`mock app did not start at ${url}`);
}

export async function launchMockApp(
  port: number,
  extraEnv: Record<string, string> = {}
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [tsxCli, "src/mock-app/server.ts"], {
    env: { ...process.env, APP_PORT: String(port), FORCE_NOTICE: extraEnv.FORCE_NOTICE ?? "0", ...extraEnv },
    stdio: "ignore",
    windowsHide: true,
  });
  await waitForUrl(`http://localhost:${port}/login`);
  return child;
}
