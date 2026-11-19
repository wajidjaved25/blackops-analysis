import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeysController, AuditController, AuthController, AuthGuard, Public, UsersController } from './auth';
import { Db } from './db';
import { InvestigateController } from './investigate.controller';
import { Jobs } from './jobs';
import { LabelsController, LabelsService } from './labels';
import { RiskController, RiskService } from './risk';
import { ScreenController, ScreenWorker } from './screen';

@Controller()
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({
  controllers: [HealthController, AuthController, UsersController, ApiKeysController, AuditController, InvestigateController, LabelsController, RiskController, ScreenController],
  providers: [Db, Jobs, LabelsService, RiskService, ScreenWorker, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
