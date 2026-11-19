import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  try {
    process.loadEnvFile(); // Node >= 20.12 reads .env natively
  } catch {
    console.warn('No backend/.env found — copy .env.example to .env (ERC20 needs ETHERSCAN_API_KEY)');
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api`);
}
bootstrap();
