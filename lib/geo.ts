// Drive time is ESTIMATED in this build (no Google Routes API key / network here):
// straight-line km × 1.25 road factor at ~60 km/h, plus 3 min to park.
// Swap estimateDriveMin() for Routes API computeRouteMatrix in production.
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const ROAD_FACTOR = 1.25;
export const AVG_KMH = 60;
export function estimateDriveMin(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return Math.round(3 + (haversineKm(a, b) * ROAD_FACTOR) / AVG_KMH * 60);
}
/** Generous straight-line prefilter radius for a drive limit (what the SQL uses). */
export const prefilterKm = (maxMin: number) => (maxMin * AVG_KMH) / 60;
