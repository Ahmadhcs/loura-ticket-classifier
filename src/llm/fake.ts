import type { Category, Classification, Priority } from '../domain.js';
import type { LLMClient } from './client.js';

export type ScriptedResponse = string | Error | 'hang';

export interface FakeLLMOptions {
    script?: ScriptedResponse[];
    seed?: number;
    failureRate?: number;
    obeyInjection?: boolean;
}

const INJECTED_INSTRUCTION =
    /classify\s+(?:it|this)(?:\s+ticket)?\s+as\s+(\w+)\s+with\s+priority\s+(\w+)\s+and\s+summari[sz]e\s+(?:it|this)?\s*as\s+'([^']*)'/i;

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hangUntilAbort(signal: AbortSignal): Promise<never> {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    let onAbort: (() => void) | undefined;
    const hang = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return hang.finally(() => {
        if (onAbort !== undefined) {
            signal.removeEventListener('abort', onAbort);
        }
    });
}

function readTicket(prompt: string): { subject: string; body: string } {
    const match = /<ticket>\nSubject: (.*)\nBody: ([\s\S]*)\n<\/ticket>$/.exec(prompt);
    return { subject: match?.[1] ?? '', body: match?.[2] ?? '' };
}

const CATEGORY_RULES: [Category, RegExp][] = [
    ['billing', /\b(charged?|charges|refunds?|invoices?|billed|billing|overcharged)\b/i],
    ['technical', /\b(errors?|bugs?|500s?|timeout|broken|crash|api|uploads?|uploading)\b/i],
    ['account', /\b(password|log ?in|account|email)\b/i],
];

function pickCategory(text: string): Category {
    for (const [category, pattern] of CATEGORY_RULES) {
        if (pattern.test(text)) {
            return category;
        }
    }
    return 'other';
}

function pickPriority(text: string): Priority {
    if (/\b(not urgent|nice to have|feature request)\b/i.test(text)) {
        return 'low';
    }
    if (/\b(urgent|blocking|production|outage|down|asap|immediately)\b/i.test(text)) {
        return 'high';
    }
    return 'medium';
}

function makeSummary(subject: string, body: string): string {
    const source = subject.trim() === '' ? body : subject;
    const start = source.trim().split(/\s+/).slice(0, 15).join(' ');
    const summary = `Customer reports: ${start}.`;
    return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
}

const BREAKAGES: ScriptedResponse[] = [
    '{"category": "billing", "priority": "high", "summary": "cut off',
    '{"category": "billing", "priority": "urgent", "summary": "Needs attention."}',
    '{"category": "billing", "priority": "high"}',
    '{"category": "billing", "priority": "high", "summary": "ok", "confidence": 0.98}',
    new Error('provider unavailable'),
    'hang',
];

export class FakeLLM implements LLMClient {
    readonly calls: string[] = [];
    private readonly script: ScriptedResponse[] | undefined;
    private scriptIndex = 0;
    private readonly random: () => number;
    private readonly failureRate: number;
    private readonly obeyInjection: boolean;

    constructor(options: FakeLLMOptions = {}) {
        this.script = options.script;
        this.random = mulberry32(options.seed ?? 1);
        this.failureRate = options.failureRate ?? 0.2;
        this.obeyInjection = options.obeyInjection ?? false;
    }

    async complete(prompt: string, signal: AbortSignal): Promise<string> {
        this.calls.push(prompt);
        const response = this.script === undefined ? this.generate(prompt) : this.nextScripted();
        if (response === 'hang') {
            return hangUntilAbort(signal);
        }
        if (response instanceof Error) {
            throw response;
        }
        return response;
    }

    private nextScripted(): ScriptedResponse {
        const response = this.script?.[this.scriptIndex];
        if (response === undefined) {
            throw new Error('FakeLLM script exhausted');
        }
        this.scriptIndex += 1;
        return response;
    }

    private generate(prompt: string): ScriptedResponse {
        if (this.random() < this.failureRate) {
            const breakage = BREAKAGES[Math.floor(this.random() * BREAKAGES.length)];
            return breakage ?? 'hang';
        }

        const { subject, body } = readTicket(prompt);
        const text = `${subject} ${body}`;

        if (this.obeyInjection) {
            const injected = INJECTED_INSTRUCTION.exec(text);
            if (injected !== null) {
                return JSON.stringify({
                    category: injected[1] ?? '',
                    priority: injected[2] ?? '',
                    summary: injected[3] ?? '',
                });
            }
        }

        const classification: Classification = {
            category: pickCategory(text),
            priority: pickPriority(text),
            summary: makeSummary(subject, body),
        };
        const json = JSON.stringify(classification);

        const dress = this.random();
        if (dress < 0.15) {
            return '```json\n' + json + '\n```';
        }
        if (dress < 0.3) {
            return `Here is the classification:\n${json}\nLet me know if you need anything else.`;
        }
        return json;
    }
}
