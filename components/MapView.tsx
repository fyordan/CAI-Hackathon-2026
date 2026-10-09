"use client";
// Offline basemap: Puerto Rico outline (Natural Earth via world-atlas) drawn with Leaflet.
// No tiles/roads because this build machine can't reach tile servers or Google Maps.
// Pan/zoom/fit-to-pins behavior is real; swap the base layer for Google Maps JS with a key.
import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import type { Candidate, Lang, Persona } from "@/lib/types";
import { t } from "./i18n";
import { hoursText } from "./format";

const TOWNS: [string, number, number][] = [
  ["San Juan", 18.4655, -66.1057], ["Bayamón", 18.3989, -66.1557], ["Caguas", 18.2342, -66.0356], ["Ponce", 18.0111, -66.6141],
  ["Mayagüez", 18.2013, -67.1397], ["Arecibo", 18.4724, -66.7157], ["Carolina", 18.3808, -65.9574], ["Humacao", 18.1497, -65.8274],
  ["Cayey", 18.1119, -66.166], ["Dorado", 18.4589, -66.2677], ["Fajardo", 18.3258, -65.6524], ["Guaynabo", 18.3575, -66.111],
];

interface Props {
  persona: Persona;
  candidates: Candidate[];
  hovered: string | null;
  onHover: (id: string | null) => void;
  lang: Lang;
  booked: string | null;
}

export default function MapView({ persona, candidates, hovered, onHover, lang, booked }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const markers = useRef<Map<string, Leaflet.Marker>>(new Map());
  const iconKey = useRef<Map<string, string>>(new Map());
  const popKey = useRef<Map<string, string>>(new Map());
  const line = useRef<Leaflet.Polyline | null>(null);
  const fitKey = useRef("");
  const pendingFit = useRef<Leaflet.LatLngBounds | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      const lf = await import("leaflet");
      if (dead || !el.current || map.current) return;
      L.current = lf;
      const m = lf.map(el.current, { zoomControl: true, attributionControl: true, zoomSnap: 0.25, minZoom: 8, maxZoom: 15 });
      m.attributionControl.setPrefix(false).addAttribution("Outline: Natural Earth · Offline demo basemap");
      m.setView([18.22, -66.45], 9);
      const geo = await fetch("/pr.geo.json").then((r) => r.json());
      lf.geoJSON(geo, { style: { color: "#9FB3C2", weight: 1, fillColor: "#FFFFFF", fillOpacity: 1 }, interactive: false }).addTo(m);
      for (const [name, lat, lng] of TOWNS) {
        lf.marker([lat, lng], { interactive: false, icon: lf.divIcon({ className: "town", html: `<span>${name}</span>`, iconSize: [0, 0] }) }).addTo(m);
      }
      const pin = (cls: string, glyph: string, label: string) => lf.divIcon({ className: `origin ${cls}`, html: `<span class="origin-dot">${glyph}</span><span class="origin-label">${label}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      lf.marker([persona.home.lat, persona.home.lng], { icon: pin("home", "⌂", persona.home.label.split("·")[0].trim()), zIndexOffset: -100 }).addTo(m);
      if (persona.work) lf.marker([persona.work.lat, persona.work.lng], { icon: pin("work", "▣", persona.work.label.split("·")[0].trim()), zIndexOffset: -100 }).addTo(m);
      layer.current = lf.layerGroup().addTo(m);
      map.current = m;
      setReady(true);
      setTimeout(() => m.invalidateSize(), 50);
    })();
    return () => { dead = true; map.current?.remove(); map.current = null; };
  }, [persona]);

  // resize when the pane becomes visible (mobile tabs)
  useEffect(() => {
    if (!el.current) return;
    const ro = new ResizeObserver(() => {
      const m = map.current;
      if (!m) return;
      m.invalidateSize();
      if (pendingFit.current && m.getSize().x > 0) { m.fitBounds(pendingFit.current, { maxZoom: 12.5 }); pendingFit.current = null; }
    });
    ro.observe(el.current);
    return () => ro.disconnect();
  }, []);

  // pins
  useEffect(() => {
    const lf = L.current, m = map.current, g = layer.current;
    if (!lf || !m || !g) return;
    const seen = new Set<string>();
    for (const c of candidates) {
      seen.add(c.id);
      const cls = c.id === booked ? "pin booked" : c.included ? "pin in" : "pin out";
      const html = c.included ? `<span>${c.id === booked ? "✓" : c.rank}</span>` : "<span></span>";
      const icon = lf.divIcon({ className: cls, html, iconSize: c.included ? [30, 30] : [14, 14], iconAnchor: c.included ? [15, 15] : [7, 7] });
      const drive = [c.drive_home_min != null ? `${c.drive_home_min} min ${t(lang, "fromHome")}` : null, c.drive_work_min != null ? `${c.drive_work_min} min ${t(lang, "fromWork")}` : null].filter(Boolean).join(" · ");
      const hours = hoursText(c.hours, lang);
      const pop = `<div class="pop"><strong>${c.name}</strong><div>${c.municipio}</div><div>${drive} <em>(est.)</em></div><div>${hours}</div>${c.excluded_reason ? `<div class="pop-out">${c.excluded_reason}</div>` : ""}<div class="pop-phone">${c.phone}</div></div>`;
      let mk = markers.current.get(c.id);
      if (!mk) {
        mk = lf.marker([c.lat, c.lng], { icon, riseOnHover: true }).bindPopup(pop);
        mk.on("mouseover", () => onHover(c.id)).on("mouseout", () => onHover(null));
        mk.addTo(g);
        markers.current.set(c.id, mk);
        iconKey.current.set(c.id, cls + html);
        popKey.current.set(c.id, pop);
      } else {
        // only touch the DOM when something visible changed (re-creating icons restarts their animation)
        if (iconKey.current.get(c.id) !== cls + html) { mk.setIcon(icon); iconKey.current.set(c.id, cls + html); }
        if (popKey.current.get(c.id) !== pop) { mk.setPopupContent(pop); popKey.current.set(c.id, pop); }
      }
      mk.setZIndexOffset(c.included ? 500 - (c.rank ?? 0) : 0);
    }
    for (const [id, mk] of markers.current) if (!seen.has(id)) { g.removeLayer(mk); markers.current.delete(id); iconKey.current.delete(id); popKey.current.delete(id); }

    // fit to included pins + origins whenever the included set changes
    const inc = candidates.filter((c) => c.included);
    const key = inc.map((c) => c.id).join(",");
    if (key !== fitKey.current) {
      fitKey.current = key;
      const pts: [number, number][] = [[persona.home.lat, persona.home.lng], ...(persona.work ? [[persona.work.lat, persona.work.lng] as [number, number]] : []), ...inc.map((c) => [c.lat, c.lng] as [number, number])];
      const bounds = lf.latLngBounds(pts).pad(inc.length ? 0.18 : 0.6);
      if (m.getSize().x === 0) pendingFit.current = bounds; // hidden (phone tab) → fit when shown
      else m.flyToBounds(bounds, { duration: 1.1, maxZoom: inc.length ? 12.5 : 11 });
    }
  }, [candidates, booked, lang, persona, onHover, ready]);

  // hover: highlight pin + dashed line from the closer origin
  useEffect(() => {
    const lf = L.current, m = map.current;
    if (!lf || !m) return;
    for (const [id, mk] of markers.current) mk.getElement()?.classList.toggle("hover", id === hovered);
    line.current?.remove();
    line.current = null;
    const c = candidates.find((x) => x.id === hovered);
    if (c && c.best_origin) {
      const o = c.best_origin === "work" && persona.work ? persona.work : persona.home;
      line.current = lf.polyline([[o.lat, o.lng], [c.lat, c.lng]], { color: "#2F5D7C", weight: 2, dashArray: "4 6" }).addTo(m);
    }
  }, [hovered, candidates, persona, ready]);

  return <div ref={el} className="map" data-testid="map" />;
}
