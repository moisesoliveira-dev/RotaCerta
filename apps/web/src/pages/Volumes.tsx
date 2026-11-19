import { lazy, Suspense, useMemo, useRef, useState, type FormEvent } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { BOX_TYPE_LABELS, DEFAULT_BOX_LOCATION, volumesOf, type BoxInput, type BoxType, type Order, type Volume } from '@rotacerta/domain';
import { useStore } from '../app/store';
import { Icon } from '../app/icons';
import { Counter, Item, Stagger } from '../app/motion';
import { Empty, Header, OrderPill, Tabs } from './ui';

const OrderDetail = lazy(() => import('./OrderDetail').then((m) => ({ default: m.OrderDetail })));

type View = 'entrega' | 'local' | 'tabela';
type Filter = 'all' | 'cold' | 'gas' | 'none';
type TypeFilter = 'all' | BoxType;
type SortKey = 'code' | 'type' | 'location' | 'order' | 'client' | 'status';

/** Uma caixa física com a entrega a que pertence (os itens fora da caixa não entram: não têm etiqueta). */
interface Box { code: string; type: BoxType; location: string; order: Order }

const VIEW_KEY = 'rotacerta:volumes-view';
const readView = (): View => { try { const v = localStorage.getItem(VIEW_KEY); return v === 'local' || v === 'tabela' ? v : 'entrega'; } catch { return 'entrega'; } };
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const place = (o: Order) => (o.cold || o.frozen ? o.storage : 'Área de expedição');

/** Selo de uma caixa, colorido pelo tipo (ambiente, frio, congelado). */
const BoxTag = ({ code, type }: { code: string; type: BoxType | 'extra' }) => <span className={`vcode ${type}`}>{code}</span>;

/** Volumes e caixas: lista por entrega, por local de guarda ou em tabela; busca por leitura de código e etiquetas. */
export function Volumes() {
  const { data, saveBoxes } = useStore();
  const [view, setViewState] = useState<View>(readView);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [read, setRead] = useState<{ query: string; box: Box | null } | null>(null);
  const [conferidas, setConferidas] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(['code', 1]);
  const [detail, setDetail] = useState<number | null>(null);
  const [target, setTarget] = useState('');
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [toPrint, setToPrint] = useState<Box[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* sem armazenamento */ } };

  const open = useMemo(() => data.orders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled'), [data.orders]);
  const allBoxes = useMemo<Box[]>(() => open.flatMap((o) => volumesOf(o).filter((v: Volume): v is Volume & { type: BoxType } => v.type !== 'extra').map((v) => ({ code: v.label, type: v.type, location: v.location, order: o }))), [open]);
  const needle = q.trim().toLowerCase();

  const matches = (o: Order) => !needle || o.name.toLowerCase().includes(needle) || String(o.id).includes(needle) || o.boxes.some((b) => b.toLowerCase().includes(needle));
  const orders = open.filter((o) => matches(o) && (filter === 'all' || (filter === 'cold' && (o.cold || o.frozen)) || (filter === 'gas' && o.gas) || (filter === 'none' && !o.boxes.length)));
  const boxes = allBoxes.filter((b) => (typeFilter === 'all' || b.type === typeFilter) && (!needle || matches(b.order) || b.code.toLowerCase().includes(needle) || b.location.toLowerCase().includes(needle)));

  const total = allBoxes.length;
  const cold = open.filter((o) => o.cold || o.frozen).length;
  const none = open.filter((o) => !o.boxes.length).length;

  /** Enter no campo: se for o código exato de uma caixa, mostra a caixa; senão o texto continua filtrando a lista. */
  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const typed = q.trim();
    if (!typed) { setRead(null); return; }
    const hit = allBoxes.find((b) => norm(b.code) === norm(typed));
    setRead({ query: typed, box: hit ?? null });
    if (hit) setConferidas((s) => new Set(s).add(hit.code));
  };

  /** Locais conhecidos (os já usados mais os padrões), para o "mover". */
  const locations = useMemo(() => [...new Set([...Object.values(DEFAULT_BOX_LOCATION), ...allBoxes.map((b) => b.location)])], [allBoxes]);

  const printLabels = (list: Box[]) => { setToPrint(list); setTimeout(() => window.print(), 80); };

  /** Muda o local das caixas escolhidas: uma gravação por entrega, mantendo as outras caixas dela como estão. */
  const move = () => {
    const where = (target === '__outro' ? custom : target).trim();
    if (!where) { setMessage({ ok: false, text: 'Escolha o novo local.' }); return; }
    const chosen = allBoxes.filter((b) => picked.has(b.code));
    const byOrder = new Map<number, Box[]>();
    for (const b of chosen) byOrder.set(b.order.id, [...(byOrder.get(b.order.id) ?? []), b]);
    const errors: string[] = [];
    let moved = 0;
    for (const [orderId, list] of byOrder) {
      const o = list[0].order;
      const codes = new Set(list.map((b) => b.code));
      const next: BoxInput[] = o.boxes.map((code) => ({ code, type: o.boxDetails?.[code]?.type ?? 'ambient', location: codes.has(code) ? where : o.boxDetails?.[code]?.location ?? DEFAULT_BOX_LOCATION.ambient }));
      const err = saveBoxes(orderId, next, o.gas);
      if (err) errors.push(`#${orderId}: ${err}`); else moved += list.length;
    }
    setMessage(errors.length ? { ok: false, text: `${moved ? `${moved} caixa(s) movida(s). ` : ''}Não consegui mover: ${errors.join(' · ')}` } : { ok: true, text: `${moved} caixa(s) movida(s) para ${where}.` });
    if (!errors.length) setPicked(new Set());
  };

  const sorted = useMemo(() => {
    const val = (b: Box, k: SortKey) => (k === 'code' ? b.code : k === 'type' ? BOX_TYPE_LABELS[b.type] : k === 'location' ? b.location : k === 'order' ? b.order.id : k === 'client' ? b.order.name : b.order.status);
    return boxes.slice().sort((a, b) => (val(a, sort[0]) > val(b, sort[0]) ? 1 : val(a, sort[0]) < val(b, sort[0]) ? -1 : 0) * sort[1]);
  }, [boxes, sort]);
  const allPicked = sorted.length > 0 && sorted.every((b) => picked.has(b.code));
  const togglePick = (code: string) => setPicked((s) => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const sortBy = (k: SortKey) => setSort(([cur, dir]) => [k, cur === k ? (dir === 1 ? -1 : 1) : 1]);
  const arrow = (k: SortKey) => (sort[0] === k ? (sort[1] === 1 ? ' ▲' : ' ▼') : '');

  const byLocation = useMemo(() => {
    const map = new Map<string, Box[]>();
    for (const b of boxes) map.set(b.location, [...(map.get(b.location) ?? []), b]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [boxes]);
  const extras = open.filter((o) => o.gas > 0 && matches(o));

  return (
    <>
      <Header title="Volumes e caixas" subtitle="Identifique a caixa física, o conteúdo e onde ela está guardada." actions={
        <form className="vol-search" onSubmit={submitSearch}>
          <label className="rt-search"><Icon name="search" size={18} />
            <input ref={searchRef} type="search" aria-label="Buscar caixa, entrega ou cliente; Enter lê o código da caixa" placeholder="Caixa, entrega ou cliente · Enter lê o código" value={q}
              onChange={(e) => { setQ(e.target.value); if (read) setRead(null); }} />
          </label>
        </form>} />

      {read && (read.box ? (
        <section className="card vol-found" aria-label="Caixa encontrada">
          <div className="vol-found-head"><strong className="vol-big">{read.box.code}</strong><BoxTag code={BOX_TYPE_LABELS[read.box.type]} type={read.box.type} /><span className="grow" />
            <button type="button" className="link" onClick={() => { setRead(null); setQ(''); searchRef.current?.focus(); }}>Ler outra</button></div>
          <div className="vol-found-grid">
            <div><small className="muted">Entrega</small><b>#{read.box.order.id} · {read.box.order.name}</b></div>
            <div><small className="muted">Bairro</small><b>{read.box.order.neighborhood}</b></div>
            <div><small className="muted">Guardar em</small><b>{read.box.location}</b></div>
            <div><small className="muted">Situação</small><OrderPill status={read.box.order.status} /></div>
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDetail(read.box!.order.id)}>Ver entrega</button>
            <button type="button" onClick={() => printLabels([read.box!])}>Imprimir etiqueta</button>
          </div>
          <small className="muted">{conferidas.size} de {total} caixas conferidas nesta sessão. <button type="button" className="link" onClick={() => setConferidas(new Set())}>Zerar</button></small>
        </section>
      ) : (
        <section className="card vol-found bad" role="alert"><strong className="vol-big">{read.query}</strong><b>Caixa não encontrada.</b>
          <span className="muted">Confira o código da etiqueta. A caixa pode estar em uma entrega já encerrada ou ainda não ter sido identificada.</span></section>
      ))}

      <Stagger className="rt-stats">
        <Item className="rt-stat"><span>Caixas em operação</span><b><Counter to={total} /></b><small>{open.length} entrega(s)</small></Item>
        <Item className="rt-stat"><span>Com frio ou congelado</span><b className="blue"><Counter to={cold} /></b><small>guardadas separadas</small></Item>
        <Item className="rt-stat"><span>Sem caixas</span><b className={none ? 'red' : ''}><Counter to={none} /></b><small>{none ? 'aguardam identificação' : 'tudo identificado'}</small></Item>
      </Stagger>

      <div className="vol-toolbar">
        <SegmentedControl label="Forma de ver os volumes" value={view} onChange={(v) => setView(v as View)}>
          <SegmentedControlItem value="entrega" label="Por entrega" />
          <SegmentedControlItem value="local" label="Por local" />
          <SegmentedControlItem value="tabela" label="Tabela" />
        </SegmentedControl>
        {view !== 'tabela' && null}
      </div>

      {view === 'entrega' ? (
        <Tabs value={filter} onChange={(v) => setFilter(v as Filter)} label="Filtro de volumes" items={[{ value: 'all', label: 'Todas' }, { value: 'cold', label: 'Frio e congelado' }, { value: 'gas', label: 'Com gás' }, { value: 'none', label: 'Sem caixas' }]} />
      ) : (
        <Tabs value={typeFilter} onChange={(v) => setTypeFilter(v as TypeFilter)} label="Tipo de volume" items={[{ value: 'all', label: 'Todos os tipos' }, { value: 'ambient', label: 'Ambiente' }, { value: 'cold', label: 'Frio' }, { value: 'frozen', label: 'Congelado' }]} />
      )}

      {view === 'entrega' && (orders.length === 0 ? <Empty>Nenhum volume encontrado.</Empty> : (
        <Stagger as="ul" className="rt-list" key={filter} count={orders.length}>
          {orders.map((o) => (
            <Item as="li" key={o.id}>
              <div className="rt-item rt-item-static">
                <span className="rt-name">
                  <b>#{o.id} · {o.name}</b>
                  <small>{place(o)}</small>
                  <span className="vol-tags">
                    {volumesOf(o).map((v) => <BoxTag key={v.key} code={v.type === 'extra' ? 'Gás' : v.label} type={v.type} />)}
                    {!o.boxes.length && <span className="vcode extra">Sem caixas</span>}
                  </span>
                </span>
                <OrderPill status={o.status} />
              </div>
            </Item>
          ))}
        </Stagger>
      ))}

      {view === 'local' && (byLocation.length === 0 && extras.length === 0 ? <Empty>Nenhuma caixa encontrada.</Empty> : (
        <div className="vol-cols">
          {byLocation.map(([loc, list]) => (
            <section className="card vol-col" key={loc}>
              <div className="card-head"><h2>{loc.split(' · ')[0]}</h2><span className="pill blue">{list.length}</span></div>
              {loc.includes(' · ') && <p className="muted small">{loc.split(' · ').slice(1).join(' · ')}</p>}
              {list.map((b) => (
                <button type="button" key={b.code} className="vol-bitem" onClick={() => setDetail(b.order.id)} aria-label={`Abrir a entrega ${b.order.id}, caixa ${b.code}`}>
                  <span><BoxTag code={b.code} type={b.type} /><small className="muted">#{b.order.id} · {b.order.name}</small></span>
                  <OrderPill status={b.order.status} />
                </button>
              ))}
            </section>
          ))}
          {extras.length > 0 && (
            <section className="card vol-col">
              <div className="card-head"><h2>Fora da caixa</h2><span className="pill amber">{extras.reduce((n, o) => n + o.gas, 0)}</span></div>
              <p className="muted small">Itens soltos (gás e outros): ficam na Área de expedição.</p>
              {extras.map((o) => <button type="button" key={o.id} className="vol-bitem" onClick={() => setDetail(o.id)}><span><span className="vcode extra">{o.gas} item(ns)</span><small className="muted">#{o.id} · {o.name}</small></span><OrderPill status={o.status} /></button>)}
            </section>
          )}
        </div>
      ))}

      {view === 'tabela' && (
        <>
          {picked.size > 0 && (
            <div className="vol-bulk" role="region" aria-label="Caixas selecionadas">
              <strong>{picked.size} selecionada(s)</strong><span className="grow" />
              <label className="vol-move">Mover para
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Escolha o local</option>
                  {locations.map((l) => <option key={l} value={l}>{l}</option>)}
                  <option value="__outro">Outro local…</option>
                </select>
              </label>
              {target === '__outro' && <input className="vol-custom" aria-label="Novo local" placeholder="Ex.: Câmara fria 02 · Prateleira A" value={custom} onChange={(e) => setCustom(e.target.value)} />}
              <button type="button" className="primary" onClick={move}>Mover</button>
              <button type="button" onClick={() => printLabels(allBoxes.filter((b) => picked.has(b.code)))}>Imprimir etiquetas</button>
              <button type="button" className="link" onClick={() => { setPicked(new Set()); setMessage(null); }}>Limpar</button>
            </div>
          )}
          {message && <p className={message.ok ? 'vol-msg ok' : 'error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
          {sorted.length === 0 ? <Empty>Nenhuma caixa encontrada.</Empty> : (
            <div className="card vol-table-card"><div className="table-wrap"><table className="vol-table">
              <thead><tr>
                <th style={{ width: 36 }}><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(sorted.map((b) => b.code)) : new Set())} aria-label="Selecionar todas as caixas exibidas" /></th>
                {([['code', 'Caixa'], ['type', 'Tipo'], ['location', 'Local'], ['order', 'Entrega'], ['client', 'Cliente'], ['status', 'Situação']] as Array<[SortKey, string]>).map(([k, label]) => (
                  <th key={k} aria-sort={sort[0] === k ? (sort[1] === 1 ? 'ascending' : 'descending') : 'none'}><button type="button" className="vol-sort" onClick={() => sortBy(k)}>{label}{arrow(k)}</button></th>
                ))}
              </tr></thead>
              <tbody>{sorted.map((b) => (
                <tr key={b.code} className={picked.has(b.code) ? 'sel' : ''}>
                  <td><input type="checkbox" checked={picked.has(b.code)} onChange={() => togglePick(b.code)} aria-label={`Selecionar ${b.code}`} /></td>
                  <td><BoxTag code={b.code} type={b.type} /></td>
                  <td>{BOX_TYPE_LABELS[b.type]}</td>
                  <td className="muted">{b.location}</td>
                  <td><button type="button" className="link" onClick={() => setDetail(b.order.id)}>#{b.order.id}</button></td>
                  <td>{b.order.name}</td>
                  <td><OrderPill status={b.order.status} /></td>
                </tr>
              ))}</tbody>
            </table></div></div>
          )}
        </>
      )}

      {/* Etiquetas para imprimir: ficam fora da tela e só aparecem na impressão (mesmo formato das etiquetas da carga) */}
      <div className={`vol-print labels ${toPrint?.length ? 'vol-print-on' : ''}`} aria-hidden="true">
        {(toPrint ?? []).map((b) => (
          <article className="label" key={b.code}>
            <div className="label-perm"><small>CAIXA</small><strong>{b.code}</strong></div>
            <div className="label-tmp">
              <small>COMPRA #{b.order.id}</small>
              <strong>{b.order.name}</strong>
              <span>{b.order.neighborhood}</span>
              <span className={b.type === 'ambient' ? '' : 'label-cold'}>{BOX_TYPE_LABELS[b.type]} · {b.location}</span>
            </div>
          </article>
        ))}
      </div>

      {detail != null && <Suspense fallback={null}><OrderDetail orderId={detail} onClose={() => setDetail(null)} /></Suspense>}
    </>
  );
}
