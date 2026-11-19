import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'USDT Trace',
  description: 'USDT investigation and screening for TRC20 and ERC20',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">USDT Trace</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
