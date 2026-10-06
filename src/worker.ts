import type { Claimed, TicketsRepo } from './repository/tickets.repo.js';

export interface Classifier {
    classify(claimed: Claimed): Promise<void>;
}

export interface WorkerConfig {
    concurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
}

export interface WorkerLogger {
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
}

export class Worker {
    private readonly inFlight = new Set<Promise<void>>();
    private stopped = false;
    private wake: (() => void) | undefined;

    constructor(
        private readonly repo: TicketsRepo,
        private readonly classifier: Classifier,
        private readonly clock: () => number,
        private readonly logger: WorkerLogger,
        private readonly config: WorkerConfig,
    ) {}

    tick(): void {
        try {
            this.repo.recoverExpiredLeases(this.clock());
            while (this.inFlight.size < this.config.concurrency && !this.stopped) {
                const claimed = this.repo.claimNext(this.clock(), this.config.leaseMs);
                if (claimed === undefined) {
                    break;
                }
                this.launch(claimed);
            }
        } catch (err) {
            this.logger.error({ err }, 'worker tick failed');
        }
    }

    async start(): Promise<void> {
        while (!this.stopped) {
            this.tick();
            await this.delay(this.config.pollIntervalMs);
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.wake?.();
        await Promise.allSettled([...this.inFlight]);
    }

    private launch(claimed: Claimed): void {
        const task: Promise<void> = this.classifier
            .classify(claimed)
            .catch((err: unknown) => {
                this.logger.error({ ticketId: claimed.ticket.id, err }, 'classification crashed');
            })
            .finally(() => {
                this.inFlight.delete(task);
            });
        this.inFlight.add(task);
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.wake = undefined;
                resolve();
            }, ms);
            this.wake = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
        });
    }
}
