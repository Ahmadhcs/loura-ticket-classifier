import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from './app.js';
import { BACKOFF_BASE_MS, loadConfig } from './config.js';
import { FakeLLM } from './llm/fake.js';
import { logger } from './logger.js';
import { openDB } from './repository/db.js';
import { TicketsRepo } from './repository/tickets.repo.js';
import { ClassificationService } from './services/classification.service.js';
import { TicketsService } from './services/tickets.service.js';
import { Worker } from './worker.js';

const config = loadConfig();

const db = openDB(config.dbPath);
const repo = new TicketsRepo(db);
const tickets = new TicketsService(repo, Date.now);
const llm = new FakeLLM({ seed: config.fakeLlmSeed, failureRate: config.fakeLlmFailureRate });
const classifier = new ClassificationService(repo, llm, Date.now, (ms) => sleep(ms), logger, {
    maxAttempts: config.maxAttempts,
    timeoutMs: config.modelTimeoutMs,
    backoffBaseMs: BACKOFF_BASE_MS,
});
const worker = new Worker(repo, classifier, Date.now, logger, {
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.pollIntervalMs,
    leaseMs: config.leaseMs,
});

const server = createApp({ tickets }).listen(config.port, () => {
    logger.info({ config }, 'listening');
});
void worker.start();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const outcome = await Promise.race([
        worker.stop().then(() => 'stopped' as const),
        sleep(config.shutdownTimeoutMs).then(() => 'timeout' as const),
    ]);
    if (outcome === 'timeout') {
        logger.warn(
            { timeoutMs: config.shutdownTimeoutMs },
            'in-flight work did not settle in time; exiting anyway, leases will recover it',
        );
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    logger.info('shutdown complete');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
