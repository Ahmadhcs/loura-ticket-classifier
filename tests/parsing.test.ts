import { describe, expect, it } from 'vitest';
import type { Classification } from '../src/domain.js';
import { parseModelOutput } from '../src/llm/parsing.js';

const VALID =
    '{"category": "billing", "priority": "high", "summary": "Customer was charged twice."}';
const VALID_PARSED: Classification = {
    category: 'billing',
    priority: 'high',
    summary: 'Customer was charged twice.',
};

describe('parseModelOutput accepts', () => {
    const cases: { name: string; raw: string; expected: Classification }[] = [
        {
            name: 'plain valid JSON',
            raw: VALID,
            expected: VALID_PARSED,
        },
        {
            name: 'JSON inside markdown fences',
            raw: '```json\n' + VALID + '\n```',
            expected: VALID_PARSED,
        },
        {
            name: 'JSON with prose before and after',
            raw: 'Sure, here is the classification:\n' + VALID + '\nLet me know if you need more.',
            expected: VALID_PARSED,
        },
        {
            name: 'case and whitespace repaired on enums and summary',
            raw: '{"category": "Billing ", "priority": "HIGH", "summary": "  padded  "}',
            expected: { category: 'billing', priority: 'high', summary: 'padded' },
        },
        {
            name: 'summary containing braces',
            raw: '{"category": "other", "priority": "low", "summary": "uses { and } chars"}',
            expected: { category: 'other', priority: 'low', summary: 'uses { and } chars' },
        },
        {
            name: 'summary with an escaped quote next to a brace',
            raw: '{"category": "other", "priority": "low", "summary": "he said \\"{\\" twice"}',
            expected: { category: 'other', priority: 'low', summary: 'he said "{" twice' },
        },
        {
            name: 'two JSON objects: the first one is used',
            raw: VALID + '\n{"category": "other", "priority": "low", "summary": "second"}',
            expected: VALID_PARSED,
        },
    ];

    it.each(cases)('$name', ({ raw, expected }) => {
        expect(parseModelOutput(raw)).toEqual({ ok: true, value: expected });
    });
});

describe('parseModelOutput rejects', () => {
    const cases: { name: string; raw: string; reason: string | RegExp }[] = [
        { name: 'empty string', raw: '', reason: 'no JSON object found' },
        { name: 'prose with no JSON', raw: 'I could not classify this ticket.', reason: 'no JSON object found' },
        {
            name: 'trailing comma',
            raw: '{"category": "billing", "priority": "high", "summary": "x",}',
            reason: 'invalid JSON',
        },
        { name: 'unclosed brace', raw: '{"category": "billing"', reason: 'no JSON object found' },
        {
            name: 'brace-balanced non-JSON blob before the real JSON',
            raw: '{see below} ' + VALID,
            reason: 'invalid JSON',
        },
        {
            name: 'unknown category',
            raw: '{"category": "urgent", "priority": "high", "summary": "x"}',
            reason: 'invalid category: "urgent"',
        },
        {
            name: 'unknown priority',
            raw: '{"category": "billing", "priority": "critical", "summary": "x"}',
            reason: 'invalid priority: "critical"',
        },
        {
            name: 'category as a number',
            raw: '{"category": 3, "priority": "high", "summary": "x"}',
            reason: 'invalid category: 3',
        },
        {
            name: 'missing summary',
            raw: '{"category": "billing", "priority": "high"}',
            reason: 'missing summary',
        },
        {
            name: 'empty summary',
            raw: '{"category": "billing", "priority": "high", "summary": ""}',
            reason: 'invalid summary: ""',
        },
        {
            name: 'whitespace-only summary',
            raw: '{"category": "billing", "priority": "high", "summary": "   "}',
            reason: 'invalid summary: "   "',
        },
        {
            name: 'summary of 201 chars is rejected and truncated in the error',
            raw: `{"category": "billing", "priority": "high", "summary": "${'a'.repeat(201)}"}`,
            reason: /^invalid summary: "a{49}…$/,
        },
        {
            name: 'extra field',
            raw: '{"category": "billing", "priority": "high", "summary": "x", "confidence": 0.9}',
            reason: 'unexpected field: confidence',
        },
        {
            name: 'JSON array instead of an object',
            raw: '["billing", "high", "x"]',
            reason: 'no JSON object found',
        },
    ];

    it.each(cases)('$name', ({ raw, reason }) => {
        const result = parseModelOutput(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            if (typeof reason === 'string') {
                expect(result.error).toBe(reason);
            } else {
                expect(result.error).toMatch(reason);
            }
        }
    });
});
