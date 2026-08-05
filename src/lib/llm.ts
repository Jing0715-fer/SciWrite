/**
 * Shared LLM helper — ported from pdb-tracker-web-v4/src/lib/llm.ts.
 *
 * Provider selection policy (NO z-ai, NO hardcoded absolute paths):
 *
 *   The first time a model call is made (or on explicit `inspectProviders()`)
 *   we **probe** each candidate. A candidate is considered *available* only if
 *   its binary resolves on PATH (via `where`/`which`) and a tiny smoke-test
 *   invocation succeeds within a 6-second budget. That probe is cached for
 *   the lifetime of the Node process.
 *
 *   At call time `generateText` walks the candidate list in the user-requested
 *   order (or auto order), and on the first failed call it cleanly falls
 *   through to the next candidate. We never fabricate output.
 *
 *   Each CLI has a tiny *adapter* table — name, smoke-test args, real-call
 *   arg template, output-stream hint (stdout|stderr|both), and a regex to
 *   strip the leading "session_id: ..." banner that some agents emit on
 *   stderr. Adding a new CLI = adding one entry to `CLI_ADAPTERS`.
 *
 * Differences from the upstream pdb-tracker copy:
 *   • SciWrite's existing default LLM is `z-ai-web-dev-sdk` (callZai).
 *   • Cache file lives under `os.tmpdir()/sciwrite-cache/` (not pdb-tracker-cache).
 *   • `inspectProviders()` reports a 'zai-sdk' provider when the SDK is importable.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LlmConfig {
  /** One of: 'cli:hermes' | 'cli:claude' | 'cli:codex' | 'cli:openclaw' | 'cli:gemini' | 'cli:codebuddy' | 'cli:aider' | 'anthropic' | 'openai' | 'zai-sdk' | '' (auto) */
  provider?: string;
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResult {
  ok: boolean;
  content: string;
  /** Alias for `content` — legacy callers read `.text`. */
  text: string;
  provider: string;
  model: string;
  durationMs: number;
  fallback: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface LlmProviderInfo {
  provider: string;
  /** Resolved binary path if a CLI provider; null for SDK providers. */
  bin: string | null;
  /** UI icon — single emoji chosen to loosely match the original brand. */
  icon: string;
  label: string;
  reason: string;
  available: boolean;
  /** 'native' (PATH on host OS), 'wsl' (Linux distro via WSL bridge), or 'sdk'. */
  via: "native" | "wsl" | "sdk";
}

// ─── CLI adapter table ────────────────────────────────────────────────────────

interface CliAdapter {
  id: string;
  label: string;
  icon: string;
  bin: string;
  wslBin?: string;
  /** Hard-coded fallback locations to try before PATH lookup. */
  extraProbePaths?: string[] | (() => string[]);
  /** Args used by the smoke-test probe (default: ['--version']). */
  probeArgs?: string[];
  probeTimeoutMs?: number;
  /** Set true for Node-script shims that need `node <bin> ...args`. */
  needsNode?: boolean;
  /**
   * Real-call argv template. Receives the prompt and (optionally) the user
   * model name. Return an array of args appended to the resolved binary.
   */
  callArgs: (prompt: string, model?: string) => string[];
  /** Which stream(s) to harvest for the agent's reply. */
  outputStream?: "stdout" | "stderr" | "both";
  /** If set, the CLI writes its final answer to this file (token $OUTPUT_FILE substituted). */
  outputFile?: string;
  /** Strip a leading banner (e.g. Hermes' `session_id: ...`). */
  stripBanner?: (raw: string) => string;
  /**
   * Build the `--resume <sessionId>` argv tokens (or equivalent) to append to
   * `callArgs()` when reusing an existing CLI session. When undefined the
   * adapter does not support session reuse and every call starts a fresh
   * CLI session (the existing fallback behavior).
   */
  resumeArg?: (sessionId: string) => string[];
  /**
   * Pull a session id out of the CLI's stdout/stderr. Return null when no
   * id is present (or when the adapter does not surface one). Used together
   * with `resumeArg` to persist a (project, taskType, provider) → session_id
   * mapping across calls.
   */
  parseSessionId?: (raw: string) => string | null;
  /**
   * Extract the LLM's reply text out of `stdout`. Defaults to
   * `stripBanner(raw).trim()`. Override for adapters whose stdout contains
   * structured output (JSON envelopes, stream-json NDJSON, etc.) — without
   * this the entire envelope gets passed up as the LLM's answer.
   */
  extractContent?: (raw: string) => string;
  callTimeoutMs?: number;
  /** Extra env vars merged into the child process environment. */
  extraEnv?: Record<string, string>;
}

const HERMES_BANNER_RE = /(?:^|\n)\s*session_id:\s*\S+\s*(?=\n|$)/i;
// Capture group on the same banner so parseSessionId() can extract just the id.
const HERMES_SESSION_ID_RE = /(?:^|\n)\s*session_id:\s*(\S+)/i;

const CLI_ADAPTERS: CliAdapter[] = [
  {
    id: "hermes",
    label: "Hermes CLI",
    bin: "hermes",
    icon: "🪶",
    wslBin: "hermes",
    probeArgs: ["--version"],
    callArgs: (q) => ["chat", "-q", q, "-Q"],
    outputStream: "both",
    stripBanner: (raw) => raw.replace(HERMES_BANNER_RE, "").trim(),
    // Hermes `chat -q` emits a leading `session_id: <id>` banner (see HERMES_BANNER_RE).
    // We capture it via parseSessionId and pass it back as `--resume <id>` on the
    // next call so the agent reuses the same remote session instead of starting
    // a brand-new one.
    parseSessionId: (raw) => {
      const m = raw.match(HERMES_SESSION_ID_RE);
      return m ? m[1] : null;
    },
    resumeArg: (sessionId) => ["--resume", sessionId],
    // Hermes ships inside a Python venv; first-run startup can take 20-30s
    // on Windows because of a CWD scan that walks the project's AGENTS.md.
    // Give the probe enough time to return a version string before declaring
    // the binary unavailable.
    extraEnv: { PYTHONIOENCODING: "utf-8" },
    probeTimeoutMs: 45_000,
    callTimeoutMs: Number(process.env.HERMES_CLI_TIMEOUT_MS) || 600_000,
  },
  {
    id: "claude",
    label: "Claude Code CLI",
    bin: "claude",
    icon: "🟠",
    wslBin: "claude",
    probeArgs: ["--version"],
    // --output-format json emits a JSON envelope per turn; --resume <sid>
    // reuses an existing session. Same wire shape as codebuddy because the
    // two CLIs share a common ancestor — extractContent + parseSessionId
    // can reuse the same regex/strategy.
    callArgs: (q) => ["-p", q, "--no-stream", "--output-format", "json"],
    outputStream: "stdout",
    probeTimeoutMs: 15_000,
    callTimeoutMs: 240_000,
    parseSessionId: (raw) => {
      const m = raw.match(/"sessionId"\s*:\s*"([a-f0-9-]{8,})"/i);
      return m ? m[1] : null;
    },
    resumeArg: (sessionId) => ["--resume", sessionId],
    extractContent: (raw) => {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (let i = arr.length - 1; i >= 0; i--) {
            const ev = arr[i];
            if (ev?.type === "result" && typeof ev.result === "string") return ev.result;
          }
          for (let i = arr.length - 1; i >= 0; i--) {
            const ev = arr[i];
            if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
              const blocks = ev.message.content.filter((b: any) => b?.type === "text");
              const lastText = blocks[blocks.length - 1]?.text;
              if (typeof lastText === "string") return lastText;
            }
          }
        }
      } catch {}
      return raw.trim();
    },
  },
  {
    id: "codex",
    label: "Codex CLI",
    bin: "codex",
    icon: "🟢",
    wslBin: "codex",
    probeArgs: ["--version"],
    extraProbePaths: (() => {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      const paths: string[] = [];
      if (process.platform === "win32") {
        if (home) {
          paths.push(`${home}\\.bun\\bin\\codex.exe`);
          paths.push(`${home}\\.bun\\bin\\codex.cmd`);
          paths.push(`${home}\\AppData\\Roaming\\npm\\codex.cmd`);
          paths.push(`${home}\\AppData\\Local\\npm\\codex.cmd`);
          paths.push(`${home}\\.local\\bin\\codex.exe`);
        }
        paths.push("C:\\Program Files\\nodejs\\codex.cmd");
      } else {
        if (home) {
          paths.push(`${home}/.bun/bin/codex`);
          paths.push(`${home}/.local/bin/codex`);
          paths.push(`${home}/.npm-global/bin/codex`);
          paths.push(`${home}/.nvm/versions/node/current/bin/codex`);
        }
        paths.push("/usr/local/bin/codex");
        paths.push("/opt/homebrew/bin/codex");
      }
      return paths;
    })(),
    // --json emits JSONL events to stdout: thread.started, turn.started,
    // item.completed (item.type=agent_message carries the final text in
    // item.text), turn.completed. We need --json for parseSessionId; the
    // legacy --output-last-message + $OUTPUT_FILE flow is dropped because
    // we can now read the answer from the same JSONL stream.
    callArgs: (q) => ["exec", "--json", q],
    outputStream: "stdout",
    probeTimeoutMs: 15_000,
    callTimeoutMs: 240_000,
    // codex prints `{"type":"thread.started","thread_id":"<uuid>"}` on the
    // first JSONL line. Resume via `codex exec resume <thread_id> <prompt>`.
    parseSessionId: (raw) => {
      const m = raw.match(/"thread_id"\s*:\s*"([a-f0-9-]{8,})"/i);
      return m ? m[1] : null;
    },
    resumeArg: (sessionId) => ["resume", sessionId],
    // Last `item.completed` whose item.type === "agent_message" carries the
    // final answer in .item.text. Walk from the end so trailing text wins.
    extractContent: (raw) => {
      const lines = raw.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev?.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
            return ev.item.text;
          }
        } catch {}
      }
      // Fallback: last `turn.completed` with .text (rare)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev?.type === "turn.completed" && typeof ev.text === "string") return ev.text;
        } catch {}
      }
      return raw.trim();
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw CLI",
    bin: "openclaw",
    icon: "🦅",
    wslBin: "openclaw",
    probeArgs: ["--version"],
    callArgs: (q) => ["llm", "chat", "--no-stream", q],
    outputStream: "stdout",
    probeTimeoutMs: 15_000,
    callTimeoutMs: 240_000,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    icon: "♊",
    wslBin: "gemini",
    probeArgs: ["--version"],
    callArgs: (q) => [q],
    outputStream: "stdout",
    probeTimeoutMs: 15_000,
    callTimeoutMs: 240_000,
  },
  {
    id: "codebuddy",
    label: "Codebuddy / WorkBuddy CLI",
    icon: "🐼",
    bin: "codebuddy",
    needsNode: true,
    extraProbePaths: [
      process.platform === "win32"
        ? "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy"
        : "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
      "/usr/local/bin/codebuddy",
      "/opt/homebrew/bin/codebuddy",
    ],
    callArgs: (q, model) => {
      const m = model || process.env.CODEBUDDY_MODEL || "deepseek-v4-pro";
      // --output-format json prints the full message envelope to stdout so we can
      // pull the sessionId. --resume <id> reuses the existing session on the
      // next call. Both are added at the call site (callAnyLlm) when the
      // adapter's resumeArg/parseSessionId hooks are present.
      return ["--print", "--output-format", "json", "--model", m, q];
    },
    outputStream: "stdout",
    // codebuddy prints `{"type":"message", ... "sessionId":"<uuid>", ...}` for
    // every message. We pull the first match so the same remote session is
    // resumed on the next call. Falls back to null on malformed JSON.
    parseSessionId: (raw) => {
      const m = raw.match(/"sessionId"\s*:\s*"([a-f0-9-]{8,})"/i);
      return m ? m[1] : null;
    },
    resumeArg: (sessionId) => ["--resume", sessionId],
    // --output-format json emits a JSON array of envelopes. The actual LLM
    // answer lives in the LAST `assistant` message's last text block (after
    // any `thinking` blocks). Walk backwards so trailing text wins. Falls
    // back to the trimmed raw output if no assistant text is found, so a
    // future codebuddy format change won't silently break us.
    extractContent: (raw) => {
      try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return raw.trim();
        // Last "result" event carries the final answer in .result.
        for (let i = arr.length - 1; i >= 0; i--) {
          const ev = arr[i];
          if (ev?.type === "result" && typeof ev.result === "string") return ev.result;
        }
        // Last assistant message's last text block.
        for (let i = arr.length - 1; i >= 0; i--) {
          const ev = arr[i];
          if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
            const blocks = ev.message.content.filter((b: any) => b?.type === "text");
            const lastText = blocks[blocks.length - 1]?.text;
            if (typeof lastText === "string") return lastText;
          }
        }
      } catch {}
      return raw.trim();
    },
    probeTimeoutMs: 15_000,
    callTimeoutMs: 240_000,
    extraEnv: { PYTHONIOENCODING: "utf-8" },
  },
  {
    id: "aider",
    label: "Aider CLI",
    bin: "aider",
    icon: "🛠️",
    wslBin: "aider",
    probeArgs: ["--version"],
    callArgs: (q) => ["--message", q, "--no-git", "--yes", "--no-auto-commits"],
    outputStream: "stdout",
    probeTimeoutMs: 15_000,
    callTimeoutMs: 240_000,
  },
];

// ─── PATH-based resolver (cross-platform, no hardcoded paths) ────────────────

/** Read the Lxss registry to enumerate installed WSL distros + the default one. */
function wslRegistryInfo(): { defaultDistro: string; distros: string[] } | null {
  if (process.platform !== "win32") return null;
  try {
    const wslList = execSync("wsl.exe -l -v", {
      timeout: 10_000,
      encoding: "buffer",
      windowsHide: true,
    });
    const cleaned = Buffer.from(wslList).toString("utf8").replace(/\0/g, " ").replace(/\t/g, " ");
    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^NAME\b/i.test(l));
    const distros: string[] = [];
    let defaultDistro = "";
    for (const line of lines) {
      const isDefault = /^\*/.test(line);
      const tokens = line.split(/\s{2,}|\s+/).map((t) => t.trim()).filter(Boolean);
      const name = (isDefault ? tokens[1] : tokens[0]) || "";
      if (!name || /^(running|stopped|installing)$/i.test(name)) continue;
      distros.push(name);
      if (isDefault && !defaultDistro) defaultDistro = name;
    }
    if (distros.length === 0) {
      const out = execSync(
        'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Lxss" /s',
        { timeout: 5_000, encoding: "buffer", windowsHide: true },
      );
      const text = Buffer.from(out).toString("latin1");
      const uuids: string[] = [];
      const uuid2name: Record<string, string> = {};
      const blocks = text.split(/\r?\n\s*\r?\n/);
      for (const blk of blocks) {
        const uuidMatch = blk.match(/\\([\w-]{36})\s*$/m);
        if (!uuidMatch) continue;
        const uuid = uuidMatch[1];
        uuids.push(uuid);
        const nameMatch = blk.match(/DistributionName\s+REG_SZ\s+(.+)/);
        if (nameMatch) uuid2name[uuid] = nameMatch[1].trim();
      }
      const defaultMatch = text.match(/DefaultDistribution\s+REG_SZ\s+\{?([\w-]+)\}?/);
      if (defaultMatch) {
        const uuid = defaultMatch[1];
        defaultDistro = uuid2name[uuid] || uuid;
      }
      for (const u of uuids) {
        const n = uuid2name[u] || u;
        if (n) distros.push(n);
      }
    }
    if (distros.length === 0) return null;
    return { defaultDistro: defaultDistro || distros[0], distros };
  } catch {
    return null;
  }
}

/** Resolve the WSL distro name to invoke. Priority: WSL_DISTRO env > registry default > "Debian". */
function wslTargetDistro(): string {
  return process.env.WSL_DISTRO || "Debian";
}

/** Lightweight readiness check — runs `true` in the default distro. */
function wslAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const info = wslRegistryInfo();
  if (!info) return Promise.resolve(false);
  const distro = wslTargetDistro();
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (b: boolean) => {
      if (!done) {
        done = true;
        resolve(b);
      }
    };
    try {
      const child = spawn("wsl.exe", ["-d", distro, "--", "true"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
    setTimeout(() => finish(false), 45_000);
  });
}

/** Run `bash -lc '...'` inside the configured WSL distro and capture stdout/stderr. */
function runInWsl(
  bashCmd: string,
  timeoutMs = 300_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const distro = wslTargetDistro();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (code: number, stdout: string, stderr: string) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    try {
      const child = spawn("wsl.exe", ["-d", distro, "--", "bash"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const killTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish(124, stdout, stderr);
      }, timeoutMs);
      child.stdout.on("data", (b) => {
        stdout += b.toString();
      });
      child.stderr.on("data", (b) => {
        stderr += b.toString();
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        finish(1, stdout, stderr + "\nspawn: " + err.message);
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        finish(code ?? -1, stdout, stderr);
      });
      const script = [
        `set +e`,
        `[ -r "$HOME/.profile" ] && . "$HOME/.profile" 2>/dev/null || true`,
        `[ -r "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" 2>/dev/null || true`,
        `[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" 2>/dev/null || true`,
        `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.bun/bin:$HOME/Library/Python/3.12/bin:$HOME/Library/Python/3.11/bin:/opt/homebrew/bin:/usr/local/bin:/snap/bin:$PATH"`,
        bashCmd,
      ].join("\n");
      child.stdin.write(script + "\n");
      child.stdin.end();
    } catch (err) {
      finish(1, "", "spawn: " + (err as Error).message);
    }
  });
}

/** Try to find `bin` inside WSL PATH. Returns path or null. */
async function findOnWsl(bin: string): Promise<string | null> {
  try {
    const bashCmd = `command -v ${bin} 2>/dev/null || which ${bin} 2>/dev/null`;
    const r = await runInWsl(bashCmd, 30_000);
    if (r.code !== 0) return null;
    const first = r.stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/** Resolve `bin` on PATH. Uses `where` (Windows) / `which` (POSIX). Returns absolute path or null. */
function findOnPath(bin: string, extras?: string[]): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    if (extras) {
      for (const p of extras) {
        if (resolved) break;
        try {
          if (existsSync(p)) {
            resolved = true;
            resolve(p);
            return;
          }
        } catch {}
      }
    }
    if (!resolved) {
      const envKey = bin.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_CLI_PATH";
      const envPath = process.env[envKey];
      if (envPath) {
        try {
          if (existsSync(envPath)) {
            resolved = true;
            resolve(envPath);
            return;
          }
        } catch {}
      }
    }
    if (resolved) return;
    const cmd = process.platform === "win32" ? "where" : "which";
    const r = spawn(cmd, [bin], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let out = "";
    r.stdout.on("data", (b) => {
      out += b.toString();
    });
    r.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
    r.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) return resolve(null);
      const first = out
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      resolve(first || null);
    });
  });
}

// ─── Probe (smoke test) ───────────────────────────────────────────────────────

interface ProbeOk {
  ok: true;
  bin: string;
  reason: string;
}
interface ProbeErr {
  ok: false;
  reason: string;
}

async function probeCli(adapter: CliAdapter): Promise<ProbeOk | ProbeErr> {
  const extras = typeof adapter.extraProbePaths === "function" ? adapter.extraProbePaths() : adapter.extraProbePaths;
  const bin = await findOnPath(adapter.bin, extras);
  if (!bin) return { ok: false, reason: `${adapter.label} not found on PATH` };

  const args = adapter.probeArgs ?? ["--version"];
  const probeTimeout = adapter.probeTimeoutMs ?? 8_000;

  return new Promise((resolve) => {
    // On Windows .cmd/.bat shims need shell:true to spawn correctly. The
    // subsequent `node` interpreter only fires for adapters flagged
    // needsNode (WorkBuddy codebuddy etc.); non-node CLIs spawn their bin
    // directly with the appropriate shell flag.
    const isCmdBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const nodeBin = process.platform === "win32" ? "node.exe" : "node";
    // Guard: Windows CreateProcessW cmdline limit ~32KB. Detect up front
    // and surface a clear "prompt too long" error instead of the cryptic
    // ENAMETOOLONG that Node's child_process throws.
    if (process.platform === "win32") {
      const fullArgv = adapter.needsNode ? [bin, ...args] : [bin, ...args];
      const cmdlineLen = fullArgv.reduce((s, x) => s + x.length + 1, 0);
      if (cmdlineLen > 30000) {
        return resolve({ ok: false, reason: `${adapter.label} probe prompt too long for Windows spawn (cmdline ${cmdlineLen} chars)` });
      }
    }
    const child = adapter.needsNode
      ? spawn(nodeBin, [bin, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...adapter.extraEnv },
          windowsHide: true,
        })
      : spawn(bin, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...adapter.extraEnv },
          shell: isCmdBatch,
          windowsHide: true,
        });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: ProbeOk | ProbeErr) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, reason: `${adapter.label} probe timed out (${probeTimeout}ms)` });
    }, probeTimeout);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      finish({ ok: false, reason: `${adapter.label} spawn failed: ${err?.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const combined = (stdout + "\n" + stderr).trim();
      if (code === 0 && combined.length > 0) {
        finish({ ok: true, bin, reason: `${adapter.label} found at ${bin}` });
      } else {
        finish({
          ok: false,
          reason: `${adapter.label} probe failed (exit=${code}, ${combined.slice(0, 120)})`,
        });
      }
    });
  });
}

// ─── Probe cache (per-process) ────────────────────────────────────────────────

interface AdapterProbes {
  native?: ProbeOk | ProbeErr;
  wsl?: ProbeOk | ProbeErr;
}

let _probeCache: Promise<Record<string, AdapterProbes>> | null = null;
let _probeCacheAt = 0;
const PROBE_TTL_MS = 5 * 60_000; // 5 minutes

// Cache file lives in OS tmpdir so writing does NOT trigger webpack's file
// watcher → no HMR / page refresh / CSS flash. Per-project namespace
// ("sciwrite-cache") keeps us isolated from pdb-tracker's cache file.
const _CACHE_DIR = join(tmpdir(), "sciwrite-cache");
try {
  mkdirSync(_CACHE_DIR, { recursive: true });
} catch {}
const DISK_CACHE_FILE = join(_CACHE_DIR, "llm-providers-cache.json");
const DISK_CACHE_VERSION = 1;
const DISK_TTL_MS = 144 * 60 * 60_000; // 144 hours (6 days)

interface CachedProvider {
  id: string;
  via: "native" | "wsl";
  bin: string | null;
  available: boolean;
  reason: string;
  binMtime?: number;
}
interface ProviderCache {
  version: number;
  lastUpdated: string;
  providers: CachedProvider[];
}

function readDiskCache(): ProviderCache | null {
  try {
    const text = readFileSync(DISK_CACHE_FILE, "utf8");
    const parsed = JSON.parse(text) as ProviderCache;
    if (parsed.version !== DISK_CACHE_VERSION) return null;
    if (!Array.isArray(parsed.providers) || !parsed.lastUpdated) return null;
    const ageMs = Date.now() - new Date(parsed.lastUpdated).getTime();
    if (ageMs > DISK_TTL_MS) return null;
    for (const p of parsed.providers) {
      if (p.available && p.bin && !existsSync(p.bin)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(probes: Record<string, AdapterProbes>): void {
  try {
    // Don't persist a "all unavailable" snapshot — that snapshot is usually
    // the result of a transient probe-time failure (e.g. WSL service hung
    // or codebuddy.exe momentarily locked), and persisting it causes every
    // subsequent request to also report "no providers". Only cache when at
    // least one adapter returned a positive result.
    let anyAvailable = false;
    for (const id of Object.keys(probes)) {
      for (const via of ["native", "wsl"] as const) {
        if (probes[id]?.[via]?.ok) { anyAvailable = true; break; }
      }
      if (anyAvailable) break;
    }
    if (!anyAvailable) {
      // Best-effort: delete the stale cache file so next read forces re-probe.
      try { unlinkSync(DISK_CACHE_FILE); } catch {}
      return;
    }
    const providers: CachedProvider[] = [];
    for (const a of CLI_ADAPTERS) {
      const pair = probes[a.id];
      if (!pair) continue;
      for (const via of ["native", "wsl"] as const) {
        const p = pair[via];
        if (!p) continue;
        let binMtime: number | undefined;
        if (p.ok && p.bin) {
          try {
            binMtime = statSync(p.bin).mtimeMs / 1000;
          } catch {}
        }
        providers.push({
          id: a.id,
          via,
          bin: p.ok ? p.bin : null,
          available: p.ok,
          reason: p.reason,
          binMtime,
        });
      }
    }
    const cache: ProviderCache = {
      version: DISK_CACHE_VERSION,
      lastUpdated: new Date().toISOString(),
      providers,
    };
    writeFileSync(DISK_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[llm] failed to write provider cache:", (err as Error).message);
  }
}

function clearDiskCache(): void {
  try {
    unlinkSync(DISK_CACHE_FILE);
  } catch {}
}

function markProviderStale(adapterId: string, via: "native" | "wsl"): void {
  const cache = readDiskCache();
  if (!cache) return;
  const before = cache.providers.length;
  cache.providers = cache.providers.filter((p) => !(p.id === adapterId && p.via === via));
  if (cache.providers.length === before) return;
  try {
    cache.lastUpdated = new Date().toISOString();
    writeFileSync(DISK_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

function probeAll(force = false): Promise<Record<string, AdapterProbes>> {
  const ageOk = Date.now() - _probeCacheAt < PROBE_TTL_MS;
  if (_probeCache && ageOk && !force) return _probeCache;
  if (_probeCache && force) _probeCache = null;
  _probeCache = (async () => {
    if (!force) {
      const disk = readDiskCache();
      if (disk) {
        const out: Record<string, AdapterProbes> = {};
        for (const p of disk.providers) {
          if (!out[p.id]) out[p.id] = {};
          out[p.id][p.via] = p.available
            ? { ok: true, bin: p.bin!, reason: p.reason }
            : { ok: false, reason: p.reason };
        }
        return out;
      }
    }
    const out: Record<string, AdapterProbes> = {};
    await Promise.all(
      CLI_ADAPTERS.map(async (a) => {
        out[a.id] = { native: await probeCli(a) };
      }),
    );
    if (process.platform === "win32") {
      const wsl = await wslAvailable();
      if (wsl) {
        const wslResults = await Promise.all(
          CLI_ADAPTERS.map((a) => probeCliInWsl(a).then((r) => ({ id: a.id, r }))),
        );
        for (const { id, r } of wslResults) {
          out[id] = { ...(out[id] ?? {}), wsl: r };
        }
      }
    }
    writeDiskCache(out);
    _probeCacheAt = Date.now();
    return out;
  })();
  return _probeCache;
}

async function probeCliInWsl(adapter: CliAdapter): Promise<ProbeOk | ProbeErr> {
  const wslBin = adapter.wslBin ?? adapter.bin;
  const wslPath = await findOnWsl(wslBin);
  if (!wslPath) return { ok: false, reason: `${adapter.label} not found inside WSL` };
  const args = adapter.probeArgs ?? ["--version"];
  const bashCmd = `${wslBin} ${args.map((a) => JSON.stringify(a)).join(" ")}`;
  const probeTimeout = adapter.probeTimeoutMs ?? 8_000;
  try {
    const r = await runInWsl(
      `timeout ${Math.ceil(probeTimeout / 1000)} ${bashCmd} 2>&1`,
      probeTimeout + 30_000,
    );
    const combined = (r.stdout + "\n" + r.stderr).trim();
    if ((r.code === 0 || r.code === 124) && combined.length > 0) {
      return { ok: true, bin: wslPath, reason: `${adapter.label} found in WSL at ${wslPath}` };
    }
    return {
      ok: false,
      reason: `${adapter.label} WSL probe failed (exit=${r.code}, ${combined.slice(0, 120)})`,
    };
  } catch (err: any) {
    return { ok: false, reason: `${adapter.label} WSL probe error: ${err?.message}` };
  }
}

export function clearLlmProbeCache(): void {
  _probeCache = null;
  _probeCacheAt = 0;
  clearDiskCache();
}

export function markLlmProviderStale(adapterId: string, via: "native" | "wsl"): void {
  markProviderStale(adapterId, via);
}

// ─── z-ai SDK availability check (SciWrite-specific) ─────────────────────────
//
// SciWrite's existing default is z-ai-web-dev-sdk. We surface it as a synthetic
// 'zai-sdk' provider so the existing UI flow keeps working alongside the new
// CLI detection. The SDK doesn't need a probe — just verify the importable
// package exists in node_modules.

function isZaiSdkAvailable(): boolean {
  try {
    require.resolve("z-ai-web-dev-sdk");
    return true;
  } catch {
    return false;
  }
}

// ─── Provider enumeration (for the front-end settings panel) ──────────────────

export interface InspectProvidersOptions {
  /** When true, include `available: false` entries so the UI can show them dim. Default false. */
  showUnavailable?: boolean;
  /** Optional list of provider ids the user has whitelisted (others hidden). */
  whitelist?: string[];
}

export async function inspectProviders(opts: InspectProvidersOptions = {}): Promise<{
  chosen: string;
  available: LlmProviderInfo[];
  totalClisScanned: number;
}> {
  const probes = await probeAll();
  const available: LlmProviderInfo[] = [];
  let totalClisScanned = 0;

  // Iterate CLI_ADAPTERS instead of `probes` so every registered adapter is
  // represented in the result — even ones that were skipped because the disk
  // cache had no record of them (e.g. a CLI installed after the first probe
  // session). Without this, `detected` would silently drop the entry and the
  // "redetect" button in the LLM config dialog would have nothing to show.
  for (const a of CLI_ADAPTERS) {
    totalClisScanned++;
    const probePair = probes[a.id] ?? {};
    if (probePair.native?.ok) {
      available.push({
        provider: `cli:${a.id}`,
        bin: probePair.native.bin,
        icon: a.icon,
        label: a.label,
        reason: probePair.native.reason,
        available: true,
        via: "native",
      });
    } else if (probePair.wsl?.ok) {
      available.push({
        provider: `cli:${a.id}`,
        bin: probePair.wsl.bin,
        icon: a.icon,
        label: `${a.label} (WSL)`,
        reason: probePair.wsl.reason,
        available: true,
        via: "wsl",
      });
    } else {
      const why =
        probePair.native?.reason || probePair.wsl?.reason || `${a.label} not probed yet (cache miss — click 重新检测)`;
      available.push({
        provider: `cli:${a.id}`,
        bin: null,
        icon: a.icon,
        label: a.label,
        reason: why,
        available: false,
        via: "native",
      });
    }
  }

  // SDK fallbacks — only added if their package is installed.
  const anthropicAvailable = !!process.env.ANTHROPIC_API_KEY;
  available.push({
    provider: "anthropic",
    bin: null,
    icon: "🤖",
    label: "Anthropic SDK",
    reason: anthropicAvailable ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY not set",
    available: anthropicAvailable,
    via: "sdk",
  });

  const openaiAvailable = !!process.env.OPENAI_API_KEY;
  available.push({
    provider: "openai",
    bin: null,
    icon: "🧠",
    label: "OpenAI SDK",
    reason: openaiAvailable ? "OPENAI_API_KEY is set" : "OPENAI_API_KEY not set",
    available: openaiAvailable,
    via: "sdk",
  });

  // SciWrite's default — z-ai-web-dev-sdk. Always report it (SDK ships with
  // the project), and let the existing /api/llm-config route own the actual
  // dispatch through `src/lib/ai.ts`.
  const zaiSdkAvailable = isZaiSdkAvailable();
  available.push({
    provider: "zai-sdk",
    bin: null,
    icon: "🧊",
    label: "z-ai-web-dev-sdk",
    reason: zaiSdkAvailable
      ? "z-ai-web-dev-sdk installed (SciWrite default)"
      : "z-ai-web-dev-sdk not installed",
    available: zaiSdkAvailable,
    via: "sdk",
  });

  const chosen = available.find((p) => p.available)?.provider || "zai-sdk";
  const showAll = !!opts.showUnavailable;
  const wl = opts.whitelist && opts.whitelist.length > 0 ? new Set(opts.whitelist) : null;
  const filtered = available.filter((p) => {
    if (wl && !wl.has(p.provider)) return false;
    if (!showAll && !p.available) return false;
    return true;
  });
  return { chosen, available: filtered, totalClisScanned };
}

export function resolveLlmConfig(overrides?: LlmConfig): LlmConfig & { resolvedProvider: string } {
  const envProvider = process.env.LLM_PROVIDER || "";
  const provider = (overrides?.provider || envProvider || "").trim() || "auto";
  const model = (overrides?.model || process.env.LLM_MODEL || "").trim() || undefined;
  return { ...overrides, provider, model, resolvedProvider: provider };
}

// ─── High-level text-in / text-out ────────────────────────────────────────────

export async function generateText(
  systemPrompt: string,
  userPrompt: string,
  opts: { maxChars?: number; llm?: LlmConfig; sessionId?: string } = {},
): Promise<LlmResult> {
  const t0 = Date.now();
  const maxChars = opts.maxChars ?? 4000;
  const cfg = resolveLlmConfig(opts.llm);
  const r = await callAnyLlm(
    userPrompt,
    { ...cfg, system: cfg.system || systemPrompt },
    { sessionId: opts.sessionId },
  );
  if (r.ok) {
    const content = (r.content || "").slice(0, maxChars);
    return {
      ok: true,
      content,
      text: content,
      provider: r.provider,
      model: r.model,
      durationMs: Date.now() - t0,
      fallback: false,
      meta: r.meta,
    };
  }
  return {
    ok: false,
    content: "",
    text: "",
    provider: r.provider,
    model: r.model,
    durationMs: Date.now() - t0,
    fallback: false,
    error: r.error,
  };
}

// ─── Core dispatch with fallback ──────────────────────────────────────────────

async function callAnyLlm(
  prompt: string,
  cfg: LlmConfig & { resolvedProvider: string; system: string },
  opts: { sessionId?: string } = {},
): Promise<LlmResult> {
  const probes = await probeAll();
  const order = decideProviderOrder(cfg.resolvedProvider, cfg.model);
  // If a session id was passed in, only feed it to adapters that declared a
  // `resumeArg`. Other adapters get undefined and behave as before.
  const sessionId = opts.sessionId;

  const errors: string[] = [];
  for (const item of order) {
    const id = item.id;
    const via = item.via;
    if (id.startsWith("cli:")) {
      const adapter = CLI_ADAPTERS.find((a) => `cli:${a.id}` === id);
      if (!adapter) continue;
      const probePair = probes[adapter.id] ?? {};
      const probe = via === "wsl" ? probePair.wsl : probePair.native;
      if (!probe?.ok) {
        errors.push(`${id}${via ? `(${via})` : ""}: ${probe?.reason ?? "unavailable"}`);
        continue;
      }
      // Pass the session id only to adapters that support resume AND that
      // match the adapter the stored id came from. Otherwise the resume
      // would silently land on the wrong CLI's session store and fail.
      const adapterSessionId = adapter.resumeArg ? sessionId : undefined;
      try {
        const t0 = Date.now();
        const result =
          via === "wsl"
            ? await runCliInWsl(adapter, probe.bin, prompt, cfg.model, adapterSessionId)
            : await runCli(adapter, probe.bin, prompt, cfg.model, adapterSessionId);
        const text = result.text;
        return {
          ok: true,
          content: text,
          text,
          provider: id,
          model: cfg.model || adapter.id,
          durationMs: Date.now() - t0,
          fallback: item.fallback,
          meta: { cli: probe.bin, via: via ?? "native", cliSessionId: result.sessionId },
        };
      } catch (err: any) {
        errors.push(`${id}${via ? `(${via})` : ""}: ${err?.message ?? String(err)}`);
        if (via) {
          try {
            markLlmProviderStale(adapter.id, via);
          } catch {}
        }
        continue;
      }
    }
    if (id === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) {
        errors.push("anthropic: ANTHROPIC_API_KEY not set");
        continue;
      }
      try {
        const t0 = Date.now();
        const text = await callAnthropic(prompt, cfg.system, cfg.model);
        return {
          ok: true,
          content: text,
          text,
          provider: id,
          model: cfg.model || "claude-3-5-sonnet-latest",
          durationMs: Date.now() - t0,
          fallback: false,
        };
      } catch (err: any) {
        errors.push(`anthropic: ${err?.message ?? String(err)}`);
        continue;
      }
    }
    if (id === "openai") {
      if (!process.env.OPENAI_API_KEY) {
        errors.push("openai: OPENAI_API_KEY not set");
        continue;
      }
      try {
        const t0 = Date.now();
        const text = await callOpenai(prompt, cfg.system, cfg.model);
        return {
          ok: true,
          content: text,
          text,
          provider: id,
          model: cfg.model || "gpt-4o-mini",
          durationMs: Date.now() - t0,
          fallback: false,
        };
      } catch (err: any) {
        errors.push(`openai: ${err?.message ?? String(err)}`);
        continue;
      }
    }
    // ── z.ai SDK (SciWrite default branch) ──
    if (id === "zai-sdk") {
      try {
        const t0 = Date.now();
        const text = await callZai(prompt, cfg.system, cfg.model);
        return {
          ok: true,
          content: text,
          text,
          provider: id,
          model: cfg.model || "glm-4.6",
          durationMs: Date.now() - t0,
          fallback: item.fallback,
        };
      } catch (err: any) {
        errors.push(`zai-sdk: ${err?.message ?? String(err)}`);
        continue;
      }
    }
  }

  return {
    ok: false,
    content: "",
    text: "",
    provider: cfg.resolvedProvider,
    model: cfg.model || "",
    durationMs: 0,
    fallback: false,
    error: `No LLM provider succeeded. Tried ${order.length} candidate(s): ${errors.join("; ")}`,
  };
}

interface OrderedProvider {
  id: string;
  via?: "native" | "wsl";
  /** True when not the user-requested provider (i.e. fallback). */
  fallback: boolean;
}

function decideProviderOrder(requested: string, _model?: string): OrderedProvider[] {
  const cliIds = CLI_ADAPTERS.map((a) => `cli:${a.id}`);
  const auto: OrderedProvider[] = [];
  for (const id of cliIds) auto.push({ id, via: "native", fallback: requested !== id });
  for (const id of cliIds) auto.push({ id, via: "wsl", fallback: requested !== id });
  auto.push({ id: "anthropic", fallback: true });
  auto.push({ id: "openai", fallback: true });
  // z-ai SDK — always-available fallback candidate (SciWrite default)
  auto.push({ id: "zai-sdk", fallback: requested !== "zai-sdk" });

  if (!requested || requested === "auto") {
    return auto.map((p) => ({ ...p, fallback: false }));
  }
  const requestedProvider = auto.find((p) => p.id === requested);
  const rest = auto.filter((p) => p.id !== requested);
  return [
    { ...(requestedProvider ?? { id: requested, fallback: false }), fallback: false },
    ...rest,
  ];
}

// ─── CLI subprocess runner ────────────────────────────────────────────────────

/**
 * Compute per-call timeout. Hermes specifically scales with prompt size — a 10k-char
 * full report takes ~5-10 minutes; a short query returns in ~30s.
 */
function computeCliTimeoutMs(adapter: CliAdapter, prompt: string): number {
  const base = adapter.callTimeoutMs ?? 240_000;
  const heuristic = 60_000 + prompt.length * 30;
  return Math.max(base, heuristic);
}

function runCli(
  adapter: CliAdapter,
  bin: string,
  prompt: string,
  model: string | undefined,
  sessionId?: string,
): Promise<{ text: string; sessionId: string | null }> {
  const rawArgs = adapter.callArgs(prompt, model);
  const timeoutMs = computeCliTimeoutMs(adapter, prompt);
  let outputFilePath: string | null = null;
  let args = rawArgs;
  if (adapter.outputFile) {
    const ext = adapter.id === "codex" ? ".md" : ".txt";
    outputFilePath = join(
      tmpdir(),
      `sciwrite-llm-${adapter.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
    );
    try {
      writeFileSync(outputFilePath, "");
    } catch {}
    args = rawArgs.map((a) => (a === "$OUTPUT_FILE" ? outputFilePath! : a));
  }
  // Append --resume <sessionId> when the adapter supports session reuse AND
  // we have a stored id. Adapters that don't define `resumeArg` keep the
  // old behavior (fresh CLI session every call) so this is fully backwards
  // compatible with claude/codex/aider/etc.
  if (sessionId && adapter.resumeArg) {
    args = [...args, ...adapter.resumeArg(sessionId)];
  }

  return new Promise<{ text: string; sessionId: string | null }>((resolve, reject) => {
    const isCmdBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    // For Node shims (e.g. codebuddy) prefer spawning `node` directly; under
    // bun-exec the shebang lookup mis-fires and the next call leaks handles.
    // Guard: CLI providers pass the prompt as a command-line argument to
    // spawn(). On Windows the limit is ~32KB (CreateProcessW). On Linux,
    // MAX_ARG_STRLEN is 128KB per single argument, but the total argv +
    // envp must fit within ARG_MAX (~2MB). In practice, prompts >24KB
    // cause ENAMETOOLONG on some CLI providers (codebuddy, hermes).
    // Detect up front and surface a clear error.
    const fullArgv = adapter.needsNode ? [bin, ...args] : [bin, ...args];
    const cmdlineLen = fullArgv.reduce((s, x) => s + x.length + 1, 0);
    if (cmdlineLen > 30000) {
      const promptArg = args.find((a) => a.length > 100);
      return reject(
        new Error(
          `prompt too long for CLI spawn (cmdline ${cmdlineLen} chars, max ~30KB). ` +
          `Largest arg is ${promptArg?.length ?? 0} chars. ` +
          `The prompt should have been compressed by compressPrompt() — check ai.ts.`
        ),
      );
    }
    const child = adapter.needsNode
      ? spawn("node", [bin, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...adapter.extraEnv },
          windowsHide: true,
        })
      : spawn(bin, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...adapter.extraEnv },
          shell: isCmdBatch,
          windowsHide: true,
        });

    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error(`${adapter.id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      cleanup();
      reject(new Error(`${adapter.id} spawn error: ${err?.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      let cleaned = "";
      if (outputFilePath) {
        try {
          const fileContent = readFileSync(outputFilePath, "utf8");
          if (fileContent.trim().length > 0) cleaned = fileContent;
        } catch {}
      }
      if (!cleaned) {
        const raw =
          adapter.outputStream === "stdout"
            ? stdout
            : adapter.outputStream === "stderr"
              ? stderr
              : (stdout.trim() + (stderr.includes("\n") ? "\n" : "") + stderr).trim();
        const stripped = adapter.stripBanner ? adapter.stripBanner(raw) : raw;
        cleaned = adapter.extractContent ? adapter.extractContent(stripped) : stripped.trim();
      }
      cleanup();
      // Best-effort session-id extraction. We always run parseSessionId on
      // the un-extracted raw output (some adapters put the id in a banner
      // that extractContent then strips). When we don't have an id yet and
      // this is a brand-new session, this is the one we'll persist for the
      // next resume. When we *do* have an id, the freshly-returned one
      // should match (sanity check) — if not, the CLI started a new session
      // (e.g. the old one expired) and we surface the new id to the caller.
      const newSessionId = adapter.parseSessionId
        ? adapter.parseSessionId(
            adapter.outputStream === "stderr" ? stderr : stdout,
          )
        : null;
      const effectiveSessionId = newSessionId || sessionId || null;
      if (cleaned.length > 0) {
        resolve({ text: cleaned, sessionId: effectiveSessionId });
        return;
      }
      reject(
        new Error(
          `${adapter.id} returned empty output (exit=${code}, stderr=${stderr.slice(0, 300)})`,
        ),
      );
    });

    function cleanup() {
      if (outputFilePath) {
        try {
          unlinkSync(outputFilePath);
        } catch {}
        outputFilePath = null;
      }
    }
  });
}

function runCliInWsl(
  adapter: CliAdapter,
  wslBin: string,
  prompt: string,
  model: string | undefined,
  sessionId?: string,
): Promise<{ text: string; sessionId: string | null }> {
  let args = adapter.callArgs(prompt, model);
  if (sessionId && adapter.resumeArg) {
    args = [...args, ...adapter.resumeArg(sessionId)];
  }
  const escaped = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const timeoutSec = Math.max(1, Math.ceil((adapter.callTimeoutMs ?? 240_000) / 1000));
  const bashCmd = `timeout ${timeoutSec} ${wslBin} ${escaped} 2>&1`;
  const totalTimeout = computeCliTimeoutMs(adapter, prompt) + 15_000;
  return new Promise<{ text: string; sessionId: string | null }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("wsl.exe", ["-e", "bash", "-lc", bashCmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error(`${adapter.id} WSL timed out after ${totalTimeout}ms`));
    }, totalTimeout);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`${adapter.id} WSL spawn error: ${err?.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const raw = (stdout + (stderr ? "\n" + stderr : "")).trim();
      const stripped = adapter.stripBanner ? adapter.stripBanner(raw) : raw;
      const cleaned = adapter.extractContent ? adapter.extractContent(stripped) : stripped.trim();
      const newSessionId = adapter.parseSessionId
        ? adapter.parseSessionId(stdout || stderr)
        : null;
      const effectiveSessionId = newSessionId || sessionId || null;
      if (cleaned.length > 0) {
        resolve({ text: cleaned, sessionId: effectiveSessionId });
        return;
      }
      reject(
        new Error(
          `${adapter.id} WSL returned empty output (exit=${code}, stderr=${stderr.slice(0, 300)})`,
        ),
      );
    });
  });
}

// ─── SDK providers ────────────────────────────────────────────────────────────

async function callAnthropic(prompt: string, system?: string, model?: string): Promise<string> {
  const Anthropic = (await (eval("import"))("@anthropic-ai/sdk")).default;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: model || "claude-3-5-sonnet-latest",
    max_tokens: 4096,
    system: system || "You are a helpful assistant.",
    messages: [{ role: "user", content: prompt }],
  });
  const block = resp.content?.[0];
  return (block && block.type === "text" ? block.text : "") || "";
}

async function callOpenai(prompt: string, system?: string, model?: string): Promise<string> {
  const OpenAI = (await (eval("import"))("openai")).default;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const client = new OpenAI({ apiKey });
  const resp = await client.chat.completions.create({
    model: model || "gpt-4o-mini",
    messages: [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      { role: "user" as const, content: prompt },
    ],
  });
  return resp.choices?.[0]?.message?.content || "";
}

/**
 * z.ai SDK — SciWrite's default LLM. Delegates to z-ai-web-dev-sdk which is
 * already imported by `src/lib/ai.ts`. We re-import here so this file is
 * self-contained and the dispatch logic doesn't need a separate wiring step.
 */
async function callZai(prompt: string, system?: string, model?: string): Promise<string> {
  const ZAI = (await (eval("import"))("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  const resp = await zai.chat.completions.create({
    model: model || "glm-4.6",
    messages: [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      { role: "user" as const, content: prompt },
    ],
    thinking: { type: "disabled" as const },
  });
  return resp.choices?.[0]?.message?.content || "";
}