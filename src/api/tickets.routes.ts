import { Router } from 'express';
import { CreateTicketBody } from './schemas.js';
import type { TicketsService } from '../services/tickets.service.js';

export function ticketsRouter(tickets: TicketsService): Router {
    const router = Router();

    router.post('/tickets', (req, res) => {
        const input = CreateTicketBody.parse(req.body);
        const { ticket, created } = tickets.ingest(input);
        res.status(created ? 202 : 200).json(ticket);
    });

    router.get('/tickets/:id', (req, res) => {
        res.json(tickets.get(req.params.id));
    });

    return router;
}
