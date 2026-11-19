import { useRef, useState, type FormEvent } from 'react';
import { GlowCard } from '../app/GlowCard';
import { Icon, Logo } from '../app/icons';
import { RouteMap } from '../app/RouteMap';
import { SlideUpText } from '../app/SlideUpText';
import { useStore } from '../app/store';
import { InstallCard } from './InstallCard';

/** O que cada perfil faz, para escolher com um olhar (o nome da pessoa de demonstração não ajuda). */
const ROLE_HINT: Record<string, string> = {
  gestao: 'Painel, usuários e configurações', atendente: 'Cadastro de entregas e clientes', expedicao: 'Cargas, conferência e viagens',
  motorista: 'Entregas na rua', plataforma: 'Painel de empresas',
};

export function Login() {
  const { login, problem, clearProblem, env, quickLogin } = useStore();
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const testing = env?.environment === 'teste' && env.quickLogin.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    clearProblem();
    setBusy(true);
    // ambiente de teste: senha em branco entra só com o e-mail (ou o início dele, como "gestao")
    const err = testing && !password ? await quickLogin({ email: email.trim() }) : await login(email.trim(), password);
    setBusy(false);
    if (err) setError(err);
  };

  const enter = async (role: string) => {
    if (quickBusy) return;
    setError('');
    clearProblem();
    setQuickBusy(role);
    const err = await quickLogin(role);
    setQuickBusy(null);
    if (err) setError(err);
  };

  return (
    <div className="signin">
      <RouteMap area={mapRef} />
      <aside className="signin-map">
        <Logo />
        <div className="signin-route-area" ref={mapRef} aria-hidden="true" />
        <div className="signin-copy">
          <span className="signin-tag">Do caixa à porta do cliente</span>
          <h1><SlideUpText delay={0.2}>{'Entregas organizadas.\nClientes avisados.'}</SlideUpText></h1>
          <p>Atendimento, expedição e motorista no mesmo fluxo. Cada pessoa com o que precisa para seguir.</p>
        </div>
      </aside>
      <main className="signin-side">
        <GlowCard className="signin-form">
          <div className="signin-heading">
            <span className="signin-eyebrow">RotaCerta · Acesso à loja</span>
            <h2><SlideUpText delay={0.3}>{'Sua operação\ncomeça aqui.'}</SlideUpText></h2>
            <p className="muted">{testing ? 'Ambiente de teste: a senha é opcional.' : 'Use o e-mail e a senha fornecidos pela loja.'}</p>
          </div>
          {testing && (
            <section className="quick-login" aria-label="Ambiente de teste: entrar como">
              <div className="quick-head"><span className="quick-tag">Ambiente de teste</span><span className="muted small">Entre com um clique, sem senha</span></div>
              <div className="quick-grid">
                {env.quickLogin.map((p) => (
                  <button key={p.role} type="button" className="quick-btn" disabled={quickBusy !== null} aria-busy={quickBusy === p.role} onClick={() => void enter(p.role)}>
                    <b>{quickBusy === p.role ? 'Entrando…' : p.label}</b>
                    <span className="muted small">{ROLE_HINT[p.role] ?? p.name}</span>
                  </button>
                ))}
              </div>
              <p className="quick-or"><span>ou entre com e-mail e senha</span></p>
            </section>
          )}
          <form onSubmit={submit}>
            <label className="field">E-mail
              <input type={testing ? 'text' : 'email'} autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={testing ? 'gestao ou gestao@rotacerta.local' : undefined} />
            </label>
            <label className="field"><span>Senha{testing && <span className="muted small"> (opcional no teste)</span>}</span>
              <span className="pw">
                <input type={visible ? 'text' : 'password'} autoComplete="current-password" required={!testing} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={visible} onClick={() => setVisible((v) => !v)}>
                  <Icon name={visible ? 'eyeOff' : 'eye'} />
                </button>
              </span>
            </label>
            {(error || problem) && <p className="error" role="alert">{error || problem}</p>}
            <button type="submit" className="signin-submit" disabled={busy} aria-busy={busy}>
              <span className="signin-submit-icon" aria-hidden="true">
                {busy ? <span className="signin-submit-spinner" /> : <Icon name="arrow" size={19} />}
              </span>
              <span className="signin-submit-label" aria-live="polite">{busy ? 'Entrando…' : 'Entrar'}</span>
            </button>
          </form>
          <p className="muted small">Esqueceu a senha? Peça uma nova para a gestão da loja.</p>
          <InstallCard compact />
        </GlowCard>
      </main>
    </div>
  );
}
