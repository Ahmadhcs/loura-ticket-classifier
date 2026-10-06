import type { Classification, Result } from '../domain.js';
import type { LLMClient } from '../llm/client.js';
import { parseModelOutput, truncate } from '../llm/parsing.js';
import { buildPrompt } from '../llm/prompt.js';
import type { Claimed, TicketsRepo } from '../repository/tickets.repo.js';

export interface ClassificationConfig {
    maxAttempts: number;
    timeoutMs: number;
    backoffBaseMs: number;
}

export interface WarnLogger {
    warn(obj: object, msg?: string): void;
}

export class ClassificationService {
    constructor(
        private readonly repo: TicketsRepo,
        private readonly llm: LLMClient,
        private readonly clock: () => number,
        private readonly sleep: (ms: number) => Promise<void>,
        private readonly logger: WarnLogger,
        private readonly config: ClassificationConfig,
    ) {}

    async classify(claimed: Claimed): Promise<void> {
        const { ticket, lease } = claimed;
        const { maxAttempts } = this.config;

        if (ticket.attempts >= maxAttempts) {
            this.markFailed(ticket.id, lease, 'max attempts exceeded');
            return;
        }

        const prompt = buildPrompt(ticket);
        let lastReason = 'no attempts made';

        for (let attempt = ticket.attempts + 1; attempt <= maxAttempts; attempt++) {
            if (!this.repo.recordAttempt(ticket.id, lease, this.clock())) {
                this.logger.warn({ ticketId: ticket.id, attempt }, 'lease lost; abandoning ticket');
                return;
            }

            const outcome = await this.attemptOnce(prompt);
            if (outcome.ok) {
                if (!this.repo.markClassified(ticket.id, lease, outcome.value, this.clock())) {
                    this.logger.warn(
                        { ticketId: ticket.id, attempt },
                        'lease lost; classification discarded',
                    );
                }
                return;
            }

            lastReason = outcome.error;
            this.logger.warn(
                { ticketId: ticket.id, attempt, reason: lastReason },
                'classification attempt failed',
            );

            if (attempt < maxAttempts) {
                const backoff = this.config.backoffBaseMs * 2 ** (attempt - 1);
                await this.sleep(backoff + Math.random() * 0.25 * backoff);
            }
        }

        this.markFailed(ticket.id, lease, lastReason);
    }

    private markFailed(id: string, lease: number, reason: string): void {
        if (!this.repo.markFailed(id, lease, reason, this.clock())) {
            this.logger.warn({ ticketId: id, reason }, 'lease lost; failure not recorded');
        }
    }

    private async attemptOnce(prompt: string): Promise<Result<Classification, string>> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        let raw: string;
        try {
            raw = await this.llm.complete(prompt, controller.signal);
        } catch (err) {
            if (controller.signal.aborted) {
                return { ok: false, error: 'model timeout' };
            }
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: `model error: ${truncate(message)}` };
        } finally {
            clearTimeout(timer);
        }
        return parseModelOutput(raw);
    }
}
