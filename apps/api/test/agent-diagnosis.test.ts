import type Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/agents/runtime';
import { AGENT_TOOLS } from '../src/agents/tools';
import { closeTestDbs, createTestApp, loginAs } from './helpers';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
let toolToCall = 'problemas_da_operacao';
let toolInput: Record<string, unknown> = {};

/** Modelo falso: pede a ferramenta na primeira rodada e devolve o JSON recebido na segunda. */
const llm: LlmClient = {
  beta: { messages: { async create(params) {
    requests.push(params);
    const last = params.messages[params.messages.length - 1];
    const result = Array.isArray(last.content) ? last.content.find((b) => b.type === 'tool_result') : undefined;
    if (!result) {
      return { id: 'm1', type: 'message', role: 'assistant', model: params.model, stop_reason: 'tool_use', stop_sequence: null, usage,
        content: [{ type: 'tool_use', id: 't1', name: toolToCall, input: toolInput }] } as unknown as Anthropic.Beta.BetaMessage;
    }
    const text = 'content' in result ? String(result.content) : '';
    return { id: 'm2', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null, usage,
      content: [{ type: 'text', text }] } as unknown as Anthropic.Beta.BetaMessage;
  } } },
};

describe('agente que entende as regras e diagnostica a operação', () => {
  let app: FastifyInstance;
  let agentId = 0;
  beforeAll(async () => {
    ({ app } = await createTestApp({ llm }));
    const gestao = await loginAs(app, 'gestao');
    const res = await app.inject({ method: 'POST', url: '/api/agents', headers: gestao, payload: {
      name: 'Resolvedor', instructions: 'Ajude a equipe a resolver problemas da operação.', tools: ['problemas_da_operacao', 'diagnosticar_entrega', 'consultar_dados'], roles: ['gestao', 'atendente'],
    } });
    agentId = res.json().id;
  });
  afterAll(closeTestDbs);

  const ask = async (role: 'gestao' | 'atendente', text = 'o que está errado?') => {
    requests.length = 0;
    return app.inject({ method: 'POST', url: `/api/agents/${agentId}/chat`, headers: await loginAs(app, role), payload: { messages: [{ role: 'user', text }] } });
  };

  it('o manual do sistema (fluxo e regras) vai nas instruções de qualquer agente', async () => {
    await ask('gestao');
    const system = JSON.stringify(requests[0].system);
    expect(system).toContain('COMO O ROTACERTA FUNCIONA');
    expect(system).toContain('MÁQUINA DE ESTADOS DA ENTREGA');
    expect(system).toContain('confirmar a devolução');
    expect(system).toContain('MODELO DE DADOS');
    expect(system).toContain('entregas.romaneio_id -> romaneios.id');
    expect(system).toContain('COMO RACIOCINAR');
    expect(system).not.toContain('PROBLEMAS COMUNS');
  });

  it('as duas ferramentas de diagnóstico estão no catálogo, só de leitura', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toContain('problemas_da_operacao');
    expect(names).toContain('diagnosticar_entrega');
  });

  it('problemas_da_operacao devolve achados com a regra e o que fazer', async () => {
    toolToCall = 'problemas_da_operacao'; toolInput = {};
    const res = await ask('gestao');
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.json().reply);
    expect(out.total).toBeGreaterThan(0);
    const first = out.problemas[0];
    expect(first).toHaveProperty('regra');
    expect(first).toHaveProperty('o_que_fazer');
    expect(['alta', 'media', 'baixa']).toContain(first.gravidade);
  });

  it('diagnosticar_entrega explica o próximo passo de uma entrega que existe e trata a que não existe', async () => {
    const gestao = await loginAs(app, 'gestao');
    const orders = (await app.inject({ method: 'GET', url: '/api/dataset', headers: gestao })).json().data.orders as Array<{ id: number }>;
    toolToCall = 'diagnosticar_entrega'; toolInput = { codigo: orders[0].id };
    const ok = JSON.parse((await ask('gestao')).json().reply);
    expect(ok.encontrada).toBe(true);
    expect(typeof ok.proximo_passo).toBe('string');
    expect(Array.isArray(ok.alertas)).toBe(true);
    toolInput = { codigo: 999_999 };
    expect(JSON.parse((await ask('gestao')).json().reply).encontrada).toBe(false);
  });

  const query = (q: Partial<Record<string, unknown>>) => {
    toolToCall = 'consultar_dados';
    toolInput = { entidade: 'entregas', filtros: [], agrupar_por: '', acao: 'listar', campo_metrica: '', campos: [], ordenar_por: '', ordem: 'asc', limite: 25, ...q };
    return ask('gestao').then((r) => JSON.parse(r.json().reply));
  };

  it('consultar_dados agrupa, conta e soma sobre os dados reais', async () => {
    const porSituacao = await query({ agrupar_por: 'situacao_codigo', acao: 'contar' });
    expect(porSituacao.grupos.length).toBeGreaterThan(0);
    const total = porSituacao.grupos.reduce((n: number, g: { contar: number }) => n + g.contar, 0);
    expect(total).toBe(porSituacao.total_linhas);
    const volumes = await query({ acao: 'somar', campo_metrica: 'volumes' });
    expect(typeof volumes.somar).toBe('number');
  });

  it('consultar_dados filtra por campo, cruza entregas e romaneios pelas ligações e ordena', async () => {
    const emRota = await query({ filtros: [{ campo: 'situacao_codigo', op: '=', valor: 'onroute' }], campos: ['id', 'cliente', 'romaneio_id', 'motorista'] });
    for (const l of emRota.linhas) expect(l.romaneio_id).not.toBeNull();
    const romaneios = await query({ entidade: 'romaneios', ordenar_por: 'ocupacao_pct', ordem: 'desc', campos: ['id', 'veiculo', 'volumes', 'capacidade', 'ocupacao_pct'] });
    expect(romaneios.linhas.length).toBeGreaterThan(0);
    for (const l of romaneios.linhas) expect(l.ocupacao_pct).toBe(Math.round((l.volumes / l.capacidade) * 100));
    const semCaixa = await query({ filtros: [{ campo: 'caixas', op: '=', valor: '0' }, { campo: 'situacao_codigo', op: '=', valor: 'awaiting' }], acao: 'contar' });
    expect(typeof semCaixa.contar).toBe('number');
  });

  it('consultar_dados corrige o modelo: campo errado devolve os campos válidos, e telefone não é consultável', async () => {
    const r = await query({ filtros: [{ campo: 'telefone', op: '=', valor: '1' }] });
    expect(r.erro).toContain('telefone');
    expect(r.validos).toContain('situacao_codigo');
    expect(r.validos).not.toContain('telefone');
    expect((await query({ entidade: 'pagamentos' })).erro).toContain('pagamentos');
    expect((await query({ acao: 'somar', campo_metrica: 'cliente' })).erro).toContain('numérico');
  });
});
