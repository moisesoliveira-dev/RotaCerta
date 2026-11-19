import { useState } from 'react';
import { useStore } from './store';

/**
 * Só aparece no ambiente de TESTE: selo "Teste" e um seletor para trocar de perfil sem sair nem digitar senha.
 * Em produção (ou sem resposta da API) não renderiza nada.
 */
export function TestProfileSwitch({ currentRole }: { currentRole: string | null }) {
  const { env, quickLogin } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (env?.environment !== 'teste' || env.quickLogin.length === 0) return null;

  const change = async (role: string) => {
    if (role === currentRole || busy) return;
    setBusy(true);
    setError('');
    const err = await quickLogin(role);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <span className="test-switch" title={error || 'Ambiente de teste: troque de perfil sem sair'}>
      <span className="test-tag">Teste</span>
      <select aria-label="Trocar de perfil (ambiente de teste)" value={currentRole ?? ''} disabled={busy} onChange={(e) => void change(e.target.value)}>
        {env.quickLogin.map((p) => <option key={p.role} value={p.role}>{p.label}</option>)}
      </select>
      {error && <span className="test-error" role="alert">{error}</span>}
    </span>
  );
}
