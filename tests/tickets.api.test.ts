import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { DB } from '../src/repository/db.js';
import { buildTestApp } from './helpers.js';

const TICKET = { id: 't-1001', subject: 'Charged twice this month', body: 'Two charges of 49.00' };

let app: Express;
let db: DB;

beforeEach(() => {
    ({ app, db } = buildTestApp());
});

afterEach(() => {
    db.close();
});

describe('POST /tickets', () => {
    it('creates a new ticket as pending', async () => {
        const res = await request(app).post('/tickets').send(TICKET);

        expect(res.status).toBe(202);
        expect(res.body.status).toBe('pending');
        expect(res.body.id).toBe('t-1001');
    });

    it('returns the existing ticket for a duplicate with identical content', async () => {
        const first = await request(app).post('/tickets').send(TICKET);
        const res = await request(app).post('/tickets').send(TICKET);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(first.body);

        const { n } = db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
        expect(n).toBe(1);
    });

    it('rejects a duplicate id with different content', async () => {
        await request(app).post('/tickets').send(TICKET);
        const res = await request(app)
            .post('/tickets')
            .send({ ...TICKET, body: 'completely different' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            error: { code: 'conflict', message: expect.any(String) },
        });
    });

    it('accepts an empty subject (t-1008)', async () => {
        const res = await request(app).post('/tickets').send({ id: 't-1008', subject: '', body: 'asdf' });

        expect(res.status).toBe(202);
    });

    it('rejects a missing body field', async () => {
        const res = await request(app).post('/tickets').send({ id: 't-1', subject: 's' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
        expect(res.body.error.details).toBeDefined();
    });

    it('rejects malformed JSON', async () => {
        const res = await request(app)
            .post('/tickets')
            .set('Content-Type', 'application/json')
            .send('{"id": "t-1",');

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_json');
    });
});

describe('GET /tickets/:id', () => {
    it('returns an existing ticket', async () => {
        await request(app).post('/tickets').send(TICKET);
        const res = await request(app).get('/tickets/t-1001');

        expect(res.status).toBe(200);
        expect(res.body.id).toBe('t-1001');
        expect(res.body.status).toBe('pending');
    });

    it('returns 404 in the error format for an unknown id', async () => {
        const res = await request(app).get('/tickets/t-nope');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            error: { code: 'not_found', message: expect.any(String) },
        });
    });
});
