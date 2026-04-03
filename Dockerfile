# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src/ src/

RUN pnpm run build

# --- Production stage ---
FROM node:22-alpine

LABEL org.opencontainers.image.title="aimock"
LABEL org.opencontainers.image.description="Mock infrastructure for AI application testing"
LABEL org.opencontainers.image.source="https://github.com/CopilotKit/llmock"

WORKDIR /app

# No runtime dependencies — all imports are node:* built-ins
COPY --from=build /app/dist/ dist/
COPY fixtures/ fixtures/

EXPOSE 4010

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--fixtures", "./fixtures", "--host", "0.0.0.0"]
