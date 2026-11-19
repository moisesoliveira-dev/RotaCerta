import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { AGENT_MODELS, agentChat, agentInput, agentPatch, aiSettingsInput } from '@rotacerta/contracts';
import type { Role } from '@rotacerta/domain';
import type { Ctx } from '../app';
import { type AgentConfig, type LlmClient, runAgent } from '../agents/runtime';
import { toolByName, toolCatalog } from '../agents/tools';
import { schema } from '../db/client';
import { withTenant } from '../db/tenants';
import { readWorkspace } from '../db/unit-of-work';
import { scopeFor } from '../privacy';

const GESTAO: Role[] = ['gestao'];
const USERS: Role[] = ['gestao', 'atendente', 'expedicao'];

/**
 * Preço de referência em dólares por 1 milhão de tokens (entrada, leitura de cache, saída). A escrita de cache custa
 * 1,25x a entrada. Só para a estimativa da tela: confira os preços vigentes na Anthropic.
 */
const PRICES: Record<string, { input: number; cacheRead: number; output: number }> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, output: 0.5 },
};

type AgentRow = typeof schema.agents.$inferSelect;

const toConfig = (a: AgentRow, companyContext = ''): AgentConfig => ({
  id: a.id, name: a.name, instructions: a.instructions, model: a.model,
  effort: (['low', 'medium', 'high'].includes(a.effort) ? a.effort : 'medium') as AgentConfig['effort'],
  tools: a.tools, knowledge: a.knowledge, companyContext,
});

export function registerAgentRoutes({ app, db, guard, company, config }: Ctx, llm: LlmClient | null) {
  const parse = <T>(s: ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | undefined => {
    const p = s.safeParse(req.body ?? {});
    if (p.success) return p.data;
    reply.code(400).send({ error: p.error.issues[0]?.message ?? 'Dados inválidos.' });
    return undefined;
  };
  const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id);
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: config.APP_TZ });
  const unknownTools = (tools: string[]) => tools.filter((t) => !toolByName(t));

  /** Ajustes da IA da empresa; sem linha ainda, valem os padrões. */
  const loadSettings = async (companyId: number) => {
    const [row] = await withTenant(db, companyId, (tx) => tx.select().from(schema.aiSettings).limit(1));
    return row ?? { id: 1, enabled: true, defaultModel: 'claude-opus-5-5', defaultEffort: 'medium', dailyLimit: null as number | null, companyContext: '', updatedBy: '', updatedAt: null as Date | null };
  };
  const effectiveLimit = (s: { dailyLimit: number | null }) => Math.min(s.dailyLimit ?? config.AGENT_DAILY_LIMIT, config.AGENT_DAILY_LIMIT);

  /** Tela Configurações > Inteligência artificial: ajustes da empresa e estado da conexão (a chave nunca sai do servidor). */
  app.get('/api/ai/settings', { preHandler: guard(GESTAO) }, async (req) => {
    const s = await loadSettings(company(req));
    const [{ chats }] = await withTenant(db, company(req), (tx) => tx.select({ chats: sql<number>`coalesce(sum(${schema.agentUsage.chats}), 0)::int` }).from(schema.agentUsage).where(eq(schema.agentUsage.day, today())));
    return {
      settings: { enabled: s.enabled, defaultModel: s.defaultModel, defaultEffort: s.defaultEffort, dailyLimit: s.dailyLimit, companyContext: s.companyContext, updatedBy: s.updatedBy, updatedAt: s.updatedAt },
      status: { keyConfigured: !!llm, serverLimit: config.AGENT_DAILY_LIMIT, effectiveLimit: effectiveLimit(s), todayChats: chats },
      models: AGENT_MODELS,
    };
  });

  app.put('/api/ai/settings', { preHandler: guard(GESTAO) }, async (req, reply) => {
    const b = parse(aiSettingsInput, req, reply); if (!b) return;
    if (b.dailyLimit !== null && b.dailyLimit > config.AGENT_DAILY_LIMIT) return reply.code(400).send({ error: `O teto do servidor é de ${config.AGENT_DAILY_LIMIT} conversas por dia; o limite da empresa não pode passar disso.` });
    const values = { ...b, updatedBy: req.user.name ?? '', updatedAt: new Date() };
    await withTenant(db, company(req), (tx) => tx.insert(schema.aiSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: schema.aiSettings.id, set: values }));
    return { ok: true };
  });

  /** Teste de conexão: uma chamada mínima ao modelo escolhido. Não guarda nada e não conta como conversa. */
  app.post('/api/ai/test', { preHandler: guard(GESTAO), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!llm) return reply.code(503).send({ error: 'Falta a chave ANTHROPIC_API_KEY na API: configure a variável no servidor e reinicie.' });
    const s = await loadSettings(company(req));
    const started = Date.now();
    try {
      await llm.beta.messages.create({ model: s.defaultModel, max_tokens: 16, messages: [{ role: 'user', content: 'Responda apenas: ok' }] });
      return { ok: true, model: s.defaultModel, ms: Date.now() - started };
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'teste da IA falhou');
      return reply.code(502).send({ error: 'A IA não respondeu. Confira a chave, o modelo e a conexão do servidor com a Anthropic.' });
    }
  });

  /** O que a tela precisa para montar o formulário: catálogo de ferramentas, modelos e se a IA está configurada. */
  app.get('/api/agents/catalog', { preHandler: guard(USERS) }, async (req) => {
    const s = await loadSettings(company(req));
    return { tools: toolCatalog(), models: AGENT_MODELS, ready: !!llm && s.enabled, enabled: s.enabled, dailyLimit: effectiveLimit(s), defaults: { model: s.defaultModel, effort: s.defaultEffort } };
  });

  /** Gestão vê todos (com a configuração completa); os outros perfis, só os ativos liberados para eles. */
  app.get('/api/agents', { preHandler: guard(USERS) }, async (req) => {
    const rows = await withTenant(db, company(req), (tx) => tx.select().from(schema.agents).orderBy(schema.agents.id));
    if (req.user.role === 'gestao') return rows;
    return rows.filter((a) => a.active && a.roles.includes(req.user.role))
      .map((a) => ({ id: a.id, name: a.name, description: a.description, tools: a.tools, model: a.model }));
  });

  app.post('/api/agents', { preHandler: guard(GESTAO) }, async (req, reply) => {
    const b = parse(agentInput, req, reply); if (!b) return;
    const bad = unknownTools(b.tools);
    if (bad.length) return reply.code(400).send({ error: `Ferramenta desconhecida: ${bad.join(', ')}.` });
    const [row] = await withTenant(db, company(req), (tx) => tx.insert(schema.agents).values({ ...b, createdBy: req.user.name ?? '' }).returning());
    return row;
  });

  app.patch('/api/agents/:id', { preHandler: guard(GESTAO) }, async (req, reply) => {
    const b = parse(agentPatch, req, reply); if (!b) return;
    const bad = unknownTools(b.tools ?? []);
    if (bad.length) return reply.code(400).send({ error: `Ferramenta desconhecida: ${bad.join(', ')}.` });
    const [row] = await withTenant(db, company(req), (tx) => tx.update(schema.agents).set({ ...b, updatedAt: new Date() }).where(eq(schema.agents.id, idOf(req))).returning());
    if (!row) return reply.code(404).send({ error: 'Agente não encontrado.' });
    return row;
  });

  app.delete('/api/agents/:id', { preHandler: guard(GESTAO) }, async (req, reply) => {
    const [row] = await withTenant(db, company(req), (tx) => tx.delete(schema.agents).where(eq(schema.agents.id, idOf(req))).returning({ id: schema.agents.id }));
    if (!row) return reply.code(404).send({ error: 'Agente não encontrado.' });
    return { ok: true };
  });

  /**
   * Conversa. O histórico vem do aparelho (a API não guarda o texto das conversas); cada pergunta roda o loop do agente
   * com os dados que o perfil da pessoa já pode ver. Teto por minuto (por IP) e por dia (por empresa).
   */
  app.post('/api/agents/:id/chat', { preHandler: guard(USERS), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(agentChat, req, reply); if (!b) return;
    const companyId = company(req);
    const [agent] = await withTenant(db, companyId, (tx) => tx.select().from(schema.agents).where(eq(schema.agents.id, idOf(req))));
    if (!agent || (!agent.active && req.user.role !== 'gestao')) return reply.code(404).send({ error: 'Agente não encontrado.' });
    if (req.user.role !== 'gestao' && !agent.roles.includes(req.user.role)) return reply.code(403).send({ error: 'Este agente não está liberado para o seu perfil.' });
    if (!llm) return reply.code(503).send({ error: 'A IA não está configurada neste ambiente (falta a chave ANTHROPIC_API_KEY na API).' });
    const settings = await loadSettings(companyId);
    if (!settings.enabled) return reply.code(503).send({ error: 'A IA está desativada pela gestão (Configurações > Inteligência artificial).' });
    const limit = effectiveLimit(settings);

    const day = today();
    const [{ chats }] = await withTenant(db, companyId, (tx) => tx.select({ chats: sql<number>`coalesce(sum(${schema.agentUsage.chats}), 0)::int` }).from(schema.agentUsage).where(eq(schema.agentUsage.day, day)));
    if (chats >= limit) return reply.code(429).send({ error: `Limite diário de ${limit} conversas com agentes atingido. Volta amanhã ou peça à gestão para aumentar.` });

    const { data, papers } = await readWorkspace(db, companyId);
    const scoped = scopeFor({ role: req.user.role as Role, driverId: req.user.driverId }, data, papers);
    const result = await runAgent({
      client: llm, agent: toConfig(agent, settings.companyContext), history: b.messages, timezone: config.APP_TZ, log: req.log,
      ctx: { data: scoped.data, role: req.user.role as Role, driverId: req.user.driverId, now: new Date(), tenant: (fn) => withTenant(db, companyId, fn) },
    });

    const u = result.usage;
    await withTenant(db, companyId, (tx) => tx.insert(schema.agentUsage).values({
      day, agentId: agent.id, model: result.model, chats: 1, calls: u.calls, failures: u.failures,
      inputTokens: u.input, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, outputTokens: u.output,
    }).onConflictDoUpdate({
      target: [schema.agentUsage.day, schema.agentUsage.agentId, schema.agentUsage.model],
      set: {
        chats: sql`${schema.agentUsage.chats} + 1`, calls: sql`${schema.agentUsage.calls} + ${u.calls}`, failures: sql`${schema.agentUsage.failures} + ${u.failures}`,
        inputTokens: sql`${schema.agentUsage.inputTokens} + ${u.input}`, cacheReadTokens: sql`${schema.agentUsage.cacheReadTokens} + ${u.cacheRead}`,
        cacheWriteTokens: sql`${schema.agentUsage.cacheWriteTokens} + ${u.cacheWrite}`, outputTokens: sql`${schema.agentUsage.outputTokens} + ${u.output}`,
      },
    }));
    return { reply: result.reply, steps: result.steps, outcome: result.outcome };
  });

  /** Uso e custo estimado dos últimos dias, por agente. */
  app.get('/api/agents/usage', { preHandler: guard(GESTAO) }, async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 30, 1), 365);
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toLocaleDateString('sv-SE', { timeZone: config.APP_TZ });
    const rows = await withTenant(db, company(req), (tx) => tx.select().from(schema.agentUsage).where(and(gte(schema.agentUsage.day, since))));
    const byAgent = new Map<number, { agentId: number; chats: number; calls: number; failures: number; tokens: number; usd: number }>();
    for (const r of rows) {
      const p = PRICES[r.model];
      const usd = p ? (r.inputTokens * p.input + r.cacheWriteTokens * p.input * 1.25 + r.cacheReadTokens * p.cacheRead + r.outputTokens * p.output) / 1e6 : 0;
      const cur = byAgent.get(r.agentId) ?? { agentId: r.agentId, chats: 0, calls: 0, failures: 0, tokens: 0, usd: 0 };
      cur.chats += r.chats; cur.calls += r.calls; cur.failures += r.failures;
      cur.tokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens; cur.usd += usd;
      byAgent.set(r.agentId, cur);
    }
    const agents = [...byAgent.values()].map((a) => ({ ...a, usd: Math.round(a.usd * 10_000) / 10_000 }));
    return { days, agents, totalUsd: Math.round(agents.reduce((s, a) => s + a.usd, 0) * 10_000) / 10_000, today: rows.filter((r) => r.day === today()).reduce((s, r) => s + r.chats, 0) };
  });
}
