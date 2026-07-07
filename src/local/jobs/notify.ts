/**
 * Best-effort completion notification for a background job. The status JSON is the
 * canonical signal an agent polls; this just nudges a human: a terminal bell
 * (cross-platform, zero deps) and, on macOS, an optional `osascript` notification.
 * All side effects are injectable so tests never fire a real OS notification.
 */
import { execFile } from "node:child_process";
import { JobRecord } from "./jobStore.js";

const BELL = String.fromCharCode(7); // ASCII BEL — terminal beep, zero deps

export interface NotifyHooks {
  /** Where the terminal bell goes (default: stderr). */
  write?: (s: string) => void;
  /** OS notifier (default: macOS osascript; no-op elsewhere). */
  notifier?: (title: string, body: string) => void;
  platform?: NodeJS.Platform;
}

export function notifyJobDone(rec: JobRecord, hooks: NotifyHooks = {}): void {
  const write = hooks.write ?? ((s: string) => void process.stderr.write(s));
  const platform = hooks.platform ?? process.platform;
  // Terminal bell — the canonical completion signal stays the status file.
  write(BELL);
  const title = "OrangePro";
  const body = `Job ${rec.id} ${rec.status}`;
  const notifier =
    hooks.notifier ??
    ((t: string, b: string): void => {
      if (platform !== "darwin") return;
      try {
        // Array args (injection-safe); fire-and-forget, swallow any error.
        execFile("osascript", ["-e", `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)}`], () => {});
      } catch {
        // best-effort only
      }
    });
  notifier(title, body);
}
