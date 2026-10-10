#!/usr/bin/env bash
# Deploys the PoC with AgentCore Runtime direct code deployment (NODE_22). No docker needed.
# Needs: AWS credentials (S3, IAM, bedrock-agentcore), deno, curl, python3.
# Usage (from poc/): AWS_REGION=us-west-2 ./agentcore/deploy-code.sh
set -euo pipefail

REGION=${AWS_REGION:-us-west-2}
NAME=${RUNTIME_NAME:-agent_code_sandbox_poc}
ROLE=${ROLE_NAME:-AgentCodeSandboxPocRuntimeRole}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=${CODE_BUCKET:-agent-code-sandbox-poc-$ACCOUNT-$REGION}
KEY=agentcore/$(date +%Y%m%d%H%M%S).zip

ZIP=$(./agentcore/build-zip.sh)
aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 || {
  if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
}
aws s3 cp "$ZIP" "s3://$BUCKET/$KEY" --region "$REGION" >/dev/null

# Execution role. The PoC itself calls no AWS API; the role only reads the code and writes logs.
if ! ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null); then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"}, "Action": "sts:AssumeRole",
      "Condition": {"StringEquals": {"aws:SourceAccount": "'"$ACCOUNT"'"}}}]}')
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
  sleep 10 # wait for IAM propagation
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name read-code --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion"], "Resource": "arn:aws:s3:::'"$BUCKET"'/*"}]}'

ARTIFACT="{\"codeConfiguration\":{\"code\":{\"s3\":{\"bucket\":\"$BUCKET\",\"prefix\":\"$KEY\"}},\"runtime\":\"NODE_22\",\"entryPoint\":[\"bootstrap.js\"]}}"
ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='$NAME'].agentRuntimeId | [0]" --output text)
if [ "$ID" = "None" ] || [ -z "$ID" ]; then
  aws bedrock-agentcore-control create-agent-runtime --region "$REGION" --agent-runtime-name "$NAME" \
    --agent-runtime-artifact "$ARTIFACT" --role-arn "$ROLE_ARN" \
    --network-configuration networkMode=PUBLIC --query agentRuntimeArn --output text
else
  aws bedrock-agentcore-control update-agent-runtime --region "$REGION" --agent-runtime-id "$ID" \
    --agent-runtime-artifact "$ARTIFACT" --role-arn "$ROLE_ARN" \
    --network-configuration networkMode=PUBLIC --query agentRuntimeArn --output text
fi
