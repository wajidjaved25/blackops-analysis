import { Controller, Get, Injectable, Param, Query } from '@nestjs/common';
import { ApiKeyAuth, CurrentCtx } from './auth';
import { Chain, flows, getTransfers, isTetherFrozen, Transfer } from './chains';
import { Ctx } from './db';
import { LabelLite, LabelsService } from './labels';
import { IndirectInput, RiskResult, scoreRisk, WEIGHTS } from './risk-score';
import { parseAddr } from './util';

export interface Assessment extends RiskResult {
  chain: Chain;
  address: string;
  labels: LabelLite[];
  frozen: boolean;
  transfersChecked: number;
}

const INDIRECT_FANOUT = 5; // ponytail: 2nd hop checks only the top 5 counterparties (API cost). Indexer (Phase 7) lifts this.

@Injectable()
export class RiskService {
  constructor(private labels: LabelsService) {}

  /** `deep` adds 2-hop indirect exposure (≈5 extra API calls). Bulk screening uses deep=false. */
  async assess(chain: Chain, address: string, orgId: number, opts: { transfers?: Transfer[]; deep?: boolean } = {}): Promise<Assessment> {
    const transfers = opts.transfers ?? (await getTransfers(chain, address, 500));
    const fl = flows(address, transfers);
    const [frozenLive, labelMap] = await Promise.all([isTetherFrozen(chain, address), this.labels.lookup(chain, [address, ...fl.map((f) => f.address)], orgId)]);
    const own = labelMap.get(address) ?? [];
    const frozen = frozenLive || own.some((l) => l.category === 'frozen');
    const labelsOf = (a: string) => labelMap.get(a) ?? [];

    let indirect: IndirectInput[] | undefined;
    if (opts.deep) {
      const total = fl.reduce((s, f) => s + f.in + f.out, 0);
      const unflagged = fl.filter((f) => !labelsOf(f.address).some((l) => (WEIGHTS[l.category] ?? 0) > 0)).slice(0, INDIRECT_FANOUT);
      indirect = [];
      for (const f of unflagged) {
        const cfl = flows(f.address, await getTransfers(chain, f.address, 200));
        const cLabels = await this.labels.lookup(chain, cfl.map((x) => x.address), orgId);
        const r = scoreRisk({ own: [], frozen: false, flows: cfl.filter((x) => x.address !== address), labelsOf: (a) => cLabels.get(a) ?? [] });
        indirect.push({ address: f.address, share: total ? (f.in + f.out) / total : 0, directScore: r.direct });
      }
    }

    const r = scoreRisk({ own, frozen, flows: fl, labelsOf, indirect });
    return { chain, address, labels: own, frozen, transfersChecked: transfers.length, ...r };
  }
}

@Controller()
export class RiskController {
  constructor(private risk: RiskService) {}

  @Get('risk/:addr')
  risk_(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string) {
    const { chain, addr } = parseAddr(raw);
    return this.risk.assess(chain, addr, ctx.orgId, { deep: true });
  }

  /** Public screening API (Phase 6.4). Header: X-API-Key. `?deep=true` adds 2-hop exposure. */
  @ApiKeyAuth()
  @Get('v1/screen/:addr')
  async screen(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Query('deep') deep?: string) {
    const { chain, addr } = parseAddr(raw);
    const a = await this.risk.assess(chain, addr, ctx.orgId, { deep: deep === 'true' });
    return {
      address: a.address,
      chain: a.chain,
      riskScore: a.score,
      riskLevel: a.level,
      frozenByTether: a.frozen,
      labels: a.labels.map((l) => ({ name: l.name, category: l.category, source: l.source })),
      reasons: a.reasons,
      exposures: a.exposures.filter((e) => e.weight > 0).map((e) => ({ address: e.address, category: e.category, name: e.name, volume: e.volume, share: e.share })),
      transfersChecked: a.transfersChecked,
      checkedAt: new Date().toISOString(),
    };
  }
}
