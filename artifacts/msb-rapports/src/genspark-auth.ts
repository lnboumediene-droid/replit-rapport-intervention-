// Read the signed-in Genspark visitor in the browser.
//
// Production (deployed, "Sign in with Genspark" access mode): the Genspark edge
// authenticates the visitor and serves GET /__genspark_auth/me for them — the
// app never shows its own login form.
//
// Local sandbox dev preview (no edge): the endpoint is absent, so a dev-only
// mock is returned when the dev flag is on, letting the author test the app
// before deploying. The flag is tied to `import.meta.env.DEV`, which is false in
// a production build, so production always returns the real user or null.

export type GensparkUser = {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  org_id: string | null;
  org_role: string | null;
};

const DEV_USER: GensparkUser = {
  id: 'genspark-dev-user',
  email: 'assistante@msb-bat.com',
  name: 'Sonia OLINDA',
  avatar: '',
  org_id: null,
  org_role: null,
};

export async function fetchGensparkUser(): Promise<GensparkUser | null> {
  try {
    const res = await fetch('/__genspark_auth/me', { credentials: 'include' });
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      if (data && data.authenticated) {
        return {
          id: String(data.id ?? ''),
          email: (data.email as string | null) ?? null,
          name: (data.name as string | null) ?? null,
          avatar: (data.avatar as string | null) ?? null,
          org_id: (data.org_id as string | null) ?? null,
          org_role: (data.org_role as string | null) ?? null,
        };
      }
    }
  } catch {
    // Dev preview has no /me endpoint — fall through to the dev fallback.
  }
  return import.meta.env.DEV ? { ...DEV_USER } : null;
}
