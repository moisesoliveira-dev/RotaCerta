import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  BOX_TYPE_LABELS, confirmedCount, orderChecked, routeOrders, volumesOf, volumesSignature,
  type Order, type Route as RouteT,
} from '@rotacerta/domain';
import { useStore } from '../app/store';
import { Icon } from '../app/icons';
import { Empty, Header } from './ui';
import { Etiquetas } from './Etiquetas';
import { useFeedback } from '../app/feedback';

export function Carregamento() {
  return (
    <Routes>
      <Route index element={<Lista />} />
      <Route path="etiquetas/:routeId" element={<Etiquetas />} />
      <Route path="*" element={<Navigate to="/carregamento" replace />} />
    </Routes>
  );
}

function Lista() {
  const { data } = useStore();
  const loading = data.routes.filter((r) => r.status === 'loading');
  return (
    <>
      <Header title="Carregamento" subtitle="Nada fica para trás: confira fisicamente as caixas e os itens separados."
        actions={<Link className="btn" to="/expedicao">Montar nova carga</Link>} />
      {loading.length === 0 ? (
        <section className="card"><Empty>Nenhuma carga em conferência. Monte uma carga na expedição para começar.</Empty></section>
      ) : loading.map((r) => <Conferencia key={r.id} route={r} />)}
      <p className="muted small">O romaneio só fica disponível ao motorista depois que todos os pedidos forem conferidos e confirmados. Nenhum aviso ao cliente é disparado nesta etapa.</p>
    </>
  );
}

const norm = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
type Flash = { tone: 'ok' | 'warn' | 'bad'; text: string };

/** Conferência: campo de leitura no topo, pedidos à esquerda com o andamento e os volumes do pedido escolhido à direita. */
function Conferencia({ route }: { route: RouteT }) {
  const { confirm, toast } = useFeedback();
  const { data, setChecked, confirmOrder, releaseRoute, discardRoute, syncConference } = useStore();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [selId, setSelId] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const orders = routeOrders(data, route);

  // Se os volumes de um pedido mudaram depois de conferidos, a conferência dele recomeça.
  const signature = orders.map(volumesSignature).join('|');
  useEffect(() => { syncConference(route.id); }, [signature, route.id, syncConference]);

  const volumes = orders.flatMap(volumesOf);
  const done = volumes.filter((v) => route.checked?.[v.key]).length;
  const confirmed = confirmedCount(route);
  const complete = volumes.length > 0 && done === volumes.length && confirmed === orders.length;
  const vehicle = data.vehicles.find((v) => v.id === route.vehicleId);
  const driver = data.drivers.find((d) => d.id === route.driverId);
  // sem escolha, o foco vai para o primeiro pedido que ainda tem volume por conferir
  const firstOpen = orders.find((o) => !route.confirmed?.[String(o.id)] && !orderChecked(route, o)) ?? orders.find((o) => !route.confirmed?.[String(o.id)]) ?? orders[0];
  const selected = orders.find((o) => o.id === selId) ?? firstOpen;
  const missing = volumes.filter((v) => !route.checked?.[v.key]);

  const confirmPedido = (orderId: number) => { const err = confirmOrder(route.id, orderId); setError(err ?? ''); };
  const release = () => {
    const err = releaseRoute(route.id);
    if (err) setError(err); else navigate('/romaneios');
  };

  /** Enter no campo: confere a caixa pelo código da etiqueta e leva ao pedido dela. */
  const scan = (raw: string) => {
    const code = norm(raw);
    setTyped('');
    scanRef.current?.focus();
    if (!code) return;
    const hit = orders.flatMap((o) => volumesOf(o).map((v) => ({ v, o }))).find(({ v }) => norm(v.label) === code);
    if (!hit) { setFlash({ tone: 'bad', text: `${raw.trim().toUpperCase()}: este código não está nesta carga. Confira a etiqueta.` }); return; }
    setSelId(hit.o.id);
    if (route.confirmed?.[String(hit.o.id)]) { setFlash({ tone: 'warn', text: `${hit.v.label} é do pedido #${hit.o.id}, que já está confirmado. Reabra o pedido para alterar.` }); return; }
    if (route.checked?.[hit.v.key]) { setFlash({ tone: 'warn', text: `${hit.v.label} já estava conferida (pedido #${hit.o.id}).` }); return; }
    setChecked(route.id, [hit.v.key], true);
    setFlash({ tone: 'ok', text: `${hit.v.label} conferida: pedido #${hit.o.id} · ${hit.o.name}. Guardar em ${hit.v.location}.` });
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Romaneio #{route.id}</h2>
        <span className="muted">{vehicle?.name} · saída {route.departure}{driver ? ` · ${driver.name}` : ''}</span>
        <span className={`pill ${complete ? 'green' : 'amber'}`}>{done} de {volumes.length} volumes · {confirmed} de {orders.length} pedidos confirmados</span>
      </div>
      <div className="bar-track" aria-hidden><i style={{ width: `${volumes.length ? (done / volumes.length) * 100 : 0}%` }} /></div>

      <form className="cg-scan" onSubmit={(e) => { e.preventDefault(); scan(typed); }}>
        <Icon name="search" size={22} />
        <input ref={scanRef} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false}
          aria-label="Leia ou digite o código da caixa e aperte Enter" placeholder="Leia ou digite o código da caixa (ex.: CX-036) e Enter" />
      </form>
      <div className={flash ? `cg-flash ${flash.tone}` : 'cg-flash idle'} role="status" aria-live="polite">
        {flash ? flash.text : 'Leia a etiqueta de cada caixa: o sistema marca sozinho e avisa se a caixa não é desta carga. Também dá para marcar à mão no pedido ao lado.'}
      </div>

      <div className="cg-split">
        <ul className="cg-orders" aria-label="Pedidos da carga">
          {orders.map((o, i) => {
            const vols = volumesOf(o);
            const n = vols.filter((v) => route.checked?.[v.key]).length;
            const ok = !!route.confirmed?.[String(o.id)];
            return (
              <li key={o.id}>
                <button type="button" className={`cg-order ${o.id === selected?.id ? 'on' : ''}`} aria-current={o.id === selected?.id} onClick={() => setSelId(o.id)}>
                  <span className={`cg-dot ${ok ? 'ok' : n ? 'part' : ''}`} aria-hidden="true">{ok ? '✓' : ''}</span>
                  <span className="cg-order-text"><b>{i + 1}. #{o.id} · {o.name}</b><small>{o.neighborhood} · {n}/{vols.length} volumes{ok ? ' · confirmado' : ''}</small></span>
                </button>
              </li>
            );
          })}
        </ul>
        {selected && <Pedido key={selected.id} route={route} order={selected} stop={orders.indexOf(selected) + 1} onCheck={setChecked} onConfirm={confirmPedido} />}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {!complete && (
        <p className="muted small">Falta conferir {missing.length} volume(s) e confirmar {orders.length - confirmed} pedido(s), inclusive os do frio, para liberar o romaneio.
          {missing.length > 0 && missing.length <= 6 && <> Faltam: {missing.map((v) => v.label).join(', ')}.</>}</p>
      )}
      <div className="bar">
        <button type="button" className="primary" disabled={!complete} onClick={release}>Liberar romaneio ao motorista</button>
        <Link className="btn" to={`etiquetas/${route.id}`}>Etiquetas</Link>
        <button type="button" onClick={() => navigate('/expedicao')}>Continuar depois</button>
        <button type="button" className="danger" onClick={async () => { if (await confirm({ title: `Desfazer a carga #${route.id}?`, message: 'As entregas voltam para a fila.', confirmLabel: 'Desfazer carga', danger: true })) { discardRoute(route.id); toast('Carga desfeita. As entregas voltaram para a fila.'); } }}>Desfazer carga</button>
      </div>
      <p className="muted small">A conferência fica salva neste navegador. Para retomar, volte em Carregamento ou use "Retomar conferência" na expedição.</p>
    </section>
  );
}

function Pedido({ route, order: o, stop, onCheck, onConfirm }: {
  route: RouteT; order: Order; stop: number;
  onCheck: (routeId: number, keys: string[], value: boolean) => void;
  onConfirm: (orderId: number) => void;
}) {
  const vols = volumesOf(o);
  const all = orderChecked(route, o);
  const confirmed = !!route.confirmed?.[String(o.id)];
  return (
    <div className={`conf-order cg-detail ${confirmed ? 'confirmed' : ''}`}>
      <div className="card-head">
        <strong>{stop}. #{o.id} · {o.name}</strong>
        <span className="muted small">{o.neighborhood}</span>
        {confirmed && <span className="pill green">Pedido confirmado</span>}
        <button type="button" disabled={confirmed} onClick={() => onCheck(route.id, vols.map((v) => v.key), !all)}>{all ? 'Desmarcar todos' : 'Marcar todos'}</button>
      </div>
      {vols.length === 0 ? <p className="error">Esta entrega não tem volumes cadastrados.</p> : vols.map((v) => {
        const a = route.audit?.[v.key];
        return (
          <label className={`conf-vol ${route.checked?.[v.key] ? 'ok' : ''}`} key={v.key}>
            <input type="checkbox" checked={!!route.checked?.[v.key]} disabled={confirmed}
              onChange={(e) => onCheck(route.id, [v.key], e.target.checked)} />
            <span className="grow">
              <strong>{v.label}</strong><span className="muted small"> · {v.location}</span>
              {a?.checked && <span className="muted small audit">Conferido por {a.actor} às {a.at}</span>}
            </span>
            {v.type === 'cold' || v.type === 'frozen'
              ? <span className="pill blue">{BOX_TYPE_LABELS[v.type]}</span>
              : v.type === 'extra' ? <span className="pill amber">Fora da caixa</span> : null}
          </label>
        );
      })}
      {!confirmed && vols.length > 0 && (
        <div className="bar" style={{ marginTop: 8 }}>
          <button type="button" disabled={!all} onClick={() => onConfirm(o.id)}>Confirmar pedido</button>
          {!all && <span className="muted small">Marque todos os volumes para confirmar.</span>}
        </div>
      )}
      {confirmed && <button type="button" className="textbtn" onClick={() => onCheck(route.id, vols.map((v) => v.key), false)}>Reabrir pedido (desmarca os volumes)</button>}
    </div>
  );
}
