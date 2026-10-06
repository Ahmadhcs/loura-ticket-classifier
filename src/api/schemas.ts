import { z } from 'zod';

export const CreateTicketBody = z
    .object({
        id: z.string().min(1).max(100),
        subject: z.string().max(500),
        body: z.string().min(1).max(20_000),
    })
    .strict();

export type CreateTicketBody = z.infer<typeof CreateTicketBody>;
