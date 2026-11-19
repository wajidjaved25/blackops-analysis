'use client';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { EmptyState, LinkButton, SkeletonRows } from './ui';

export function Forbidden() {
  return (
    <div className="page">
      <EmptyState icon={<ShieldOff size={22} />} title="You don't have permission for this" action={<LinkButton href="/" variant="primary">Back to dashboard</LinkButton>}>
        Your role does not include access to this page. Ask an organisation admin if you need it.
      </EmptyState>
    </div>
  );
}

/** Renders children only if the user holds the permission (any of, if several); otherwise a friendly 403 page. */
export function RequirePerm({ perm, children }: { perm: string | string[]; children: React.ReactNode }) {
  const { can, loading } = useAuth();
  if (loading) return <div className="page"><SkeletonRows /></div>;
  const ok = (Array.isArray(perm) ? perm : [perm]).some(can);
  return ok ? <>{children}</> : <Forbidden />;
}
