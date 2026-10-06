import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewTicket } from '../src/domain.js';
import { FakeLLM } from '../src/llm/fake.js';
import { openDB, type DB } from '../src/repository/db.js';
import { TicketsRepo, type Claimed } from '../src/repository/tickets.repo.js';
import { ClassificationService } from '../src/services/classification.service.js';
import { Worker, type Classifier } from '../src/worker.js';

const silent = { warn: () => undefined, error: () => undefined };
const NOW = 1_700_000_000_000;

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class StubClassifier implements Classifier {
    readonly started: Claimed[] = [];
    readonly deferreds: Deferred[] = [];

    classify(claimed: Claimed): Promise<void> {
        this.started.push(claimed);
        const d = deferred();
        this.deferreds.push(d);
        return d.promise;
    }
}

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

let db: DB;
let repo: TicketsRepo;
let now: number;

const clock = (): number => (now += 1000);

beforeEach(() => {
    db = openDB(':memory:');
    repo = new TicketsRepo(db);
    now = NOW;
});

afterEach(() => {
    db.close();
});

function insertTickets(count: number): void {
    for (let i = 0; i < count; i++) {
        repo.insertIfAbsent({ id: `t-${i}`, subject: `s ${i}`, body: `b ${i}` }, NOW + i);
    }
}

function buildWorker(classifier: Classifier, concurrency: number): Worker {
    return new Worker(repo, classifier, clock, silent, {
        concurrency,
        pollIntervalMs: 10,
        leaseMs: 60_000,
    });
}

describe('Worker.tick', () => {
    it('claims at most `concurrency` tickets and refills one slot per completion', async () => {
        insertTickets(5);
        const stub = new StubClassifier();
        const worker = buildWorker(stub, 2);

        worker.tick();
        expect(stub.started).toHaveLength(2);

        worker.tick();
        expect(stub.started).toHaveLength(2);

        stub.deferreds[0]?.resolve();
        await flush();

        worker.tick();
        expect(stub.started).toHaveLength(3);
        expect(new Set(stub.started.map((c) => c.ticket.id)).size).toBe(3);
    });

    it('claims nothing from an empty queue', () => {
        const stub = new StubClassifier();
        const worker = buildWorker(stub, 2);

        worker.tick();

        expect(stub.started).toHaveLength(0);
    });

    it('recovers a stranded processing ticket with an expired lease and processes it', () => {
        repo.insertIfAbsent({ id: 't-stranded', subject: 's', body: 'b' }, NOW);
        db.prepare(
            `UPDATE tickets SET status = 'processing', lease_until = @lease WHERE id = 't-stranded'`,
        ).run({ lease: NOW - 5000 });
        const stub = new StubClassifier();
        const worker = buildWorker(stub, 2);

        worker.tick();

        expect(stub.started.map((c) => c.ticket.id)).toEqual(['t-stranded']);
    });

    it('survives a crashing classifier and frees its slot', async () => {
        insertTickets(2);
        const stub = new StubClassifier();
        const worker = buildWorker(stub, 1);

        worker.tick();
        expect(stub.started).toHaveLength(1);

        stub.deferreds[0]?.reject(new Error('db exploded'));
        await flush();

        worker.tick();
        expect(stub.started).toHaveLength(2);
        expect(repo.findById('t-0')).toMatchObject({ status: 'processing' });
    });
});

describe('Worker.stop', () => {
    it('resolves only after in-flight work settles and claims nothing afterwards', async () => {
        insertTickets(3);
        const stub = new StubClassifier();
        const worker = buildWorker(stub, 2);

        worker.tick();
        expect(stub.started).toHaveLength(2);

        let stopResolved = false;
        const stopping = worker.stop().then(() => {
            stopResolved = true;
        });
        await flush();
        expect(stopResolved).toBe(false);

        stub.deferreds[0]?.resolve();
        stub.deferreds[1]?.resolve();
        await stopping;
        expect(stopResolved).toBe(true);

        worker.tick();
        expect(stub.started).toHaveLength(2);
    });
});

describe('Worker end to end', () => {
    function loadSamples(): NewTicket[] {
        return JSON.parse(
            readFileSync(new URL('../data/sample_tickets.json', import.meta.url), 'utf8'),
        ) as NewTicket[];
    }

    function buildRealWorker(failureRate: number, seed: number): Worker {
        const llm = new FakeLLM({ seed, failureRate });
        const service = new ClassificationService(
            repo,
            llm,
            Date.now,
            async () => undefined,
            silent,
            { maxAttempts: 3, timeoutMs: 20, backoffBaseMs: 1 },
        );
        return new Worker(repo, service, Date.now, silent, {
            concurrency: 4,
            pollIntervalMs: 10,
            leaseMs: 60_000,
        });
    }

    function countByStatus(): Record<string, number> {
        const rows = db
            .prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status')
            .all() as { status: string; n: number }[];
        return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    }

    async function runUntilSettled(worker: Worker): Promise<void> {
        for (let i = 0; i < 500; i++) {
            const { n } = db
                .prepare(
                    `SELECT COUNT(*) AS n FROM tickets WHERE status IN ('pending', 'processing')`,
                )
                .get() as { n: number };
            if (n === 0) {
                return;
            }
            worker.tick();
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('tickets did not settle');
    }

    it('classifies all 10 sample tickets with failureRate 0', async () => {
        for (const ticket of loadSamples()) {
            repo.insertIfAbsent(ticket, Date.now());
        }
        const worker = buildRealWorker(0, 42);

        await runUntilSettled(worker);

        expect(countByStatus()).toEqual({ classified: 10 });
    });

    it('settles every ticket as classified or failed with failureRate 0.3', async () => {
        for (const ticket of loadSamples()) {
            repo.insertIfAbsent(ticket, Date.now());
        }
        const worker = buildRealWorker(0.3, 1337);

        await runUntilSettled(worker);

        const counts = countByStatus();
        expect((counts.classified ?? 0) + (counts.failed ?? 0)).toBe(10);
    }, 10_000);
});
