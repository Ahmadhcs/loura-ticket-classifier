import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { openDB, type DB } from '../src/repository/db.js';
import { TicketsRepo } from '../src/repository/tickets.repo.js';
import { TicketsService } from '../src/services/tickets.service.js';

export function buildTestApp(): { app: Express; db: DB } {
    const db = openDB(':memory:');
    const tickets = new TicketsService(new TicketsRepo(db), Date.now);
    return { app: createApp({ tickets }), db };
}
