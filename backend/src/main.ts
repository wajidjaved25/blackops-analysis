import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { csrfGuard } from './csrf';

async function bootstrap() {
  try {
    process.loadEnvFile(); // Node >= 20.12 reads .env natively
  } catch {
    console.warn('No backend/.env found — copy .env.example to .env (DATABASE_URL is required)');
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store'); // API responses hold investigation data
    next();
  });
  app.use(csrfGuard);
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '12mb' }); // case graph snapshots and CSV imports
  // Real client IP for rate limits. 'true' = one proxy (Caddy); 'loopback' = Apache -> Next -> API on one host; or a hop count.
  const tp = process.env.TRUST_PROXY;
  if (tp && tp !== 'false') app.set('trust proxy', tp === 'true' ? 1 : /^\d+$/.test(tp) ? Number(tp) : tp);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, process.env.HOST || '0.0.0.0'); // HOST=127.0.0.1 behind Apache/nginx
  console.log(`API listening on http://localhost:${port}/api`);
}
bootstrap();
