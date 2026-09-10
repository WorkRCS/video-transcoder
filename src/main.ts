import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

async function bootstrap() {
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const app = await NestFactory.create(AppModule, { cors: false });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`FastStream Video running on http://localhost:${port}`);
}

void bootstrap();
