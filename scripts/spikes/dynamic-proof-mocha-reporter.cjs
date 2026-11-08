const { writeFileSync } = require("node:fs");

function safeValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function serializeError(error) {
  const detail = {
    name: error?.name ?? null,
    constructorName: error?.constructor?.name ?? null,
    message: error?.message ?? null,
    stack: error?.stack ?? null
  };
  for (const key of ["actual", "expected", "operator", "showDiff", "ok", "diff", "generatedMessage", "code"]) {
    if (error && key in error) {
      detail[key] = safeValue(error[key]);
    }
  }
  return detail;
}

function failureMessage(error) {
  if (typeof error?.stack === "string" && error.stack.trim()) {
    return error.stack;
  }
  const name = error?.name ?? "Error";
  const message = error?.message ?? String(error);
  return `${name}: ${message}`;
}

function ancestorTitles(test) {
  const titles = [];
  let parent = test?.parent;
  while (parent) {
    if (parent.title) {
      titles.unshift(parent.title);
    }
    parent = parent.parent;
  }
  return titles;
}

// Mocha marks a hook with type "hook". The title is consulted only when no type is given at all: a test
// whose title happens to start with "before" or "after" is a test.
function isHookFailure(test) {
  const type = String(test?.type ?? "");
  if (type) {
    return type === "hook";
  }
  return /^"(?:before|after)(?: each| all)?" hook/i.test(String(test?.title ?? ""));
}

class DynamicProofMochaReporter {
  constructor(runner) {
    const files = new Map();

    function bucket(test) {
      const file = test?.file ?? "";
      if (!files.has(file)) {
        files.set(file, { name: file, assertionResults: [] });
      }
      return files.get(file);
    }

    runner.on("pass", test => {
      bucket(test).assertionResults.push({
        ancestorTitles: ancestorTitles(test),
        fullName: typeof test?.fullTitle === "function" ? test.fullTitle() : test?.title ?? "",
        status: "passed",
        title: test?.title ?? "",
        file: test?.file ?? null,
        duration: typeof test?.duration === "number" ? test.duration : null,
        failureMessages: [],
        failureDetails: []
      });
    });

    // A skipped or pending test did not run. It is listed so that a run of nothing is visible as such.
    runner.on("pending", test => {
      bucket(test).assertionResults.push({
        ancestorTitles: ancestorTitles(test),
        fullName: typeof test?.fullTitle === "function" ? test.fullTitle() : test?.title ?? "",
        status: "pending",
        title: test?.title ?? "",
        file: test?.file ?? null,
        duration: null,
        failureMessages: [],
        failureDetails: []
      });
    });

    runner.on("fail", (test, error) => {
      bucket(test).assertionResults.push({
        ancestorTitles: ancestorTitles(test),
        fullName: typeof test?.fullTitle === "function" ? test.fullTitle() : test?.title ?? "",
        status: "failed",
        title: test?.title ?? "",
        file: test?.file ?? null,
        duration: typeof test?.duration === "number" ? test.duration : null,
        failurePhase: isHookFailure(test) ? "hook" : "test",
        failureMessages: [failureMessage(error)],
        failureDetails: [serializeError(error)]
      });
    });

    runner.once("end", () => {
      const stats = runner.stats ?? {};
      const totals = {
        tests: stats.tests ?? null,
        passes: stats.passes ?? null,
        failures: stats.failures ?? null,
        pending: stats.pending ?? null
      };
      const body = `${JSON.stringify({ testResults: Array.from(files.values()), stats: totals }, null, 2)}\n`;
      if (process.env.OPRO_DYNAMIC_PROOF_REPORT) {
        writeFileSync(process.env.OPRO_DYNAMIC_PROOF_REPORT, body);
        return;
      }
      process.stdout.write(body);
    });
  }
}

// ── The signed channel (OPRO_DYNAMIC_PROOF_FRAME=1): what OrangePro's own stages use ─────────────
//
// The tests run in the same process as this reporter, so a test could change what an ordinary
// reporter writes: replace JSON.stringify or Array.prototype.push, print a report of its own, or
// write the report file itself. In this mode the reporter:
//   - takes every built-in it needs when this module loads, which Mocha does before it loads any test
//     file, and at report time calls none it did not take then (it encodes the report itself, from
//     character codes: Buffer's string methods look up base64Slice and the like when they are called);
//   - reads a key the parent gives only to it, on stdin, once, when it loads; the key is in no
//     argument, variable, mount or file;
//   - writes exactly one frame to stdout, `<<OPRO-FRAME:v1:<hmac>:<base64 report>>>`, signed with that
//     key, and nothing to the output folder.
// The parent accepts a stage's report only when there is exactly one frame and it verifies. A missing,
// extra or unsigned frame, or a report file, makes the stage's account unusable, never a pass or a catch.
// This is not unforgeable from inside the process: what keeps a candidate from rewriting what the reporter
// uses is verify-test's refusal of writes to anything the test did not make (candidatePatch.ts).
const FRAME_MODE = process.env.OPRO_DYNAMIC_PROOF_FRAME === "1";

function armSignedReporter() {
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const events = require("node:events");
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const writeSync = fs.writeSync;
  const readSync = fs.readSync;
  const createHmac = crypto.createHmac;
  const hmacProto = Object.getPrototypeOf(createHmac("sha256", "x"));
  const hmacUpdate = hmacProto.update;
  const hmacDigest = hmacProto.digest;
  const bufferFrom = Buffer.from;
  const bufferAlloc = Buffer.alloc;
  const bufferToString = Buffer.prototype.toString;
  const charCodeAt = String.prototype.charCodeAt;
  const emit = events.prototype.emit;
  const on = events.prototype.on;
  const stringify = JSON.stringify;
  const regexTest = RegExp.prototype.test;
  const atomicsWait = Atomics.wait;
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  const HOOK_TITLE = /^"(?:before|after)(?: each| all)?" hook/i;
  const HEX = "0123456789abcdef";
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // The key: 64 hex characters and a newline, read before any test file exists.
  let key = null;
  try {
    const buf = bufferAlloc(65);
    let got = 0;
    for (let tries = 0; got < 65 && tries < 2000; tries++) {
      let n = 0;
      try {
        n = readSync(0, buf, got, 65 - got, null);
      } catch (error) {
        if (error && error.code === "EAGAIN") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          continue;
        }
        break;
      }
      if (n === 0) break;
      got += n;
    }
    const text = apply(bufferToString, buf, ["latin1", 0, got]);
    if (got === 65 && /^[0-9a-f]{64}\n$/.test(text)) key = bufferFrom(text.slice(0, 64), "hex");
  } catch {
    key = null;
  }
  // The key goes into the HMAC now and is kept nowhere else: nothing at report time is handed it.
  const mac = key ? createHmac("sha256", key) : null;
  if (key) key.fill(0);
  key = null;

  // JSON text from primitives only, with no lookup a test could have changed. ASCII out.
  function q(value) {
    if (typeof value !== "string") return "null";
    let out = '"';
    const n = value.length;
    for (let i = 0; i < n; i++) {
      const c = apply(charCodeAt, value, [i]);
      if (c === 34) out += '\\"';
      else if (c === 92) out += "\\\\";
      else if (c >= 32 && c < 127) out += value[i];
      else out += "\\u" + HEX[(c >> 12) & 15] + HEX[(c >> 8) & 15] + HEX[(c >> 4) & 15] + HEX[c & 15];
    }
    return out + '"';
  }
  // Base64 of an ASCII string, from character codes: no Buffer method a test could replace (base64Slice, utf8Write) is used.
  function base64(text) {
    let out = "";
    const n = text.length;
    let i = 0;
    for (; i + 2 < n; i += 3) {
      const v = (apply(charCodeAt, text, [i]) << 16) | (apply(charCodeAt, text, [i + 1]) << 8) | apply(charCodeAt, text, [i + 2]);
      out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    if (n - i === 1) {
      const v = apply(charCodeAt, text, [i]) << 16;
      out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + "==";
    } else if (n - i === 2) {
      const v = (apply(charCodeAt, text, [i]) << 16) | (apply(charCodeAt, text, [i + 1]) << 8);
      out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + "=";
    }
    return out;
  }
  function num(value) {
    if (typeof value !== "number" || value !== value || value === Infinity || value === -Infinity) return "null";
    return "" + value;
  }
  function prim(value) {
    if (value === undefined || value === null) return "null";
    if (typeof value === "string") return q(value);
    if (typeof value === "number") return num(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    // An object's display value (actual, expected): best effort, and never trusted for a verdict.
    try {
      return q(stringify(value));
    } catch {
      return "null";
    }
  }
  function own(object, name) {
    try {
      return object === null || object === undefined ? undefined : object[name];
    } catch {
      return undefined;
    }
  }

  return class SignedDynamicProofMochaReporter {
    constructor(runner) {
      // Mocha's runner emits through EventEmitter.prototype.emit: pinned here, so a test that replaces it reaches no event.
      defineProperty(runner, "emit", { __proto__: null, value: emit, writable: false, configurable: false, enumerable: false });
      let broken = !mac;
      let ended = false;
      let current = null;
      let currentInfo = null;
      const files = { __proto__: null };
      const order = { __proto__: null };
      let fileCount = 0;

      // The titles as Mocha reports them (fullTitle: every non-root suite's title and the test's own, joined by spaces).
      function describeTest(test) {
        let ancestors = "";
        let path = "";
        let parent = own(test, "parent");
        let guard = 0;
        while (parent && guard++ < 1000) {
          const title = own(parent, "title");
          const isRoot = own(parent, "root") === true;
          if (title) ancestors = ancestors === "" ? q(title) : q(title) + "," + ancestors;
          if (!isRoot) path = path === "" ? (typeof title === "string" ? title : "") : (typeof title === "string" ? title : "") + " " + path;
          parent = own(parent, "parent");
        }
        const title = own(test, "title");
        const own_title = typeof title === "string" ? title : "";
        const file = own(test, "file");
        return { __proto__: null, ancestors: "[" + ancestors + "]", fullName: path === "" ? own_title : path + " " + own_title, title: own_title, file: typeof file === "string" ? file : null };
      }
      function infoOf(test) {
        return test === current && currentInfo ? currentInfo : describeTest(test);
      }
      function add(file, entry) {
        const name = file === null ? "" : file;
        if (files[name] === undefined) {
          order[fileCount] = name;
          fileCount += 1;
          files[name] = entry;
        } else {
          files[name] = files[name] + "," + entry;
        }
      }
      function entry(info, status, duration, extra) {
        return "{" + '"ancestorTitles":' + info.ancestors + ',"fullName":' + q(info.fullName) + ',"status":' + q(status) + ',"title":' + q(info.title) + ',"file":' + (info.file === null ? "null" : q(info.file)) + ',"duration":' + num(duration) + extra + "}";
      }
      function hookFailure(test) {
        const type = own(test, "type");
        if (typeof type === "string" && type !== "") return type === "hook";
        const title = own(test, "title");
        return typeof title === "string" && apply(regexTest, HOOK_TITLE, [title]);
      }
      const listen = (name, fn) =>
        apply(on, runner, [
          name,
          function (a, b) {
            try {
              fn(a, b);
            } catch {
              broken = true;
            }
          }
        ]);

      listen("test", (test) => {
        current = test;
        currentInfo = describeTest(test);
      });
      listen("pass", (test) => {
        const info = infoOf(test);
        add(info.file, entry(info, "passed", own(test, "duration"), ',"failureMessages":[],"failureDetails":[]'));
      });
      listen("pending", (test) => {
        const info = infoOf(test);
        add(info.file, entry(info, "pending", null, ',"failureMessages":[],"failureDetails":[]'));
      });
      listen("fail", (test, error) => {
        const info = infoOf(test);
        const stack = own(error, "stack");
        const name = own(error, "name");
        const message = own(error, "message");
        const ctor = own(error, "constructor");
        let detail = '{"name":' + prim(name === undefined ? null : name) + ',"constructorName":' + prim(own(ctor, "name") ?? null) + ',"message":' + prim(message === undefined ? null : message) + ',"stack":' + prim(stack === undefined ? null : stack);
        const keys = ["actual", "expected", "operator", "showDiff", "ok", "diff", "generatedMessage", "code"];
        for (let i = 0; i < 8; i++) {
          let present = false;
          try {
            present = error !== null && typeof error === "object" && keys[i] in error;
          } catch {
            present = false;
          }
          if (present) detail += "," + q(keys[i]) + ":" + prim(own(error, keys[i]));
        }
        detail += "}";
        const failure = typeof stack === "string" && stack !== "" ? stack : (typeof name === "string" ? name : "Error") + ": " + (typeof message === "string" ? message : "");
        add(info.file, entry(info, "failed", own(test, "duration"), ',"failurePhase":' + q(hookFailure(test) ? "hook" : "test") + ',"failureMessages":[' + q(failure) + '],"failureDetails":[' + detail + "]"));
      });
      listen("end", () => {
        if (ended) return;
        ended = true;
        if (broken) return;
        const stats = own(runner, "stats");
        let results = "";
        for (let i = 0; i < fileCount; i++) {
          const name = order[i];
          results += (i === 0 ? "" : ",") + '{"name":' + q(name) + ',"assertionResults":[' + files[name] + "]}";
        }
        const body = '{"testResults":[' + results + '],"stats":{"tests":' + num(own(stats, "tests") ?? null) + ',"passes":' + num(own(stats, "passes") ?? null) + ',"failures":' + num(own(stats, "failures") ?? null) + ',"pending":' + num(own(stats, "pending") ?? null) + "}}";
        // The body is ASCII by construction (q escapes everything else), so its bytes are its character codes.
        const payload = base64(body);
        apply(hmacUpdate, mac, [payload, "latin1"]);
        const tag = apply(hmacDigest, mac, ["hex"]);
        const line = "\n<<OPRO-FRAME:v1:" + tag + ":" + payload + ">>\n";
        // stdout is a pipe that may not block: a full pipe (64 KiB) answers EAGAIN, and the rest is written once it drains.
        let written = 0;
        const total = line.length;
        const bytes = bufferAlloc(total);
        for (let i = 0; i < total; i++) bytes[i] = apply(charCodeAt, line, [i]);
        for (let waits = 0; written < total && waits < 600000; ) {
          try {
            written += writeSync(1, bytes, written, total - written);
          } catch (error) {
            if (!error || error.code !== "EAGAIN") throw error;
            waits += 1;
            apply(atomicsWait, null, [sleepCell, 0, 0, 1]);
          }
        }
      });
    }
  };
}

module.exports = FRAME_MODE ? armSignedReporter() : DynamicProofMochaReporter;
