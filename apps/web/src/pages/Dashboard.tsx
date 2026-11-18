import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { call } from '../app/api';
import { useStore } from '../app/store';
import { Icon } from '../app/icons';
import { Counter, Item, Stagger } from '../app/motion';
import { OrderDetail } from './OrderDetail';
import { Header, OrderPill } from './ui';
import { TrackMap, type Live } from './Acompanhamento';

const today = () => new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const doneStatuses = new Set(['delivered', 'failed']);

/** Visão executiva combinada à torre de controle: resultado, rotas ao vivo e exceções no mesmo painel. */
export function Dashboard() {
  const { data, subscribeLocations } = useStore();
  const [openId, setOpenId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [live, setLive] = useState<Live[]>([]);
  const [trackingLoaded, setTrackingLoaded] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const count = (status: string) => data.orders.filter((o) => o.status === status).length;
  const total = data.orders.length;
  const delivered = count('delivered');
  const failed = count('failed');
  const onroute = count('onroute');
  const activeRoutes = data.routes.filter((r) => r.status === 'active');
  const eligible = data.orders.filter((o) => !['cancelled', 'draft'].includes(o.status)).length;
  const completion = eligible ? Math.round((delivered / eligible) * 100) : 0;
  const attention = failed + count('awaiting');

  const loadTracking = useCallback(() => call<Live[]>('GET', '/tracking')
    .then((rows) => {
      setLive(rows);
      setSelectedRoute((current) => current !== null && rows.some((r) => r.routeId === current) ? current : rows[0]?.routeId ?? null);
    })
    .catch(() => setLive([]))
    .finally(() => setTrackingLoaded(true)), []);

  useEffect(() => { void loadTracking(); }, [loadTracking, data.routes]);
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); void loadTracking(); }, 30_000);
    return () => clearInterval(timer);
  }, [loadTracking]);
  useEffect(() => subscribeLocations((message) => {
    setLive((rows) => rows.map((row) => row.routeId === message.routeId
      ? { ...row, last: { lat: message.lat, lng: message.lng, accuracy: message.accuracy, speed: message.speed, heading: message.heading, recordedAt: message.recordedAt } }
      : row));
    setNow(Date.now());
  }), [subscribeLocations]);

  const selectedLive = live.find((route) => route.routeId === selectedRoute) ?? live[0] ?? null;

  const active = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.orders
      .filter((o) => !['delivered', 'cancelled', 'draft'].includes(o.status))
      .filter((o) => !normalized || o.name.toLowerCase().includes(normalized) || String(o.id).includes(normalized))
      .slice(0, 6);
  }, [data.orders, query]);

  const flow = [
    ['Aguardando volumes', count('awaiting')],
    ['Prontas', count('ready') + count('queued')],
    ['Carregando', count('loading') + count('released')],
    ['Em rota', onroute],
    ['Entregues', delivered],
  ] as const;

  const routeProgress = (routeId: number) => {
    const route = data.routes.find((item) => item.id === routeId);
    if (!route?.orders.length) return 0;
    const done = route.orders.filter((id) => doneStatuses.has(data.orders.find((order) => order.id === id)?.status ?? '')).length;
    return Math.round((done / route.orders.length) * 100);
  };

  return (
    <>
      <Header title="Visão executiva" subtitle={`${today()} · operação em tempo real`} actions={<>
        <label className="rt-search"><Icon name="search" size={18} />
          <input type="search" aria-label="Buscar entrega" placeholder="Buscar entrega" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Link to="/acompanhamento" className="btn"><Icon name="pin" size={17} /> Abrir torre</Link>
        <Link to="/atendimento/nova" className="btn primary">Nova entrega</Link>
      </>} />

      <Stagger className="rt-stats mg-kpis">
        <Item className="rt-stat"><span>Entregas cadastradas</span><b><Counter to={total} /></b><small>{delivered} concluídas</small></Item>
        <Item className="rt-stat"><span>Taxa de conclusão</span><b className="green"><Counter to={completion} />%</b><small>das entregas válidas</small></Item>
        <Item className="rt-stat"><span>Em rota agora</span><b className="blue"><Counter to={onroute} /></b><small>{activeRoutes.length} romaneio(s) ativo(s)</small></Item>
        <Item className="rt-stat"><span>Precisam de atenção</span><b className={attention ? 'red' : 'green'}><Counter to={attention} /></b><small>{failed} não entregue(s) · {count('awaiting')} sem volumes</small></Item>
      </Stagger>

      <section className="mg-control-grid">
        <article className="card mg-map-card" aria-label="Torre de controle">
          <div className="mg-card-head">
            <div><span className="eyebrow">Torre de controle</span><h2>Rotas em tempo real</h2></div>
            <span className={`mg-live ${live.some((route) => route.last) ? 'on' : ''}`}><i />{live.some((route) => route.last) ? 'GPS ao vivo' : trackingLoaded ? 'Aguardando GPS' : 'Conectando'}</span>
          </div>
          <TrackMap live={live} selected={selectedLive} trail={[]} now={now} follow={false} onSelect={setSelectedRoute} onUserMove={() => undefined} />
          <div className="rt-legend">
            <span><i className="dot green" />Ao vivo</span><span><i className="dot amber" />Sinal fraco</span><span><i className="dot gray" />Sem posição</span>
          </div>
        </article>

        <aside className="mg-control-side">
          <article className="card mg-routes" aria-label="Rotas ativas">
            <div className="mg-card-head"><h2>Rotas ativas</h2><Link to="/acompanhamento" className="rt-link">Acompanhar</Link></div>
            {activeRoutes.length === 0 && <p className="empty">Nenhuma rota em andamento.</p>}
            {activeRoutes.map((route) => {
              const driver = data.drivers.find((item) => item.id === route.driverId)?.name ?? 'Sem motorista';
              const vehicle = data.vehicles.find((item) => item.id === route.vehicleId)?.name ?? 'Veículo';
              const progress = routeProgress(route.id);
              const position = live.find((item) => item.routeId === route.id)?.last;
              return <button type="button" key={route.id} className={`mg-route ${selectedRoute === route.id ? 'on' : ''}`} onClick={() => setSelectedRoute(route.id)}>
                <span><b>Romaneio #{route.id}</b><small>{driver} · {vehicle}</small></span>
                <span className={`pill ${position ? 'green' : 'amber'}`}>{position ? 'Ao vivo' : 'Sem posição'}</span>
                <span className="mg-progress"><i style={{ width: `${progress}%` }} /></span><small>{progress}% concluído</small>
              </button>;
            })}
          </article>

          <article className="card mg-alerts" aria-label="Alertas da operação">
            <div className="mg-card-head"><h2>Requer atenção</h2><span className={`pill ${attention ? 'red' : 'green'}`}>{attention}</span></div>
            {failed > 0 && <Link to="/entregas" className="mg-alert red"><span><Icon name="alert" size={18} /></span><div><b>{failed} entrega(s) não realizada(s)</b><small>Aguardando retorno ou nova tentativa.</small></div><Icon name="arrow" size={17} /></Link>}
            {count('awaiting') > 0 && <Link to="/pendencias" className="mg-alert amber"><span><Icon name="box" size={18} /></span><div><b>{count('awaiting')} entrega(s) sem volumes</b><small>O atendimento ainda precisa ser concluído.</small></div><Icon name="arrow" size={17} /></Link>}
            {attention === 0 && <p className="empty">Nenhuma pendência crítica agora.</p>}
          </article>
        </aside>
      </section>

      <section className="mg-bottom-grid">
        <article className="card mg-flow" aria-label="Desempenho da operação">
          <div className="mg-card-head"><div><span className="eyebrow">Desempenho</span><h2>Fluxo das entregas</h2></div><Link to="/entregas" className="rt-link">Ver todas</Link></div>
          <div className="mg-flow-grid">{flow.map(([label, value], index) => <div key={label} className={index === flow.length - 1 ? 'done' : ''}>
            <span>{label}</span><b>{value}</b><i><span style={{ width: `${total ? Math.max(5, value / total * 100) : 0}%` }} /></i>
          </div>)}</div>
        </article>

        <article className="card rt-panel mg-orders" aria-label="Entregas em andamento">
          <div className="rt-panel-head"><div><span className="eyebrow">Operação</span><h2>Entregas em andamento</h2></div><Link to="/entregas" className="rt-link">Ver todas</Link></div>
          {active.length === 0 && <p className="empty">Nenhuma entrega em andamento{query ? ' para essa busca' : ''}.</p>}
          <Stagger as="ul" className="rt-rows" count={active.length}>{active.map((order) => <Item as="li" key={order.id}>
            <button type="button" className="rt-row" onClick={() => setOpenId(order.id)} aria-label={`Detalhes da entrega #${order.id}, ${order.name}`}>
              <span className="rt-name"><b>{order.name}</b><small>#{order.id} · {order.neighborhood}</small></span>
              <span className="rt-when">{order.window}</span><OrderPill status={order.status} />
            </button>
          </Item>)}</Stagger>
        </article>
      </section>
      {openId !== null && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
