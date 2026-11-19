import { useState } from 'react';
import { IonContent, IonIcon, IonPage } from '@ionic/react';
import { busOutline } from 'ionicons/icons';
import { useSession } from '../session';

export function Login() {
  const { login, env, quickLogin } = useSession();
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const testing = env?.environment === 'teste' && env.quickLogin.length > 0;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // ambiente de teste: senha em branco entra só com o e-mail (ou o início dele)
    const err = testing && !password ? await quickLogin({ email: email.trim() }) : await login(email.trim(), password);
    setBusy(false);
    if (err) setError(err);
  };

  const enter = async (role: string) => {
    if (quickBusy) return;
    setError('');
    setQuickBusy(role);
    const err = await quickLogin(role);
    setQuickBusy(null);
    if (err) setError(err);
  };

  return (
    <IonPage>
      <IonContent>
        <form className="r-login" onSubmit={(e) => void submit(e)}>
          <div className="r-logo"><span><IonIcon icon={busOutline} /></span><b>RotaCerta</b></div>
          <div>
            <h1 className="r-display">Sua rota de hoje começa aqui.</h1>
            <p className="r-muted">Entre com o e-mail e a senha que a loja cadastrou para você.</p>
          </div>
          {testing && (
            <div className="r-quick" role="group" aria-label="Ambiente de teste: entrar como">
              <span className="r-pill amber">Ambiente de teste</span>
              <div className="r-quick-grid">
                {env.quickLogin.map((p) => (
                  <button key={p.role} type="button" className="r-btn" disabled={quickBusy !== null} onClick={() => void enter(p.role)}>
                    {quickBusy === p.role ? 'Entrando…' : p.label}
                  </button>
                ))}
              </div>
              <p className="r-small r-muted" style={{ margin: 0 }}>Este app é do motorista; os outros perfis abrem um aviso. Para usar o sistema completo, entre pelo navegador.</p>
            </div>
          )}
          <label className="r-field">E-mail
            <input className="r-input" type={testing ? 'text' : 'email'} autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="r-field">Senha
            <input className="r-input" type="password" autoComplete="current-password" required={!testing} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="r-error" role="alert">{error}</p>}
          <button className="r-btn primary" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
          <p className="r-small r-muted">Esqueceu a senha? Peça uma nova para a gestão da loja.</p>
        </form>
      </IonContent>
    </IonPage>
  );
}
