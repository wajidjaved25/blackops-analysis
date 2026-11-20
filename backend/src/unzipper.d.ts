// Minimal typings for the part of unzipper (already installed via exceljs) used by binance-por.ts.
declare module 'unzipper' {
  import { Readable } from 'node:stream';
  export interface File {
    path: string;
    type: string;
    stream(): Readable;
  }
  const unzipper: { Open: { file(path: string): Promise<{ files: File[] }> } };
  export default unzipper;
}
