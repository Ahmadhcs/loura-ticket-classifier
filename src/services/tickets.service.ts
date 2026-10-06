import { z } from 'zod';
import type { NewTicket, Ticket } from '../domain.js';
import type { Keyset, TicketsRepo } from '../repository/tickets.repo.js';
import { ConflictError, InvalidCursorError, NotFoundError } from '../api/errors.js';
import type { ListTicketsQuery } from '../api/schemas.js';

const Cursor = z
    .object({
        createdAt: z.number().int(),
        id: z.string(),
    })
    .strict();

function decodeCursor(cursor: string): Keyset {
    try {
        return Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
        throw new InvalidCursorError('cursor is malformed');
    }
}

function encodeCursor(last: Ticket): string {
    const json = JSON.stringify({ createdAt: Date.parse(last.createdAt), id: last.id });
    return Buffer.from(json, 'utf8').toString('base64url');
}

export class TicketsService {
    constructor(
        private readonly repo: TicketsRepo,
        private readonly clock: () => number,
    ) {}

    ingest(input: NewTicket): { ticket: Ticket; created: boolean } {
        const { ticket, created } = this.repo.insertIfAbsent(input, this.clock());
        if (!created && (ticket.subject !== input.subject || ticket.body !== input.body)) {
            throw new ConflictError(`ticket ${input.id} already exists with different content`);
        }
        return { ticket, created };
    }

    get(id: string): Ticket {
        const ticket = this.repo.findById(id);
        if (ticket === undefined) {
            throw new NotFoundError(`ticket ${id} not found`);
        }
        return ticket;
    }

    list(query: ListTicketsQuery): { items: Ticket[]; nextCursor: string | null } {
        const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
        const rows = this.repo.list(
            { category: query.category, priority: query.priority },
            query.limit + 1,
            after,
        );
        const items = rows.slice(0, query.limit);
        const last = items[items.length - 1];
        const nextCursor =
            rows.length > items.length && last !== undefined ? encodeCursor(last) : null;
        return { items, nextCursor };
    }
}
