import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  try {
    process.loadEnvFile(); // Node >= 20.12 reads .env natively
  } catch {
    console.warn('No backend/.env found — copy .env.example to .env (DATABASE_URL is required)');
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '12mb' }); // case graph snapshots and CSV imports
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1); // behind Caddy/nginx: real client IP for rate limits
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api`);
}
bootstrap();
