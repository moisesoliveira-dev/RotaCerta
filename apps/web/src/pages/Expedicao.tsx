import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { suggestSequence } from '@rotacerta/domain';
import { useStore } from '../app/store';
import { Empty, Header, Tabs } from './ui';
import { Icon } from '../app/icons';
import { Counter, Item, Stagger } from '../app/motion';

/** Montar carga: à esquerda as entregas prontas, à direita a carga já na ordem em que será planejada. */
export function Expedicao() {
  const { data, plan, setPlan } = useStore();
  const navigate = useNavigate();
  const [zone, setZone] = useState<string>('');
  const [selected, setSelected] = useState<number[]>(plan?.orderIds ?? []);
  const [manual, setManual] = useState(false);
  const [vehicleId, setVehicleId] = useState<number>(plan?.vehicleId ?? 0);
  const [departure, setDeparture] = useState(plan?.departure ?? data.departures[0] ?? '');

  const loadingRoutes = data.routes.filter((r) => r.status === 'loading');
  const busy = new Set(data.routes.filter((r) => r.status !== 'finished').map((r) => r.vehicleId));
  const freeVehicles = data.vehicles.filter((v) => v.active !== false && !busy.has(v.id));
  const zoneOf = (n: string) => data.neighborhoods.find((x) => x.name === n)?.zone ?? 'Sem região';
  const readyAll = data.orders.filter((o) => o.status === 'ready' && o.boxes.length > 0);
  const byId = new Map(data.orders.map((o) => [o.id, o]));
  const available = readyAll.filter((o) => !selected.includes(o.id) && (!zone || zoneOf(o.neighborhood) === zone));
  const vehicle = vehicleId || freeVehicles[0]?.id || 0;
  const current = data.vehicles.find((v) => v.id === vehicle);

  const chosen = selected.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
  const volumes = chosen.reduce((n, o) => n + o.boxes.length, 0);
  const capacity = current?.capacity ?? 0;
  const over = capacity > 0 && volumes > capacity;
  const pct = capacity ? Math.min(100, Math.round((volumes / capacity) * 100)) : 0;

  /** Enquanto o usuário não mexeu na ordem, a carga segue a sugestão por região; depois dele mexer, respeita a ordem escolhida. */
  const arrange = (ids: number[]) => (manual ? ids : suggestSequence(ids.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o), data.neighborhoods));
  const add = (ids: number[]) => setSelected((s) => arrange([...s, ...ids.filter((id) => !s.includes(id))]));
  const remove = (id: number) => setSelected((s) => s.filter((x) => x !== id));
  const move = (id: number, dir: -1 | 1) => {
    setManual(true);
    setSelected((s) => { const i = s.indexOf(id); const j = i + dir; if (j < 0 || j >= s.length) return s; const n = s.slice(); [n[i], n[j]] = [n[j], n[i]]; return n; });
  };
  const suggest = () => { setManual(false); setSelected((s) => suggestSequence(s.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o), data.neighborhoods)); };

  const generate = () => {
    if (!selected.length || !vehicle || over) return;
    setPlan({ orderIds: selected, vehicleId: vehicle, departure, driverId: plan?.driverId ?? null });
    navigate('/planejamento');
  };

  return (
    <>
      <Header title="Montar carga" subtitle="À esquerda o que está pronto; à direita a carga, na ordem em que será planejada." />
      <Stagger className="rt-stats">
        <Item className="rt-stat"><span>Prontas para sair</span><b><Counter to={readyAll.length} /></b><small>com volumes identificados</small></Item>
        <Item className="rt-stat"><span>Selecionadas</span><b className="green"><Counter to={selected.length} /></b><small>nesta carga</small></Item>
        <Item className="rt-stat"><span>Veículos livres</span><b className="blue"><Counter to={freeVehicles.length} /></b><small>de {data.vehicles.filter((v) => v.active !== false).length} ativos</small></Item>
        <Item className="rt-stat"><span>Em conferência</span><b><Counter to={loadingRoutes.length} /></b><small>carga(s) no carregamento</small></Item>
      </Stagger>
      {loadingRoutes.length > 0 && (
        <section className="card rt-panel" aria-label="Cargas em conferência">
          <div className="rt-panel-head"><h2>Cargas em conferência</h2><Link className="rt-link" to="/carregamento">Ver carregamento</Link></div>
          <ul className="rt-rows">
            {loadingRoutes.map((r) => (
              <li key={r.id} className="rt-row rt-row-static">
                <span className="rt-dot amber" aria-hidden="true"><Icon name="truck" size={18} /></span>
                <span className="rt-name"><b>Romaneio #{r.id}</b><small>{r.orders.length} pedido(s) · saída {r.departure} · {Object.keys(r.confirmed ?? {}).length} de {r.orders.length} confirmados</small></span>
                <Link className="btn primary" to="/carregamento">Retomar</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Tabs value={zone} onChange={setZone} label="Região" items={[{ value: '', label: 'Todas as regiões' }, ...data.zones.map((z) => ({ value: z, label: z }))]} />

      <div className="mc-two">
        <section className="card mc-panel" aria-label="Entregas disponíveis">
          <div className="mc-head"><h2>Disponíveis <span className="muted small">{available.length}</span></h2>
            <button type="button" disabled={!available.length} onClick={() => add(available.map((o) => o.id))}>Adicionar todas</button></div>
          {available.length === 0 ? <Empty>{readyAll.length ? 'Nada mais disponível nesta região.' : 'Nenhuma entrega pronta para sair.'}</Empty> : (
            <ul className="mc-list">
              {available.map((o) => (
                <li key={o.id} className="mc-line">
                  <span className="mc-text"><b>#{o.id} {o.name}</b><small>{o.neighborhood} · {o.window}</small></span>
                  <span className="vcode">{o.boxes.length} vol.</span>
                  {(o.cold || o.frozen) && <span className="vcode cold">frio</span>}
                  <button type="button" className="mc-mini" aria-label={`Adicionar ${o.name} à carga`} onClick={() => add([o.id])}><Icon name="plus" size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card mc-panel mc-drop" aria-label="Carga em montagem">
          <div className="mc-head"><h2>Carga em montagem <span className="muted small">{selected.length} entrega(s)</span></h2>
            {selected.length > 1 && <button type="button" onClick={suggest}>Ordenar por região</button>}</div>
          <div className="mc-setup">
            <label>Veículo
              <select value={vehicle} onChange={(e) => setVehicleId(Number(e.target.value))}>
                {freeVehicles.length === 0 && <option value={0}>Nenhum veículo livre</option>}
                {freeVehicles.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.capacity} vol.</option>)}
              </select>
            </label>
            <label>Saída
              <select value={departure} onChange={(e) => setDeparture(e.target.value)}>
                {data.departures.map((d) => <option key={d}>{d}</option>)}
              </select>
            </label>
          </div>
          <div className="mc-fill">
            <span><b>{volumes}</b>{capacity ? ` de ${capacity}` : ''} volumes</span>
            <div className={`mc-bar ${over ? 'over' : pct > 85 ? 'warn' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={volumes} aria-label="Ocupação do veículo"><i style={{ width: `${pct}%` }} /></div>
          </div>
          {over && <p className="error" role="alert">A carga passa em {volumes - capacity} volume(s) a capacidade do veículo. Tire entregas ou escolha outro veículo.</p>}
          {chosen.length === 0 ? <div className="mc-empty">Clique em + nas entregas à esquerda para montar a carga.</div> : (
            <ol className="mc-list">
              {chosen.map((o, i) => (
                <li key={o.id} className="mc-line">
                  <span className="mc-num" aria-hidden="true">{i + 1}</span>
                  <span className="mc-text"><b>#{o.id} {o.name}</b><small>{o.neighborhood} · {o.boxes.length} vol.</small></span>
                  <button type="button" className="mc-mini" aria-label={`Subir ${o.name}`} disabled={i === 0} onClick={() => move(o.id, -1)}>↑</button>
                  <button type="button" className="mc-mini" aria-label={`Descer ${o.name}`} disabled={i === chosen.length - 1} onClick={() => move(o.id, 1)}>↓</button>
                  <button type="button" className="mc-mini" aria-label={`Tirar ${o.name} da carga`} onClick={() => remove(o.id)}><span aria-hidden="true">×</span></button>
                </li>
              ))}
            </ol>
          )}
          <button type="button" className="primary" disabled={!selected.length || !vehicle || over} onClick={generate}>Planejar sequência ({selected.length})</button>
        </section>
      </div>
    </>
  );
}
