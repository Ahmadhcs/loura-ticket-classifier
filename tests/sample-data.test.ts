import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CreateTicketBody } from '../src/api/schemas.js';

const tickets = JSON.parse(
    readFileSync(new URL('../data/sample_tickets.json', import.meta.url), 'utf8'),
) as unknown[];

describe('sample tickets', () => {
    it('every sample ticket passes CreateTicketBody', () => {
        for (const ticket of tickets) {
            const result = CreateTicketBody.safeParse(ticket);
            expect(result.success, JSON.stringify(ticket)).toBe(true);
        }
    });
});
