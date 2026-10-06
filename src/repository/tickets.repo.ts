import type { Statement } from 'better-sqlite3';
import type { DB } from './db.js';
import type { Category, NewTicket, Priority, Ticket } from '../domain.js';

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
    lease_until: number | null;
    created_at: number;
    updated_at: number;
}

export class TicketsRepo {
    private readonly insertStmt: Statement;
    private readonly selectByIdStmt: Statement;

    constructor(db: DB) {
        this.insertStmt = db.prepare(`
            INSERT INTO tickets (id, subject, body, status, attempts, created_at, updated_at)
            VALUES (@id, @subject, @body, 'pending', 0, @now, @now)
            ON CONFLICT(id) DO NOTHING
        `);
        this.selectByIdStmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
    }

    insertIfAbsent(input: NewTicket, now: number): { ticket: Ticket; created: boolean } {
        const info = this.insertStmt.run({ ...input, now });
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

    private rowToTicket(row: TicketRow): Ticket {
        const base = {
            id: row.id,
            subject: row.subject,
            body: row.body,
            attempts: row.attempts,
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
