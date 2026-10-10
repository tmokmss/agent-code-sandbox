#!/usr/bin/env bash
# Invokes the deployed runtime (AWS CLI v2). Usage: ./agentcore/invoke.sh <runtime-arn> '{"action":"selftest"}'
set -euo pipefail
REGION=${AWS_REGION:-us-west-2}
PAYLOAD=${2:-'{"action":"selftest"}'}
SESSION=$(printf 'acs-poc-%s-%s' "$(date +%s)" "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')")
aws bedrock-agentcore invoke-agent-runtime --region "$REGION" --agent-runtime-arn "$1" \
  --runtime-session-id "$SESSION" --content-type application/json \
  --cli-binary-format raw-in-base64-out --payload "$PAYLOAD" /dev/stdout
