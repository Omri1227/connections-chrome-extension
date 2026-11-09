// Original schematic SVG of one airport: buildings, gate groups, transport lines, walking links, and the selected route.
// Not to scale. Straight walking lines are schematic (they do not trace corridors).
// Stacked levels (Area.stack) are drawn shifted by level; closed/suspended items (status on the routing date) are greyed.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AirportModel, Area, Shape } from '../src/types.ts';
import { nodePos, ridePath, serviceAt, stackShift, stateOn, type Route } from '../src/route.ts';

export const ZONE_FILL: Record<string, string> = { schengen: '#dbe8fb', 'non-schengen': '#fde6d2', domestic: '#dcefe0', international: '#f9dede', mixed: '#e9e0f7', 'n/a': '#ecebe6' };
export const ZONE_STROKE: Record<string, string> = { schengen: '#5b84c4', 'non-schengen': '#d0874a', domestic: '#4c9a62', international: '#c2585a', mixed: '#8b6cc0', 'n/a': '#9a978c' };
const BG_FILL: Record<string, string> = { runway: '#d5d3cc', apron: '#f2f1ec', road: '#e4e2da', rail: '#cfcac0', water: '#d6e7ef', parking: '#efeee8', other: '#efeee8' };

function shapeEl(s: Shape, props: React.SVGProps<SVGElement>, shift: [number, number] = [0, 0]) {
  const [dx, dy] = shift;
  if (s.type === 'rect') {
    const t = s.rotate ? `rotate(${s.rotate} ${s.x + dx + s.w / 2} ${s.y + dy + s.h / 2})` : undefined;
    return <rect x={s.x + dx} y={s.y + dy} width={s.w} height={s.h} rx={s.r ?? 4} transform={t} {...(props as React.SVGProps<SVGRectElement>)} />;
  }
  return <polygon points={s.points.map((p) => `${p[0] + dx},${p[1] + dy}`).join(' ')} {...(props as React.SVGProps<SVGPolygonElement>)} />;
}

/** Points spread evenly along a polyline (gate placement). */
export function along(path: [number, number][], n: number): [number, number][] {
  if (path.length === 1 || n === 1) return Array.from({ length: n }, () => path[0]);
  const seg = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]));
  const L = seg.reduce((a, b) => a + b, 0);
  return Array.from({ length: n }, (_, k) => {
    let d = (L * k) / (n - 1), i = 0;
    while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
    const t = seg[i] ? d / seg[i] : 0;
    return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
  });
}

const pl = (pts: [number, number][]) => pts.map((p) => p.join(',')).join(' ');

export interface MapProps {
  model: AirportModel;
  from: string | null;
  to: string | null;
  fromGate?: string | null;
  toGate?: string | null;
  route: Route | null;
  showWalks: boolean;
  showGates: boolean;
  date: string;
  /** Routing time of day "HH:MM" (lines outside their service windows are drawn as not running). */
  time?: string;
  onPick: (areaId: string) => void;
  /**
   * Optional prominent callouts (extension result view): e.g. "ARRIVE D · 62 %" next to each likely arrival area and
   * "DEPART B · 40 %" next to each likely departure area. Several per role are allowed (ties). Marked areas are drawn
   * as from/to; their small FROM/TO pins are replaced by the callout. Drawn at a constant on-screen size.
   */
  marks?: { area: string; role: 'from' | 'to'; text: string }[];
  /** Node ids to frame initially (with the route's rides); the whole-airport button still shows everything. */
  focus?: string[];
}

export default function SchematicMap({ model: m, from, to, fromGate, toGate, route, showWalks, showGates, date, time, onPick: pickArea, marks, focus }: MapProps) {
  const markFrom = useMemo(() => new Set((marks ?? []).filter((x) => x.role === 'from').map((x) => x.area)), [marks]);
  const markTo = useMemo(() => new Set((marks ?? []).filter((x) => x.role === 'to').map((x) => x.area)), [marks]);
  const isFrom = (id: string) => id === from || markFrom.has(id);
  const isTo = (id: string) => id === to || markTo.has(id);
  const W = m.schematic.width, H = m.schematic.height;
  const areaById = useMemo(() => new Map(m.areas.map((a) => [a.id, a])), [m]);
  // fit the view to the content (areas, gates, stops, lines), padded; background beyond it is clipped
  const fit = useMemo(() => {
    const pts: [number, number][] = [];
    for (const a of m.areas) {
      const [dx, dy] = stackShift(a);
      pts.push([a.anchor[0] + dx, a.anchor[1] + dy]);
      if (a.shape?.type === 'poly') pts.push(...a.shape.points.map((p) => [p[0] + dx, p[1] + dy] as [number, number]));
      else if (a.shape) pts.push([a.shape.x + dx, a.shape.y + dy], [a.shape.x + a.shape.w + dx, a.shape.y + a.shape.h + dy]);
    }
    for (const g of m.gateGroups) pts.push(...g.path);
    for (const st of m.stops) pts.push(st.anchor);
    for (const l of m.lines) if (l.path) pts.push(...l.path);
    if (!pts.length) return [0, 0, W, H];
    const pad = 45;
    const x0 = Math.max(0, Math.min(...pts.map((p) => p[0])) - pad), y0 = Math.max(0, Math.min(...pts.map((p) => p[1])) - pad);
    const x1 = Math.min(W, Math.max(...pts.map((p) => p[0])) + pad), y1 = Math.min(H, Math.max(...pts.map((p) => p[1])) + pad);
    return [x0, y0, x1 - x0, y1 - y0] as [number, number, number, number];
  }, [m, W, H]);
  // optional initial framing on some nodes (extension: the route and the marked areas); ⤢ still shows the whole airport
  const focusKey = (focus ?? []).join('|');
  const focusView = useMemo(() => {
    const pts = (focus ?? []).map((id) => nodePos(m, id)).filter(Boolean) as [number, number][];
    for (const s of route?.steps ?? []) if (s.kind === 'ride' && s.line) { const l = m.lines.find((x) => x.id === s.line); if (l) pts.push(...ridePath(m, l, s.stops!)); }
    if (!pts.length) return null;
    const x0 = Math.min(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
    const x1 = Math.max(...pts.map((p) => p[0])), y1 = Math.max(...pts.map((p) => p[1]));
    // at least a quarter of the airport, padded so the callouts above / below the areas fit
    const w = Math.max(x1 - x0, fit[2] / 4) * 1.5, h = Math.max(y1 - y0, fit[3] / 4) * 2;
    const fw = Math.min(w, fit[2] * 1.2), fh = Math.min(h, fit[3] * 1.4);   // may exceed the airport a little: room for callouts at its edge
    return [(x0 + x1) / 2 - fw / 2, (y0 + y1) / 2 - fh / 2, fw, fh] as [number, number, number, number];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, focusKey, route, fit]);
  // zoom & pan: wheel or +/− buttons zoom (around the cursor), drag pans; a drag never counts as a click
  const [view, setView] = useState<[number, number, number, number] | null>(focusView);
  useEffect(() => { if (focus) setView(focusView); }, [focusView]);   // the maps viewer (no focus) keeps its zoom
  const [vx, vy, vw, vh] = view ?? fit;
  const svgRef = useRef<SVGSVGElement>(null);
  // rendered size (px), so callouts keep a constant on-screen size whatever the zoom and the aspect ratio
  const [px, setPx] = useState<[number, number]>([560, 300]);
  useEffect(() => {
    const el = svgRef.current; if (!el || !marks?.length || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width && r.height) setPx([r.width, r.height]); });
    ro.observe(el); return () => ro.disconnect();
  }, [marks?.length]);
  const drag = useRef<{ x: number; y: number; v: [number, number, number, number]; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const zoom = (f: number, cx?: number, cy?: number) => setView((cur) => {
    const [x, y, w, h] = cur ?? fit;
    const nw = Math.min(fit[2] * 1.2, Math.max(fit[2] / 12, w * f)), k = nw / w, nh = h * k;
    const px = cx ?? x + w / 2, py = cy ?? y + h / 2;
    return [px - (px - x) * k, py - (py - y) * k, nw, nh];
  });
  const toSvg = (ev: { clientX: number; clientY: number }): [number, number] | null => {
    const el = svgRef.current, ctm = el?.getScreenCTM(); if (!el || !ctm) return null;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return [pt.x, pt.y];
  };
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const q = toSvg(e); zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, q?.[0], q?.[1]); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  const onPointerDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, v: [vx, vy, vw, vh], moved: false }; dragged.current = false; };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true; dragged.current = true;
    const r = svgRef.current!.getBoundingClientRect();
    const sc = Math.max(d.v[2] / r.width, d.v[3] / r.height); // viewBox units per pixel (preserveAspectRatio meet)
    setView([d.v[0] - dx * sc, d.v[1] - dy * sc, d.v[2], d.v[3]]);
  };
  const onPointerUp = () => { drag.current = null; };
  const onPick = (id: string) => { if (dragged.current) { dragged.current = false; return; } pickArea(id); };
  const lineById = useMemo(() => new Map(m.lines.map((l) => [l.id, l])), [m]);
  const onRoute = useMemo(() => {
    const areas = new Set<string>(), lines = new Set<string>();
    for (const s of route?.steps ?? []) { areas.add(s.from); areas.add(s.to); if (s.line) lines.add(s.line); }
    return { areas, lines };
  }, [route]);
  const dim = !!route && route.steps.length > 0;
  const gpath = (g: AirportModel['gateGroups'][number]): [number, number][] => { const [dx, dy] = stackShift(areaById.get(g.area)); return g.path.map((q) => [q[0] + dx, q[1] + dy]); };
  const off = (x: { status?: AirportModel['lines'][number]['status'] }) => stateOn(x.status, date) !== 'active';
  // draw lower stack levels first; the selected areas last so they stay clickable on top
  const drawOrder = useMemo(() => [...m.areas].filter((a) => a.shape).sort((a, b) => (a.stack?.order ?? 0) - (b.stack?.order ?? 0)), [m]);

  const routeLayers = useMemo(() => {
    if (!route) return null;
    const out: JSX.Element[] = [];
    route.steps.forEach((s, i) => {
      if (s.kind === 'ride') {
        const l = lineById.get(s.line!)!;
        const pts = ridePath(m, l, s.stops!);
        out.push(<polyline key={`r${i}`} points={pl(pts)} className="rt-ride-casing" />);
        out.push(<polyline key={`rr${i}`} points={pl(pts)} className="rt-ride" style={{ stroke: l.colour }} />);
      } else if (s.kind === 'walk' || s.kind === 'to-platform' || s.kind === 'from-platform') {
        const a = nodePos(m, s.from), b = nodePos(m, s.to);
        if (a && b) out.push(<line key={`w${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={`rt-walk ${s.practical === 'avoid' ? 'avoid' : ''}`} />);
      }
    });
    route.steps.forEach((s, i) => {
      if (s.kind !== 'control') return;
      const p = nodePos(m, s.to); if (!p) return;
      const prev = route.steps[i - 1]; const q = prev ? nodePos(m, prev.from) : null;
      const at: [number, number] = q ? [(p[0] * 2 + q[0]) / 3, (p[1] * 2 + q[1]) / 3] : p;
      const letter = s.control!.kind === 'passport' ? 'P' : s.control!.kind === 'customs' ? 'C' : 'S';
      out.push(<g key={`c${i}`} className="rt-control" transform={`translate(${at[0]},${at[1]})`}><title>{s.text}</title><rect x={-8} y={-8} width={16} height={16} rx={3} /><text y={4}>{letter}</text></g>);
    });
    return out;
  }, [route, m, lineById]);

  const gatePins = useMemo(() => {
    const out: JSX.Element[] = [];
    for (const [gate, cls] of [[fromGate, 'from'], [toGate, 'to']] as const) {
      if (!gate) continue;
      const g = m.gateGroups.find((x) => x.gates.includes(gate)); if (!g) continue;
      const p = along(gpath(g), g.gates.length)[g.gates.indexOf(gate)];
      out.push(<g key={cls} className={`gpin ${cls}`} transform={`translate(${p[0]},${p[1]})`}><title>{`Gate ${gate} (${g.label}; approximate position)`}</title><circle r={5} /><text y={-8}>{gate}</text></g>);
    }
    return out;
  }, [fromGate, toGate, m]);

  return (
    <div className="smapbox">
    <div className="zoomctl">
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(1 / 1.5)}>+</button>
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.5)}>−</button>
      <button type="button" title="Fit the whole airport" aria-label="Reset view" onClick={() => setView(null)}>⤢</button>
    </div>
    <svg ref={svgRef} className={`smap ${dim ? 'dim' : ''} ${view ? 'zoomed' : ''}`} viewBox={`${vx} ${vy} ${vw} ${vh}`} role="img" aria-label={`Schematic map of ${m.name}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#efeee9" /><line x1="0" y1="0" x2="0" y2="6" stroke="#c9c6bd" strokeWidth="2" /></pattern>
        <marker id="arrhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3c8d5a" /></marker>
      </defs>
      <rect x={0} y={0} width={W} height={H} className="smap-bg" />
      {m.schematic.background?.map((b, i) => (
        <g key={`bg${i}`} className={`bg bg-${b.kind}`}>{shapeEl(b.shape, { fill: BG_FILL[b.kind] ?? BG_FILL.other })}</g>
      ))}
      {m.schematic.labels?.map((l, i) => (
        <text key={`lb${i}`} x={l.at[0]} y={l.at[1]} className={`maplabel ml-${l.kind}`} transform={l.rotate ? `rotate(${l.rotate} ${l.at[0]} ${l.at[1]})` : undefined}>{l.text}</text>
      ))}

      {drawOrder.map((a) => {
        const closed = off(a);
        return (
          <g key={a.id} className={`area ${onRoute.areas.has(a.id) ? 'on' : ''} ${isFrom(a.id) ? 'from' : ''} ${isTo(a.id) ? 'to' : ''} ${a.stack ? 'stacked' : ''} ${closed ? 'closed' : ''}`} onClick={() => onPick(a.id)}>
            <title>{a.name} — {a.side}{a.zone !== 'n/a' ? `, ${a.zone}` : ''}{a.stack ? `, level ${a.stack.label} of a stacked building` : ''}{closed ? `, ${stateOn(a.status, date)} on ${date}` : ''} ({a.confidence})</title>
            {shapeEl(a.shape!, { fill: closed ? 'url(#hatch)' : ZONE_FILL[a.zone], stroke: closed ? '#aaa69b' : ZONE_STROKE[a.zone], className: `area-shape side-${a.side}` }, stackShift(a))}
          </g>
        );
      })}

      {showWalks && m.walks.filter((w) => w.access !== 'restricted').map((w) => {
        const a = nodePos(m, w.from), b = nodePos(m, w.to); if (!a || !b) return null;
        const arr = w.flow === 'arrivals';
        return <line key={w.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={`walk walk-${w.practical} acc-${w.access} ${arr ? 'walk-arrivals' : ''} ${off(w) ? 'walk-off' : ''}`} markerEnd={arr ? 'url(#arrhead)' : undefined}><title>{`${w.id}: ${w.minutes.typical} min walk (${w.practical}${arr ? ', arrivals flow only' : ''}${w.bidirectional ? '' : ', one way'}, ${w.confidence})`}</title></line>;
      })}
      {showWalks && m.walks.filter((w) => w.access === 'restricted').map((w) => {
        const a = nodePos(m, w.from), b = nodePos(m, w.to); if (!a || !b) return null;
        return <line key={w.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="walk walk-restricted"><title>{`${w.id}: not usable by passengers`}</title></line>;
      })}

      {m.lines.map((l) => {
        const pts = l.path?.length ? l.path : l.stops.map((s) => nodePos(m, s)!).filter(Boolean);
        const closed = l.direction === 'loop' && !l.path?.length;
        const st = stateOn(l.status, date);
        const idle = st === 'active' && !serviceAt(l, date, time);
        return (
          <g key={l.id} className={`tline ${onRoute.lines.has(l.id) ? 'on' : ''} mode-${l.mode} acc-${l.access} ${st !== 'active' || idle ? 'off' : ''} ${l.notRouted ? 'notrouted' : ''}`}>
            <title>{`${l.name} (${l.mode}, ${l.access}${st !== 'active' ? `, ${st} on ${date}` : ''}${idle ? `, not running${time ? ` at ${time}` : ''} on ${date}` : ''}${l.notRouted ? `, not routed: ${l.notRouted}` : ''})`}</title>
            {closed ? <polygon points={pl(pts)} style={{ stroke: l.colour }} /> : <polyline points={pl(pts)} style={{ stroke: l.colour }} />}
          </g>
        );
      })}

      {showGates && m.gateGroups.map((g) => {
        const path = gpath(g), pts = along(path, g.gates.length);
        const showAll = g.gates.length <= 14;
        return (
          <g key={g.id} className={`gates ${onRoute.areas.has(g.area) ? 'on' : ''} ${g.bus ? 'bus' : ''} ${off(g) || off(areaById.get(g.area) ?? {}) ? 'off' : ''}`}>
            <title>{`${g.label}: ${g.gates.join(', ')} (${g.confidence})`}</title>
            {path.length > 1 && <polyline points={pl(path)} className="gate-path" />}
            {pts.map((p, k) => <circle key={k} cx={p[0]} cy={p[1]} r={1.8} className="gate-dot" />)}
            {(showAll ? pts.map((p, k) => [p, g.gates[k]] as const) : [[pts[0], g.gates[0]] as const, [pts.at(-1)!, g.gates.at(-1)!] as const])
              .map(([p, t], k) => <text key={`t${k}`} x={p[0]} y={p[1] - 3.5} className="gate-num">{t}</text>)}
          </g>
        );
      })}

      {routeLayers}

      {m.stops.map((s) => {
        const l = m.lines.find((x) => x.stops.includes(s.id));
        return (
          <g key={s.id} className={`stop ${onRoute.areas.has(s.id) ? 'on' : ''} ${off(s) ? 'off' : ''}`} transform={`translate(${s.anchor[0]},${s.anchor[1]})`}>
            <title>{`${s.name}${s.where ? ` — ${s.where}` : ''}`}</title>
            <circle r={5} style={{ stroke: l?.colour ?? '#333' }} />
          </g>
        );
      })}

      {gatePins}

      {m.areas.map((a: Area) => {
        const [x, y] = nodePos(m, a.id)!;
        return (
          <g key={`l${a.id}`} className={`alabel ${isFrom(a.id) ? 'from' : ''} ${isTo(a.id) ? 'to' : ''} ${a.shape ? '' : 'node'} ${onRoute.areas.has(a.id) ? 'on' : ''} ${off(a) ? 'closed' : ''}`} transform={`translate(${x},${y})`} onClick={() => onPick(a.id)}>
            {!a.shape && <circle r={6} className="node-dot" />}
            {(() => {
              // stacked levels share a footprint: the lowest level's label goes below its anchor, upper levels' above
              const y0 = !a.shape ? -10 : a.stack ? (a.stack.order === 0 ? 16 : -14) : 5;
              const sub = a.stack ? a.stack.label : off(a) ? stateOn(a.status, date) : null;
              const pinY = a.stack && a.stack.order > 0 ? y0 - 14 : y0 + (sub ? 24 : 17);
              return <>
                <text y={y0}>{a.short}</text>
                {sub && <text y={y0 + 11} className="lvl">{sub}{a.stack && off(a) ? ` · ${stateOn(a.status, date)}` : ''}</text>}
                {!marks?.length && (a.id === from || a.id === to) && <text y={a.shape ? pinY : 30} className="pin">{a.id === from ? 'FROM' : 'TO'}</text>}
              </>;
            })()}
          </g>
        );
      })}

      {marks?.map((mk, i) => {
        const p = nodePos(m, mk.area); if (!p) return null;
        const k = Math.max(vw / px[0], vh / px[1]);           // viewBox units per screen pixel (preserveAspectRatio meet)
        const fs = 11 * k, h = 18 * k, w = (mk.text.length * 6.6 + 14) * k;
        // arrivals above the area, departures below; a second mark of the same role on the same side steps further out
        const nth = marks.slice(0, i).filter((x) => x.role === mk.role && x.area === mk.area).length;
        const dy = (mk.role === 'from' ? -1 : 1) * (34 + nth * 24) * k;
        const by = mk.role === 'from' ? dy - h : dy;
        return (
          <g key={`mk${i}`} className={`mark ${mk.role}`} transform={`translate(${p[0]},${p[1]})`} pointerEvents="none">
            <circle r={9 * k} className="mark-ring" style={{ strokeWidth: 3 * k }} />
            <line x1={0} y1={0} x2={0} y2={dy} style={{ strokeWidth: 2 * k }} className="mark-lead" />
            <rect x={-w / 2} y={by} width={w} height={h} rx={h / 2} className="mark-box" />
            <text y={by + h / 2} dy="0.35em" style={{ fontSize: fs }} className="mark-text">{mk.text}</text>
          </g>
        );
      })}

      <g transform={`translate(${vx + vw - 24},${vy + 40}) rotate(${m.schematic.northDeg})`} className="north"><path d="M0,-18 L7,8 L0,3 L-7,8 Z" /><text y={-22} transform={`rotate(${-m.schematic.northDeg} 0 -26)`}>N</text></g>
    </svg>
    </div>
  );
}
