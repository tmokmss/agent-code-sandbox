#!/usr/bin/env bash
# Builds the PoC image, pushes it to ECR, and creates (or updates) an AgentCore Runtime.
# Needs: AWS credentials with ECR, IAM, and bedrock-agentcore permissions; docker with buildx (arm64).
# Usage: AWS_REGION=us-west-2 ./agentcore/deploy.sh   (run from the poc/ directory)
set -euo pipefail

REGION=${AWS_REGION:-us-west-2}
NAME=${RUNTIME_NAME:-agent_code_sandbox_poc}
REPO=${ECR_REPO:-agent-code-sandbox-poc}
ROLE=${ROLE_NAME:-AgentCodeSandboxPocRuntimeRole}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
IMAGE="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"

aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker buildx build --platform linux/arm64 -f agentcore/Dockerfile -t "$IMAGE" --push .

# Execution role. The PoC itself calls no AWS API; the role only needs to pull the image and write logs.
if ! ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null); then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"}, "Action": "sts:AssumeRole",
      "Condition": {"StringEquals": {"aws:SourceAccount": "'"$ACCOUNT"'"}}}]}')
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
  sleep 10 # wait for IAM propagation
fi

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"$IMAGE\"}}"
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
