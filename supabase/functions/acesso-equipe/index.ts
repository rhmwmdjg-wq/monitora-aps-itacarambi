// Monitora APS · Itacarambi — gestão de acessos pela Coordenação.
// Só quem está em usuarios_autorizados com papel 'admin' consegue usar.
// Ações:
//   definir_senha { email, senha, papel?, equipe? } -> cria a conta (já confirmada) ou troca a senha
//   remover       { email }                         -> tira da lista e apaga a conta de login
//   situacao      {}                                -> último acesso de cada e-mail
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function chaveServico(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const m = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return m.default || Object.values(m)[0] as string || "";
  } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const adm = createClient(url, chaveServico(), { auth: { persistSession: false, autoRefreshToken: false } });

  // Quem está chamando?
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ erro: "Faça login novamente." }, 401);
  const { data: quem, error: eu } = await adm.auth.getUser(token);
  if (eu || !quem?.user?.email) return json({ erro: "Sessão inválida. Faça login novamente." }, 401);
  const meuEmail = quem.user.email.toLowerCase();
  const { data: perfil } = await adm.from("usuarios_autorizados").select("papel").ilike("email", meuEmail).limit(1);
  if (!perfil?.length || perfil[0].papel !== "admin") return json({ erro: "Somente a Coordenação pode fazer isso." }, 403);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* vazio */ }
  const acao = String(b.acao || "");

  // Todos os usuários de login (são poucos; percorre as páginas)
  async function todos() {
    const out: { id: string; email: string; last_sign_in_at: string | null }[] = [];
    for (let page = 1; page < 50; page++) {
      const { data, error } = await adm.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      for (const u of data.users) out.push({ id: u.id, email: (u.email || "").toLowerCase(), last_sign_in_at: u.last_sign_in_at || null });
      if (data.users.length < 200) break;
    }
    return out;
  }

  try {
    if (acao === "situacao") {
      const us = await todos();
      return json({ usuarios: Object.fromEntries(us.map((u) => [u.email, u.last_sign_in_at])) });
    }

    const email = String(b.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erro: "E-mail inválido." }, 400);

    if (acao === "definir_senha") {
      const senha = String(b.senha || "");
      if (senha.length < 6) return json({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
      if (b.papel) {
        const papel = b.papel === "admin" ? "admin" : "equipe";
        const equipe = papel === "admin" ? null : String(b.equipe || "");
        if (papel === "equipe" && !equipe) return json({ erro: "Escolha a equipe." }, 400);
        const { error } = await adm.from("usuarios_autorizados").upsert({ email, papel, equipe });
        if (error) return json({ erro: error.message }, 400);
      } else {
        const { data: ok } = await adm.from("usuarios_autorizados").select("email").ilike("email", email).limit(1);
        if (!ok?.length) return json({ erro: "Este e-mail não tem acesso liberado." }, 400);
      }
      const ex = (await todos()).find((u) => u.email === email);
      if (ex) {
        const { error } = await adm.auth.admin.updateUserById(ex.id, { password: senha, email_confirm: true });
        if (error) return json({ erro: error.message }, 400);
        return json({ ok: true, criado: false });
      }
      const { error } = await adm.auth.admin.createUser({ email, password: senha, email_confirm: true });
      if (error) return json({ erro: error.message }, 400);
      return json({ ok: true, criado: true });
    }

    if (acao === "remover") {
      if (email === meuEmail) return json({ erro: "Você não pode remover o seu próprio acesso." }, 400);
      const { error } = await adm.from("usuarios_autorizados").delete().ilike("email", email);
      if (error) return json({ erro: error.message }, 400);
      const ex = (await todos()).find((u) => u.email === email);
      if (ex) await adm.auth.admin.deleteUser(ex.id);
      return json({ ok: true });
    }

    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message || String(e) }, 500);
  }
});
