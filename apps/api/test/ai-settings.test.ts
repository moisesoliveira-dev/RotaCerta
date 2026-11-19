import type Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/agents/runtime';
import { closeTestDbs, createTestApp, loginAs } from './helpers';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
const llm: LlmClient = {
  beta: { messages: { async create(params) {
    requests.push(params);
    return { id: 'm', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null, usage, content: [{ type: 'text', text: 'ok' }] } as unknown as Anthropic.Beta.BetaMessage;
  } } },
};

describe('configuração da IA', () => {
  let app: FastifyInstance;
  beforeAll(async () => { ({ app } = await createTestApp({ llm })); });
  afterAll(closeTestDbs);
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method, url, headers, payload: payload as object });
  const body = { enabled: true, defaultModel: 'claude-sonnet-5-5', defaultEffort: 'low', dailyLimit: null, companyContext: 'Loja Bom Preço, tom simpático.' };

  it('só a gestão lê e grava; sem linha ainda valem os padrões', async () => {
    expect((await call('GET', '/api/ai/settings', await loginAs(app, 'atendente'))).statusCode).toBe(403);
    expect((await call('PUT', '/api/ai/settings', await loginAs(app, 'atendente'), body)).statusCode).toBe(403);
    const res = (await call('GET', '/api/ai/settings', await loginAs(app, 'gestao'))).json();
    expect(res.settings.enabled).toBe(true);
    expect(res.settings.defaultModel).toBe('claude-opus-5-5');
    expect(res.status.keyConfigured).toBe(true);
  });

  it('valida: modelo desconhecido e limite acima do teto do servidor são recusados', async () => {
    const gestao = await loginAs(app, 'gestao');
    expect((await call('PUT', '/api/ai/settings', gestao, { ...body, defaultModel: 'gpt-4' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/ai/settings', gestao, { ...body, dailyLimit: 99_999 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/ai/settings', gestao, { ...body, dailyLimit: 0 })).statusCode).toBe(400);
  });

  it('grava, devolve e o catálogo passa a oferecer os padrões novos', async () => {
    const gestao = await loginAs(app, 'gestao');
    expect((await call('PUT', '/api/ai/settings', gestao, body)).statusCode).toBe(200);
    const res = (await call('GET', '/api/ai/settings', gestao)).json();
    expect(res.settings.defaultModel).toBe('claude-sonnet-5-5');
    expect(res.settings.companyContext).toContain('Bom Preço');
    const catalog = (await call('GET', '/api/agents/catalog', gestao)).json();
    expect(catalog.defaults).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('o contexto da empresa vai nas instruções de todos os agentes', async () => {
    const gestao = await loginAs(app, 'gestao');
    const created = (await call('POST', '/api/agents', gestao, { name: 'Teste', instructions: 'Ajude a equipe da loja.', tools: [], roles: ['gestao'] })).json();
    requests.length = 0;
    const chat = await call('POST', `/api/agents/${created.id}/chat`, gestao, { messages: [{ role: 'user', text: 'oi' }] });
    expect(chat.statusCode).toBe(200);
    expect(JSON.stringify(requests[0].system)).toContain('Loja Bom Preço');
  });

  it('desligada, a IA não conversa; o teste de conexão responde', async () => {
    const gestao = await loginAs(app, 'gestao');
    const test = await call('POST', '/api/ai/test', gestao);
    expect(test.statusCode).toBe(200);
    expect(test.json().ok).toBe(true);
    await call('PUT', '/api/ai/settings', gestao, { ...body, enabled: false });
    const [a] = (await call('GET', '/api/agents', gestao)).json();
    const chat = await call('POST', `/api/agents/${a.id}/chat`, gestao, { messages: [{ role: 'user', text: 'oi' }] });
    expect(chat.statusCode).toBe(503);
    expect(chat.json().error).toContain('desativada');
  });

  it('o limite da empresa reduz o teto diário', async () => {
    const gestao = await loginAs(app, 'gestao');
    await call('PUT', '/api/ai/settings', gestao, { ...body, dailyLimit: 1 });
    const [a] = (await call('GET', '/api/agents', gestao)).json();
    const ask = () => call('POST', `/api/agents/${a.id}/chat`, gestao, { messages: [{ role: 'user', text: 'oi' }] });
    const first = await ask();
    const second = await ask();
    // a primeira pode ter sido a que já estourava (conversas de testes anteriores contam no dia); a segunda com certeza bloqueia
    expect([200, 429]).toContain(first.statusCode);
    expect(second.statusCode).toBe(429);
  });
});
