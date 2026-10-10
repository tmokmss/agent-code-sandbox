# Container for the AgentCore Runtime PoC. AgentCore Runtime runs linux/arm64 images.
# Build from the poc/ directory: docker buildx build --platform linux/arm64 -f agentcore/Dockerfile .
FROM public.ecr.aws/docker/library/node:22-slim

ARG DENO_VERSION=2.9.7
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && arch=$(uname -m) \
 && curl -fsSL -o /tmp/deno.zip "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${arch}-unknown-linux-gnu.zip" \
 && unzip /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip \
 && apt-get purge -y curl unzip && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY agentcore/server.ts ./agentcore/server.ts

# Run as a non-root user to show that nothing here needs root.
USER node
ENV SANDBOX_CACHE_DIR=/tmp/acs-cache
EXPOSE 8080
CMD ["node", "agentcore/server.ts"]
