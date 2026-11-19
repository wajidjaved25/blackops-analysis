import { Controller, Get, Module } from '@nestjs/common';
import { InvestigateController } from './investigate.controller';

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({ controllers: [HealthController, InvestigateController] })
export class AppModule {}
