'use client';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, cx } from './ui';

export interface Col<R> {
  key: string;
  header: React.ReactNode;
  cell: (r: R) => React.ReactNode;
  /** value used for sorting; omit to make the column unsortable */
  sort?: (r: R) => number | string | null | undefined;
  num?: boolean;
  wrap?: boolean;
  className?: string;
}

interface Props<R> {
  cols: Col<R>[];
  rows: R[];
  rowKey: (r: R) => string | number;
  pageSize?: number;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  caption: string;
  selectable?: { selected: Set<string | number>; onChange: (s: Set<string | number>) => void };
  onRowClick?: (r: R) => void;
  /** server-side paging: when set, the table does not slice rows itself */
  server?: { page: number; total: number; pageSize: number; onPage: (p: number) => void };
  empty?: React.ReactNode;
}

export function Table<R>({ cols, rows, rowKey, pageSize = 25, initialSort, caption, selectable, onRowClick, server, empty }: Props<R>) {
  const [sort, setSort] = useState(initialSort);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    const c = cols.find((x) => x.key === sort?.key);
    if (!c?.sort) return rows;
    const f = c.sort;
    const d = sort!.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = f(a), y = f(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * d;
    });
  }, [rows, cols, sort]);
  const ps = server?.pageSize ?? pageSize;
  const cur = server ? server.page : Math.min(page, Math.max(0, Math.ceil(sorted.length / ps) - 1));
  const total = server ? server.total : sorted.length;
  const view = server ? sorted : sorted.slice(cur * ps, cur * ps + ps);
  const pages = Math.max(1, Math.ceil(total / ps));
  const go = (p: number) => (server ? server.onPage(p) : setPage(p));
  const allSel = selectable && view.length > 0 && view.every((r) => selectable.selected.has(rowKey(r)));

  if (!rows.length && empty) return <>{empty}</>;
  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 36 }}>
                  <input type="checkbox" aria-label="Select all rows" checked={!!allSel} onChange={(e) => {
                    const s = new Set(selectable.selected);
                    view.forEach((r) => (e.target.checked ? s.add(rowKey(r)) : s.delete(rowKey(r))));
                    selectable.onChange(s);
                  }} />
                </th>
              )}
              {cols.map((c) => (
                <th key={c.key} className={cx(c.num && 'num')} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sort ? (
                    <button type="button" onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.num ? 'desc' : 'asc' })}>
                      {c.header}{sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
              const k = rowKey(r);
              return (
                <tr key={k} className={cx(selectable?.selected.has(k) && 'sel')} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>
                  {selectable && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Select row" checked={selectable.selected.has(k)} onChange={(e) => {
                        const s = new Set(selectable.selected);
                        if (e.target.checked) s.add(k); else s.delete(k);
                        selectable.onChange(s);
                      }} />
                    </td>
                  )}
                  {cols.map((c) => <td key={c.key} className={cx(c.num && 'num', c.wrap && 'wrap', c.className)}>{c.cell(r)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > ps && (
        <div className="pager">
          <span>{cur * ps + 1}–{Math.min(total, cur * ps + view.length)} of {total.toLocaleString()}</span>
          <span className="end row nw">
            <Button sm icon aria-label="Previous page" disabled={cur === 0} onClick={() => go(cur - 1)}><ChevronLeft size={14} /></Button>
            <span>Page {cur + 1} / {pages}</span>
            <Button sm icon aria-label="Next page" disabled={cur >= pages - 1} onClick={() => go(cur + 1)}><ChevronRight size={14} /></Button>
          </span>
        </div>
      )}
    </>
  );
}
