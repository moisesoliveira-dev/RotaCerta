import { desc, eq } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ORDER_STATUS_LABELS, ROUTE_STATUS_LABELS, boxesInUse, checkCapacity, confirmedCount, nextStop, orderChecked, routeOrders, volumesOf, volumesOfOrders,
  type Dataset, type Order, type OrderStatus, type Role, type RouteStatus,
} from '@rotacerta/domain';
import type { Db } from '../db/client';
import { ACTIONS, ENTITIES, OPS, runQuery, type Query } from './dados';
import * as schema from '../db/schema';

/**
 * Catálogo de ferramentas que um agente pode receber. Toda ferramenta é de LEITURA e trabalha sobre os dados que o
 * perfil de quem conversa já pode ver (o mesmo filtro do `/api/dataset`): o agente nunca enxerga mais do que a pessoa.
 *
 * Para criar uma ferramenta nova: acrescente um item em `AGENT_TOOLS` com nome, descrição (o modelo lê), schema de
 * entrada estrito e `run`. A tela de agentes lista o catálogo sozinha.
 */
export interface ToolContext {
  data: Dataset;
  role: Role;
  driverId: number | null;
  /** Consulta a tabelas que não estão no Dataset (ex.: posições), numa transação curta no schema da empresa. */
  tenant: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  now: Date;
}

export interface AgentTool {
  name: string;
  label: string;
  group: 'Entregas' | 'Clientes' | 'Viagens' | 'Operação';
  /** Lida pelo modelo: diga o que a ferramenta devolve e quando usá-la. */
  description: string;
  /** Perfis que podem usar a ferramenta, além do agente tê-la liberada. */
  roles: Role[];
  input_schema: Anthropic.Beta.BetaTool['input_schema'];
  run(ctx: ToolContext, input: Record<string, unknown>): Promise<unknown> | unknown;
}

const ALL: Role[] = ['gestao', 'atendente', 'expedicao'];
const MONITORS: Role[] = ['gestao', 'expedicao'];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const digits = (s: string) => s.replace(/\D/g, '');
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const ORDER_FILTERS: Record<string, OrderStatus[] | null> = {
  todas: null,
  em_aberto: ['draft', 'awaiting', 'ready', 'queued', 'loading', 'released', 'onroute'],
  aguardando_caixas: ['awaiting'],
  prontas: ['ready', 'queued'],
  em_carregamento: ['loading', 'released'],
  em_rota: ['onroute'],
  entregues: ['delivered'],
  nao_entregues: ['failed'],
  canceladas: ['cancelled'],
};
const ROUTE_FILTERS: Record<string, RouteStatus[] | null> = {
  todos: null, carregando: ['loading'], liberados: ['released'], em_andamento: ['active'], finalizados: ['finished'],
};

const object = (properties: Record<string, unknown>) => ({
  type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false,
});

/** Um problema encontrado: o que é, por quê (regra) e onde resolver. */
interface Finding { gravidade: 'alta' | 'media' | 'baixa'; tipo: string; onde: string; problema: string; regra: string; o_que_fazer: string }
const f = (gravidade: Finding['gravidade'], tipo: string, onde: string, problema: string, regra: string, o_que_fazer: string): Finding => ({ gravidade, tipo, onde, problema, regra, o_que_fazer });
const vehicleBusy = (data: Dataset, r: { id: number; vehicleId: number }) => data.routes.some((o) => o.id !== r.id && o.vehicleId === r.vehicleId && o.status === 'active');

/** Procura, nos dados do perfil, tudo o que está travando a operação, aplicando as regras do domínio. */
function findProblems(data: Dataset, now: Date, lastFix: Map<number, number>): Finding[] {
  const out: Finding[] = [];
  for (const o of data.orders) {
    if (o.status === 'awaiting') out.push(f('media', 'sem_caixas', `entrega #${o.id} (${o.name})`, 'Aguardando caixas: não aparece em Montar carga.', 'Só entregas com ao menos uma caixa ficam prontas.', 'Volumes e caixas: identificar as caixas da entrega.'));
    if (o.status === 'failed' && !o.returned) out.push(f('alta', 'devolucao_pendente', `entrega #${o.id} (${o.name})`, `Não entregue (${o.occurrence?.reason ?? 'sem motivo'}) e os volumes ainda não foram devolvidos.`, 'Nova tentativa só depois de confirmar a devolução dos volumes (e com a viagem encerrada).', 'Entregas: confirmar a devolução; depois agendar nova tentativa.'));
    if (o.status === 'failed' && o.returned) out.push(f('baixa', 'nova_tentativa', `entrega #${o.id} (${o.name})`, 'Devolvida e sem nova tentativa agendada.', 'Entrega devolvida pode ganhar nova janela e voltar para a fila.', 'Entregas: agendar nova tentativa (ou cancelar).'));
    if (o.status === 'ready' && o.routeId == null && volumesOf(o).length === 0) out.push(f('media', 'inconsistencia', `entrega #${o.id}`, 'Pronta, mas sem volumes.', 'Pronta exige caixas.', 'Volumes e caixas: conferir as caixas da entrega.'));
  }
  const ready = data.orders.filter((o) => o.status === 'ready' && o.routeId == null);
  if (ready.length >= 1) {
    const byHood = new Map<string, number>();
    for (const o of ready) byHood.set(o.neighborhood, (byHood.get(o.neighborhood) ?? 0) + 1);
    out.push(f('baixa', 'prontas_sem_carga', `${ready.length} entrega(s) pronta(s)`, `Prontas e fora de qualquer carga (${[...byHood].map(([h, n]) => `${h}: ${n}`).join(', ')}).`, 'Entregas prontas esperam a expedição montar a carga.', 'Montar carga: agrupar por região e escolher o veículo.'));
  }
  for (const r of data.routes) {
    const orders = routeOrders(data, r);
    const vehicle = data.vehicles.find((v) => v.id === r.vehicleId);
    const vols = orders.flatMap(volumesOf);
    if (r.status === 'loading') {
      const missing = vols.filter((v) => !r.checked?.[v.key]).length;
      const pend = orders.length - confirmedCount(r);
      out.push(f(missing || pend ? 'media' : 'alta', 'conferencia', `romaneio #${r.id}`, missing || pend ? `Em conferência: faltam ${missing} volume(s) e ${pend} pedido(s) por confirmar.` : 'Tudo conferido, mas o romaneio ainda não foi liberado.', 'O romaneio só é liberado com todos os volumes marcados e todos os pedidos confirmados.', missing || pend ? 'Carregamento: marcar os volumes que faltam e confirmar os pedidos.' : 'Carregamento: clicar em "Liberar romaneio ao motorista".'));
      const cap = checkCapacity(data, r.vehicleId, volumesOfOrders(data, r.orders));
      if (cap) out.push(f('alta', 'capacidade', `romaneio #${r.id}`, cap, 'Volumes da carga não podem passar da capacidade do veículo.', 'Carregamento ou Montar carga: desfazer a carga ou tirar entregas; ou trocar o veículo.'));
      for (const o of orders) if (!orderChecked(r, o) && r.confirmed?.[String(o.id)]) out.push(f('media', 'inconsistencia', `romaneio #${r.id}, entrega #${o.id}`, 'Pedido confirmado com volume desmarcado.', 'Mudar volumes desfaz a conferência.', 'Carregamento: refazer a conferência do pedido.'));
    }
    if (r.status === 'released') {
      if (!r.driverId) out.push(f('media', 'sem_motorista', `romaneio #${r.id}`, 'Liberado e sem motorista designado.', 'O romaneio liberado fica disponível ao motorista; sem dono, o primeiro que iniciar fica com ele.', 'Romaneios: designar o motorista, ou avisar a equipe de motoristas.'));
      if (vehicle && vehicleBusy(data, r)) out.push(f('alta', 'veiculo_ocupado', `romaneio #${r.id}`, `O veículo ${vehicle.name} já está em outra viagem.`, 'Um veículo não faz duas viagens ao mesmo tempo.', 'Trocar o veículo da carga ou esperar a outra viagem terminar.'));
    }
    if (r.status === 'active') {
      const last = lastFix.get(r.id);
      const next = nextStop(data, r);
      if (last === undefined) out.push(f('alta', 'sem_sinal', `romaneio #${r.id}`, 'Viagem em andamento sem nenhuma posição recebida.', 'O aparelho do motorista envia a posição durante a viagem.', 'Ligar para o motorista: abrir o app, liberar a localização e conferir a internet.'));
      else if (now.getTime() - last > 180_000) out.push(f('alta', 'sem_sinal', `romaneio #${r.id}`, `Última posição há ${Math.round((now.getTime() - last) / 60_000)} min${next ? ` (parada atual: ${next.name})` : ''}.`, 'Posição com mais de 3 minutos é sinal fraco.', 'Ligar para o motorista: app em segundo plano, GPS bloqueado ou sem internet.'));
    }
  }
  for (const n of data.notifications) if (n.status === 'failed') out.push(f('media', 'aviso_falhou', `aviso do cliente ${n.name} (entrega #${n.orderId})`, 'O aviso por WhatsApp falhou.', 'Avisos com falha podem ser reenviados.', 'Notificações: reenviar o aviso.'));
  const rank = { alta: 0, media: 1, baixa: 2 };
  return out.sort((a, b) => rank[a.gravidade] - rank[b.gravidade]);
}

/** O que está travando UMA entrega: situação, regra e o próximo passo. */
function diagnoseOrder(data: Dataset, o: Order) {
  const route = o.routeId != null ? data.routes.find((r) => r.id === o.routeId) : undefined;
  const vols = volumesOf(o);
  const alerts: string[] = [];
  const next = (() => {
    switch (o.status) {
      case 'draft': return 'Rascunho: finalizar o cadastro.';
      case 'awaiting': return 'Aguardando caixas: identificar as caixas em Volumes e caixas para ela ficar pronta.';
      case 'ready': case 'queued': return route ? `Pronta e vinculada ao romaneio #${route.id}.` : 'Pronta: a expedição a inclui em Montar carga (escolha de veículo e sequência).';
      case 'loading': return route ? `Em conferência no romaneio #${route.id}: marcar ${vols.filter((v) => !route.checked?.[v.key]).length} volume(s) e confirmar o pedido em Carregamento.` : 'Em carregamento sem romaneio: inconsistência, avisar a gestão.';
      case 'released': return route ? `Liberada no romaneio #${route.id}: aguardando o motorista iniciar a viagem${route.driverId ? '' : ' (sem motorista designado)'}.` : 'Liberada sem romaneio: inconsistência.';
      case 'onroute': { const nx = route ? nextStop(data, route) : undefined; return nx && nx.id === o.id ? 'É a PRÓXIMA parada do motorista.' : `Em rota; ainda não é a vez dela${nx ? ` (parada atual: ${nx.name})` : ''}.`; }
      case 'delivered': return 'Concluída: nada a fazer.';
      case 'failed': return o.returned ? 'Não entregue e já devolvida: pode agendar nova tentativa ou cancelar.' : 'Não entregue: falta confirmar a devolução dos volumes (depois da viagem encerrar) antes de nova tentativa.';
      case 'cancelled': return 'Cancelada: fora do fluxo.';
      default: return '';
    }
  })();
  if (!vols.length && o.status !== 'cancelled' && o.status !== 'delivered') alerts.push('Sem volumes cadastrados.');
  const others = boxesInUse(data, o.id);
  const conflict = o.boxes.filter((c) => others.has(c));
  if (conflict.length) alerts.push(`Caixas também vinculadas a outra entrega ativa: ${conflict.join(', ')}.`);
  if (route && (route.status === 'loading' || route.status === 'released')) {
    const cap = checkCapacity(data, route.vehicleId, volumesOfOrders(data, route.orders));
    if (cap) alerts.push(cap);
  }
  if (!o.consent) alerts.push('Cliente sem autorização de WhatsApp: o aviso de "você é o próximo" será ignorado.');
  return {
    situacao: ORDER_STATUS_LABELS[o.status], proximo_passo: next, alertas: alerts,
    romaneio: route ? { codigo: route.id, situacao: ROUTE_STATUS_LABELS[route.status], pedidos_confirmados: confirmedCount(route), total_pedidos: route.orders.length } : null,
    avisos_ao_cliente: data.notifications.filter((n) => n.orderId === o.id).map((n) => ({ situacao: n.status, motivo: n.reason || null })),
  };
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'consultar_dados', label: 'Consultar e cruzar os dados', group: 'Operação', roles: ALL,
    description: 'Consulta estruturada (só leitura) sobre as visões do modelo de dados descritas no manual: entregas, romaneios, caixas, clientes, veiculos, motoristas, avisos e bairros. Filtre por campos (filtros), agrupe (agrupar_por), conte/some/tire média/mínimo/máximo (acao + campo_metrica) ou liste linhas (campos, ordenar_por, limite). Use várias consultas pequenas para levantar fatos, cruzar entidades pelas ligações (ex.: entregas.romaneio_id com romaneios.id) e analisar a operação. Deixe em branco ("" ou []) o que não usar. Se um campo estiver errado, o retorno lista os campos válidos.',
    input_schema: {
      type: 'object' as const, additionalProperties: false,
      required: ['entidade', 'filtros', 'agrupar_por', 'acao', 'campo_metrica', 'campos', 'ordenar_por', 'ordem', 'limite'],
      properties: {
        entidade: { type: 'string', enum: ENTITIES.map((e) => e.name) },
        filtros: { type: 'array', description: 'Condições combinadas com E. Vazio = sem filtro.', items: { type: 'object', additionalProperties: false, required: ['campo', 'op', 'valor'], properties: {
          campo: { type: 'string' }, op: { type: 'string', enum: [...OPS] }, valor: { type: 'string', description: 'Valor como texto (números e true/false também). Ignorado em vazio/nao_vazio.' },
        } } },
        agrupar_por: { type: 'string', description: 'Campo para agrupar, ou "" para não agrupar.' },
        acao: { type: 'string', enum: [...ACTIONS], description: 'listar linhas, contar, somar, media, min ou max.' },
        campo_metrica: { type: 'string', description: 'Campo numérico para somar/media/min/max, ou "".' },
        campos: { type: 'array', items: { type: 'string' }, description: 'Campos a devolver ao listar. Vazio = todos.' },
        ordenar_por: { type: 'string', description: 'Campo para ordenar ao listar, ou "".' },
        ordem: { type: 'string', enum: ['asc', 'desc'] },
        limite: { type: 'integer', description: 'Máximo de linhas ou grupos (até 50).' },
      },
    },
    run: async ({ data, tenant, now }, input) => {
      const lastFixSec = new Map<number, number>();
      for (const r of data.routes.filter((x) => x.status === 'active')) {
        const [last] = await tenant((tx) => tx.select().from(schema.driverLocations).where(eq(schema.driverLocations.routeId, r.id)).orderBy(desc(schema.driverLocations.recordedAt)).limit(1));
        if (last) lastFixSec.set(r.id, Math.max(0, Math.round((now.getTime() - last.recordedAt.getTime()) / 1000)));
      }
      const filtros = Array.isArray(input.filtros) ? (input.filtros as Array<Record<string, unknown>>).map((x) => ({ campo: str(x.campo), op: str(x.op), valor: str(x.valor) })) : [];
      const q: Query = {
        entidade: str(input.entidade), filtros, agrupar_por: str(input.agrupar_por), acao: str(input.acao), campo_metrica: str(input.campo_metrica),
        campos: Array.isArray(input.campos) ? (input.campos as unknown[]).map(str) : [], ordenar_por: str(input.ordenar_por), ordem: str(input.ordem), limite: Number(input.limite) || 25,
      };
      return runQuery(data, { now, lastFixSec }, q);
    },
  },
  {
    name: 'problemas_da_operacao', label: 'Problemas da operação (diagnóstico)', group: 'Operação', roles: ALL,
    description: 'ATALHO de verificação: aplica as regras de negócio aos dados e lista violações e travas conhecidas (não é exaustivo: complemente com consultar_dados). Devolve, ordenado por gravidade: entregas sem caixas, devoluções pendentes, cargas com conferência incompleta ou acima da capacidade, romaneios sem motorista, viagens sem sinal, avisos com falha. Cada item traz a regra violada e o que fazer. Use para "o que está errado?" e "o que preciso resolver agora?".',
    input_schema: object({}),
    run: async ({ data, tenant, now }) => {
      const lastFix = new Map<number, number>();
      for (const r of data.routes.filter((x) => x.status === 'active')) {
        const [last] = await tenant((tx) => tx.select().from(schema.driverLocations).where(eq(schema.driverLocations.routeId, r.id)).orderBy(desc(schema.driverLocations.recordedAt)).limit(1));
        if (last) lastFix.set(r.id, last.recordedAt.getTime());
      }
      const problemas = findProblems(data, now, lastFix);
      return { total: problemas.length, problemas: problemas.slice(0, 30), truncado: problemas.length > 30 };
    },
  },
  {
    name: 'diagnosticar_entrega', label: 'Diagnosticar uma entrega', group: 'Entregas', roles: ALL,
    description: 'Explica por que uma entrega está onde está e qual é o próximo passo: situação, romaneio, conferência, capacidade, caixas em conflito, autorização de aviso. Use para "por que a entrega X não aparece, não sai ou não avançou?".',
    input_schema: object({ codigo: { type: 'integer', description: 'Código da entrega (ex.: 103).' } }),
    run: ({ data }, input) => {
      const o = data.orders.find((x) => x.id === Number(input.codigo));
      return o ? { encontrada: true, codigo: o.id, cliente: o.name, ...diagnoseOrder(data, o) } : { encontrada: false };
    },
  },
  {
    name: 'buscar_entregas', label: 'Buscar entregas', group: 'Entregas', roles: ALL,
    description: 'Lista entregas (até 25) filtrando por texto (nome do cliente, código, bairro ou telefone; vazio = todas) e por situação. Devolve o total encontrado e, para cada entrega: código, cliente, bairro, janela, situação e número de caixas.',
    input_schema: object({
      texto: { type: 'string', description: 'Trecho do nome, código, bairro ou telefone. Vazio para não filtrar.' },
      situacao: { type: 'string', enum: Object.keys(ORDER_FILTERS) },
    }),
    run: ({ data }, input) => {
      const q = norm(str(input.texto));
      const statuses = ORDER_FILTERS[str(input.situacao)] ?? null;
      const found = data.orders.filter((o) => (!statuses || statuses.includes(o.status)) && (!q
        || norm(o.name).includes(q) || String(o.id) === q.replace('#', '') || norm(o.neighborhood).includes(q)
        || (digits(q).length >= 4 && digits(o.phone).includes(digits(q)))));
      return {
        total: found.length,
        entregas: found.slice(0, 25).map((o) => ({
          codigo: o.id, cliente: o.name, bairro: o.neighborhood, janela: o.window, situacao: ORDER_STATUS_LABELS[o.status], caixas: o.boxes.length + o.gas,
        })),
      };
    },
  },
  {
    name: 'detalhe_entrega', label: 'Detalhe de uma entrega', group: 'Entregas', roles: ALL,
    description: 'Mostra uma entrega pelo código: cliente, endereço, janela, caixas, romaneio, motorista, ocorrência e o histórico (o que aconteceu, quando e por quem).',
    input_schema: object({ codigo: { type: 'integer', description: 'Código da entrega (ex.: 103).' } }),
    run: ({ data }, input) => {
      const o = data.orders.find((x) => x.id === Number(input.codigo));
      if (!o) return { encontrada: false };
      const route = o.routeId != null ? data.routes.find((r) => r.id === o.routeId) : undefined;
      return {
        encontrada: true, codigo: o.id, cliente: o.name, telefone: o.phone, endereco: `${o.street}, ${o.number}${o.complement ? ` (${o.complement})` : ''} — ${o.neighborhood}`,
        referencia: o.reference, janela: o.window, observacoes: o.notes, situacao: ORDER_STATUS_LABELS[o.status],
        caixas: o.boxes, itens_fora_da_caixa: o.gas, aceita_whatsapp: o.consent, cadastrada: o.created, concluida: o.completed,
        romaneio: route ? { codigo: route.id, situacao: ROUTE_STATUS_LABELS[route.status], motorista: data.drivers.find((d) => d.id === route.driverId)?.name ?? null, saida: route.departure } : null,
        ocorrencia: o.occurrence ?? null, cancelamento: o.cancelled ?? null, recebedor: o.receiver ?? null,
        historico: o.history.slice(-15),
      };
    },
  },
  {
    name: 'resumo_operacao', label: 'Resumo da operação', group: 'Operação', roles: ALL,
    description: 'Números da operação agora: entregas por situação, romaneios por situação, entregas sem caixas identificadas e não entregues aguardando devolução.',
    input_schema: object({}),
    run: ({ data }) => {
      const byOrder: Record<string, number> = {};
      for (const o of data.orders) byOrder[ORDER_STATUS_LABELS[o.status]] = (byOrder[ORDER_STATUS_LABELS[o.status]] ?? 0) + 1;
      const byRoute: Record<string, number> = {};
      for (const r of data.routes) byRoute[ROUTE_STATUS_LABELS[r.status]] = (byRoute[ROUTE_STATUS_LABELS[r.status]] ?? 0) + 1;
      return {
        total_entregas: data.orders.length, entregas_por_situacao: byOrder, romaneios_por_situacao: byRoute,
        aguardando_caixas: data.orders.filter((o) => o.status === 'awaiting').length,
        nao_entregues_sem_devolucao: data.orders.filter((o) => o.status === 'failed' && !o.returned).length,
        avisos_com_falha: data.notifications.filter((n) => n.status === 'failed').length,
      };
    },
  },
  {
    name: 'buscar_clientes', label: 'Buscar clientes', group: 'Clientes', roles: ALL,
    description: 'Procura clientes (até 10) pelo nome ou telefone e devolve nome, telefone, bairro e quantas entregas cada um já teve.',
    input_schema: object({ texto: { type: 'string', description: 'Trecho do nome ou do telefone (ao menos 3 caracteres).' } }),
    run: ({ data }, input) => {
      const q = norm(str(input.texto));
      if (q.length < 3) return { erro: 'Informe ao menos 3 caracteres.' };
      const found = data.clients.filter((c) => norm(c.name).includes(q) || (digits(q).length >= 4 && digits(c.phone).includes(digits(q))));
      return {
        total: found.length,
        clientes: found.slice(0, 10).map((c) => ({ nome: c.name, telefone: c.phone, bairro: c.neighborhood, entregas: data.orders.filter((o) => o.clientId === c.id).length })),
      };
    },
  },
  {
    name: 'listar_romaneios', label: 'Listar romaneios', group: 'Viagens', roles: ALL,
    description: 'Lista romaneios (cargas) por situação, com motorista, veículo, horário de saída e andamento (paradas concluídas / total).',
    input_schema: object({ situacao: { type: 'string', enum: Object.keys(ROUTE_FILTERS) } }),
    run: ({ data }, input) => {
      const statuses = ROUTE_FILTERS[str(input.situacao)] ?? null;
      const list = data.routes.filter((r) => !statuses || statuses.includes(r.status));
      return {
        total: list.length,
        romaneios: list.slice(0, 25).map((r) => {
          const orders = routeOrders(data, r);
          return {
            codigo: r.id, situacao: ROUTE_STATUS_LABELS[r.status], motorista: data.drivers.find((d) => d.id === r.driverId)?.name ?? null,
            veiculo: data.vehicles.find((v) => v.id === r.vehicleId)?.name ?? null, saida: r.departure,
            paradas: orders.length, concluidas: orders.filter((o) => o.status === 'delivered' || o.status === 'failed').length,
          };
        }),
      };
    },
  },
  {
    name: 'viagens_ao_vivo', label: 'Viagens ao vivo (localização)', group: 'Viagens', roles: MONITORS,
    description: 'Viagens em andamento agora: motorista, parada atual (cliente e bairro), andamento e há quanto tempo chegou a última posição do motorista (com coordenadas).',
    input_schema: object({}),
    run: async ({ data, tenant, now }) => {
      const out = [];
      for (const r of data.routes.filter((x) => x.status === 'active')) {
        const [last] = await tenant((tx) => tx.select().from(schema.driverLocations).where(eq(schema.driverLocations.routeId, r.id)).orderBy(desc(schema.driverLocations.recordedAt)).limit(1));
        const orders = routeOrders(data, r);
        const current = nextStop(data, r);
        out.push({
          romaneio: r.id, motorista: data.drivers.find((d) => d.id === r.driverId)?.name ?? null,
          paradas: orders.length, concluidas: orders.filter((o) => o.status === 'delivered' || o.status === 'failed').length,
          parada_atual: current ? { codigo: current.id, cliente: current.name, bairro: current.neighborhood } : null,
          ultima_posicao: last ? { lat: Number(last.lat.toFixed(5)), lng: Number(last.lng.toFixed(5)), ha_segundos: Math.max(0, Math.round((now.getTime() - last.recordedAt.getTime()) / 1000)) } : null,
        });
      }
      return { viagens: out };
    },
  },
];

export const toolByName = (name: string) => AGENT_TOOLS.find((t) => t.name === name);

/** Catálogo para a tela (sem as funções). */
export const toolCatalog = () => AGENT_TOOLS.map(({ name, label, group, description, roles }) => ({ name, label, group, description, roles }));
