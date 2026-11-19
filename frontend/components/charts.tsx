'use client';
import { useMemo, useState } from 'react';
import { compact, num } from '@/lib/format';
import { Segmented } from './ui';

export interface Tr { timestamp: number; amount: number; from?: string; to?: string }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RING_ORDER = [0, 6, 5, 4, 3, 2, 1]; // outermost ring = Sunday, innermost = Monday
type Tz = 'UTC' | 'local';

const parts = (ts: number, tz: Tz) => { const d = new Date(ts); return tz === 'UTC' ? { day: d.getUTCDay(), hour: d.getUTCHours() } : { day: d.getDay(), hour: d.getHours() }; };

function polar(cx: number, cy: number, r: number, deg: number) { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const [x0, y0] = polar(cx, cy, r1, a0), [x1, y1] = polar(cx, cy, r1, a1), [x2, y2] = polar(cx, cy, r0, a1), [x3, y3] = polar(cx, cy, r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
}

/** "Date & time — hour of day vs day of week": 24 hour sectors x 7 weekday rings. */
export function RadialHeatmap({ transfers, title = 'Activity by hour and weekday' }: { transfers: Tr[]; title?: string }) {
  const [metric, setMetric] = useState<'count' | 'volume'>('count');
  const [tz, setTz] = useState<Tz>('UTC');
  const [hov, setHov] = useState<{ d: number; h: number } | null>(null);
  const local = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ c: 0, v: 0 })));
    for (const t of transfers) { if (!t.timestamp) continue; const p = parts(t.timestamp, tz); g[p.day][p.hour].c++; g[p.day][p.hour].v += t.amount; }
    return g;
  }, [transfers, tz]);
  const val = (c: { c: number; v: number }) => (metric === 'count' ? c.c : c.v);
  const max = Math.max(1, ...grid.flat().map(val));
  const bucket = (v: number) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor(Math.sqrt(v / max) * 5 - 1e-9)));
  const CX = 210, CY = 210, R0 = 62, R1 = 170, RW = (R1 - R0) / 7, SPAN = 336, START = 12, STEP = SPAN / 24;
  const h = hov ? grid[hov.d][hov.h] : null;
  const total = transfers.length;
  return (
    <div className="stack sm">
      <div className="row spread">
        <Segmented label="Metric" value={metric} onChange={setMetric} options={[{ id: 'count', label: 'Transfers' }, { id: 'volume', label: 'USDT volume' }]} />
        <select className="select sm" style={{ width: 'auto' }} aria-label="Time zone" value={tz} onChange={(e) => setTz(e.target.value as Tz)}>
          <option value="UTC">UTC</option><option value="local">Local ({local})</option>
        </select>
      </div>
      <svg viewBox="0 0 420 420" role="img" aria-label={`${title}: radial heatmap of ${total} transfers by hour of day and weekday`} style={{ width: '100%', maxWidth: 440, margin: '0 auto', display: 'block' }}>
        {RING_ORDER.map((day, ri) => {
          const r1 = R1 - ri * RW, r0 = r1 - RW + 1;
          const [lx, ly] = [CX, CY - (r0 + r1) / 2 + 3];
          return (
            <g key={day}>
              {Array.from({ length: 24 }, (_, hr) => {
                const c = grid[day][hr];
                const a0 = START + hr * STEP + .4, a1 = START + (hr + 1) * STEP - .4;
                const on = hov?.d === day && hov?.h === hr;
                return (
                  <path key={hr} d={sector(CX, CY, r0, r1, a0, a1)} style={{ fill: `var(--heat${bucket(val(c))})` }} stroke={on ? 'var(--text)' : 'none'} strokeWidth={1.5} tabIndex={c.c ? 0 : undefined}
                    onMouseEnter={() => setHov({ d: day, h: hr })} onMouseLeave={() => setHov(null)} onFocus={() => setHov({ d: day, h: hr })} onBlur={() => setHov(null)}>
                    <title>{`${DAYS[day]} ${String(hr).padStart(2, '0')}:00 ${tz === 'UTC' ? 'UTC' : local} — ${c.c} transfers, ${num(c.v)} USDT`}</title>
                  </path>
                );
              })}
              <text x={lx} y={ly} textAnchor="middle" fontSize="8.5" style={{ fill: 'var(--muted)' }}>{DAYS[day]}</text>
            </g>
          );
        })}
        {Array.from({ length: 24 }, (_, hr) => {
          const [x, y] = polar(CX, CY, R1 + 14, START + (hr + .5) * STEP);
          return <text key={hr} x={x} y={y + 3} textAnchor="middle" fontSize="9.5" style={{ fill: 'var(--muted)' }}>{hr}</text>;
        })}
        <text x={CX} y={CY - 4} textAnchor="middle" fontSize="11" style={{ fill: 'var(--muted)' }}>Hour</text>
        <text x={CX} y={CY + 10} textAnchor="middle" fontSize="11" style={{ fill: 'var(--faint)' }}>of day</text>
      </svg>
      <div className="small muted" style={{ minHeight: 20, textAlign: 'center' }} aria-live="polite">
        {hov && h ? <><b style={{ color: 'var(--text)' }}>{DAYS[hov.d]} {String(hov.h).padStart(2, '0')}:00</b> · {h.c} transfers · {num(h.v)} USDT</> : 'Hover a cell for details. Hour 0 starts at the top, clockwise; weekdays run Sun (outer) to Mon (inner).'}
      </div>
      <div className="row" style={{ justifyContent: 'center', gap: 6 }} aria-label="Colour scale">
        <span className="xs muted">0</span>
        {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ width: 22, height: 10, borderRadius: 2, background: `var(--heat${i})`, display: 'inline-block' }} />)}
        <span className="xs muted">{metric === 'count' ? max : compact(max)}</span>
      </div>
    </div>
  );
}

/** Daily inflow vs outflow bars for one address. */
export function DailyBars({ transfers, address }: { transfers: Tr[]; address: string }) {
  const days = useMemo(() => {
    const m = new Map<string, { i: number; o: number }>();
    for (const t of transfers) {
      if (!t.timestamp) continue;
      const k = new Date(t.timestamp).toISOString().slice(0, 10);
      const e = m.get(k) ?? { i: 0, o: 0 };
      if (t.to === address) e.i += t.amount; else if (t.from === address) e.o += t.amount;
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-40);
  }, [transfers, address]);
  if (!days.length) return <p className="muted small">No dated transfers to chart.</p>;
  const W = 640, H = 200, L = 46, B = 24, T = 8, max = Math.max(1, ...days.flatMap(([, d]) => [d.i, d.o]));
  const bw = (W - L) / days.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <div className="stack sm">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily USDT inflow and outflow, last ${days.length} active days`} style={{ width: '100%' }}>
        {[0, .5, 1].map((f) => (
          <g key={f}><line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" /><text x={L - 6} y={y(max * f) + 3} textAnchor="end" fontSize="9.5" style={{ fill: 'var(--muted)' }}>{compact(max * f)}</text></g>
        ))}
        {days.map(([d, v], i) => (
          <g key={d}>
            <rect x={L + i * bw + bw * .1} width={bw * .4} y={y(v.i)} height={H - B - y(v.i)} rx={1.5} style={{ fill: 'var(--low)' }}><title>{`${d}: in ${num(v.i)} USDT`}</title></rect>
            <rect x={L + i * bw + bw * .5} width={bw * .4} y={y(v.o)} height={H - B - y(v.o)} rx={1.5} style={{ fill: 'var(--high)' }}><title>{`${d}: out ${num(v.o)} USDT`}</title></rect>
            {(i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) && <text x={L + i * bw + bw / 2} y={H - 8} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'} fontSize="9.5" style={{ fill: 'var(--muted)' }}>{d}</text>}
          </g>
        ))}
      </svg>
      <div className="legend"><span><i className="dot" style={{ background: 'var(--low)' }} />Inflow</span><span><i className="dot" style={{ background: 'var(--high)' }} />Outflow</span><span>USDT per day (last {days.length} active days)</span></div>
    </div>
  );
}
