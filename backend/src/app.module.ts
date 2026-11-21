import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeysController, AuditController, OrgController, RolesController, UsersController } from './admin';
import { AttributionController, ClusterWorker } from './attribution';
import { AuthController, AuthGuard, RoleSeeder } from './auth';
import { CaseAnalysisController } from './case-analysis';
import { CaseTxController } from './case-tx';
import { CasesController, CasesService } from './cases';
import { Db } from './db';
import { InvestigateController } from './investigate.controller';
import { Jobs } from './jobs';
import { CrossChainController } from './crosschain';
import { BinancePor } from './binance-por';
import { ExchangeLists } from './exchange-lists';
import { WalletGroupsController, WalletGroupsService } from './wallet-groups.controller';
import { LabelsController, LabelsService } from './labels';
import { MonitorController, MonitorService, Notifier } from './monitor';
import { RiskController, RiskService } from './risk';
import { IndexController, TransferIndex } from './transfer-index';
import { ScreenController, ScreenWorker } from './screen';

@Module({
  controllers: [AuthController, UsersController, RolesController, OrgController, ApiKeysController, AuditController, InvestigateController, LabelsController, RiskController, ScreenController, MonitorController, CasesController, CaseTxController, CaseAnalysisController, AttributionController, IndexController, CrossChainController, WalletGroupsController],
  providers: [Db, Jobs, LabelsService, BinancePor, ExchangeLists, WalletGroupsService, RiskService, ScreenWorker, MonitorService, Notifier, RoleSeeder, CasesService, ClusterWorker, TransferIndex, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
