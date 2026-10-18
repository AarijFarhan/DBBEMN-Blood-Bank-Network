import { useMemo, useState } from "react";
import { api } from "../api";
import { useRequest } from "../hooks/useRequest";
import { useEventStream } from "../hooks/useEventStream";
import NetworkMap from "../components/NetworkMap";
import EventFeed from "../components/EventFeed";
import { Button, ErrorState, LoadingState, PageHeader, SectionCard, SimulatedBadge, StatCard } from "../components/UI";
import { formatNumber } from "../utils";

/**
 * Emergency network map.
 *
 * Cities, hospitals, and blood banks are drawn on OpenStreetMap with their
 * catalog coordinates. The marker colour and count come from the live
 * scatter-gather stats, and selecting an origin city draws Haversine distance
 * lines to every other shard — the same ranking the reservation saga uses when
 * a hospital asks for `searchScope: CROSS_CITY`.
 */
export function NetworkMapPage() {
  const citiesRequest = useRequest(() => api.catalog.cities(), []);
  const facilities = useRequest(() => Promise.all([api.catalog.bloodBanks(), api.catalog.hospitals()]).then(([banks, hospitals]) => ({ banks: banks.bloodBanks ?? [], hospitals: hospitals.hospitals ?? [] })), []);
  const stats = useRequest(() => api.stats.overview(), []);
  const feed = useEventStream({ enabled: true });
  const [selectedCity, setSelectedCity] = useState("KHI");
  const [originHospitalId, setOriginHospitalId] = useState("");

  const cities = useMemo(() => citiesRequest.data?.cities ?? [], [citiesRequest.data]);
  const banks = facilities.data?.banks ?? [];
  const hospitals = facilities.data?.hospitals ?? [];

  const originHospital = hospitals.find((hospital) => hospital.hospitalId === originHospitalId);

  const distances = useMemo(() => {
    if (!originHospital || !cities.length) return null;
    const originCity = cities.find((city) => city.cityCode === originHospital.cityCode);
    const originLat = Number(originHospital.latitude ?? originCity?.latitude);
    const originLon = Number(originHospital.longitude ?? originCity?.longitude);
    if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
    return Object.fromEntries(
      hospitals.map((hospital) => [
        hospital.hospitalId,
        haversineKm(originLat, originLon, Number(hospital.latitude), Number(hospital.longitude)),
      ]),
    );
  }, [originHospital, cities, hospitals]);

  const cityRows = useMemo(() => {
    if (!stats.data?.cities) return [];
    return Object.entries(stats.data.cities).map(([cityCode, city]) => {
      const total = Object.values(city.matrix || {}).reduce(
        (sum, groups) => sum + Object.values(groups).reduce((inner, count) => inner + count, 0),
        0,
      );
      const name = cities.find((item) => item.cityCode === cityCode)?.name ?? cityCode;
      const distanceKm = originHospital && originHospital.cityCode !== cityCode && originCityDistance(originHospital, cities, cityCode);
      return { cityCode, name, total, available: city.available ?? 0, reserved: city.reserved ?? 0, health: city.health, distanceKm };
    });
  }, [stats.data, cities, originHospital]);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Emergency operations"
        title="Network map"
        description="Live inventory pressure across every city shard, with Haversine distance ranking from your chosen origin."
        actions={<SimulatedBadge label="LIVE SSE" />}
      />
      {stats.loading || citiesRequest.loading || facilities.loading ? (
        <SectionCard><LoadingState label="Loading network map data" /></SectionCard>
      ) : null}
      {stats.error ? <ErrorState error={stats.error} onRetry={stats.reload} /> : null}
      {citiesRequest.error ? <ErrorState error={citiesRequest.error} onRetry={citiesRequest.reload} /> : null}

      <div className="stat-grid">
        {cityRows.map((row) => (
          <StatCard
            key={row.cityCode}
            label={row.name}
            value={formatNumber(row.total)}
            detail={`${row.cityCode} · ${row.health?.primaryUp === false ? "primary DOWN" : "shard online"}`}
            tone={row.total === 0 ? "red" : row.total < 5 ? "amber" : "green"}
            icon="map"
          />
        ))}
      </div>

      <div className="map-layout">
        <SectionCard
          title="Pakistan blood network"
          description="Marker size and colour reflect total available units. Click a city to select it as the distance origin."
          className="map-card"
        >
          <div className="map-toolbar">
            <label className="map-toolbar-field">
              <span>Distance origin</span>
              <select
                className="compact-select"
                value={originHospitalId}
                onChange={(event) => {
                  setOriginHospitalId(event.target.value);
                  const hospital = hospitals.find((item) => item.hospitalId === event.target.value);
                  if (hospital) setSelectedCity(hospital.cityCode);
                }}
              >
                <option value="">City centre ({selectedCity})</option>
                {hospitals.map((hospital) => (
                  <option key={hospital.hospitalId} value={hospital.hospitalId}>
                    {hospital.name} ({hospital.cityCode})
                  </option>
                ))}
              </select>
            </label>
            <Button variant="ghost" size="sm" onClick={() => { stats.reload(); feed.clear(); }}>
              Refresh map
            </Button>
          </div>
          <NetworkMap
            cities={cities}
            banks={banks}
            hospitals={hospitals}
            stats={stats.data}
            selectedCity={selectedCity}
            onSelectCity={setSelectedCity}
            distances={distances}
          />
        </SectionCard>

        <SectionCard title="Live activity" description="Mutations streaming from the API while this map is open." icon="wifi">
          <EventFeed events={feed.events} connected={feed.connected} onClear={feed.clear} />
        </SectionCard>
      </div>

      <SectionCard title="Distance ranking" description={`Haversine kilometres from ${originHospital?.name ?? selectedCity} to every other city.`}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>City</th><th>Code</th><th>Total units</th><th>Available</th><th>Reserved</th><th>Distance</th><th>Shard</th></tr>
            </thead>
            <tbody>
              {cityRows.map((row) => (
                <tr key={row.cityCode} className={row.cityCode === selectedCity ? "row-highlight" : ""}>
                  <td><strong>{row.name}</strong></td>
                  <td><code>{row.cityCode}</code></td>
                  <td>{formatNumber(row.total)}</td>
                  <td>{formatNumber(row.available)}</td>
                  <td>{formatNumber(row.reserved)}</td>
                  <td>{row.cityCode === selectedCity ? "Origin" : row.distanceKm != null ? `${Math.round(row.distanceKm)} km` : "—"}</td>
                  <td>{row.health?.primaryUp === false ? "Primary DOWN" : row.health?.replicaUp === false ? "Replica DOWN" : "Healthy"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function originCityDistance(originHospital, cities, cityCode) {
  const originCity = cities.find((city) => city.cityCode === originHospital.cityCode);
  const targetCity = cities.find((city) => city.cityCode === cityCode);
  if (!originCity || !targetCity) return null;
  const originLat = Number(originHospital.latitude ?? originCity.latitude);
  const originLon = Number(originHospital.longitude ?? originCity.longitude);
  if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return null;
  return haversineKm(originLat, originLon, Number(targetCity.latitude), Number(targetCity.longitude));
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
