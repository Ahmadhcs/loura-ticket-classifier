import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NewTicket } from '../src/domain.js';
import { FakeLLM } from '../src/llm/fake.js';
import { parseModelOutput } from '../src/llm/parsing.js';
import { buildPrompt } from '../src/llm/prompt.js';

const samples = JSON.parse(
    readFileSync(new URL('../data/sample_tickets.json', import.meta.url), 'utf8'),
) as NewTicket[];

function sample(id: string): NewTicket {
    const ticket = samples.find((t) => t.id === id);
    if (ticket === undefined) {
        throw new Error(`no sample ticket ${id}`);
    }
    return ticket;
}

async function settle(fake: FakeLLM, prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
        return `ok:${await fake.complete(prompt, controller.signal)}`;
    } catch (err) {
        return `err:${err instanceof Error ? err.message : String(err)}`;
    } finally {
        clearTimeout(timer);
    }
}

describe('FakeLLM generated mode', () => {
    it('produces the same sequence for the same seed', async () => {
        const prompt = buildPrompt(sample('t-1001'));
        const a = new FakeLLM({ seed: 7, failureRate: 0.5 });
        const b = new FakeLLM({ seed: 7, failureRate: 0.5 });

        const seqA: string[] = [];
        const seqB: string[] = [];
        for (let i = 0; i < 20; i++) {
            seqA.push(await settle(a, prompt));
            seqB.push(await settle(b, prompt));
        }

        expect(seqA).toEqual(seqB);
        expect(new Set(seqA).size).toBeGreaterThan(1);
    });

    it('classifies t-1001, t-1003 and t-1006 sensibly with failureRate 0', async () => {
        const fake = new FakeLLM({ failureRate: 0 });
        const { signal } = new AbortController();

        const cases: { id: string; category?: string; priority?: string }[] = [
            { id: 't-1001', category: 'billing' },
            { id: 't-1003', category: 'technical', priority: 'high' },
            { id: 't-1006', priority: 'low' },
        ];

        for (const expected of cases) {
            const raw = await fake.complete(buildPrompt(sample(expected.id)), signal);
            const result = parseModelOutput(raw);
            expect(result.ok, `${expected.id} → ${raw}`).toBe(true);
            if (result.ok) {
                if (expected.category !== undefined) {
                    expect(result.value.category, expected.id).toBe(expected.category);
                }
                if (expected.priority !== undefined) {
                    expect(result.value.priority, expected.id).toBe(expected.priority);
                }
            }
        }
    });
});

describe('FakeLLM scripted mode', () => {
    it('plays responses in order and records every call', async () => {
        const fake = new FakeLLM({ script: ['first', new Error('boom'), 'third'] });
        const { signal } = new AbortController();

        await expect(fake.complete('p1', signal)).resolves.toBe('first');
        await expect(fake.complete('p2', signal)).rejects.toThrow('boom');
        await expect(fake.complete('p3', signal)).resolves.toBe('third');
        await expect(fake.complete('p4', signal)).rejects.toThrow('script exhausted');

        expect(fake.calls).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('a hang rejects when the signal aborts', async () => {
        const fake = new FakeLLM({ script: ['hang'] });
        const controller = new AbortController();

        const pending = fake.complete('p', controller.signal);
        controller.abort();

        await expect(pending).rejects.toThrow(/abort/i);
    });
});
