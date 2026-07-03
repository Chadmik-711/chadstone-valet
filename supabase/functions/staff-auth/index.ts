import { createClient } from 'jsr:@supabase/supabase-js@2';

// IMPORTANT: keep this in sync with CENTRE.salt in index_v2.html.
const SALT = 'chadstone-salt-2026';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text + '|' + SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const verify = async (username: string, password: string) => {
      if (!username || !password) return null;
      const { data } = await supa.from('staff').select('*').eq('username', username).eq('is_active', true).single();
      if (!data) return null;
      const hash = await sha256(password);
      if (data.password_hash !== hash) return null;
      return data;
    };

    // Mint a Supabase session for the shared dashboard account so the browser
    // can run as the `authenticated` role (which sees customer PII). The
    // credential lives only in app_config (service-role only). Best-effort:
    // if anything fails we return no session and the app falls back to anon.
    const mintSession = async () => {
      try {
        const { data: cfg } = await supa.from('app_config').select('value').eq('key', 'shared_login').maybeSingle();
        const cred = cfg?.value as { email?: string; password?: string } | null;
        if (!cred?.email || !cred?.password) return null;
        let r = await supa.auth.signInWithPassword({ email: cred.email, password: cred.password });
        if (r.error) {
          await supa.auth.admin.createUser({ email: cred.email, password: cred.password, email_confirm: true }).catch(() => {});
          r = await supa.auth.signInWithPassword({ email: cred.email, password: cred.password });
        }
        if (!r.error && r.data?.session) {
          return { access_token: r.data.session.access_token, refresh_token: r.data.session.refresh_token };
        }
      } catch (_) { /* ignore */ }
      return null;
    };

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'list') {
      const { data } = await supa.from('staff').select('username, display_name, role, is_active').eq('is_active', true).order('display_name');
      return json({ staff: data || [] });
    }

    if (action === 'login') {
      const u = await verify(body.username, body.password);
      if (!u) return json({ user: null });
      await supa.from('staff').update({ last_login: new Date().toISOString() }).eq('username', u.username);
      const session = await mintSession();
      return json({ user: { username: u.username, displayName: u.display_name, role: u.role }, session });
    }

    // Admin-only actions require the requesting admin to re-authenticate.
    if (action === 'create' || action === 'update' || action === 'deactivate') {
      const admin = await verify(body.adminUser, body.adminPass);
      if (!admin || admin.role !== 'admin') return json({ error: 'Not authorised' }, 403);
      const p = body.payload || {};
      if (action === 'create') {
        if (!p.username || !p.password) return json({ error: 'username and password required' }, 400);
        const password_hash = await sha256(p.password);
        const { error } = await supa.from('staff').insert({
          username: p.username, display_name: p.displayName || p.username,
          password_hash, role: p.role || 'staff', is_active: true,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      if (action === 'update') {
        const upd: Record<string, unknown> = {};
        if (p.displayName) upd.display_name = p.displayName;
        if (p.role) upd.role = p.role;
        if (typeof p.is_active === 'boolean') upd.is_active = p.is_active;
        if (p.password) upd.password_hash = await sha256(p.password);
        const { error } = await supa.from('staff').update(upd).eq('username', p.username);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      if (action === 'deactivate') {
        const { error } = await supa.from('staff').update({ is_active: false }).eq('username', p.username);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
