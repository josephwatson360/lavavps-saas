import { useEffect, useState, useCallback } from 'react';
import { getCurrentUser, fetchAuthSession, signOut } from 'aws-amplify/auth';
import { useStore } from '@/store/useStore';
import type { TenantContext } from '@/api/types';

// ─────────────────────────────────────────────────────────────────────────────
// useAuth — Amplify Cognito auth hook with tenant context extraction
// ─────────────────────────────────────────────────────────────────────────────

export function useAuth() {
  const [loading, setLoading]         = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const { tenant, setTenant }         = useStore();

  const loadUser = useCallback(async () => {
    try {
      await getCurrentUser();
      const session = await fetchAuthSession();
      const claims  = session.tokens?.idToken?.payload;

      if (claims) {
        const ctx: TenantContext = {
          tenantId: (claims['custom:tenant_id'] as string) ?? '',
          planCode: (claims['custom:plan_code'] as string ?? 'starter') as TenantContext['planCode'],
          role:     (claims['custom:role'] as string ?? 'owner') as TenantContext['role'],
          sub:      (claims['sub'] as string) ?? '',
          email:    (claims['email'] as string) ?? '',
        };
        setTenant(ctx);
        setAuthenticated(true);
      }
    } catch {
      setTenant(null);
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, [setTenant]);

  useEffect(() => { loadUser(); }, [loadUser]);

  const logout = useCallback(async () => {
    await signOut();
    setTenant(null);
    setAuthenticated(false);
    window.location.href = '/login';
  }, [setTenant]);

  return { loading, authenticated, tenant, logout, reload: loadUser };
}
