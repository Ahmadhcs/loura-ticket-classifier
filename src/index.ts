import { createApp } from './app.js';
import { logger } from './logger.js';
import { openDB } from './repository/db.js';
import { TicketsRepo } from './repository/tickets.repo.js';
import { TicketsService } from './services/tickets.service.js';

const db = openDB('./tickets.db');
const tickets = new TicketsService(new TicketsRepo(db), Date.now);

const port = Number(3000);

createApp({ tickets }).listen(port, () => {
  logger.info(`listening on port ${port}`);
});
