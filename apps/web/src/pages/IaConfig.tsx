import { useCallback, useEffect, useState } from 'react';
import { call } from '../app/api';
import { Icon } from '../app/icons';

interface Settings { enabled: boolean; defaultModel: string; defaultEffort: 'low' | 'medium' | 'high'; dailyLimit: number | null; companyContext: string; updatedBy: string; updatedAt: string | null }
interface Status { keyConfigured: boolean; serverLimit: number; effectiveLimit: number; todayChats: number }
interface Response { settings: Settings; status: Status; models: string[] }
interface Usage { days: number; totalUsd: number; today: number }

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 · mais capaz',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 · equilíbrio entre custo e qualidade',
  'claude-haiku-5-5': 'Claude Haiku 5.5 · mais rápido e barato',
};
const EFFORTS: Array<[Settings['defaultEffort'], string, string]> = [
  ['low', 'Rápido', 'respostas curtas e baratas'],
  ['medium', 'Equilibrado', 'o melhor para o dia a dia'],
  ['high', 'Caprichado', 'raciocina mais; custa mais'],
];
const CONTEXT_MAX = 2000;

/** Configurações > Inteligência artificial: liga e desliga, modelo padrão, limite diário e o contexto comum dos agentes. */
export function IaConfig() {
  const [data, setData] = useState<Response | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, u] = await Promise.all([call<Response>('GET', '/ai/settings'), call<Usage>('GET', '/agents/usage?days=30')]);
      setData(r); setDraft(r.settings); setUsage(u);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não consegui carregar os ajustes da IA.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!data || !draft) return <section className="card" aria-busy={!error}>{error ? <p className="error" role="alert">{error}</p> : <p className="muted">Carregando…</p>}</section>;

  const { status } = data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setDraft({ ...draft, [k]: v }); setSaved(''); };

  const save = async () => {
    setSaving(true); setError(''); setSaved('');
    try {
      await call('PUT', '/ai/settings', { enabled: draft.enabled, defaultModel: draft.defaultModel, defaultEffort: draft.defaultEffort, dailyLimit: draft.dailyLimit, companyContext: draft.companyContext });
      setSaved('Ajustes salvos.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não consegui salvar.'); } finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const r = await call<{ model: string; ms: number }>('POST', '/ai/test');
      setTest({ ok: true, text: `Conexão funcionando: ${MODEL_LABELS[r.model] ?? r.model} respondeu em ${(r.ms / 1000).toFixed(1)} s.` });
    } catch (e) { setTest({ ok: false, text: e instanceof Error ? e.message : 'O teste falhou.' }); } finally { setTesting(false); }
  };

  return (
    <div className="ia-cfg">
      <section className="card ia-status" aria-label="Estado da IA">
        <div className="ia-status-row">
          <span className={`ia-dot ${status.keyConfigured ? (draft.enabled ? 'ok' : 'off') : 'bad'}`} aria-hidden="true" />
          <div>
            <b>{!status.keyConfigured ? 'Sem chave da Anthropic' : data.settings.enabled ? 'IA ligada' : 'IA desligada pela gestão'}</b>
            <p className="muted small">
              {!status.keyConfigured
                ? 'A chave é um segredo do servidor: defina ANTHROPIC_API_KEY na API e reinicie. Ela nunca aparece nem é guardada nesta tela.'
                : `${status.todayChats} de ${status.effectiveLimit} conversas usadas hoje${usage ? ` · gasto estimado nos últimos ${usage.days} dias: US$ ${usage.totalUsd.toFixed(2)}` : ''}.`}
            </p>
          </div>
          <button type="button" onClick={() => void runTest()} disabled={!status.keyConfigured || testing}>{testing ? 'Testando…' : 'Testar conexão'}</button>
        </div>
        {test && <p className={test.ok ? 'ia-test ok' : 'error'} role={test.ok ? 'status' : 'alert'}>{test.text}</p>}
      </section>

      <section className="card ia-form">
        <label className="ia-switch">
          <input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span><b>Usar IA nesta empresa</b><small className="muted">Desligada, os agentes continuam configuráveis, mas ninguém consegue conversar com eles.</small></span>
        </label>

        <label className="field">Modelo padrão dos novos agentes
          <select value={draft.defaultModel} onChange={(e) => set('defaultModel', e.target.value)}>
            {data.models.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
          </select>
          <small className="muted">Cada agente ainda pode escolher o próprio modelo no editor.</small>
        </label>

        <fieldset className="ia-effort">
          <legend>Esforço padrão</legend>
          {EFFORTS.map(([v, label, hint]) => (
            <label key={v} className={draft.defaultEffort === v ? 'on' : ''}>
              <input type="radio" name="ia-effort" checked={draft.defaultEffort === v} onChange={() => set('defaultEffort', v)} />
              <b>{label}</b><small className="muted">{hint}</small>
            </label>
          ))}
        </fieldset>

        <label className="field">Limite diário de conversas
          <input type="number" min={1} max={status.serverLimit} inputMode="numeric" value={draft.dailyLimit ?? ''} placeholder={`Sem limite próprio (teto do servidor: ${status.serverLimit})`}
            onChange={(e) => set('dailyLimit', e.target.value === '' ? null : Math.max(1, Math.round(Number(e.target.value))))} />
          <small className="muted">Controla o gasto. Vale por dia e por empresa; não pode passar do teto do servidor ({status.serverLimit}).</small>
        </label>

        <label className="field">Contexto da empresa
          <textarea rows={6} maxLength={CONTEXT_MAX} value={draft.companyContext} onChange={(e) => set('companyContext', e.target.value)}
            placeholder="Ex.: Somos o Mercado Bom Preço, em Campinas. Falamos de forma simpática e direta. Entregamos das 8h às 20h. Nunca prometa horário exato." />
          <small className="muted">{draft.companyContext.length} / {CONTEXT_MAX} · Entra nas instruções de todos os agentes, abaixo das regras da plataforma. Não coloque senhas nem dados pessoais de clientes.</small>
        </label>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="ia-actions">
          <button type="button" className="primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Salvando…' : 'Salvar ajustes'}</button>
          {dirty && <button type="button" onClick={() => { setDraft(data.settings); setError(''); }}>Descartar</button>}
          {saved && <span className="ia-saved" role="status"><Icon name="check" size={16} /> {saved}</span>}
          {data.settings.updatedBy && data.settings.updatedAt && <small className="muted ia-by">Última alteração: {data.settings.updatedBy}, {new Date(data.settings.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>}
        </div>
      </section>
    </div>
  );
}
