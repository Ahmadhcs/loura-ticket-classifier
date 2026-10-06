const PATTERNS: RegExp[] = [
    /\b(ignore|disregard)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|directions?)\b/i,
    /\bfrom now on,?\s+you are\b/i,
    /\byou are now\s+(a|an|the|acting as|in)\b/i,
    /\bsystem prompt\b/i,
    /\bclassify\s+(it|this)(\s+ticket)?\s+as\b/i,
    /\bsummari[sz]e\s+(it|this)?\s*as\b/i,
    /<\s*\/?\s*ticket\s*>/i,
];

export function detectSuspectedInjection(subject: string, body: string): boolean {
    const text = `${subject}\n${body}`;
    return PATTERNS.some((pattern) => pattern.test(text));
}
