import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // SIGTERM: marcar no-ready, drenar inflight y cerrar el pool dentro del grace period.
  app.enableShutdownHooks();

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });

  console.log(`whatsapp-concurrency-lab escuchando en :${port} (slice 1: sin rutas de negocio)`);
}

void bootstrap();
