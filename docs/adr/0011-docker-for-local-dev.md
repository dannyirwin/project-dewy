# ADR-0011: Docker runs the API only; Supabase CLI owns the DB stack

Status: Accepted

## Context
We want a containerized local-dev path. But the data layer talks to PostgREST via supabase-js (ADR-0004), so a bare `postgres:pgvector` container is insufficient, and vendoring the full self-hosted Supabase compose would duplicate what `supabase start` already provides. LM Studio runs on the host (GPU access).

## Decision
`Dockerfile` builds only the KMS API (multi-stage Node 22, runs TS via tsx). `docker-compose.yml` runs that one service and reaches the host's `supabase start` stack and LM Studio via `host.docker.internal` (mapped to `host-gateway` for Linux). The service-role key is injected via environment.

## Consequences
- One obvious dev recipe: `supabase start` → export key → `docker compose up --build`.
- No duplicate database lifecycle to keep in sync with Supabase CLI.
- Authored in an environment without a Docker daemon: files are written to spec; first build on a real machine is the smoke test.
