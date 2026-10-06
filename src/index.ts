import { createApp } from './app.js';
import { logger } from './logger.js';

const port = Number(3000);

createApp().listen(port, () => {
  logger.info(`listening on port ${port}`);
});
