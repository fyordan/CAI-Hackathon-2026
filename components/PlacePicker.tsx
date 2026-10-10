"use client";
// Small offline map for the profile editor: click (or drag the pin) to place home/work.
// Same Natural Earth outline as MapView; the parent decides the label from the nearest town.
import { useEffect, useRef } from "react";
import type * as Leaflet from "leaflet";

export interface Pt { lat: number; lng: number }

export default function PlacePicker({ home, work, active, onPick }: { home: Pt; work: Pt | null; active: "home" | "work"; onPick: (p: Pt, kind: "home" | "work") => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const pins = useRef<{ home?: Leaflet.Marker; work?: Leaflet.Marker }>({});
  const pick = useRef(onPick);
  pick.current = onPick;
  const act = useRef(active);
  act.current = active;

  useEffect(() => {
    let dead = false;
    (async () => {
      const lf = await import("leaflet");
      if (dead || !el.current || map.current) return;
      L.current = lf;
      const m = lf.map(el.current, { attributionControl: false, zoomSnap: 0.25, minZoom: 8, maxZoom: 13, maxBounds: [[17.6, -67.6], [18.8, -65.0]] });
      m.fitBounds([[17.9, -67.3], [18.52, -65.6]]);
      const geo = await fetch("/pr.geo.json").then((r) => r.json());
      if (dead) return;
      lf.geoJSON(geo, { style: { color: "#3E5F75", weight: 1.5, fillColor: "#FFFFFF", fillOpacity: 1 }, interactive: false }).addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => pick.current({ lat: e.latlng.lat, lng: e.latlng.lng }, act.current));
      map.current = m;
      sync();
    })();
    return () => { dead = true; map.current?.remove(); map.current = null; pins.current = {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = () => {
    const lf = L.current, m = map.current;
    if (!lf || !m) return;
    for (const kind of ["home", "work"] as const) {
      const pt = kind === "home" ? home : work;
      const existing = pins.current[kind];
      if (!pt) { existing?.remove(); delete pins.current[kind]; continue; }
      const icon = lf.divIcon({ className: `origin ${kind} ${act.current === kind ? "picking" : ""}`, html: `<span class="origin-dot">${kind === "home" ? "⌂" : "▣"}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      if (existing) { existing.setLatLng([pt.lat, pt.lng]); existing.setIcon(icon); }
      else {
        const mk = lf.marker([pt.lat, pt.lng], { icon, draggable: true, keyboard: false });
        mk.on("dragend", () => { const ll = mk.getLatLng(); pick.current({ lat: ll.lat, lng: ll.lng }, kind); });
        mk.addTo(m);
        pins.current[kind] = mk;
      }
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sync, [home.lat, home.lng, work?.lat, work?.lng, active]);

  return <div ref={el} className="picker-map" aria-hidden />;
}
