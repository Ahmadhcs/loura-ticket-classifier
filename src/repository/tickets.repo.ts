import type { Statement } from 'better-sqlite3';
import type { DB } from './db.js';
import type { Category, Classification, NewTicket, Priority, Ticket } from '../domain.js';

export interface TicketRow {
    id: string;
    subject: string;
    body: string;
    status: string;
    category: string | null;
    priority: string | null;
    summary: string | null;
    error: string | null;
    attempts: number;
    suspected_injection: number;
    lease_until: number | null;
    created_at: number;
    updated_at: number;
}

export interface ListFilters {
    category?: Category;
    priority?: Priority;
    suspectedInjection?: boolean;
}

export interface Keyset {
    createdAt: number;
    id: string;
}

export interface Claimed {
    ticket: Ticket;
    lease: number;
}

export class TicketsRepo {
    private readonly db: DB;
    private readonly insertStmt: Statement;
    private readonly selectByIdStmt: Statement;
    private readonly claimStmt: Statement;
    private readonly recordAttemptStmt: Statement;
    private readonly markClassifiedStmt: Statement;
    private readonly markFailedStmt: Statement;
    private readonly recoverStmt: Statement;

    constructor(db: DB) {
        this.db = db;
        this.claimStmt = db.prepare(`
            UPDATE tickets
            SET status = 'processing', lease_until = @lease, updated_at = @now
            WHERE id = (
                SELECT id FROM tickets
                WHERE status = 'pending'
                ORDER BY created_at, id
                LIMIT 1
            )
            RETURNING *
        `);
        this.recordAttemptStmt = db.prepare(`
            UPDATE tickets
            SET attempts = attempts + 1, updated_at = @now
            WHERE id = @id AND status = 'processing' AND lease_until = @lease
        `);
        this.markClassifiedStmt = db.prepare(`
            UPDATE tickets
            SET status = 'classified', category = @category, priority = @priority,
                summary = @summary, error = NULL, lease_until = NULL, updated_at = @now
            WHERE id = @id AND status = 'processing' AND lease_until = @lease
        `);
        this.markFailedStmt = db.prepare(`
            UPDATE tickets
            SET status = 'failed', error = @error, category = NULL, priority = NULL,
                summary = NULL, lease_until = NULL, updated_at = @now
            WHERE id = @id AND status = 'processing' AND lease_until = @lease
        `);
        this.recoverStmt = db.prepare(`
            UPDATE tickets
            SET status = 'pending', lease_until = NULL, updated_at = @now
            WHERE status = 'processing' AND lease_until < @now
        `);
        this.insertStmt = db.prepare(`
            INSERT INTO tickets (id, subject, body, status, attempts, suspected_injection, created_at, updated_at)
            VALUES (@id, @subject, @body, 'pending', 0, @suspectedInjection, @now, @now)
            ON CONFLICT(id) DO NOTHING
        `);
        this.selectByIdStmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
    }

    insertIfAbsent(
        input: NewTicket,
        now: number,
        suspectedInjection = false,
    ): { ticket: Ticket; created: boolean } {
        const info = this.insertStmt.run({
            ...input,
            now,
            suspectedInjection: suspectedInjection ? 1 : 0,
        });
        const ticket = this.findById(input.id);
        if (!ticket) {
            throw new Error(`ticket ${input.id} not found after insert`);
        }
        return { ticket, created: info.changes === 1 };
    }

    findById(id: string): Ticket | undefined {
        const row = this.selectByIdStmt.get(id) as TicketRow | undefined;
        return row === undefined ? undefined : this.rowToTicket(row);
    }

    list(filters: ListFilters, limit: number, after?: Keyset): Ticket[] {
        const where: string[] = [];
        const params: Record<string, string | number> = { limit };

        if (filters.category !== undefined) {
            where.push('category = @category');
            params.category = filters.category;
        }
        if (filters.priority !== undefined) {
            where.push('priority = @priority');
            params.priority = filters.priority;
        }
        if (filters.suspectedInjection === true) {
            where.push('suspected_injection = 1');
        }
        if (after !== undefined) {
            where.push(
                '(created_at < @afterCreatedAt OR (created_at = @afterCreatedAt AND id < @afterId))',
            );
            params.afterCreatedAt = after.createdAt;
            params.afterId = after.id;
        }

        const sql = [
            'SELECT * FROM tickets',
            where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
            'ORDER BY created_at DESC, id DESC LIMIT @limit',
        ]
            .filter((part) => part !== '')
            .join(' ');

        const rows = this.db.prepare(sql).all(params) as TicketRow[];
        return rows.map((row) => this.rowToTicket(row));
    }

    claimNext(now: number, leaseMs: number): Claimed | undefined {
        const lease = now + leaseMs;
        const row = this.claimStmt.get({ lease, now }) as TicketRow | undefined;
        return row === undefined ? undefined : { ticket: this.rowToTicket(row), lease };
    }

    recordAttempt(id: string, lease: number, now: number): boolean {
        return this.recordAttemptStmt.run({ id, lease, now }).changes === 1;
    }

    markClassified(id: string, lease: number, classification: Classification, now: number): boolean {
        return (
            this.markClassifiedStmt.run({
                id,
                lease,
                now,
                category: classification.category,
                priority: classification.priority,
                summary: classification.summary,
            }).changes === 1
        );
    }

    markFailed(id: string, lease: number, error: string, now: number): boolean {
        return this.markFailedStmt.run({ id, lease, error, now }).changes === 1;
    }

    recoverExpiredLeases(now: number): number {
        return this.recoverStmt.run({ now }).changes;
    }

    private rowToTicket(row: TicketRow): Ticket {
        const base = {
            id: row.id,
            subject: row.subject,
            body: row.body,
            attempts: row.attempts,
            suspectedInjection: row.suspected_injection === 1,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
        };
        switch (row.status) {
            case 'pending':
            case 'processing':
                return { ...base, status: row.status };
            case 'classified':
                if (row.category === null || row.priority === null || row.summary === null) {
                    throw new Error(`classified ticket ${row.id} is missing classification fields`);
                }
                return {
                    ...base,
                    status: 'classified',
                    classification: {
                        category: row.category as Category,
                        priority: row.priority as Priority,
                        summary: row.summary,
                    },
                };
            case 'failed':
                if (row.error === null) {
                    throw new Error(`failed ticket ${row.id} is missing its error`);
                }
                return { ...base, status: 'failed', error: row.error };
            default:
                throw new Error(`ticket ${row.id} has unknown status '${row.status}'`);
        }
    }
}
