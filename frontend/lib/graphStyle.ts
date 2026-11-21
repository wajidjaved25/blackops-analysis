import type cytoscape from 'cytoscape';
import { catColor } from './format';

const ICONS: Record<string, string> = {
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  bank: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  skull: '<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>',
  alert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  bridge: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  dice: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="8.5" cy="8.5" r=".6"/><circle cx="15.5" cy="8.5" r=".6"/><circle cx="8.5" cy="15.5" r=".6"/><circle cx="15.5" cy="15.5" r=".6"/><circle cx="12" cy="12" r=".6"/>',
};
const iconUri = (k: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`)}`;
export const ICON_URI = Object.fromEntries(Object.keys(ICONS).map((k) => [k, iconUri(k)]));

export function iconFor(category?: string | null): string {
  switch (category) {
    case 'sanctioned': case 'frozen': case 'terrorism': case 'terror': case 'ransomware': case 'darknet': return 'skull';
    case 'scam': case 'fraud': return 'alert';
    case 'mixer': return 'shuffle';
    case 'gambling': return 'dice';
    case 'exchange': case 'exchange_deposit': case 'service': return 'bank';
    case 'bridge': case 'dex': return 'bridge';
    default: return 'wallet';
  }
}
export const nodeColor = catColor;
export const FLOW_IN = '#22c55e';
export const FLOW_OUT = '#f97316';
export const START_RING = '#facc15';
export const TARGET_RING = '#22c55e';

export interface Theme { dark: boolean; bg: string; label: string; edge: string; halo: string; text: string }
export function readTheme(): Theme {
  const dark = document.documentElement.dataset.theme !== 'light';
  const s = getComputedStyle(document.documentElement);
  const g = (v: string, f: string) => s.getPropertyValue(v).trim() || f;
  return { dark, bg: g('--graph-bg', dark ? '#0c1018' : '#fbfcfe'), label: g('--graph-label', '#b4bccb'), edge: g('--graph-edge', '#5b667c'), halo: g('--graph-halo', '#0c1018'), text: g('--text', '#fff') };
}

/** Cytoscape paints on canvas and cannot read CSS variables, so the stylesheet is rebuilt per theme. */
export function buildStyle(t: Theme): cytoscape.StylesheetJson {
  return [
    { selector: 'node', style: {
      label: 'data(label)', 'font-size': 9, 'font-family': 'Inter, system-ui, sans-serif', color: t.label, 'text-wrap': 'wrap', 'text-max-width': '110px', 'text-valign': 'bottom', 'text-margin-y': 5, 'line-height': 1.25,
      'text-outline-color': t.halo, 'text-outline-width': 2.5, 'min-zoomed-font-size': 6,
      'background-color': 'data(color)', 'background-image': 'data(icon)', 'background-fit': 'none', 'background-width': '56%', 'background-height': '56%', 'background-clip': 'none',
      width: 'data(size)', height: 'data(size)', 'border-width': 3, 'border-color': t.dark ? '#ffffff33' : '#00000022', 'border-opacity': 1,
    } },
    { selector: 'node[?root]', style: { 'border-width': 6, 'border-color': START_RING, 'font-weight': 'bold' } },
    { selector: 'node[?target]', style: { 'border-width': 6, 'border-color': TARGET_RING } },
    { selector: 'node[!expanded]', style: { 'border-style': 'dashed' } },
    { selector: 'node:selected', style: { 'overlay-color': '#7c8cff', 'overlay-opacity': .25, 'overlay-padding': 7, 'overlay-shape': 'ellipse' } },
    { selector: 'edge', style: {
      width: 'data(w)', 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', 'target-arrow-shape': 'triangle', 'arrow-scale': .9, 'curve-style': 'bezier', 'control-point-step-size': 16, opacity: .9,
      label: 'data(label)', 'font-size': 7.5, color: t.label, 'text-rotation': 'autorotate', 'text-background-color': t.halo, 'text-background-opacity': .85, 'text-background-padding': '1.5px', 'text-wrap': 'wrap', 'min-zoomed-font-size': 7,
    } },
    { selector: 'edge[?xchain]', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 5], opacity: 1 } },
    { selector: 'node[?swap]', style: { 'border-width': 6, 'border-color': '#f59e0b', 'border-style': 'double' } },
    { selector: 'edge:selected', style: { 'overlay-color': '#7c8cff', 'overlay-opacity': .3, 'overlay-padding': 4 } },
    { selector: '.path', style: { 'line-color': '#facc15', 'target-arrow-color': '#facc15', 'z-index': 10 } },
    { selector: 'node.path', style: { 'border-color': '#facc15', 'border-width': 5 } },
    { selector: '.dim', style: { opacity: .12, 'text-opacity': .15 } },
  ];
}
