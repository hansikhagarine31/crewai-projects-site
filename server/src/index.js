import { createApp } from './app.js';
import { config } from './config.js';

const { app, registry } = createApp({ config });
registry.startSweeper();

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
