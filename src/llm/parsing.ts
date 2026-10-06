import { z } from 'zod';
import { CATEGORIES, PRIORITIES, type Classification, type Result } from '../domain.js';

function normalize(value: unknown): unknown {
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export const ClassificationSchema = z
    .object({
        category: z.preprocess(normalize, z.enum(CATEGORIES)),
        priority: z.preprocess(normalize, z.enum(PRIORITIES)),
        summary: z.string().trim().min(1).max(200),
    })
    .strict();

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

true satisfies Equal<z.infer<typeof ClassificationSchema>, Classification>;

export function extractJson(raw: string): string | null {
    const start = raw.indexOf('{');
    if (start === -1) {
        return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
        const char = raw[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (inString) {
            if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return raw.slice(start, i + 1);
            }
        }
    }
    return null;
}

export function truncate(text: string): string {
    return text.length > 50 ? `${text.slice(0, 50)}…` : text;
}

function describeIssue(issue: z.ZodIssue, parsed: unknown): string {
    if (issue.code === 'unrecognized_keys') {
        return `unexpected field: ${issue.keys.join(', ')}`;
    }
    const key = issue.path[0];
    if (key === undefined) {
        return 'not a JSON object';
    }
    const value = (parsed as Record<string, unknown>)[String(key)];
    if (value === undefined) {
        return `missing ${String(key)}`;
    }
    return `invalid ${String(key)}: ${truncate(JSON.stringify(value))}`;
}

export function parseModelOutput(raw: string): Result<Classification, string> {
    const json = extractJson(raw);
    if (json === null) {
        return { ok: false, error: 'no JSON object found' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { ok: false, error: 'invalid JSON' };
    }

    const result = ClassificationSchema.safeParse(parsed);
    if (!result.success) {
        const issue = result.error.issues[0];
        return {
            ok: false,
            error: issue === undefined ? 'invalid classification' : describeIssue(issue, parsed),
        };
    }
    return { ok: true, value: result.data };
}
