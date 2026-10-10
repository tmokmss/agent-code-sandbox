# PoC

A proof of concept of `exec()`. See [docs/design.md](../docs/design.md) for the design and the results.

## Run locally

Needs Node.js 22.18 or later (runs `.ts` directly) and Deno 2.9 on `PATH` (or set `SANDBOX_DENO_PATH`).

```sh
cd poc
npm test                 # attack and behavior tests
node examples/demo.ts    # sample outputs and timings
```

The tests download `papaparse` and `lodash` from registry.npmjs.org.

## Run on AgentCore Runtime

`agentcore/server.ts` serves `/ping` and `/invocations` on port 8080. Payloads:

- `{"action": "selftest"}` runs the test suite inside the runtime
- `{"action": "probe"}` shows what the host process sees (AWS env var names, metadata endpoint) and what the sandboxed code sees
- `{"code": "...", "allowedDomains": [...], ...}` runs `exec()` once

Two ways to deploy. Both need AWS credentials and AWS CLI v2.

- Direct code deployment (`NODE_22`, no docker): `agentcore/deploy-code.sh`. It bundles the TypeScript into plain JS with `deno bundle`, adds the arm64 Deno binary, uploads the zip to S3, and creates the runtime. Needs S3, IAM, and bedrock-agentcore permissions.
- Container: `agentcore/deploy.sh`. Needs docker with buildx for linux/arm64, and ECR, IAM, and bedrock-agentcore permissions.

```sh
cd poc
AWS_REGION=us-west-2 ./agentcore/deploy-code.sh     # prints the runtime ARN
./agentcore/invoke.sh <runtime-arn> '{"action":"probe"}'
./agentcore/invoke.sh <runtime-arn> '{"action":"selftest"}'
```
