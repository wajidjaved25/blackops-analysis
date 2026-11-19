import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeysController, AuditController, OrgController, RolesController, UsersController } from './admin';
import { AttributionController, ClusterWorker } from './attribution';
import { AuthController, AuthGuard, RoleSeeder } from './auth';
import { CasesController, CasesService } from './cases';
import { Db } from './db';
import { InvestigateController } from './investigate.controller';
import { Jobs } from './jobs';
import { LabelsController, LabelsService } from './labels';
import { MonitorController, MonitorService, Notifier } from './monitor';
import { RiskController, RiskService } from './risk';
import { ScreenController, ScreenWorker } from './screen';

@Module({
  controllers: [AuthController, UsersController, RolesController, OrgController, ApiKeysController, AuditController, InvestigateController, LabelsController, RiskController, ScreenController, MonitorController, CasesController, AttributionController],
  providers: [Db, Jobs, LabelsService, RiskService, ScreenWorker, MonitorService, Notifier, RoleSeeder, CasesService, ClusterWorker, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
