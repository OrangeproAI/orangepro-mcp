import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

// The execution boundary for customer-repository code (context §12.7, handoff §5).
// Every command that runs a customer's code runs in one container shape: the pinned
// image, no network, a read-only root and read-only copies, no capabilities, and one
// empty run-owned folder it may write. The kit itself stays on the host; nothing of
// the host is passed in except the mounts listed here. The shape is V1's test stage
// (artifacts/milestones/M0/0.2.58/isolation/boundary.sh) plus OrangePro's reporter,
// read-only, and that one output folder.

export const WORK_REPO = "/work/repo";
export const WORK_OUT = "/work/out";
export const OPRO_DIR = "/opro";

export interface ContainerShape {
  image: string;
  platform: string;
  memory: string;
  cpus: string;
  processes: number;
  deadlineSeconds: number;
}

export const CONTAINER_USER = "1000:1000";
export const CONTAINER_TMP_SIZE = "2g";

export interface ContainerMount {
  /** Host path. Never recorded: `role` stands in for it. */
  source: string;
  target: string;
  readonly: boolean;
  /** How the mount is named in records: `<original>`, `<mutant>`, `<node_modules>`, `<out>`, `<reporter>`, `<witness>`. */
  role: string;
}

export interface ContainerRequest {
  shape: ContainerShape;
  mounts: ContainerMount[];
  env: Record<string, string>;
  workdir: string;
  command: string[];
  deadlineMs: number;
}

export interface ContainerResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The full `docker run` argv with host paths replaced by mount roles. */
  dockerArgv: string[];
  /** false when the container could not be confirmed gone after its deadline: nothing after it can be trusted. */
  stopped: boolean;
}

/** Runs one command in the boundary. Injectable, so tests can run synthetic fixtures without docker. */
export type ContainerExecutor = (request: ContainerRequest) => ContainerResult;

// The variables V1's test shape sets. Anything else the caller adds is named in the stage record.
const SHAPE_ENV: Record<string, string> = {
  HOME: "/tmp/home",
  npm_config_cache: "/tmp/npm-cache",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  NODE_ENV: "test",
  CI: "1"
};

export function shapeEnvNames(extra: Record<string, string>): string[] {
  return [...new Set([...Object.keys(SHAPE_ENV), ...Object.keys(extra)])].sort();
}

/** `docker run` arguments for one command. Host paths go in `--mount`; `forRecord` swaps them for roles. */
export function dockerRunArgs(name: string, request: ContainerRequest, forRecord = false): string[] {
  const { shape } = request;
  const args = [
    "run",
    "--name",
    forRecord ? "<name>" : name,
    "--rm",
    "--init",
    "--platform",
    shape.platform,
    "--pull",
    "never",
    "--user",
    CONTAINER_USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,size=${CONTAINER_TMP_SIZE}`,
    "--memory",
    shape.memory,
    "--memory-swap",
    shape.memory,
    "--cpus",
    shape.cpus,
    "--pids-limit",
    String(shape.processes),
    "--ulimit",
    "nofile=4096:4096",
    "--hostname",
    "opro-boundary",
    "--network",
    "none",
    "--workdir",
    request.workdir
  ];
  for (const [key, value] of Object.entries({ ...SHAPE_ENV, ...request.env })) args.push("--env", `${key}=${value}`);
  for (const mount of request.mounts) {
    args.push("--mount", `type=bind,src=${forRecord ? mount.role : mount.source},dst=${mount.target}${mount.readonly ? ",readonly" : ""}`);
  }
  return [...args, shape.image, ...request.command];
}

/** A mount source docker's `--mount` syntax can carry unchanged. */
export function assertMountablePath(path: string): void {
  if (/[,"\n\r]/.test(path)) throw new Error(`cannot mount ${path} into the container: it contains a comma, a quote or a line break.`);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The docker client, as an absolute path. `ORANGEPRO_DOCKER` wins when it names an
 * executable file; otherwise PATH is searched, skipping relative entries and any entry
 * inside a `node_modules` folder (npx and npm exec put a project's `.bin` first, and a
 * dependency's `docker` must never run on the host). null when none is found.
 */
export function resolveDocker(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ORANGEPRO_DOCKER?.trim();
  if (explicit) return isAbsolute(explicit) && isExecutableFile(explicit) ? explicit : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir) || dir.split(/[\\/]/).includes("node_modules")) continue;
    const candidate = join(dir, "docker");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The real executor: `docker run`, with a deadline that stops the container, not only the
 * client. At the deadline the client is killed outright, the container is killed and
 * removed, and the run is marked not stopped unless docker confirms it is gone.
 */
export function dockerExecutor(dockerBin: string | null = resolveDocker()): ContainerExecutor {
  return (request) => {
    for (const mount of request.mounts) assertMountablePath(mount.source);
    const name = `opro-probe-${process.pid}-${randomBytes(4).toString("hex")}`;
    const dockerArgv = ["docker", ...dockerRunArgs(name, request, true)];
    if (!dockerBin) {
      return { exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "docker was not found on a trusted PATH (set ORANGEPRO_DOCKER to its absolute path).", durationMs: 0, dockerArgv, stopped: true };
    }
    const started = Date.now();
    const child = spawnSync(dockerBin, dockerRunArgs(name, request), {
      encoding: "utf8",
      timeout: request.deadlineMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const code = (child.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = code === "ETIMEDOUT";
    let stopped = true;
    if (timedOut || (child.error && code !== "ENOENT")) {
      spawnSync(dockerBin, ["kill", name], { stdio: "ignore", timeout: 30_000 });
      stopped = false;
      for (let attempt = 0; attempt < 10 && !stopped; attempt++) {
        spawnSync(dockerBin, ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
        stopped = spawnSync(dockerBin, ["inspect", "--type", "container", name], { stdio: "ignore", timeout: 30_000 }).status !== 0;
        if (!stopped) sleepMs(500);
      }
    }
    return {
      exitCode: child.status,
      signal: child.signal,
      timedOut,
      stdout: child.stdout ?? "",
      stderr: code === "ENOENT" ? `${dockerBin} could not be started.` : (child.stderr ?? ""),
      durationMs: Date.now() - started,
      dockerArgv,
      stopped
    };
  };
}

// Runs inside the container (`node -e <this> <json>`). Reports what the process can see and
// do; it reads no secret. The host compares the report with what the shape promises.
export const BOUNDARY_PROBE_SOURCE = String.raw`
const fs = require("fs");
const net = require("net");
const want = JSON.parse(process.argv[1]);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const canWrite = (dir) => { const p = dir + "/.opro-boundary-probe-" + process.pid; try { fs.writeFileSync(p, "x"); fs.rmSync(p); return true; } catch { return false; } };
const canWriteTarget = (t) => { let file = false; try { file = fs.statSync(t).isFile(); } catch { return false; } if (!file) return canWrite(t); try { fs.closeSync(fs.openSync(t, "r+")); return true; } catch { return false; } };
const status = read("/proc/self/status") || "";
const field = (k) => { const m = status.match(new RegExp("^" + k + ":\\s*(.+)$", "m")); return m ? m[1].trim() : null; };
// Every mount point except the ones docker itself always makes. What is left came from the host.
const DOCKER_OWN = new Set(["/", "/tmp", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf", "/sbin/docker-init", "/usr/sbin/docker-init"]);
const hostBacked = [...new Set((read("/proc/self/mountinfo") || "").split("\n")
  .map((line) => (line.split(" - ")[0] || "").split(" ")[4])
  .filter((point) => point && !DOCKER_OWN.has(point) && !/^\/(proc|sys|dev)(\/|$)/.test(point)))].sort();
const out = {
  node: process.version,
  uid: process.getuid(),
  effective_capabilities: field("CapEff"),
  no_new_privileges: field("NoNewPrivs"),
  env_names: Object.keys(process.env).sort(),
  host_users_dir_visible: fs.existsSync("/Users") || fs.existsSync("/home/" + (process.env.USER || "nobody-here")),
  docker_socket_visible: fs.existsSync("/var/run/docker.sock"),
  root_writable: canWrite(""),
  tmp_writable: canWrite("/tmp"),
  writable: Object.fromEntries(want.check_writable.map((target) => [target, canWriteTarget(target)])),
  host_backed_mounts: hostBacked
};
const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
const done = (reachable) => { out.network_reachable = reachable; socket.destroy(); process.stdout.write(JSON.stringify(out) + "\n"); };
socket.on("connect", () => done(true));
socket.on("timeout", () => done(false));
socket.on("error", () => done(false));
`;

/** The probe's command and what its report must show for the given mounts. */
export function boundaryProbeRequest(base: Omit<ContainerRequest, "command">): ContainerRequest {
  const checkWritable = base.mounts.map((mount) => mount.target);
  return { ...base, command: ["node", "-e", BOUNDARY_PROBE_SOURCE, JSON.stringify({ check_writable: checkWritable })] };
}

const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSPHRASE|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/**
 * Compare the probe's report with the shape. Returns the list of promises it broke;
 * empty means the boundary holds for these mounts.
 */
export function boundaryFailures(report: unknown, request: ContainerRequest, expectedNode: string | null = null): string[] {
  const failures: string[] = [];
  if (typeof report !== "object" || report === null) return ["the probe printed no report"];
  const r = report as Record<string, unknown>;
  if (expectedNode !== null && r.node !== expectedNode) failures.push(`the container runs Node ${String(r.node)}, not ${expectedNode}: not the pinned image`);
  if (r.network_reachable !== false) failures.push("the network is reachable");
  if (r.uid !== 1000) failures.push(`the process runs as uid ${String(r.uid)}, not 1000`);
  if (r.effective_capabilities !== "0000000000000000") failures.push(`effective capabilities are ${String(r.effective_capabilities)}`);
  if (r.no_new_privileges !== "1") failures.push("no-new-privileges is not set");
  if (r.root_writable !== false) failures.push("the root filesystem is writable");
  if (r.tmp_writable !== true) failures.push("/tmp is not writable");
  if (r.host_users_dir_visible !== false) failures.push("a host home folder is visible");
  if (r.docker_socket_visible !== false) failures.push("the docker socket is visible");
  const writable = (r.writable ?? {}) as Record<string, unknown>;
  for (const mount of request.mounts) {
    if (writable[mount.target] !== !mount.readonly) failures.push(`${mount.target} is ${writable[mount.target] ? "writable" : "not writable"}, expected ${mount.readonly ? "read-only" : "writable"}`);
  }
  const expectedMounts = request.mounts.map((mount) => mount.target).sort();
  const seen = Array.isArray(r.host_backed_mounts) ? (r.host_backed_mounts as unknown[]).map(String).sort() : null;
  if (!seen || seen.join("\n") !== expectedMounts.join("\n")) {
    failures.push(`host-backed mounts are [${seen?.join(", ") ?? "unknown"}], expected [${expectedMounts.join(", ")}]`);
  }
  const names = Array.isArray(r.env_names) ? (r.env_names as unknown[]).map(String) : [];
  const secretLooking = names.filter((name) => SECRET_NAME_RE.test(name));
  if (secretLooking.length > 0) failures.push(`secret-looking variables are visible: ${secretLooking.join(", ")}`);
  const unexpected = names.filter((name) => !shapeEnvNames(request.env).includes(name) && !["PATH", "HOSTNAME", "NODE_VERSION", "YARN_VERSION", "PWD", "SHLVL", "_"].includes(name));
  if (unexpected.length > 0) failures.push(`unexpected variables are visible: ${unexpected.join(", ")}`);
  return failures;
}
