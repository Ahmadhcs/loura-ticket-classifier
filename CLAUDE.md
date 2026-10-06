# Loura ticket classifier

Small HTTP service: ingest support tickets, classify them asynchronously
with an LLM (will be building a mock one), expose results via API. See README.md for the
design decisions.

## Stack
Node.js 22+, TypeScript (strict), Express 5, better-sqlite3, Zod,
pino, Vitest + supertest, ESLint (typescript-eslint).

## Structure
src/index.ts (starts server + worker), src/app.ts (builds app, no listen),
src/config.ts, src/domain.ts, src/api/, src/services/,
src/repository/ (all SQL lives here), src/llm/, src/worker.ts, src/logger.ts

## Rules
- Small, readable code. No abstractions unless they have a real second use.
- Strict types everywhere; no `any`.
- Never store unvalidated model output.
- Only add what I ask for in the current step.
- Do not run git commands; I commit myself.