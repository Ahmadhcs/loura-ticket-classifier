import express from 'express';
import { errorHandler } from './api/errors.js';
import { ticketsRouter } from './api/tickets.routes.js';
import type { TicketsService } from './services/tickets.service.js';

export interface AppDeps {
  tickets: TicketsService;
}

export function createApp({ tickets }: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(ticketsRouter(tickets));
  app.use(errorHandler);

  return app;
}
