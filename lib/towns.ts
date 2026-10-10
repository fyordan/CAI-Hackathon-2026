// Approximate town-center coordinates for Puerto Rico's 78 municipios plus a few San Juan
// neighborhoods. Used by the profile editor to place home/work; precision is "which town".
export const TOWNS: [name: string, lat: number, lng: number][] = [
  ["Adjuntas", 18.163, -66.722], ["Aguada", 18.379, -67.188], ["Aguadilla", 18.427, -67.154], ["Aguas Buenas", 18.257, -66.103],
  ["Aibonito", 18.14, -66.266], ["Añasco", 18.283, -67.14], ["Arecibo", 18.472, -66.716], ["Arroyo", 17.966, -66.061],
  ["Barceloneta", 18.451, -66.539], ["Barranquitas", 18.187, -66.306], ["Bayamón", 18.399, -66.156], ["Cabo Rojo", 18.087, -67.146],
  ["Caguas", 18.2385, -66.026], ["Camuy", 18.484, -66.845], ["Canóvanas", 18.379, -65.901], ["Carolina", 18.381, -65.957],
  ["Cataño", 18.441, -66.118], ["Cayey", 18.112, -66.166], ["Ceiba", 18.264, -65.648], ["Ciales", 18.336, -66.469],
  ["Cidra", 18.176, -66.161], ["Coamo", 18.08, -66.358], ["Comerío", 18.219, -66.226], ["Corozal", 18.341, -66.317],
  ["Culebra", 18.303, -65.301], ["Dorado", 18.4589, -66.2677], ["Fajardo", 18.326, -65.652], ["Florida", 18.363, -66.567],
  ["Guánica", 17.972, -66.908], ["Guayama", 17.984, -66.114], ["Guayanilla", 18.019, -66.792], ["Guaynabo", 18.358, -66.111],
  ["Gurabo", 18.254, -65.973], ["Hatillo", 18.486, -66.825], ["Hormigueros", 18.14, -67.127], ["Humacao", 18.15, -65.827],
  ["Isabela", 18.501, -67.024], ["Jayuya", 18.219, -66.592], ["Juana Díaz", 18.053, -66.507], ["Juncos", 18.228, -65.921],
  ["Lajas", 18.05, -67.059], ["Lares", 18.295, -66.878], ["Las Marías", 18.251, -66.992], ["Las Piedras", 18.183, -65.866],
  ["Loíza", 18.432, -65.88], ["Luquillo", 18.373, -65.717], ["Manatí", 18.428, -66.492], ["Maricao", 18.181, -66.98],
  ["Maunabo", 18.007, -65.899], ["Mayagüez", 18.201, -67.14], ["Moca", 18.395, -67.113], ["Morovis", 18.326, -66.407],
  ["Naguabo", 18.212, -65.735], ["Naranjito", 18.301, -66.245], ["Orocovis", 18.227, -66.391], ["Patillas", 18.006, -66.016],
  ["Peñuelas", 18.056, -66.722], ["Ponce", 18.0111, -66.6141], ["Quebradillas", 18.474, -66.939], ["Rincón", 18.34, -67.25],
  ["Río Grande", 18.38, -65.831], ["Sabana Grande", 18.078, -66.961], ["Salinas", 17.977, -66.298], ["San Germán", 18.083, -67.045],
  ["San Juan", 18.466, -66.106], ["San Lorenzo", 18.19, -65.961], ["San Sebastián", 18.337, -66.99], ["Santa Isabel", 17.966, -66.405],
  ["Toa Alta", 18.388, -66.248], ["Toa Baja", 18.444, -66.254], ["Trujillo Alto", 18.355, -66.007], ["Utuado", 18.266, -66.7],
  ["Vega Alta", 18.412, -66.331], ["Vega Baja", 18.444, -66.387], ["Vieques", 18.149, -65.443], ["Villalba", 18.127, -66.492],
  ["Yabucoa", 18.05, -65.879], ["Yauco", 18.035, -66.85],
  ["Hato Rey", 18.4225, -66.059], ["Santurce", 18.448, -66.068], ["Río Piedras", 18.399, -66.05], ["Condado", 18.457, -66.073],
];

export function nearestTown(lat: number, lng: number) {
  let best = TOWNS[0], d = Infinity;
  for (const tw of TOWNS) {
    const dd = (tw[1] - lat) ** 2 + ((tw[2] - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (dd < d) { d = dd; best = tw; }
  }
  return best;
}
