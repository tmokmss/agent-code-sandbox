# agent-code-sandbox

Run LLM-generated JavaScript and TypeScript safely from a Node.js AI agent.

- No OS isolation features needed (namespaces, seccomp, root). Works as is inside VMs such as Amazon Bedrock AgentCore Runtime.
- The code can read and write only its working directory, read only the directories you allow, and connect only to the hosts you allow.
- npm packages are found from the `import`s in the code and downloaded on demand. You can limit them with an allowlist.
- Each run is independent. Only the files in the working directory carry over.

Under the hood, the code runs in a [Deno](https://deno.com) child process with tight permissions. You do not need to install Deno: if it is not on `PATH`, a pinned version is downloaded (and its checksum verified) on the first run.

> Status: early development. The API may change before v0.1.

## Usage

```ts
import { exec } from "agent-code-sandbox";

// A one-off calculation. No files to keep, so no workDir.
const { stdout } = await exec({ code: "console.log(2 ** 10)" });

const result = await exec({
  code: llmGeneratedCode,
  workDir: `/tmp/session-${sessionId}`,
  readOnlyDirs: ["/data/uploads"],
  allowedPackages: ["papaparse@5", "date-fns"],
  allowedDomains: ["api.example.com"],
  env: { API_BASE_URL: "https://api.example.com" },
  timeoutMs: 30_000,
});
// Pass stdout and stderr to the LLM as they are.
return [result.stdout, result.stderr].filter(Boolean).join("\n");
```

The LLM can also write files with your agent's file tools and run one of them with `entrypoint`:

```ts
await exec({ entrypoint: "main.ts", workDir: `/tmp/session-${sessionId}` });
```

## Options

Specify exactly one of `code` and `entrypoint`.

| Option | Default | Description |
|---|---|---|
| `code` | | JS / TS code to run as an ES module. Top-level `await` works. Relative imports resolve from `workDir`. |
| `entrypoint` | | Path of a file in `workDir` to run. |
| `workDir` | Required with `entrypoint`. With `code`, a temporary directory removed after the run. | Working directory. The code can read and write it, and its files stay between runs. Must exist. |
| `readOnlyDirs` | `[]` | Directories the code can read. |
| `allowedPackages` | Any package | npm packages the code may import: `"name"` or `"name@range"` (`*`, `5`, `5.7`, `5.7.0`, `^5.1.0`, `~5.1.0`). `[]` allows none. Dependencies of allowed packages are allowed automatically. |
| `allowedDomains` | `[]` (none) | Hosts the code may connect to: `"api.example.com"` (any port), `"api.example.com:443"`, `"*.example.com"`, or an IP address. Redirects are checked too. |
| `env` | `{}` | Environment variables the code can see. Other names read as `undefined`. Names starting with `DENO_`, `LD_`, `DYLD_` and the proxy variables are reserved. |
| `timeoutMs` | No limit | Time limit for running the code. Downloading packages does not count. |
| `memoryMb` | V8's default | Limit of the JS heap. |
| `maxOutputBytes` | 1 MB | Bytes kept for each of stdout and stderr. Beyond this, the middle is dropped. This protects the host process; trim further for the LLM on your side. |
| `signal` | | An `AbortSignal` to stop the run. |

## Result

```ts
type ExecResult = {
  stdout: string;
  stderr: string;      // rewritten so the LLM can fix its code
  exitCode: number | null; // 1 when rejected before running, null when stopped
  timedOut: boolean;   // stopped by timeoutMs or signal
  truncated: boolean;  // stdout or stderr was truncated
  durationMs: number;
};
```

Problems the LLM can fix come back as a result: exceptions, syntax errors, denied file or network access, packages that are not allowed or do not exist, and timeouts. Problems you have to fix throw:

- `SandboxConfigError`: invalid options, such as a missing `workDir`, a reserved `env` name, or a symbolic link in an allowed directory that points outside.
- `SandboxError`: the environment, such as failing to download Deno or to reach the npm registry.

## What the sandboxed code cannot do

- Read files outside `workDir` and `readOnlyDirs`, or write outside `workDir`, including through static imports and symbolic links.
- Connect to hosts not in `allowedDomains`, including the cloud metadata endpoints and the npm registry.
- See the host's environment variables, except the ones passed in `env`.
- Run subprocesses, load native libraries (FFI), or read system information.
- Import npm packages outside `allowedPackages`, including through computed `import()` or packages cached by earlier runs. Install scripts never run.

Escapes through bugs in the runtime itself (V8, Deno) are out of scope. Run your agent inside a VM or container for that layer.

## Environment variables

These configure the library itself (not the sandboxed code):

| Name | Description |
|---|---|
| `AGENT_CODE_SANDBOX_DENO_PATH` | Path of the Deno binary to use. |
| `AGENT_CODE_SANDBOX_DENO_BASE_URL` | Mirror of `https://github.com/denoland/deno/releases/download` to download Deno from. The checksum is still verified. |
| `AGENT_CODE_SANDBOX_CACHE_DIR` | Where Deno and npm packages are cached. Default: `~/.cache/agent-code-sandbox`, or the temp directory if the home directory is not writable. |

`HTTPS_PROXY` and `NO_PROXY` are respected when downloading Deno and npm packages.

## Requirements

- Node.js 22 or later
- Linux (x86_64, arm64) or macOS (x86_64, arm64). On other platforms, install Deno 2.9 or later yourself.

## Development

```sh
npm install
npm test        # needs Node.js 22.18+ and access to registry.npmjs.org (and GitHub, to download Deno)
npm run build
```

Design documents (in Japanese for now): [requirements](docs/requirements.md), [background](docs/background.md), [design](docs/design.md).
