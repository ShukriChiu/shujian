/**
 * shujian-backend client for `apps/future`.
 *
 * Same multi-tenant control plane as `apps/dashboard` — opaque bearer
 * token in localStorage, 401 = wipe + redirect to login. The two apps
 * share a single backend; auth state is per-app (different localStorage
 * keys) so logging out of `future` doesn't kill a dashboard session.
 *
 * `BACKEND_BASE` resolves at runtime:
 *   - VITE_BACKEND_URL env  → use as-is (set this for prod overrides)
 *   - dev mode              → `/backend` (proxied by Vite to :8080)
 *   - prod fallback         → Railway deployment
 *
 * Eventually this client should move to `packages/shared-client/` so we
 * stop duplicating it across `apps/dashboard` and `apps/future`.
 */

import type { FutureWarRoomData } from "@shujian/shared-types";

const TOKEN_KEY = "shujian.future.token.v1";
const TENANT_KEY = "shujian.future.tenant.v1";

const PROD_BACKEND_URL = "https://backend-production-fb29.up.railway.app";

export const BACKEND_BASE: string = (() => {
  const envUrl = (import.meta.env.VITE_BACKEND_URL ?? "").replace(/\/$/, "");
  if (envUrl) return envUrl;
  if (import.meta.env.DEV) return "/backend";
  return PROD_BACKEND_URL;
})();

export interface UserPublic {
  id: string;
  identifier: string;
  display_name: string | null;
  is_superuser: boolean;
}

export interface TenantPublic {
  id: string;
  slug: string;
  name: string;
  display_name: string | null;
  status: string;
  role?: string;
}

interface BackendTenant {
  id: string;
  slug: string;
  name: string;
  display_name: string | null;
  status: string;
}

interface BackendMembership {
  tenant: BackendTenant;
  role: string;
}

interface BackendMeResponse {
  user: UserPublic;
  current_tenant: BackendTenant | null;
  memberships: BackendMembership[];
}

interface BackendLoginResponse extends BackendMeResponse {
  token: string;
  expires_at: string;
}

export interface MeResponse {
  user: UserPublic;
  current_tenant: TenantPublic | null;
  tenants: TenantPublic[];
}

export interface LoginResponse extends MeResponse {
  token: string;
  expires_at: string;
}

function flattenMe<T extends BackendMeResponse>(r: T): T & MeResponse {
  const tenants = (r.memberships ?? []).map(
    (m): TenantPublic => ({ ...m.tenant, role: m.role }),
  );
  const current = r.current_tenant
    ? ({
        ...r.current_tenant,
        role: tenants.find((t) => t.id === r.current_tenant!.id)?.role,
      } as TenantPublic)
    : null;
  return { ...r, tenants, current_tenant: current };
}

export class BackendError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

export function getActiveTenantId(): string | null {
  try {
    return window.localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenantId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(TENANT_KEY, id);
    else window.localStorage.removeItem(TENANT_KEY);
  } catch {
    /* private mode */
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BACKEND_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    setToken(null);
    setActiveTenantId(null);
    onUnauthorized?.();
    throw new BackendError(401, "unauthorized");
  }

  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/html") || text.startsWith("<!")) {
    throw new BackendError(502, `backend unreachable at ${BACKEND_BASE}${path}`);
  }
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!res.ok) {
    const bodyObj = body as Record<string, unknown> | undefined;
    const msg =
      bodyObj && "message" in bodyObj
        ? String(bodyObj.message)
        : bodyObj && "error" in bodyObj
          ? String(bodyObj.error)
          : typeof body === "string"
            ? body
            : `HTTP ${res.status}`;
    throw new BackendError(res.status, msg);
  }
  return body as T;
}

export const backend = {
  health: () => call<{ ok: true }>("/healthz"),

  login: async (
    identifier: string,
    password: string,
  ): Promise<LoginResponse> => {
    const raw = await call<BackendLoginResponse>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    });
    const r = flattenMe(raw);
    setToken(r.token);
    if (r.current_tenant) setActiveTenantId(r.current_tenant.id);
    else if (r.tenants[0]) setActiveTenantId(r.tenants[0].id);
    return r;
  },

  logout: async () => {
    try {
      await call<{ ok: true }>("/v1/auth/logout", { method: "POST" });
    } finally {
      setToken(null);
      setActiveTenantId(null);
    }
  },

  me: async (): Promise<MeResponse> => {
    const raw = await call<BackendMeResponse>("/v1/auth/me");
    return flattenMe(raw);
  },

  switchTenant: async (tenantId: string): Promise<MeResponse> => {
    const raw = await call<BackendMeResponse>("/v1/auth/switch-tenant", {
      method: "POST",
      body: JSON.stringify({ tenant_id: tenantId }),
    });
    const r = flattenMe(raw);
    if (r.current_tenant) setActiveTenantId(r.current_tenant.id);
    return r;
  },

  // future-specific endpoints --------------------------------------------

  getFutureState: () => call<FutureWarRoomData>("/v1/future/state"),

  putFutureState: (data: FutureWarRoomData) =>
    call<FutureWarRoomData>("/v1/future/state", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
};
