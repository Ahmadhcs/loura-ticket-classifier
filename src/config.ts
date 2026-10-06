import { z } from 'zod';

export const BACKOFF_BASE_MS = 1000;

const EnvSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DB_PATH: z.string().default('./tickets.db'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
    LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
    MODEL_TIMEOUT_MS: z.coerce.number().int().min(1).default(10_000),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    FAKE_LLM_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),
    FAKE_LLM_SEED: z.coerce.number().int().default(1),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
});

export interface Config {
    port: number;
    dbPath: string;
    workerConcurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
    modelTimeoutMs: number;
    maxAttempts: number;
    fakeLlmFailureRate: number;
    fakeLlmSeed: number;
    shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = EnvSchema.parse(env);

    let totalBackoffMs = 0;
    for (let attempt = 1; attempt < parsed.MAX_ATTEMPTS; attempt++) {
        totalBackoffMs += BACKOFF_BASE_MS * 2 ** (attempt - 1) * 1.25;
    }
    const worstCaseMs = parsed.MAX_ATTEMPTS * parsed.MODEL_TIMEOUT_MS + totalBackoffMs;
    if (parsed.LEASE_MS <= worstCaseMs) {
        throw new Error(
            `LEASE_MS (${parsed.LEASE_MS}) must be longer than the worst-case retry time ` +
                `(${worstCaseMs}ms = MAX_ATTEMPTS × MODEL_TIMEOUT_MS + max total backoff), ` +
                `or a live ticket's lease can expire mid-work and be processed twice`,
        );
    }

    return {
        port: parsed.PORT,
        dbPath: parsed.DB_PATH,
        workerConcurrency: parsed.WORKER_CONCURRENCY,
        pollIntervalMs: parsed.POLL_INTERVAL_MS,
        leaseMs: parsed.LEASE_MS,
        modelTimeoutMs: parsed.MODEL_TIMEOUT_MS,
        maxAttempts: parsed.MAX_ATTEMPTS,
        fakeLlmFailureRate: parsed.FAKE_LLM_FAILURE_RATE,
        fakeLlmSeed: parsed.FAKE_LLM_SEED,
        shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
    };
}
