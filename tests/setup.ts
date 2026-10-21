import { setImmediate } from "node:timers";
import { afterEach } from "vitest";

// Vitest runs a file's tests back to back without giving Node's event loop a
// turn, so a file of synchronous work (git, child processes) can hold it for a
// minute. The worker then cannot read the main process's replies, and a reply
// older than vitest's fixed 60 s limit fails the run with
// `Timeout calling "onTaskUpdate"` even when every test passed. One turn after
// each test keeps that window to a single test.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
