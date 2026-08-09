import { createApp, installShutdownHandlers } from './bootstrap';
import { INSTANCE_ID } from './observability/instance';
import { lifecycle } from './observability/lifecycle';

async function main(): Promise<void> {
  const app = await createApp();

  const drainDelayMs = Number.parseInt(process.env.DRAIN_DELAY_MS ?? '5000', 10);
  installShutdownHandlers(app, drainDelayMs);

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });

  lifecycle.markStarted();
  console.log(`[${INSTANCE_ID}] escuchando en :${port}`);
}

void main();
