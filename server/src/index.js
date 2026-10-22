import { createApp } from './app.js';
import { config, configProblems } from './config.js';

// In production an unsound configuration stops the service at once, so that the host reports a failed deployment.
const problems = configProblems(config);
if (problems.length > 0) {
  for (const problem of problems) console.error(`Configuration: ${problem}`);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

const { app, registry } = createApp({ config });
registry.startSweeper();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Server listening on port ${config.port}`);
});
