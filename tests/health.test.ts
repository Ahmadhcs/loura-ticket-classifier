import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp } from './helpers.js';

describe('GET /health', () => {
    it('returns status ok', async () => {
        const { app, db } = buildTestApp();

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });

        db.close();
    });
});
