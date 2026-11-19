import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../pages/ui';

/**
 * Retorno ao usuário em um lugar só (heurísticas de Nielsen: visibilidade do estado, prevenção de erros, consistência):
 * - `confirm`: pergunta antes de uma ação destrutiva, com o verbo da ação no botão (nada de "OK/Cancelar" do navegador);
 * - `ask`: pede um texto curto (renomear), com o campo já preenchido;
 * - `toast`: confirma que deu certo, sem bloquear; fala com leitor de tela (aria-live) e some sozinho.
 */
interface ConfirmOptions { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
interface AskOptions { title: string; label: string; initial?: string; confirmLabel?: string; maxLength?: number }
type Tone = 'success' | 'info' | 'error';
interface Toast { id: number; text: string; tone: Tone }
interface Api {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  ask: (o: AskOptions) => Promise<string | null>;
  toast: (text: string, tone?: Tone) => void;
}

const Ctx = createContext<Api | null>(null);
export const useFeedback = (): Api => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFeedback fora do FeedbackProvider.');
  return v;
};

type Pending =
  | { kind: 'confirm'; o: ConfirmOptions; done: (v: boolean) => void }
  | { kind: 'ask'; o: AskOptions; done: (v: string | null) => void };

const TOAST_MS = 4500;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((done) => setPending({ kind: 'confirm', o, done })), []);
  const ask = useCallback((o: AskOptions) => new Promise<string | null>((done) => setPending({ kind: 'ask', o, done })), []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text: string, tone: Tone = 'success') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => dismiss(id), TOAST_MS);
  }, [dismiss]);

  const api = useMemo<Api>(() => ({ confirm, ask, toast }), [confirm, ask, toast]);
  const close = (v: boolean | string | null) => {
    if (!pending) return;
    (pending.done as (x: boolean | string | null) => void)(v);
    setPending(null);
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {pending?.kind === 'confirm' && (
        <Modal title={pending.o.title} width={440} icon={pending.o.danger ? 'alert' : undefined} tone={pending.o.danger ? 'danger' : 'info'} onClose={() => close(false)}
          footer={<>
            <button type="button" onClick={() => close(false)}>{pending.o.cancelLabel ?? 'Cancelar'}</button>
            <button type="button" className={pending.o.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus={!pending.o.danger}>{pending.o.confirmLabel ?? 'Confirmar'}</button>
          </>}>
          {pending.o.message && <p>{pending.o.message}</p>}
        </Modal>
      )}
      {pending?.kind === 'ask' && <AskDialog o={pending.o} onDone={close} />}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : undefined}>
            <span>{t.text}</span>
            <button type="button" className="toast-x" aria-label="Fechar aviso" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function AskDialog({ o, onDone }: { o: AskOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(o.initial ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  const ok = value.trim().length > 0;
  return (
    <Modal title={o.title} width={440} onClose={() => onDone(null)}
      footer={<><button type="button" onClick={() => onDone(null)}>Cancelar</button><button type="button" className="primary" disabled={!ok} onClick={() => onDone(value.trim())}>{o.confirmLabel ?? 'Salvar'}</button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (ok) onDone(value.trim()); }}>
        <label className="field">{o.label}
          <input ref={input} value={value} maxLength={o.maxLength ?? 80} onChange={(e) => setValue(e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}
