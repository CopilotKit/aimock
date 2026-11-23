# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src/ src/

RUN pnpm run build

# --- Production stage ---
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

LABEL org.opencontainers.image.title="aimock"
LABEL org.opencontainers.image.description="Mock infrastructure for AI application testing"
LABEL org.opencontainers.image.source="https://github.com/CopilotKit/llmock"

WORKDIR /app

# git is needed for sparse-checkout fixture fetching in production
RUN apk add --no-cache git

COPY --from=build /app/dist/ dist/
# package.json sits above dist/ so aimockVersion() reports the real version
COPY --from=build /app/package.json ./
COPY fixtures/ fixtures/

EXPOSE 4010

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--fixtures", "./fixtures", "--host", "0.0.0.0"]
