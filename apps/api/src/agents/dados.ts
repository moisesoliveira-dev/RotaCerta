import {
  ORDER_STATUS_LABELS, ROUTE_STATUS_LABELS, confirmedCount, volumesOf,
  type Dataset, type Order, type Route,
} from '@rotacerta/domain';

/**
 * Modelo de dados que o agente enxerga, em "visões" planas (uma linha por entrega, romaneio, cliente, caixa...), já com
 * os relacionamentos resolvidos (a entrega traz o romaneio, o motorista e o veículo). A MESMA definição alimenta o manual
 * do agente (para ele saber o que existe e como as tabelas se ligam) e o motor de consulta `consultar_dados`
 * (para ele cruzar, filtrar, agrupar e somar sozinho). Acrescentar um campo aqui o torna conhecido e consultável.
 *
 * Privacidade: sem telefone e sem rua/número; só entra o que a análise precisa. Os dados já chegam filtrados pelo perfil.
 */
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type FieldType = 'texto' | 'numero' | 'booleano';
export interface FieldDef { name: string; type: FieldType; desc: string }
export interface Extra { now: Date; /** segundos desde a última posição, por romaneio em andamento */ lastFixSec: Map<number, number> }
export interface EntityDef { name: string; desc: string; links: string; fields: FieldDef[]; rows: (d: Dataset, x: Extra) => Row[] }

const t = (name: string, desc: string): FieldDef => ({ name, type: 'texto', desc });
const n = (name: string, desc: string): FieldDef => ({ name, type: 'numero', desc });
const b = (name: string, desc: string): FieldDef => ({ name, type: 'booleano', desc });

const zoneOf = (d: Dataset, hood: string) => d.neighborhoods.find((x) => x.name === hood)?.zone ?? null;
const driverName = (d: Dataset, id: number | null) => (id == null ? null : d.drivers.find((x) => x.id === id)?.name ?? null);
const lastEvent = (o: Order) => o.history[o.history.length - 1];
const delivered = (d: Dataset, r: Route) => r.orders.map((id) => d.orders.find((o) => o.id === id)).filter((o): o is Order => !!o);

export const ENTITIES: EntityDef[] = [
  {
    name: 'entregas', desc: 'Uma linha por entrega (compra a levar ao cliente). É a entidade central.',
    links: 'entregas.cliente_id -> clientes.id; entregas.romaneio_id -> romaneios.id (nulo enquanto não está em carga); entregas.bairro -> bairros.nome; caixas.entrega_id -> entregas.id.',
    fields: [
      n('id', 'código da entrega'), n('cliente_id', 'código do cliente'), t('cliente', 'nome'), t('bairro', 'bairro (cadastrado)'), t('zona', 'região do bairro'),
      t('janela', 'janela de entrega prometida (10:00–12:00, 14:00–16:00 ou 16:00–18:00)'),
      t('situacao', 'situação em português (Aguardando caixas, Pronta, Em carregamento, Liberada, Em rota, Entregue, Não entregue, Cancelada)'),
      t('situacao_codigo', 'draft, awaiting, ready, queued, loading, released, onroute, delivered, failed ou cancelled'),
      n('romaneio_id', 'romaneio em que está (nulo = fora de carga)'), t('romaneio_situacao', 'situação do romaneio dela'), t('motorista', 'motorista do romaneio'), t('veiculo', 'veículo do romaneio'),
      n('caixas', 'quantidade de caixas'), n('caixas_frio', 'caixas de frio'), n('caixas_congelado', 'caixas de congelado'), n('itens_fora_caixa', 'itens fora da caixa (gás etc.)'), n('volumes', 'caixas + itens fora da caixa'),
      b('tem_frio', 'tem frio ou congelado'), b('aceita_aviso', 'cliente autorizou aviso por WhatsApp'),
      t('cadastrada', 'quando foi cadastrada (texto como o sistema mostra)'), t('concluida', 'quando foi concluída (nulo se não)'),
      t('ocorrencia', 'motivo da ocorrência, se não foi entregue'), b('devolvida', 'volumes devolvidos à expedição (só para não entregues)'), t('cancelamento', 'motivo do cancelamento'),
      n('eventos', 'quantos eventos no histórico'), t('ultimo_evento', 'último evento do histórico'), t('ultimo_evento_hora', 'hora do último evento'), t('observacoes', 'observações da entrega'),
    ],
    rows: (d) => d.orders.map((o) => {
      const r = o.routeId != null ? d.routes.find((x) => x.id === o.routeId) : undefined;
      const v = volumesOf(o);
      return {
        id: o.id, cliente_id: o.clientId, cliente: o.name, bairro: o.neighborhood, zona: zoneOf(d, o.neighborhood), janela: o.window,
        situacao: ORDER_STATUS_LABELS[o.status], situacao_codigo: o.status, romaneio_id: o.routeId, romaneio_situacao: r ? ROUTE_STATUS_LABELS[r.status] : null,
        motorista: r ? driverName(d, r.driverId) : null, veiculo: r ? d.vehicles.find((x) => x.id === r.vehicleId)?.name ?? null : null,
        caixas: o.boxes.length, caixas_frio: o.cold, caixas_congelado: o.frozen, itens_fora_caixa: o.gas, volumes: v.length, tem_frio: o.cold + o.frozen > 0,
        aceita_aviso: o.consent, cadastrada: o.created, concluida: o.completed, ocorrencia: o.occurrence?.reason ?? null, devolvida: o.status === 'failed' ? !!o.returned : null,
        cancelamento: o.cancelled?.reason ?? null, eventos: o.history.length, ultimo_evento: lastEvent(o)?.label ?? null, ultimo_evento_hora: lastEvent(o)?.time ?? null, observacoes: o.notes || null,
      };
    }),
  },
  {
    name: 'romaneios', desc: 'Uma linha por romaneio (carga de um veículo com várias entregas em sequência).',
    links: 'romaneios.id <- entregas.romaneio_id (um romaneio tem várias entregas, na ordem das paradas); romaneios.veiculo_id -> veiculos.id; romaneios.motorista_id -> motoristas.id (pode ser nulo antes da viagem).',
    fields: [
      n('id', 'código do romaneio'), t('situacao', 'Em conferência, Liberado, Em andamento ou Finalizado'), t('situacao_codigo', 'loading, released, active ou finished'),
      n('veiculo_id', 'código do veículo'), t('veiculo', 'nome do veículo'), n('capacidade', 'capacidade do veículo em volumes'), n('motorista_id', 'código do motorista (nulo = sem motorista)'), t('motorista', 'nome do motorista'),
      t('saida', 'horário de saída planejado'), t('criado', 'hora em que foi criado'), n('paradas', 'quantidade de entregas'), n('paradas_concluidas', 'entregues + não entregues'), n('entregues', 'paradas entregues'), n('nao_entregues', 'paradas não entregues'),
      n('volumes', 'volumes totais da carga'), n('ocupacao_pct', 'volumes / capacidade, em %'), n('volumes_conferidos', 'volumes já marcados na conferência'), n('pedidos_confirmados', 'pedidos já confirmados na conferência'),
      b('interrompido', 'viagem encerrada antes do fim'), t('motivo_interrupcao', 'motivo, se interrompida'), t('finalizado', 'hora em que terminou'), n('ultima_posicao_seg', 'só em andamento: segundos desde a última posição do motorista (nulo = nenhuma recebida)'),
    ],
    rows: (d, x) => d.routes.map((r) => {
      const os = delivered(d, r);
      const veh = d.vehicles.find((v) => v.id === r.vehicleId);
      const vols = os.flatMap(volumesOf);
      return {
        id: r.id, situacao: ROUTE_STATUS_LABELS[r.status], situacao_codigo: r.status, veiculo_id: r.vehicleId, veiculo: veh?.name ?? null, capacidade: veh?.capacity ?? null,
        motorista_id: r.driverId, motorista: driverName(d, r.driverId), saida: r.departure, criado: r.created, paradas: os.length,
        paradas_concluidas: os.filter((o) => o.status === 'delivered' || o.status === 'failed').length, entregues: os.filter((o) => o.status === 'delivered').length, nao_entregues: os.filter((o) => o.status === 'failed').length,
        volumes: vols.length, ocupacao_pct: veh?.capacity ? Math.round((vols.length / veh.capacity) * 100) : null, volumes_conferidos: vols.filter((v) => r.checked?.[v.key]).length, pedidos_confirmados: confirmedCount(r),
        interrompido: !!r.interrupted, motivo_interrupcao: r.interrupted?.reason ?? null, finalizado: r.finished ?? null,
        ultima_posicao_seg: r.status === 'active' ? x.lastFixSec.get(r.id) ?? null : null,
      };
    }),
  },
  {
    name: 'caixas', desc: 'Uma linha por volume físico (caixa ou item fora da caixa) de entregas em aberto ou encerradas.',
    links: 'caixas.entrega_id -> entregas.id; caixas.romaneio_id -> romaneios.id. O código de uma caixa é único entre as entregas ATIVAS.',
    fields: [
      t('codigo', 'código da caixa (ou rótulo do item fora da caixa)'), t('tipo', 'ambient, cold, frozen ou extra (fora da caixa)'), t('local', 'local de guarda'), n('entrega_id', 'entrega dona'), t('cliente', 'cliente da entrega'),
      t('situacao_entrega', 'situação da entrega'), n('romaneio_id', 'romaneio da entrega (nulo se fora de carga)'), b('conferida', 'marcada na conferência do romaneio (nulo se não há conferência)'),
    ],
    rows: (d) => d.orders.flatMap((o) => {
      const r = o.routeId != null ? d.routes.find((x) => x.id === o.routeId) : undefined;
      return volumesOf(o).map((v) => ({ codigo: v.label, tipo: v.type, local: v.location, entrega_id: o.id, cliente: o.name, situacao_entrega: ORDER_STATUS_LABELS[o.status], romaneio_id: o.routeId, conferida: r && r.status === 'loading' ? !!r.checked?.[v.key] : null }));
    }),
  },
  {
    name: 'clientes', desc: 'Uma linha por cliente cadastrado.',
    links: 'clientes.id <- entregas.cliente_id (um cliente tem várias entregas).',
    fields: [n('id', 'código'), t('nome', 'nome'), t('bairro', 'bairro do cadastro'), b('aceita_aviso', 'autorizou aviso por WhatsApp'), n('entregas', 'total de entregas'), n('entregas_nao_entregues', 'entregas não realizadas'), n('entregas_em_aberto', 'entregas ainda não encerradas')],
    rows: (d) => d.clients.map((c) => {
      const os = d.orders.filter((o) => o.clientId === c.id);
      return { id: c.id, nome: c.name, bairro: c.neighborhood, aceita_aviso: c.consent, entregas: os.length, entregas_nao_entregues: os.filter((o) => o.status === 'failed').length, entregas_em_aberto: os.filter((o) => !['delivered', 'cancelled', 'failed'].includes(o.status)).length };
    }),
  },
  {
    name: 'veiculos', desc: 'Frota.',
    links: 'veiculos.id <- romaneios.veiculo_id.',
    fields: [n('id', 'código'), t('nome', 'nome'), t('placa', 'identificação'), n('capacidade', 'volumes que cabem'), b('ativo', 'pode ser escolhido'), b('em_viagem', 'está em um romaneio em andamento'), n('romaneios_abertos', 'romaneios não finalizados com este veículo')],
    rows: (d) => d.vehicles.map((v) => ({ id: v.id, nome: v.name, placa: v.plate, capacidade: v.capacity, ativo: v.active !== false, em_viagem: d.routes.some((r) => r.vehicleId === v.id && r.status === 'active'), romaneios_abertos: d.routes.filter((r) => r.vehicleId === v.id && r.status !== 'finished').length })),
  },
  {
    name: 'motoristas', desc: 'Equipe de entrega.',
    links: 'motoristas.id <- romaneios.motorista_id.',
    fields: [n('id', 'código'), t('nome', 'nome'), b('ativo', 'pode receber cargas'), b('em_viagem', 'está em viagem agora'), n('viagens_finalizadas', 'romaneios finalizados'), n('romaneios_abertos', 'romaneios designados e não finalizados')],
    rows: (d) => d.drivers.map((m) => ({ id: m.id, nome: m.name, ativo: m.active !== false, em_viagem: d.routes.some((r) => r.driverId === m.id && r.status === 'active'), viagens_finalizadas: d.routes.filter((r) => r.driverId === m.id && r.status === 'finished').length, romaneios_abertos: d.routes.filter((r) => r.driverId === m.id && r.status !== 'finished').length })),
  },
  {
    name: 'avisos', desc: 'Avisos por WhatsApp ao cliente (um por parada, sem duplicar).',
    links: 'avisos.entrega_id -> entregas.id; avisos.romaneio_id -> romaneios.id.',
    fields: [t('id', 'código'), n('romaneio_id', 'romaneio'), n('entrega_id', 'entrega avisada'), t('cliente', 'cliente'), t('situacao', 'queued (na fila), delivered (enviado), failed (falhou) ou skipped (ignorado)'), t('evento', 'rota_iniciada ou entrega_concluida'), t('criado', 'hora'), t('motivo', 'motivo (ex.: sem autorização)')],
    rows: (d) => d.notifications.map((a) => ({ id: a.id, romaneio_id: a.routeId, entrega_id: a.orderId, cliente: a.name, situacao: a.status, evento: a.event, criado: a.created, motivo: a.reason || null })),
  },
  {
    name: 'bairros', desc: 'Bairros atendidos e a região de cada um.',
    links: 'bairros.nome <- entregas.bairro e clientes.bairro.',
    fields: [t('nome', 'bairro'), t('zona', 'região'), n('entregas_em_aberto', 'entregas ainda não encerradas no bairro'), n('entregas_total', 'todas as entregas do bairro')],
    rows: (d) => d.neighborhoods.map((h) => ({ nome: h.name, zona: h.zone, entregas_em_aberto: d.orders.filter((o) => o.neighborhood === h.name && !['delivered', 'cancelled', 'failed'].includes(o.status)).length, entregas_total: d.orders.filter((o) => o.neighborhood === h.name).length })),
  },
];

export const entityByName = (name: string) => ENTITIES.find((e) => e.name === name);

/** O modelo de dados em texto, para o manual do agente. */
export function describeModel(): string {
  return ENTITIES.map((e) => `- ${e.name}: ${e.desc}\n  Campos: ${e.fields.map((f) => `${f.name} (${f.type}; ${f.desc})`).join('; ')}.\n  Ligações: ${e.links}`).join('\n');
}

/* ---------- motor de consulta ---------- */

export const OPS = ['=', '!=', '>', '>=', '<', '<=', 'contem', 'vazio', 'nao_vazio'] as const;
export const ACTIONS = ['listar', 'contar', 'somar', 'media', 'min', 'max'] as const;
export interface Query {
  entidade: string; filtros: Array<{ campo: string; op: string; valor: string }>; agrupar_por: string; acao: string; campo_metrica: string; campos: string[]; ordenar_por: string; ordem: string; limite: number;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const MAX_ROWS = 50;

function coerce(f: FieldDef, raw: string): Cell {
  if (f.type === 'numero') { const v = Number(raw.replace(',', '.')); return Number.isFinite(v) ? v : null; }
  if (f.type === 'booleano') return ['true', 'verdadeiro', 'sim', '1'].includes(norm(raw)) ? true : ['false', 'falso', 'nao', '0'].includes(norm(raw)) ? false : null;
  return raw;
}

function test(cell: Cell, op: string, f: FieldDef, raw: string): boolean {
  if (op === 'vazio') return cell === null || cell === '';
  if (op === 'nao_vazio') return !(cell === null || cell === '');
  const want = coerce(f, raw);
  if (want === null) return false;
  if (op === 'contem') return typeof cell === 'string' && norm(cell).includes(norm(String(want)));
  if (cell === null) return op === '!=';
  const a = f.type === 'texto' ? norm(String(cell)) : cell;
  const w = f.type === 'texto' ? norm(String(want)) : want;
  switch (op) {
    case '=': return a === w;
    case '!=': return a !== w;
    case '>': return a > w;
    case '>=': return a >= w;
    case '<': return a < w;
    case '<=': return a <= w;
    default: return false;
  }
}

const bad = (erro: string, validos: string[]) => ({ erro, validos });
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);

function metric(rows: Row[], action: string, field: string | null): Cell {
  if (action === 'contar') return rows.length;
  const xs = rows.map((r) => r[field as string]).filter((v): v is number => typeof v === 'number');
  if (!xs.length) return null;
  if (action === 'somar') return xs.reduce((s, x) => s + x, 0);
  if (action === 'media') return mean(xs);
  if (action === 'min') return Math.min(...xs);
  return Math.max(...xs);
}

/** Executa uma consulta estruturada (só leitura) sobre uma visão. Erros de campo voltam com a lista de campos válidos. */
export function runQuery(data: Dataset, extra: Extra, q: Query): unknown {
  const entity = entityByName(q.entidade);
  if (!entity) return bad(`Entidade desconhecida: ${q.entidade}.`, ENTITIES.map((e) => e.name));
  const fieldOf = (name: string) => entity.fields.find((f) => f.name === name);
  const names = entity.fields.map((f) => f.name);
  let rows = entity.rows(data, extra);

  for (const fl of q.filtros) {
    const f = fieldOf(fl.campo);
    if (!f) return bad(`Campo desconhecido em ${entity.name}: ${fl.campo}.`, names);
    if (!(OPS as readonly string[]).includes(fl.op)) return bad(`Operador inválido: ${fl.op}.`, [...OPS]);
    rows = rows.filter((r) => test(r[fl.campo], fl.op, f, fl.valor));
  }
  const total = rows.length;
  const limit = Math.min(Math.max(Math.round(q.limite) || 25, 1), MAX_ROWS);
  const action = (ACTIONS as readonly string[]).includes(q.acao) ? q.acao : 'listar';
  const mfield = q.campo_metrica ? fieldOf(q.campo_metrica) : undefined;
  if (q.campo_metrica && !mfield) return bad(`Campo desconhecido em ${entity.name}: ${q.campo_metrica}.`, names);
  if (['somar', 'media', 'min', 'max'].includes(action) && mfield?.type !== 'numero') return bad(`${action} precisa de campo_metrica numérico.`, entity.fields.filter((f) => f.type === 'numero').map((f) => f.name));

  if (q.agrupar_por) {
    if (!fieldOf(q.agrupar_por)) return bad(`Campo desconhecido em ${entity.name}: ${q.agrupar_por}.`, names);
    const groups = new Map<string, Row[]>();
    for (const r of rows) { const k = String(r[q.agrupar_por] ?? '(vazio)'); groups.set(k, [...(groups.get(k) ?? []), r]); }
    const act = action === 'listar' ? 'contar' : action;
    const out = [...groups.entries()].map(([valor, rs]) => ({ [q.agrupar_por]: valor, [act]: metric(rs, act, q.campo_metrica || null) }));
    out.sort((a, b2) => Number(b2[act] ?? 0) - Number(a[act] ?? 0));
    return { entidade: entity.name, total_linhas: total, grupos: out.slice(0, limit), truncado: out.length > limit };
  }
  if (action !== 'listar') return { entidade: entity.name, total_linhas: total, [action]: metric(rows, action, q.campo_metrica || null) };

  if (q.ordenar_por) {
    const f = fieldOf(q.ordenar_por);
    if (!f) return bad(`Campo desconhecido em ${entity.name}: ${q.ordenar_por}.`, names);
    const dir = q.ordem === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b2) => {
      const x = a[q.ordenar_por], y = b2[q.ordenar_por];
      if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
      return (x > y ? 1 : -1) * dir;
    });
  }
  const pick = q.campos.length ? q.campos : names;
  const unknown = pick.find((c) => !fieldOf(c));
  if (unknown) return bad(`Campo desconhecido em ${entity.name}: ${unknown}.`, names);
  return { entidade: entity.name, total_linhas: total, linhas: rows.slice(0, limit).map((r) => Object.fromEntries(pick.map((c) => [c, r[c]]))), truncado: total > limit };
}
