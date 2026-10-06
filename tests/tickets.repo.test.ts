import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Classification } from '../src/domain.js';
import { openDB, type DB } from '../src/repository/db.js';
import { TicketsRepo } from '../src/repository/tickets.repo.js';

const NOW = 1_700_000_000_000;

let db: DB;
let repo: TicketsRepo;

beforeEach(() => {
    db = openDB(':memory:');
    repo = new TicketsRepo(db);
});

afterEach(() => {
    db.close();
});

describe('insertIfAbsent', () => {
    it('creates a new ticket as pending with 0 attempts', () => {
        const { ticket, created } = repo.insertIfAbsent(
            { id: 't-1', subject: 'Charged twice', body: 'Two charges of 49.00' },
            NOW,
        );

        expect(created).toBe(true);
        expect(ticket.status).toBe('pending');
        expect(ticket.attempts).toBe(0);
        expect(ticket.createdAt).toBe(new Date(NOW).toISOString());
        expect(ticket.updatedAt).toBe(new Date(NOW).toISOString());
    });

    it('does not modify an existing ticket on duplicate id', () => {
        repo.insertIfAbsent({ id: 't-1', subject: 'original', body: 'original body' }, NOW);
        const { ticket, created } = repo.insertIfAbsent(
            { id: 't-1', subject: 'changed', body: 'changed body' },
            NOW + 5_000,
        );

        expect(created).toBe(false);
        expect(ticket.subject).toBe('original');
        expect(ticket.body).toBe('original body');

        const { n } = db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
        expect(n).toBe(1);
    });
});

describe('findById', () => {
    it('returns undefined for an unknown id', () => {
        expect(repo.findById('t-missing')).toBeUndefined();
    });

    it('maps a classified row', () => {
        repo.insertIfAbsent({ id: 't-1', subject: 's', body: 'b' }, NOW);
        db.prepare(
            `UPDATE tickets
             SET status = 'classified', category = 'billing', priority = 'high',
                 summary = 'Customer was charged twice.'
             WHERE id = ?`,
        ).run('t-1');

        const ticket = repo.findById('t-1');

        expect(ticket).toMatchObject({
            status: 'classified',
            classification: {
                category: 'billing',
                priority: 'high',
                summary: 'Customer was charged twice.',
            },
        });
    });

    it('maps a failed row', () => {
        repo.insertIfAbsent({ id: 't-1', subject: 's', body: 'b' }, NOW);
        db.prepare(`UPDATE tickets SET status = 'failed', error = 'model timed out' WHERE id = ?`).run(
            't-1',
        );

        const ticket = repo.findById('t-1');

        expect(ticket).toMatchObject({ status: 'failed', error: 'model timed out' });
    });
});

const CLASSIFICATION: Classification = {
    category: 'billing',
    priority: 'high',
    summary: 'Customer was charged twice.',
};

function insertAt(r: TicketsRepo, id: string, at: number): void {
    r.insertIfAbsent({ id, subject: `subject ${id}`, body: `body ${id}` }, at);
}

function mustClaim(r: TicketsRepo, now: number, leaseMs: number) {
    const claimed = r.claimNext(now, leaseMs);
    if (claimed === undefined) {
        throw new Error('expected a claim');
    }
    return claimed;
}

describe('claimNext', () => {
    it('claims the oldest pending ticket first, undefined when none pending', () => {
        insertAt(repo, 't-newer', NOW + 1000);
        insertAt(repo, 't-older', NOW);

        const first = mustClaim(repo, NOW + 5000, 30_000);
        expect(first.ticket.id).toBe('t-older');
        expect(first.ticket.status).toBe('processing');
        expect(first.lease).toBe(NOW + 5000 + 30_000);

        const second = mustClaim(repo, NOW + 6000, 30_000);
        expect(second.ticket.id).toBe('t-newer');

        expect(repo.claimNext(NOW + 7000, 30_000)).toBeUndefined();
    });

    it('never claims classified or failed tickets', () => {
        insertAt(repo, 't-classified', NOW);
        insertAt(repo, 't-failed', NOW + 1);
        insertAt(repo, 't-pending', NOW + 2);
        db.prepare(
            `UPDATE tickets SET status = 'classified', category = 'billing', priority = 'low',
             summary = 's' WHERE id = 't-classified'`,
        ).run();
        db.prepare(`UPDATE tickets SET status = 'failed', error = 'e' WHERE id = 't-failed'`).run();

        expect(mustClaim(repo, NOW + 100, 30_000).ticket.id).toBe('t-pending');
        expect(repo.claimNext(NOW + 200, 30_000)).toBeUndefined();
    });

    it('two connections claiming alternately never get the same ticket', () => {
        const dir = mkdtempSync(join(tmpdir(), 'loura-test-'));
        const db1 = openDB(join(dir, 'test.db'));
        const db2 = openDB(join(dir, 'test.db'));
        try {
            const repo1 = new TicketsRepo(db1);
            const repo2 = new TicketsRepo(db2);
            for (let i = 0; i < 10; i++) {
                insertAt(repo1, `t-${i}`, NOW + i);
            }

            const claimed: string[] = [];
            for (let i = 0; i < 10; i++) {
                const claimer = i % 2 === 0 ? repo1 : repo2;
                claimed.push(mustClaim(claimer, NOW + 100 + i, 30_000).ticket.id);
            }

            expect(new Set(claimed).size).toBe(10);
            expect(repo1.claimNext(NOW + 200, 30_000)).toBeUndefined();
            expect(repo2.claimNext(NOW + 201, 30_000)).toBeUndefined();
        } finally {
            db1.close();
            db2.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('lease-guarded writes', () => {
    it('recordAttempt, markClassified and markFailed succeed with the right lease', () => {
        insertAt(repo, 't-1', NOW);
        const { lease } = mustClaim(repo, NOW + 100, 30_000);

        expect(repo.recordAttempt('t-1', lease, NOW + 200)).toBe(true);
        expect(repo.markClassified('t-1', lease, CLASSIFICATION, NOW + 300)).toBe(true);
        expect(repo.findById('t-1')).toMatchObject({
            status: 'classified',
            attempts: 1,
            classification: CLASSIFICATION,
        });

        insertAt(repo, 't-2', NOW);
        const second = mustClaim(repo, NOW + 400, 30_000);
        expect(repo.markFailed('t-2', second.lease, 'model kept failing', NOW + 500)).toBe(true);
        expect(repo.findById('t-2')).toMatchObject({ status: 'failed', error: 'model kept failing' });
    });

    it('returns false with a stale lease and leaves the row unchanged', () => {
        insertAt(repo, 't-1', NOW);
        const { lease } = mustClaim(repo, NOW + 100, 30_000);
        const stale = lease - 1;

        expect(repo.recordAttempt('t-1', stale, NOW + 200)).toBe(false);
        expect(repo.markClassified('t-1', stale, CLASSIFICATION, NOW + 300)).toBe(false);
        expect(repo.markFailed('t-1', stale, 'nope', NOW + 400)).toBe(false);

        expect(repo.findById('t-1')).toMatchObject({ status: 'processing', attempts: 0 });
    });

    it('markFailed clears classification columns so failed tickets never match filters', () => {
        insertAt(repo, 't-1', NOW);
        const first = mustClaim(repo, NOW + 100, 30_000);
        expect(repo.markClassified('t-1', first.lease, CLASSIFICATION, NOW + 200)).toBe(true);
        expect(repo.list({ category: 'billing' }, 10)).toHaveLength(1);

        db.prepare(
            `UPDATE tickets SET status = 'processing', lease_until = @lease WHERE id = 't-1'`,
        ).run({ lease: NOW + 1000 });
        expect(repo.markFailed('t-1', NOW + 1000, 'reclassification failed', NOW + 300)).toBe(true);

        expect(repo.findById('t-1')).toMatchObject({
            status: 'failed',
            error: 'reclassification failed',
        });
        expect(repo.list({ category: 'billing' }, 10)).toHaveLength(0);
        expect(repo.list({ priority: 'high' }, 10)).toHaveLength(0);

        const row = db.prepare(`SELECT category, priority, summary FROM tickets WHERE id = 't-1'`).get();
        expect(row).toEqual({ category: null, priority: null, summary: null });
    });
});

describe('recoverExpiredLeases', () => {
    it('resets only expired processing tickets and keeps attempts', () => {
        insertAt(repo, 't-expired', NOW);
        insertAt(repo, 't-alive', NOW + 1);

        const expired = mustClaim(repo, NOW + 100, 1000);
        expect(repo.recordAttempt('t-expired', expired.lease, NOW + 150)).toBe(true);
        mustClaim(repo, NOW + 200, 100_000);

        expect(repo.recoverExpiredLeases(NOW + 5000)).toBe(1);
        expect(repo.findById('t-expired')).toMatchObject({ status: 'pending', attempts: 1 });
        expect(repo.findById('t-alive')).toMatchObject({ status: 'processing' });
    });

    it('fences out the original holder after recovery and re-claim', () => {
        insertAt(repo, 't-1', NOW);
        const original = mustClaim(repo, NOW + 100, 1000);

        expect(repo.recoverExpiredLeases(NOW + 5000)).toBe(1);
        const next = mustClaim(repo, NOW + 6000, 1000);
        expect(next.ticket.id).toBe('t-1');
        expect(next.lease).toBeGreaterThan(original.lease);

        expect(repo.markClassified('t-1', original.lease, CLASSIFICATION, NOW + 7000)).toBe(false);
        expect(repo.findById('t-1')).toMatchObject({ status: 'processing' });

        expect(repo.markClassified('t-1', next.lease, CLASSIFICATION, NOW + 8000)).toBe(true);
        expect(repo.findById('t-1')).toMatchObject({ status: 'classified' });
    });
});
