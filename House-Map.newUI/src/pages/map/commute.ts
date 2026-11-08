import { MANUAL_SOURCE } from "./manual";

export type LngLat = [number, number];

export type CommuteMode = "ebike" | "ebike+transit" | "transit";

export interface CommuteResult {
  minutes: number;
  mode: CommuteMode;
  summary: string;
  alternatives?: CommuteResult[];
}

export interface CommuteSettings {
  city: string;
  office: LngLat;
  maxMinutes: number;
  ebikeSpeedKmh: number;
}

const CACHE_KEY = "house-map-commute-cache-v1";
// City road distance is typically ~1.3x the straight-line distance.
const DETOUR_FACTOR = 1.3;
const WALK_SPEED_KMH = 4.8;
const PARK_AT_OFFICE_MIN = 2;
// Parking the e-bike plus walking into the station.
const PARK_AT_STATION_MIN = 4;
const MAX_TO_STATION_KM = 5;
// Line 18 runs ~100 km/h, so far-out stations can still be within range.
const MAX_STRAIGHT_KM = 60;
const FASTEST_METRO_KMH = 110;
const COARSE_LEVELS = ["国家", "省", "市", "区县", "开发区"];

let store: Record<string, unknown> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function getStore() {
  if (!store) {
    try {
      store = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    } catch {
      store = {};
    }
  }
  return store!;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(getStore()));
    } catch {
      // localStorage full: keep the in-memory cache only.
    }
  }, 1000);
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const data = getStore();
  if (key in data) return data[key] as T;
  const value = await load();
  data[key] = value;
  scheduleSave();
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// "no_data" resolves to null (cacheable); errors reject so they are never cached.
function amapCall<T>(
  invoke: (callback: (status: string, result: any) => void) => void,
  pick: (result: any) => T | null,
): Promise<T | null> {
  const attempt = (retry: number): Promise<T | null> =>
    new Promise<T | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("AMAP_TIMEOUT")), 4000);
      invoke((status, result) => {
        clearTimeout(timer);
        if (status === "complete") resolve(pick(result));
        else if (status === "no_data") resolve(null);
        else {
          reject(new Error(
            typeof result === "string" ? result : result?.info || "AMap error",
          ));
        }
      });
    }).catch(async (error: Error) => {
      if (retry < 3 && /QPS/i.test(error.message)) {
        await sleep(800 * (retry + 1));
        return attempt(retry + 1);
      }
      throw error;
    });
  return attempt(0);
}

const keyOf = (p: LngLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
const toAMap = (p: LngLat) => new AMap.LngLat(p[0], p[1]);

export function distanceKm(a: LngLat, b: LngLat) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function nextWorkdayMorning() {
  const d = new Date();
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: "08:30",
  };
}

function geocode(city: string, address: string, allowCoarse = false) {
  return cached(`geo:${allowCoarse ? 1 : 0}:${city}:${address}`, () =>
    amapCall<LngLat>(
      (cb) => new AMap.Geocoder({ city }).getLocation(address, cb),
      (result) => {
        const geo = result?.geocodes?.[0];
        if (!geo?.location) return null;
        if (!allowCoarse && COARSE_LEVELS.includes(geo.level)) return null;
        return [geo.location.lng, geo.location.lat];
      },
    ).catch((error: Error) => {
      // The geocoder silently drops some addresses; treat that as "not found".
      if (error.message === "AMAP_TIMEOUT") return null;
      throw error;
    }));
}

// POI search is far better than geocoding for building/community names; errors (e.g. quota) fall back silently.
export function searchPoi(city: string, keyword: string) {
  return cached(`poi:${city}:${keyword}`, () =>
    amapCall<LngLat>(
      (cb) => new AMap.PlaceSearch({ city, citylimit: true, pageSize: 1 }).search(keyword, cb),
      (result) => {
        const poi = result?.poiList?.pois?.[0];
        return poi?.location ? [poi.location.lng, poi.location.lat] : null;
      },
    )).catch(() => null);
}

export async function locateHouse(
  house: HouseListItem,
  office: LngLat,
): Promise<LngLat | null> {
  if (house.source === MANUAL_SOURCE) {
    const poi = await searchPoi(house.city, house.location);
    if (poi) return poi;
    // The geocoder silently ignores some query spellings, so try both "广州市xxx" and "广州xxx".
    const prefix = house.city.endsWith("市") ? house.city : `${house.city}市`;
    for (const query of [`${prefix}${house.location}`, `${house.city}${house.location}`]) {
      const position = await geocode(house.city, query);
      if (position) return position;
    }
  }
  const district = house.district && !house.district.includes("周边")
    ? house.district
    : "";
  if (district) {
    const center = await geocode(house.city, `${house.city}${district}`, true);
    // Skip whole districts that are obviously out of range to save quota.
    if (center && distanceKm(center, office) > MAX_STRAIGHT_KM + 10) return null;
  }
  const community = (house.title || "").split(/\s+/)[0];
  const candidates = [house.location, community].filter(Boolean);
  for (const text of candidates) {
    const position = await geocode(house.city, `${house.city}${district}${text}`);
    if (position) return position;
  }
  return null;
}

function ridingKm(from: LngLat, to: LngLat) {
  return cached(`ride:${keyOf(from)}>${keyOf(to)}`, () =>
    amapCall<number>(
      (cb) => new AMap.Riding().search(toAMap(from), toAMap(to), cb),
      (result) => {
        const meters = result?.routes?.[0]?.distance;
        return typeof meters === "number" ? meters / 1000 : null;
      },
    ));
}

// fromStation: origin is a station centre, so drop the leading walk into the subway
// (the caller already adds its own access leg + parking time).
function transitMinutes(city: string, from: LngLat, to: LngLat, fromStation = false) {
  return cached(`bus2:${fromStation ? 1 : 0}:${keyOf(from)}>${keyOf(to)}`, () =>
    amapCall<number>(
      (cb) => {
        const transfer = new AMap.Transfer({
          city,
          policy: AMap.TransferPolicy.LEAST_TIME,
          extensions: "all",
        });
        const { date, time } = nextWorkdayMorning();
        // Without this AMap plans for "now", which at night means night buses only.
        transfer.leaveAt(time, date);
        transfer.search(toAMap(from), toAMap(to), cb);
      },
      (result) => {
        const times = (result?.plans || [])
          .filter((plan: any) => typeof plan.time === "number")
          .map((plan: any) => {
            const [first, second] = plan.segments || [];
            const skip = fromStation && first?.transit_mode === "WALK" &&
                second?.transit_mode === "SUBWAY"
              ? first.time || 0
              : 0;
            return plan.time - skip;
          });
        return times.length ? Math.round(Math.min(...times) / 60) : null;
      },
    ));
}

interface Station {
  name: string;
  lnglat: LngLat;
}

const SUBWAY_FILES: Record<string, string> = {
  广州: "4401_drw_guangzhou.json",
  北京: "1100_drw_beijing.json",
  上海: "3100_drw_shanghai.json",
  深圳: "4403_drw_shenzhen.json",
  杭州: "3301_drw_hangzhou.json",
};
const stationLists = new Map<string, Promise<Station[]>>();

function loadStations(city: string) {
  if (!stationLists.has(city)) {
    const file = SUBWAY_FILES[city];
    const promise = file
      ? fetch(`/amap-subway?srhdata=${file}`)
        .then((res) => res.json())
        .then((data) => {
          const byName = new Map<string, Station>();
          for (const line of data?.l || []) {
            for (const st of line.st || []) {
              const [lng, lat] = String(st.sl).split(",").map(Number);
              if (st.n && Number.isFinite(lng) && Number.isFinite(lat)) {
                byName.set(st.n, { name: st.n, lnglat: [lng, lat] });
              }
            }
          }
          return [...byName.values()];
        })
        .catch(() => [] as Station[])
      : Promise.resolve([] as Station[]);
    stationLists.set(city, promise);
  }
  return stationLists.get(city)!;
}

async function nearbyStations(city: string, center: LngLat) {
  return (await loadStations(city))
    .map((station) => ({ station, km: distanceKm(center, station.lnglat) }))
    .filter((item) => item.km <= MAX_TO_STATION_KM)
    .sort((a, b) => a.km - b.km)
    .map((item) => item.station);
}

export async function computeCommute(
  home: LngLat,
  settings: CommuteSettings,
): Promise<CommuteResult | null> {
  const { city, office, maxMinutes, ebikeSpeedKmh } = settings;
  const straight = distanceKm(home, office);
  if (straight > MAX_STRAIGHT_KM) return null;
  const ebikeMin = (km: number) => (km / ebikeSpeedKmh) * 60;
  const options: CommuteResult[] = [];

  if (ebikeMin(straight * DETOUR_FACTOR) + PARK_AT_OFFICE_MIN <= maxMinutes + 10) {
    const km = await ridingKm(home, office);
    if (km !== null) {
      options.push({
        minutes: Math.round(ebikeMin(km) + PARK_AT_OFFICE_MIN),
        mode: "ebike",
        summary: `电动车直达公司（${km.toFixed(1)} km）`,
      });
    }
  }

  const stations = await nearbyStations(city, home);
  for (const station of stations) {
    const km = distanceKm(home, station.lnglat) * DETOUR_FACTOR;
    const walk = (km / WALK_SPEED_KMH) * 60 + 1;
    const ride = ebikeMin(km) + PARK_AT_STATION_MIN;
    const leg = Math.min(walk, ride);
    const bestCase = leg + (distanceKm(station.lnglat, office) / FASTEST_METRO_KMH) * 60 + 5;
    if (bestCase > maxMinutes) continue;
    const transit = await transitMinutes(city, station.lnglat, office, true);
    if (transit === null) continue;
    const stationName = station.name.endsWith("站") ? station.name : `${station.name}站`;
    options.push({
      minutes: Math.round(leg + transit),
      mode: "ebike+transit",
      summary: `${walk <= ride ? "步行" : "电动车"} ${km.toFixed(1)} km 到${stationName} + 地铁/公交 ${transit} 分钟`,
    });
  }

  // With an e-bike, riding to a metro station beats walking to a bus stop in almost all cases.
  if (!stations.length && straight <= 15 && !options.some((o) => o.minutes <= maxMinutes)) {
    const transit = await transitMinutes(city, home, office);
    if (transit !== null) {
      options.push({ minutes: transit, mode: "transit", summary: "纯公交/地铁 + 步行" });
    }
  }

  if (!options.length) return null;
  options.sort((a, b) => a.minutes - b.minutes);
  return { ...options[0], alternatives: options.slice(1) };
}

export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let index = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}
