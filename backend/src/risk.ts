import { Controller, Get, Injectable, Param, Query } from '@nestjs/common';
import { ApiKeyAuth, CurrentCtx, Perm } from './auth';
import { AssetFilter, Chain, flows, FrozenMap, frozenBy, frozenStatus, getTransfers, Transfer } from './chains';
import { Ctx } from './db';
import { LabelLite, LabelsService } from './labels';
import { IndirectInput, RiskResult, scoreRisk, WEIGHTS } from './risk-score';
import { assetParam, parseAddr } from './util';

export interface Assessment extends RiskResult {
  chain: Chain;
  address: string;
  labels: LabelLite[];
  frozen: boolean;
  frozenBy: string[]; // issuers whose blacklist currently holds the wallet, e.g. ['Tether']
  transfersChecked: number;
}

const INDIRECT_FANOUT = 5; // ponytail: 2nd hop checks only the top 5 counterparties (API cost). Indexer (Phase 7) lifts this.

@Injectable()
export class RiskService {
  constructor(private labels: LabelsService) {}

  /** `deep` adds 2-hop indirect exposure (≈5 extra API calls). Bulk screening uses deep=false. */
  async assess(chain: Chain, address: string, orgId: number, opts: { transfers?: Transfer[]; deep?: boolean; frozen?: FrozenMap; asset?: AssetFilter } = {}): Promise<Assessment> {
    const transfers = opts.transfers ?? (await getTransfers(chain, address, 500, false, 'lookup', opts.asset));
    const fl = flows(address, transfers);
    const [frozenMap, labelMap] = await Promise.all([opts.frozen ?? frozenStatus(chain, address), this.labels.lookup(chain, [address, ...fl.map((f) => f.address)], orgId)]);
    const own = labelMap.get(address) ?? [];
    const labelIssuers = own.filter((l) => l.category === 'frozen' && (l.source === 'tether' || l.source === 'circle')).map((l) => (l.source === 'tether' ? 'Tether' : 'Circle'));
    const issuers = [...new Set([...frozenBy(chain, frozenMap), ...labelIssuers])];
    const frozen = issuers.length > 0 || own.some((l) => l.category === 'frozen');
    const labelsOf = (a: string) => labelMap.get(a) ?? [];

    let indirect: IndirectInput[] | undefined;
    if (opts.deep) {
      const total = fl.reduce((s, f) => s + f.in + f.out, 0);
      const unflagged = fl.filter((f) => !labelsOf(f.address).some((l) => (WEIGHTS[l.category] ?? 0) > 0)).slice(0, INDIRECT_FANOUT);
      indirect = await Promise.all(
        unflagged.map(async (f) => {
        const cfl = flows(f.address, await getTransfers(chain, f.address, 200, false, 'graph', opts.asset));
        const cLabels = await this.labels.lookup(chain, cfl.map((x) => x.address), orgId);
        const r = scoreRisk({ own: [], frozen: false, flows: cfl.filter((x) => x.address !== address), labelsOf: (a) => cLabels.get(a) ?? [] });
        return { address: f.address, share: total ? (f.in + f.out) / total : 0, directScore: r.direct };
        }),
      );
    }

    const r = scoreRisk({ own, frozen, frozenBy: issuers, flows: fl, labelsOf, indirect });
    return { chain, address, labels: own, frozen, frozenBy: issuers, transfersChecked: transfers.length, ...r };
  }
}

@Controller()
export class RiskController {
  constructor(private risk: RiskService) {}

  @Perm('investigate.view')
  @Get('risk/:addr')
  risk_(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Query('chain') c?: string, @Query('asset') asset?: string) {
    const { chain, addr } = parseAddr(raw, c);
    const filter = assetParam(asset);
    // 200 transfers = the page the address summary already fetched (cache hit); full-history scoring is available via /v1/screen.
    return getTransfers(chain, addr, 200, false, 'lookup', filter).then((transfers) => this.risk.assess(chain, addr, ctx.orgId, { transfers, deep: true, asset: filter }));
  }

  /** Public screening API (Phase 6.4). Header: X-API-Key. `?deep=true` adds 2-hop exposure. */
  @ApiKeyAuth()
  @Get('v1/screen/:addr')
  async screen(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string, @Query('deep') deep?: string, @Query('chain') c?: string, @Query('asset') asset?: string) {
    const { chain, addr } = parseAddr(raw, c);
    const a = await this.risk.assess(chain, addr, ctx.orgId, { deep: deep === 'true', asset: assetParam(asset) });
    return {
      address: a.address,
      chain: a.chain,
      riskScore: a.score,
      riskLevel: a.level,
      frozenByTether: a.frozenBy.includes('Tether'),
      frozenBy: a.frozenBy,
      labels: a.labels.map((l) => ({ name: l.name, category: l.category, source: l.source })),
      reasons: a.reasons,
      exposures: a.exposures.filter((e) => e.weight > 0).map((e) => ({ address: e.address, category: e.category, name: e.name, volume: e.volume, share: e.share })),
      transfersChecked: a.transfersChecked,
      checkedAt: new Date().toISOString(),
    };
  }
}
