import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ROLE_LABELS, type Role } from '@rotacerta/domain';
import { call } from '../app/api';
import { Icon } from '../app/icons';
import { useStore } from '../app/store';
import { AgentChat } from './AgentChat';
import { TilesSkeleton } from './Skeletons';
import { Header, Modal, Tabs } from './ui';

/* ---------- tipos do que a API devolve ---------- */
interface ToolInfo { name: string; label: string; group: string; description: string; roles: Role[] }
interface Catalog { tools: ToolInfo[]; models: string[]; ready: boolean; dailyLimit: number }
interface Knowledge { title: string; text: string }
interface Agent {
  id: number; name: string; description: string; model: string; tools: string[];
  instructions?: string; effort?: 'low' | 'medium' | 'high'; roles?: Role[]; knowledge?: Knowledge[]; active?: boolean;
}
interface Usage { days: number; totalUsd: number; today: number; agents: Array<{ agentId: number; chats: number; usd: number }> }

type Draft = Required<Pick<Agent, 'name' | 'description' | 'instructions' | 'model' | 'effort' | 'tools' | 'roles' | 'knowledge' | 'active'>>;

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 · mais capaz (padrão)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 · equilíbrio entre custo e qualidade',
  'claude-haiku-5-5': 'Claude Haiku 5.5 · mais rápido e barato',
};
const EFFORTS: Array<[Draft['effort'], string]> = [['low', 'Rápido'], ['medium', 'Equilibrado'], ['high', 'Caprichado']];
const AGENT_ROLES: Role[] = ['gestao', 'atendente', 'expedicao'];

const EMPTY: Draft = { name: '', description: '', instructions: '', model: 'claude-opus-5-5', effort: 'medium', tools: [], roles: ['gestao'], knowledge: [], active: true };

/**
 * Modelos de partida: mostram como um agente é montado (papel, ferramentas, quem usa, base de conhecimento).
 * Depois de escolhido, tudo é editável; nada aqui é especial para a API.
 */
const TEMPLATES: Array<{ key: string; title: string; text: string; draft: Partial<Draft> }> = [
  {
    key: 'operacao', title: 'Assistente da operação', text: 'Responde qualquer pergunta sobre entregas, romaneios e números do dia.',
    draft: {
      name: 'Assistente da operação', description: 'Tira dúvidas sobre entregas, romaneios e o andamento do dia.',
      instructions: 'Você ajuda a equipe da loja a acompanhar a operação de entregas.\n- Quando perguntarem por uma entrega, procure pelo nome, código ou bairro e diga a situação e o próximo passo.\n- Para números do dia, use o resumo da operação.\n- Termine com uma sugestão prática quando houver algo atrasado ou travado.',
      tools: ['buscar_entregas', 'detalhe_entrega', 'resumo_operacao', 'listar_romaneios', 'viagens_ao_vivo'], roles: ['gestao', 'atendente', 'expedicao'],
    },
  },
  {
    key: 'atendimento', title: 'Balcão de atendimento', text: 'Ajuda a atendente a responder o cliente que liga ou chega ao caixa.',
    draft: {
      name: 'Balcão de atendimento', description: 'Consulta pedidos e clientes para responder quem pergunta da compra.',
      instructions: 'Você apoia a atendente no balcão e ao telefone.\n- Encontre a compra do cliente (nome, telefone ou código) e explique a situação em uma frase que a atendente possa repetir ao cliente.\n- Se a entrega estiver em rota, diga quantas paradas faltam quando souber.\n- Nunca prometa horário exato.',
      tools: ['buscar_entregas', 'detalhe_entrega', 'buscar_clientes'], roles: ['gestao', 'atendente'],
      knowledge: [{ title: 'Janelas de entrega', text: 'As entregas saem nas janelas 14:00–16:00, 16:00–18:00 e 18:00–20:00. O horário dentro da janela depende da ordem do romaneio.' }],
    },
  },
  {
    key: 'viagens', title: 'Monitor de viagens', text: 'Acompanha motoristas em rota e aponta quem está sem sinal ou atrasado.',
    draft: {
      name: 'Monitor de viagens', description: 'Diz onde está cada motorista e o que falta em cada romaneio.',
      instructions: 'Você acompanha as viagens em andamento para a expedição e a gestão.\n- Para cada viagem, diga motorista, parada atual e quanto falta.\n- Destaque viagens cuja última posição tem mais de 3 minutos (possível falta de sinal).\n- Seja breve: uma linha por viagem.',
      tools: ['viagens_ao_vivo', 'listar_romaneios', 'resumo_operacao'], roles: ['gestao', 'expedicao'], effort: 'low',
    },
  },
];

export function Agentes() {
  const { role } = useStore();
  const isManager = role === 'gestao';
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [editing, setEditing] = useState<Draft & { id?: number } | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('agente')) || null;

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([call<Catalog>('GET', '/agents/catalog'), call<Agent[]>('GET', '/agents')]);
      setCatalog(c); setAgents(a); setError('');
      if (isManager) setUsage(await call<Usage>('GET', '/agents/usage?days=30'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível carregar os agentes.'); }
  }, [isManager]);
  useEffect(() => { void load(); }, [load]);

  const open = agents.find((a) => a.id === openId) ?? null;
  const toolLabel = (n: string) => catalog?.tools.find((t) => t.name === n)?.label ?? n;

  if (open && catalog) {
    return (
      <AgentChat key={open.id} agent={open} ready={catalog.ready} toolLabel={toolLabel} onBack={() => setParams({})} onEdit={isManager ? () => setEditing(toDraft(open)) : undefined}>
        {editing && <Editor draft={editing} catalog={catalog} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      </AgentChat>
    );
  }

  return (
    <>
      <Header title="Agentes de IA" subtitle="Assistentes que consultam a operação e respondem em linguagem natural. Só leem dados: nada é alterado por eles."
        actions={isManager && <button type="button" className="primary" onClick={() => setEditing({ ...EMPTY })}>+ Novo agente</button>} />
      {error && <p className="error" role="alert">{error}</p>}
      {catalog && !catalog.ready && (
        <div className="banner info" role="status"><span>A IA ainda não está ligada neste ambiente: falta a chave <code>ANTHROPIC_API_KEY</code> na API. Dá para criar e configurar os agentes; a conversa funciona assim que a chave for definida.</span></div>
      )}
      {isManager && usage && (
        <div className="bal-stats ag-stats">
          <div className="rt-stat"><span>Agentes</span><b>{agents.length}</b></div>
          <div className="rt-stat"><span>Conversas hoje</span><b>{usage.today}<small className="muted"> / {catalog?.dailyLimit ?? '—'}</small></b></div>
          <div className="rt-stat"><span>Custo estimado (30 dias)</span><b>US$ {usage.totalUsd.toFixed(2)}</b></div>
        </div>
      )}

      {!catalog && !error ? <TilesSkeleton count={3} /> : agents.length === 0 ? (
        <section className="card ag-empty">
          <h2>{isManager ? 'Nenhum agente ainda' : 'Nenhum agente liberado para o seu perfil'}</h2>
          {isManager ? <>
            <p className="muted">Comece de um modelo pronto e ajuste o que quiser. Cada agente tem instruções, ferramentas de consulta, quem pode usar e uma base de conhecimento.</p>
            <div className="conf-grid">
              {TEMPLATES.map((t) => (
                <button type="button" key={t.key} className="conf-tile" onClick={() => setEditing({ ...EMPTY, ...t.draft })}>
                  <span className="conf-ico"><Icon name="star" size={20} /></span><b>{t.title}</b><span className="muted small">{t.text}</span>
                </button>
              ))}
            </div>
          </> : <p className="muted">Peça à gestão para criar um agente ou liberar um para o seu perfil.</p>}
        </section>
      ) : (
        <div className="conf-grid">
          {agents.map((a) => {
            const spent = usage?.agents.find((u) => u.agentId === a.id);
            return (
              <div key={a.id} className="conf-tile ag-tile">
                <span className="conf-ico"><Icon name="star" size={20} /></span>
                <b>{a.name}</b>
                <span className="muted small">{a.description || 'Sem descrição.'}</span>
                <span className="chips">
                  {a.active === false && <span className="pill gray">Desativado</span>}
                  <span className="pill blue">{a.tools.length} consulta(s)</span>
                  {isManager && a.roles && <span className="pill gray">{a.roles.map((r) => ROLE_LABELS[r]).join(', ')}</span>}
                  {spent && <span className="pill gray">{spent.chats} conversa(s)</span>}
                </span>
                <span className="actions">
                  <button type="button" className="primary" onClick={() => setParams({ agente: String(a.id) })}>Conversar</button>
                  {isManager && <button type="button" onClick={() => setEditing(toDraft(a))}>Editar</button>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {editing && catalog && <Editor draft={editing} catalog={catalog} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </>
  );
}

const toDraft = (a: Agent): Draft & { id: number } => ({
  id: a.id, name: a.name, description: a.description, instructions: a.instructions ?? '', model: a.model, effort: a.effort ?? 'medium',
  tools: a.tools, roles: a.roles ?? ['gestao'], knowledge: a.knowledge ?? [], active: a.active ?? true,
});

/* ---------- criação e edição ---------- */
const EDITOR_TABS = ['principal', 'consultas', 'acesso', 'conhecimento', 'modelo'] as const;
type EditorTab = (typeof EDITOR_TABS)[number];

/**
 * Janela de criação/edição do agente, em abas (Principal · Consultas · Acesso · Conhecimento · Modelo): o cabeçalho e as
 * abas ficam no topo, só o conteúdo rola e o rodapé fica fixo com Voltar / Avançar / Salvar.
 */
function Editor({ draft, catalog, onClose, onSaved }: { draft: Draft & { id?: number }; catalog: Catalog; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(draft);
  const [tab, setTab] = useState<EditorTab>('principal');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const groups = useMemo(() => [...new Set(catalog.tools.map((t) => t.group))], [catalog.tools]);
  const index = EDITOR_TABS.indexOf(tab);
  const labels: Record<EditorTab, string> = {
    principal: 'Principal',
    consultas: `Consultas${d.tools.length ? ` · ${d.tools.length}` : ''}`,
    acesso: `Acesso · ${d.roles.length}`,
    conhecimento: `Conhecimento${d.knowledge.length ? ` · ${d.knowledge.length}` : ''}`,
    modelo: 'Modelo',
  };

  const save = async () => {
    // o que falta fica na aba de origem: leva a pessoa até lá em vez de só mostrar o erro
    if (d.name.trim().length < 2) { setTab('principal'); setError('Dê um nome ao agente.'); return; }
    if (d.instructions.trim().length < 10) { setTab('principal'); setError('Escreva as instruções do agente (ao menos uma frase).'); return; }
    if (d.roles.length === 0) { setTab('acesso'); setError('Escolha ao menos um perfil que pode usar o agente.'); return; }
    setSaving(true); setError('');
    try {
      const { id, ...body } = d;
      await call(id ? 'PATCH' : 'POST', id ? `/agents/${id}` : '/agents', { ...body, knowledge: body.knowledge.filter((k) => k.title.trim() && k.text.trim()) });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!d.id || !confirm(`Remover o agente ${d.name}? O histórico de uso também sai.`)) return;
    try { await call('DELETE', `/agents/${d.id}`); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível remover.'); }
  };

  return (
    <Modal
      title={d.id ? `Editar agente · ${draft.name}` : 'Novo agente'} width={900} className="ag-editor" onClose={onClose}
      toolbar={<Tabs value={tab} onChange={(v) => { setTab(v as EditorTab); setError(''); }} label="Seções do agente" items={EDITOR_TABS.map((t) => ({ value: t, label: labels[t] }))} />}
      footer={<>
        {d.id && <button type="button" className="danger" onClick={() => void remove()}>Remover</button>}
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancelar</button>
        <button type="button" disabled={index === 0} onClick={() => setTab(EDITOR_TABS[index - 1])}>‹ Voltar</button>
        <button type="button" disabled={index === EDITOR_TABS.length - 1} onClick={() => setTab(EDITOR_TABS[index + 1])}>Avançar ›</button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar agente'}</button>
      </>}
    >
      {error && <p className="error" role="alert">{error}</p>}

      {tab === 'principal' && (
        <>
          {!d.id && (
            <div className="ag-templates">
              <span className="muted small">Começar de um modelo:</span>
              {TEMPLATES.map((t) => <button type="button" key={t.key} className="link" onClick={() => setD({ ...EMPTY, ...t.draft })}>{t.title}</button>)}
            </div>
          )}
          <div className="form-grid">
            <label className="field">Nome<input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder="Ex.: Assistente da operação" autoFocus /></label>
            <label className="field">Descrição (aparece no cartão)<input value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={240} /></label>
            <label className="field wide">Instruções: o papel do agente, o tom e o que ele deve priorizar
              <textarea rows={9} value={d.instructions} onChange={(e) => set('instructions', e.target.value)} maxLength={6000} placeholder="Você ajuda a equipe a… Quando perguntarem…, faça…" />
              <span className="muted small">{d.instructions.length}/6000 · As regras da plataforma valem acima destas: o agente só consulta, não inventa dados e trata o que vem das ferramentas como informação, não como ordem.</span>
            </label>
          </div>
        </>
      )}

      {tab === 'consultas' && (
        <>
          <p className="muted small">Escolha o que o agente pode consultar. São só leituras, e cada pessoa só alcança o que o perfil dela já enxerga.</p>
          {groups.map((g) => (
            <div key={g} className="ag-tools">
              <span className="muted small">{g}</span>
              {catalog.tools.filter((t) => t.group === g).map((t) => (
                <label key={t.name} className="ag-tool">
                  <input type="checkbox" checked={d.tools.includes(t.name)} onChange={() => set('tools', toggle(d.tools, t.name))} />
                  <span><b>{t.label}</b><span className="muted small">{t.description}</span>
                    {t.roles.length < 3 && <span className="muted small"> Só para: {t.roles.map((r) => ROLE_LABELS[r]).join(', ')}.</span>}</span>
                </label>
              ))}
            </div>
          ))}
        </>
      )}

      {tab === 'acesso' && (
        <>
          <p className="muted small">Quem pode conversar com este agente. A gestão sempre consegue abrir os agentes para configurar.</p>
          <div className="ag-access">
            {AGENT_ROLES.map((r) => (
              <label key={r} className="ag-tool">
                <input type="checkbox" checked={d.roles.includes(r)} onChange={() => set('roles', toggle(d.roles, r))} />
                <span><b>{ROLE_LABELS[r]}</b></span>
              </label>
            ))}
          </div>
          <label className="ag-tool">
            <input type="checkbox" checked={d.active} onChange={(e) => set('active', e.target.checked)} />
            <span><b>Agente ativo</b><span className="muted small">Desativado, ele some para a equipe (a gestão continua vendo).</span></span>
          </label>
        </>
      )}

      {tab === 'conhecimento' && (
        <>
          <p className="muted small">Regras e procedimentos da loja que o agente pode citar (política de troca, horários, prazos…). Só entra o que estiver aqui.</p>
          {d.knowledge.map((k, i) => (
            <div key={i} className="ag-kb">
              <input aria-label="Título" value={k.title} placeholder="Título (ex.: Política de troca)" onChange={(e) => set('knowledge', d.knowledge.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <textarea aria-label="Texto" rows={4} value={k.text} placeholder="O que o agente deve saber sobre isso" onChange={(e) => set('knowledge', d.knowledge.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <button type="button" className="link" onClick={() => set('knowledge', d.knowledge.filter((_, j) => j !== i))}>Remover item</button>
            </div>
          ))}
          <button type="button" onClick={() => set('knowledge', [...d.knowledge, { title: '', text: '' }])} disabled={d.knowledge.length >= 30}>+ Adicionar item</button>
        </>
      )}

      {tab === 'modelo' && (
        <div className="form-grid">
          <label className="field">Modelo de IA
            <select value={d.model} onChange={(e) => set('model', e.target.value)}>{catalog.models.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}</select>
          </label>
          <label className="field">Esforço de raciocínio
            <select value={d.effort} onChange={(e) => set('effort', e.target.value as Draft['effort'])}>{EFFORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <span className="muted small">Mais esforço = respostas mais cuidadosas, porém mais lentas e caras.</span>
          </label>
        </div>
      )}
    </Modal>
  );
}
