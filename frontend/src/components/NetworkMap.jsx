import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker icons resolve through a bundler-unaware URL, which
// breaks under Vite. Bank and hospital markers are CSS pins instead, so no
// image assets are needed at all.
const bankIcon = L.divIcon({
  className: "map-div-icon map-div-icon-bank",
  html: '<span class="map-pin map-pin-bank"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const hospitalIcon = L.divIcon({
  className: "map-div-icon map-div-icon-hospital",
  html: '<span class="map-pin map-pin-hospital"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

/** Severity colour for a city marker: red when a group is nearly out of stock. */
function citySeverity(total) {
  if (total === 0) return "critical";
  if (total < 5) return "low";
  if (total < 15) return "watch";
  return "ok";
}

function cityMarkerIcon(total) {
  const severity = citySeverity(total);
  return L.divIcon({
    className: "map-div-icon",
    html: `<span class="map-city-marker map-city-marker-${severity}"><b>${total}</b></span>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -24],
  });
}

/**
 * Live network map.
 *
 * Plain Leaflet rather than a React wrapper: the map is imperative by nature
 * (markers and circles are mutated in place), and a thin effect-driven layer
 * keeps React's render cycle out of Leaflet's. Cities are drawn from the
 * catalog (which already carries latitude/longitude), stock counts come from
 * the scatter-gather stats endpoint, and the marker colour is driven by how
 * much compatible blood a city actually holds.
 */
export default function NetworkMap({ cities, banks, hospitals, stats, selectedCity, onSelectCity, distances }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
    }).setView([30.3753, 69.3451], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Redraw markers whenever the underlying data changes. The layer group is
  // cleared and rebuilt rather than patched — with a dozen markers the
  // difference is imperceptible, and rebuild-on-change cannot leak a stale
  // marker when a city drops out of the response.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !cities?.length) return;
    layer.clearLayers();

    const cityTotals = {};
    for (const city of cities) {
      const cityStats = stats?.cities?.[city.cityCode];
      cityTotals[city.cityCode] = cityStats
        ? Object.values(cityStats.matrix || {}).reduce(
          (sum, groups) => sum + Object.values(groups).reduce((inner, count) => inner + count, 0),
          0,
        )
        : 0;
    }

    for (const city of cities) {
      const total = cityTotals[city.cityCode] ?? 0;
      const marker = L.marker([Number(city.latitude), Number(city.longitude)], {
        icon: cityMarkerIcon(total),
        title: `${city.name} (${city.cityCode})`,
      });
      const cityStats = stats?.cities?.[city.cityCode];
      const health = cityStats?.health;
      const healthLine = health
        ? `Primary ${health.primaryUp ? "up" : "DOWN"} · Replica ${health.replicaUp ? "up" : "DOWN"}`
        : "Health unknown";
      marker.bindPopup(
        `<strong>${city.name}</strong> · ${city.cityCode}<br/>` +
          `${total} unit(s) available<br/>${healthLine}` +
          (selectedCity === city.cityCode ? "<br/><em>Selected origin</em>" : ""),
      );
      marker.on("click", () => onSelectCity?.(city.cityCode));
      layer.addLayer(marker);
    }

    for (const bank of banks || []) {
      if (bank.latitude == null || bank.longitude == null) continue;
      const m = L.marker([Number(bank.latitude), Number(bank.longitude)], { icon: bankIcon });
      m.bindPopup(`<strong>${bank.name}</strong><br/>Blood bank · ${bank.cityCode}${bank.phone ? `<br/>${bank.phone}` : ""}`);
      layer.addLayer(m);
    }

    for (const hospital of hospitals || []) {
      if (hospital.latitude == null || hospital.longitude == null) continue;
      const m = L.marker([Number(hospital.latitude), Number(hospital.longitude)], { icon: hospitalIcon });
      const km = distances?.[hospital.hospitalId];
      m.bindPopup(
        `<strong>${hospital.name}</strong><br/>Hospital · ${hospital.cityCode}` +
          (km != null ? `<br/>${Math.round(km)} km from origin` : ""),
      );
      layer.addLayer(m);
    }

    if (distances && selectedCity) {
      const origin = cities.find((city) => city.cityCode === selectedCity);
      if (origin) {
        for (const city of cities) {
          if (city.cityCode === selectedCity) continue;
          const km = haversineKm(
            Number(origin.latitude),
            Number(origin.longitude),
            Number(city.latitude),
            Number(city.longitude),
          );
          const line = L.polyline(
            [
              [Number(origin.latitude), Number(origin.longitude)],
              [Number(city.latitude), Number(city.longitude)],
            ],
            { color: "#2563eb", weight: 2, dashArray: "6 8", opacity: 0.7 },
          );
          line.bindTooltip(`${origin.cityCode} → ${city.cityCode}: ${Math.round(km)} km`, { sticky: true });
          layer.addLayer(line);
        }
      }
    }
  }, [cities, banks, hospitals, stats, selectedCity, distances, onSelectCity]);

  return <div ref={containerRef} className="network-map" role="application" aria-label="Network inventory map" />;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = (deg) => (deg * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
