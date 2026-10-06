import { z } from 'zod';
import { CATEGORIES, PRIORITIES } from '../domain.js';

export const CreateTicketBody = z
    .object({
        id: z.string().min(1).max(100),
        subject: z.string().max(500),
        body: z.string().min(1).max(20_000),
    })
    .strict();

export const ListTicketsQuery = z
    .object({
        category: z.enum(CATEGORIES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
    })
    .strict();

export type ListTicketsQuery = z.infer<typeof ListTicketsQuery>;

export type CreateTicketBody = z.infer<typeof CreateTicketBody>;
