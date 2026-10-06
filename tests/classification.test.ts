import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLM, type ScriptedResponse } from '../src/llm/fake.js';
import { openDB, type DB } from '../src/repository/db.js';
import { TicketsRepo, type Claimed } from '../src/repository/tickets.repo.js';
import {
    ClassificationService,
    type ClassificationConfig,
} from '../src/services/classification.service.js';

const VALID =
    '{"category": "billing", "priority": "high", "summary": "Customer was charged twice."}';
const BAD_ENUM = '{"category": "billing", "priority": "urgent", "summary": "x"}';
const MISSING_FIELD = '{"category": "billing", "priority": "high"}';

let db: DB;
let repo: TicketsRepo;
let sleeps: number[];
let now: number;

const silentLogger = { warn: () => undefined };

beforeEach(() => {
    db = openDB(':memory:');
    repo = new TicketsRepo(db);
    sleeps = [];
    now = 1_700_000_000_000;
});

afterEach(() => {
    db.close();
});

function buildService(
    script: ScriptedResponse[],
    overrides: Partial<ClassificationConfig> = {},
): { llm: FakeLLM; service: ClassificationService } {
    const llm = new FakeLLM({ script });
    const service = new ClassificationService(
        repo,
        llm,
        () => (now += 1000),
        async (ms) => {
            sleeps.push(ms);
        },
        silentLogger,
        { maxAttempts: 3, timeoutMs: 20, backoffBaseMs: 1000, ...overrides },
    );
    return { llm, service };
}

function claimTicket(): Claimed {
    repo.insertIfAbsent({ id: 't-1', subject: 'Charged twice', body: 'Two charges of 49.00' }, now);
    const claimed = repo.claimNext((now += 1000), 60_000);
    if (claimed === undefined) {
        throw new Error('expected a claim');
    }
    return claimed;
}

describe('ClassificationService', () => {
    it('classifies on a valid first response', async () => {
        const { llm, service } = buildService([VALID]);

        await service.classify(claimTicket());

        expect(repo.findById('t-1')).toMatchObject({
            status: 'classified',
            attempts: 1,
            classification: { category: 'billing', priority: 'high' },
        });
        expect(llm.calls).toHaveLength(1);
        expect(sleeps).toHaveLength(0);
    });

    it('retries bad responses and succeeds on the third attempt', async () => {
        const { llm, service } = buildService(['not json at all', BAD_ENUM, VALID]);

        await service.classify(claimTicket());

        expect(repo.findById('t-1')).toMatchObject({ status: 'classified', attempts: 3 });
        expect(llm.calls).toHaveLength(3);
    });

    it('fails with the last reason after three bad responses, storing no classification', async () => {
        const { llm, service } = buildService(['prose only', MISSING_FIELD, '{cut off']);

        await service.classify(claimTicket());

        expect(repo.findById('t-1')).toMatchObject({
            status: 'failed',
            attempts: 3,
            error: 'no JSON object found',
        });
        expect(llm.calls).toHaveLength(3);

        const row = db
            .prepare(`SELECT category, priority, summary FROM tickets WHERE id = 't-1'`)
            .get();
        expect(row).toEqual({ category: null, priority: null, summary: null });
    });

    it('recovers from a provider error on the next attempt', async () => {
        const { llm, service } = buildService([new Error('provider unavailable'), VALID]);

        await service.classify(claimTicket());

        expect(repo.findById('t-1')).toMatchObject({ status: 'classified', attempts: 2 });
        expect(llm.calls).toHaveLength(2);
    });

    it('fails with model timeout after three hangs', async () => {
        const { llm, service } = buildService(['hang', 'hang', 'hang']);

        await service.classify(claimTicket());

        expect(repo.findById('t-1')).toMatchObject({
            status: 'failed',
            attempts: 3,
            error: 'model timeout',
        });
        expect(llm.calls).toHaveLength(3);
    });

    it('fails immediately when claimed with attempts already at max', async () => {
        const { llm, service } = buildService([VALID]);
        repo.insertIfAbsent({ id: 't-1', subject: 's', body: 'b' }, now);
        db.prepare(`UPDATE tickets SET attempts = 3 WHERE id = 't-1'`).run();
        const claimed = repo.claimNext((now += 1000), 60_000);
        if (claimed === undefined) {
            throw new Error('expected a claim');
        }

        await service.classify(claimed);

        expect(repo.findById('t-1')).toMatchObject({
            status: 'failed',
            error: 'max attempts exceeded',
        });
        expect(llm.calls).toHaveLength(0);
    });

    it('never calls the model or writes after the lease is taken away', async () => {
        const { llm, service } = buildService([VALID]);
        const claimed = claimTicket();
        db.prepare(`UPDATE tickets SET lease_until = @lease WHERE id = 't-1'`).run({
            lease: claimed.lease + 1,
        });

        await service.classify(claimed);

        expect(llm.calls).toHaveLength(0);
        expect(repo.findById('t-1')).toMatchObject({ status: 'processing', attempts: 0 });
    });

    it('sleeps with increasing backoff between attempts, never after the last', async () => {
        const { service } = buildService(['bad', 'bad', 'bad']);

        await service.classify(claimTicket());

        expect(sleeps).toHaveLength(2);
        const [first, second] = sleeps;
        expect(first).toBeGreaterThanOrEqual(1000);
        expect(first).toBeLessThanOrEqual(1250);
        expect(second).toBeGreaterThanOrEqual(2000);
        expect(second).toBeLessThanOrEqual(2500);
    });

    it('sends the ticket body to the model inside the delimiters', async () => {
        const { llm, service } = buildService([VALID]);

        await service.classify(claimTicket());

        const prompt = llm.calls[0] ?? '';
        const open = prompt.indexOf('<ticket>');
        const close = prompt.indexOf('</ticket>');
        const bodyAt = prompt.indexOf('Two charges of 49.00');
        expect(open).toBeGreaterThan(-1);
        expect(bodyAt).toBeGreaterThan(open);
        expect(bodyAt).toBeLessThan(close);
    });
});
