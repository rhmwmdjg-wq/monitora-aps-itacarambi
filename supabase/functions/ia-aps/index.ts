// Monitora APS · Itacarambi — Assistente IA
// Intermediário seguro entre o site (GitHub Pages) e a API do Claude (Anthropic).
// - A chave da API fica guardada aqui (segredo ANTHROPIC_API_KEY), nunca no site.
// - Só atende quem está logado E está na tabela usuarios_autorizados.
// - O site envia apenas números agregados (sem nomes, CPF ou CNS).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODELO = Deno.env.get("MODELO") || "claude-sonnet-5-5";
const MAX_ENTRADA = 120_000; // caracteres de contexto aceitos por pedido
const ORIGENS = ["https://rhmwmdjg-wq.github.io", "http://localhost", "http://127.0.0.1"];

function cors(origin: string | null) {
  const ok = origin && ORIGENS.some((o) => origin.startsWith(o));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ORIGENS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const BASE = `Você é o assistente de gestão da Coordenação de Atenção Primária à Saúde de Itacarambi (MG).
Responde sempre em português do Brasil, com linguagem clara, objetiva e própria de documentos de gestão do SUS.
Contexto: indicadores C1 a C7 do componente de qualidade da APS (Saúde Brasil 360 / Notas Metodológicas do Ministério da Saúde),
listas nominais do SIAPS cruzadas com o cadastro municipal.
Regras:
- Use SOMENTE os números fornecidos no contexto. Nunca invente valores, metas, nomes ou datas. Se faltar dado, diga que falta.
- Os dados são agregados por equipe/indicador; você não recebe nomes de pacientes e não deve pedir.
- "Pontos de impacto" = quanto o indicador da equipe pode subir se as pendências forem resolvidas.
- Classificação: C1 Ótimo >50 e ≤70, Bom >30 e ≤50, Suficiente >10 e ≤30, Regular ≤10 ou >70; demais: Ótimo >75, Bom >50 e ≤75, Suficiente >25 e ≤50, Regular ≤25.
- Formate com Markdown simples (títulos com ##, listas com -, **negrito**). Sem tabelas largas.`;

const TAREFAS: Record<string, string> = {
  resumo: `Escreva uma ANÁLISE DA COMPETÊNCIA para relatório, ofício ou reunião com a Secretaria Municipal de Saúde.
Estrutura: ## Panorama geral (1 parágrafo) · ## Destaques positivos · ## Pontos críticos (com equipes e números) · ## Qualidade do cadastro · ## Recomendações prioritárias (3 a 5, objetivas).
Compare com a competência anterior quando houver dados. Tom institucional, máximo ~450 palavras.`,
  plano: `Escreva um PLANO DE AÇÃO para a equipe indicada, para ser entregue à enfermeira/gerente da equipe.
Estrutura: ## Situação da equipe (resumo curto) · ## Prioridades (ordenadas por pontos de impacto) — para cada uma: o que fazer, quem faz (ACS, enfermagem, médico, recepção, vacina), e o que registrar no e-SUS para o item contar · ## Metas para a próxima competência (realistas, em número de pessoas) · ## Acompanhamento.
Seja prático e específico para os itens pendentes informados. Máximo ~500 palavras.`,
  acs: `Escreva uma MENSAGEM DE WHATSAPP para o(a) Agente Comunitário(a) de Saúde, em tom de orientação, respeitoso e motivador.
A mensagem deve: cumprimentar, explicar em 1-2 frases por que essa busca ativa importa, resumir o que mais falta (use os totais por pendência), dar orientações práticas do que fazer em cada visita e do que registrar.
OBRIGATÓRIO: inclua exatamente a linha {{LISTA}} sozinha no ponto onde deve entrar a lista de pessoas (o sistema substitui depois — você não conhece os nomes).
Use *negrito* do WhatsApp (asteriscos simples), sem títulos Markdown, emojis com moderação. Máximo ~220 palavras fora a lista.`,
  dados: `Responda a pergunta do usuário sobre os dados de monitoramento usando a tabela de contexto.
Mostre o raciocínio numérico em poucas linhas (valores, diferenças, competências comparadas). Se a pergunta não puder ser respondida com os dados, diga o que faltaria importar. Seja direto.`,
  regras: `Responda dúvidas sobre as regras dos indicadores C1 a C7 (o que conta, o que não conta, pesos, denominador, prazos, como registrar no e-SUS para o item ser computado), usando as definições fornecidas no contexto como fonte principal.
Quando algo não estiver nas definições, diga que é orientação geral e recomende conferir a Nota Metodológica vigente do Ministério da Saúde. Seja didático e curto.`,
};

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  try {
    // 1) Quem está pedindo?
    const auth = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u, error: eu } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (eu || !u?.user?.email) return json({ erro: "Sessão inválida — entre novamente." }, 401);
    const { data: aut } = await admin.from("usuarios_autorizados").select("email,papel").ilike("email", u.user.email).limit(1);
    if (!aut || !aut.length) return json({ erro: "Usuário não autorizado." }, 403);

    // 2) O que foi pedido?
    const corpo = await req.json();
    const tarefa = String(corpo.tarefa || "");
    if (!TAREFAS[tarefa]) return json({ erro: "Tarefa desconhecida." }, 400);
    const contexto = String(corpo.contexto || "");
    const historico: { papel: string; texto: string }[] = Array.isArray(corpo.historico) ? corpo.historico.slice(-10) : [];
    const pergunta = String(corpo.pergunta || "").slice(0, 4000);
    if (contexto.length + JSON.stringify(historico).length > MAX_ENTRADA) return json({ erro: "Contexto grande demais." }, 413);

    const chave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!chave) return json({ erro: "A chave da API ainda não foi configurada no Supabase (segredo ANTHROPIC_API_KEY)." }, 500);

    // Conversa: [pergunta, resposta, pergunta, resposta, ...] + pergunta atual.
    // O contexto de dados vai junto da primeira mensagem do usuário.
    const turnos = [...historico.map((m) => ({ role: m.papel === "ia" ? "assistant" : "user", content: String(m.texto || "").slice(0, 8000) })),
      { role: "user", content: pergunta || "Gere o texto pedido." }];
    while (turnos.length && turnos[0].role !== "user") turnos.shift();
    const messages: { role: string; content: string }[] = [];
    for (const t of turnos) {
      const ult = messages[messages.length - 1];
      if (ult && ult.role === t.role) ult.content += "\n\n" + t.content; else messages.push({ ...t });
    }
    messages[0].content = `DADOS DO SISTEMA (agregados):\n${contexto}\n\n${messages[0].content}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELO, max_tokens: 2000, system: BASE + "\n\nTAREFA:\n" + TAREFAS[tarefa], messages }),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error("Anthropic", r.status, JSON.stringify(d));
      return json({ erro: "A API de IA recusou o pedido: " + (d?.error?.message || r.status) }, 502);
    }
    const texto = (d.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(JSON.stringify({ quem: u.user.email, tarefa, modelo: MODELO, uso: d.usage }));
    return json({ texto, uso: d.usage });
  } catch (e) {
    console.error(e);
    return json({ erro: "Erro interno: " + (e?.message || e) }, 500);
  }
});
