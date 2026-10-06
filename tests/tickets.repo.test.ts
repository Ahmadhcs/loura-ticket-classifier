import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
