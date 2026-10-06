import type { NewTicket, Ticket } from '../domain.js';
import type { TicketsRepo } from '../repository/tickets.repo.js';
import { ConflictError, NotFoundError } from '../api/errors.js';

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
}
