import { spawn } from "node:child_process";

export type RunOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  maxOutputBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
};

// Spawns a process without a shell. Kills it on timeout or abort, and keeps at most
// maxOutputBytes per stream while reading, so a flood of output cannot fill the host's memory.
export function run(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out = new Capture(o.maxOutputBytes);
    const err = new Capture(o.maxOutputBytes);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    let timedOut = false;
    let aborted = false;
    // Deno gets no --allow-run, so it has no children and killing it is enough.
    const timer = o.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      const stopped = timedOut || aborted;
      resolve({
        stdout: out.text(),
        stderr: err.text(),
        exitCode: stopped ? null : code,
        timedOut,
        aborted: aborted && !timedOut,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}

// Keeps the head and the tail of a stream and drops the middle. Errors usually come last,
// so the tail matters as much as the head.
export class Capture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  private dropped = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  push(c: Buffer): void {
    const half = Math.floor(this.max / 2);
    if (this.headLen < half) {
      const take = c.subarray(0, half - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      c = c.subarray(take.length);
    }
    if (c.length === 0) return;
    this.tail.push(c);
    this.tailLen += c.length;
    const keep = this.max - half;
    while (this.tailLen > keep) {
      const first = this.tail[0];
      const over = this.tailLen - keep;
      if (first.length <= over) {
        this.tail.shift();
        this.tailLen -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailLen -= over;
        this.dropped += over;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (!this.dropped) return head + tail;
    return `${head}\n[sandbox] ... ${this.dropped} bytes omitted. Write large output to a file instead. ...\n${tail}`;
  }
}
