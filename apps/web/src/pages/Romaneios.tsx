import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ROUTE_STATUS_LABELS, type Route } from '@rotacerta/domain';
import { useStore } from '../app/store';
import { Icon } from '../app/icons';
import { Item, Stagger } from '../app/motion';
import { Empty, Header, Modal, OrderPill, RoutePill } from './ui';

const COLUMNS: Route['status'][] = ['loading', 'released', 'active', 'finished'];

/** Romaneios em quadro: uma coluna por situação da carga; o cartão abre as paradas do romaneio. */
export function Romaneios() {
  const { data } = useStore();
  const [openId, setOpenId] = useState<number | null>(null);
  // vindo da busca do topo (?romaneio=ID): abre o romaneio
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const id = Number(params.get('romaneio'));
    if (id) { setOpenId(id); setParams({}, { replace: true }); }
  }, [params, setParams]);

  const routes = data.routes.slice().reverse();
  const opened = routes.find((r) => r.id === openId);
  const orderOf = (id: number) => data.orders.find((o) => o.id === id);
  const info = (r: Route) => {
    const vehicle = data.vehicles.find((v) => v.id === r.vehicleId);
    const driver = data.drivers.find((d) => d.id === r.driverId);
    return `${vehicle?.name ?? 'Sem veículo'} · saída ${r.departure} · ${driver?.name ?? 'sem motorista'}`;
  };
  const done = (r: Route) => r.orders.filter((id) => { const s = orderOf(id)?.status; return s === 'delivered' || s === 'failed'; }).length;
  const volumes = (r: Route) => r.orders.reduce((n, id) => n + (orderOf(id)?.boxes.length ?? 0), 0);

  return (
    <>
      <Header title="Romaneios" subtitle="Veja de uma vez onde cada carga está: carregando, liberada, em rota ou finalizada."
        actions={<button type="button" onClick={() => window.print()}><Icon name="list" size={18} />Imprimir</button>} />

      {routes.length === 0 ? <Empty>Nenhum romaneio criado.</Empty> : (
        <div className="rm-board">
          {COLUMNS.map((st) => {
            const list = routes.filter((r) => r.status === st);
            return (
              <section key={st} className="rm-col" aria-label={ROUTE_STATUS_LABELS[st]}>
                <h2>{ROUTE_STATUS_LABELS[st]} <span className="muted">{list.length}</span></h2>
                {list.length === 0 ? <p className="rm-none">Nenhum romaneio</p> : (
                  <Stagger as="ul" className="rm-cards" count={list.length}>
                    {list.map((r) => {
                      const d = done(r);
                      const pct = r.orders.length ? Math.round((d / r.orders.length) * 100) : 0;
                      return (
                        <Item as="li" key={r.id}>
                          <button type="button" className="rm-card" onClick={() => setOpenId(r.id)} aria-label={`Abrir o romaneio ${r.id}`}>
                            <span className="rm-card-top"><b>#{r.id}</b><small>saída {r.departure}</small></span>
                            <span className="rm-card-info">{info(r)}</span>
                            <span className="rm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={r.orders.length} aria-valuenow={d} aria-label="Paradas concluídas"><i style={{ width: `${pct}%` }} /></span>
                            <small className="muted">{d}/{r.orders.length} paradas · {volumes(r)} vol.</small>
                          </button>
                        </Item>
                      );
                    })}
                  </Stagger>
                )}
              </section>
            );
          })}
        </div>
      )}

      {opened && (
        <Modal title={`Romaneio #${opened.id}`} onClose={() => setOpenId(null)} width={560} icon="list"
          footer={opened.status === 'loading' ? <Link className="btn primary" to="/carregamento">Conferir carga</Link> : undefined}>
          <div className="rm-open-head"><span className="muted">{info(opened)}</span><RoutePill status={opened.status} /></div>
          <ol className="rt-steps">
            {opened.orders.map((id, i) => {
              const o = orderOf(id);
              if (!o) return null;
              const tone = o.status === 'delivered' ? 'ok' : o.status === 'onroute' ? 'now' : 'todo';
              return (
                <li key={id} className={tone}>
                  <span />
                  <div className="rt-step-row">
                    <div><b>{i + 1}. {o.name}</b><small>{o.street}, {o.number} · {o.neighborhood} · {o.boxes.length} volume(s)</small></div>
                    <OrderPill status={o.status} />
                  </div>
                </li>
              );
            })}
          </ol>
        </Modal>
      )}
    </>
  );
}
