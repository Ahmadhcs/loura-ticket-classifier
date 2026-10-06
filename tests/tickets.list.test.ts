import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { DB } from '../src/repository/db.js';
import { buildTestApp } from './helpers.js';

let app: Express;
let db: DB;
let now: number;

beforeEach(() => {
    now = 0;
    ({ app, db } = buildTestApp(() => (now += 1000)));
});

afterEach(() => {
    db.close();
});

async function ingest(id: string): Promise<void> {
    await request(app).post('/tickets').send({ id, subject: `subject ${id}`, body: `body ${id}` });
}

function classify(id: string, category: string, priority: string): void {
    db.prepare(
        `UPDATE tickets
         SET status = 'classified', category = ?, priority = ?, summary = 'a summary'
         WHERE id = ?`,
    ).run(category, priority, id);
}

function ids(body: { items: { id: string }[] }): string[] {
    return body.items.map((item) => item.id);
}

describe('GET /tickets filters', () => {
    beforeEach(async () => {
        await ingest('t-1');
        await ingest('t-2');
        await ingest('t-3');
        classify('t-1', 'billing', 'high');
        classify('t-2', 'technical', 'low');
        classify('t-3', 'billing', 'low');
    });

    it('filters by category, newest first', async () => {
        const res = await request(app).get('/tickets').query({ category: 'billing' });

        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual(['t-3', 't-1']);
        expect(res.body.nextCursor).toBeNull();
    });

    it('filters by category and priority', async () => {
        const res = await request(app)
            .get('/tickets')
            .query({ category: 'billing', priority: 'high' });

        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual(['t-1']);
    });
});

describe('GET /tickets pagination', () => {
    beforeEach(async () => {
        for (const id of ['t-1', 't-2', 't-3', 't-4', 't-5']) {
            await ingest(id);
        }
    });

    it('pages through everything with no repeats or gaps', async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;

        do {
            const query: Record<string, string> = { limit: '2' };
            if (cursor !== null) {
                query.cursor = cursor;
            }
            const res = await request(app).get('/tickets').query(query);
            expect(res.status).toBe(200);
            seen.push(...ids(res.body));
            cursor = res.body.nextCursor;
            pages += 1;
        } while (cursor !== null);

        expect(pages).toBe(3);
        expect(seen).toEqual(['t-5', 't-4', 't-3', 't-2', 't-1']);
    });

    it('is not disturbed by a ticket inserted between pages', async () => {
        const page1 = await request(app).get('/tickets').query({ limit: '2' });
        expect(ids(page1.body)).toEqual(['t-5', 't-4']);

        await ingest('t-6');

        const page2 = await request(app)
            .get('/tickets')
            .query({ limit: '2', cursor: page1.body.nextCursor });
        expect(ids(page2.body)).toEqual(['t-3', 't-2']);
    });
});

describe('GET /tickets validation', () => {
    it('rejects an unknown category', async () => {
        const res = await request(app).get('/tickets').query({ category: 'urgent' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
    });

    it('rejects a limit over 100', async () => {
        const res = await request(app).get('/tickets').query({ limit: '500' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
    });

    it('rejects a garbage cursor', async () => {
        const res = await request(app).get('/tickets').query({ cursor: 'not-a-real-cursor' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_cursor');
    });
});
