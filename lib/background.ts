// Run work after the response is sent. Inside a Next.js request this uses after() (kept alive
// on Vercel via waitUntil); outside one (tests, scripts) it just runs detached.
import { after } from "next/server";

export function background(name: string, fn: () => Promise<unknown>) {
  const run = () => fn().catch((e) => console.error(`[bg:${name}]`, e));
  try {
    after(run);
  } catch {
    void run();
  }
}
