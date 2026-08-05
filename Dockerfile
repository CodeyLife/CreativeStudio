FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=creative-studio-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile
COPY . .
EXPOSE 4770 4771 5173
CMD ["node", "--import", "tsx", "scripts/novel-v2-api.ts"]
