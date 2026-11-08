import { HomeFilterOptions } from "@/constant";
import { useCities } from "@/hook/cities";
import { useUserInfo } from "@/hook/user";
import { housesService } from "@/services";
import {
  AimOutlined,
  EnvironmentOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import {
  Button,
  Input,
  InputNumber,
  message,
  Modal,
  Progress,
  Select,
  Slider,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet";
import { useSearchParams } from "react-router-dom";
import {
  computeCommute,
  type CommuteResult,
  locateHouse,
  runPool,
  searchPoi,
} from "./commute";
import {
  addManualHouses,
  loadManualHouses,
  MANUAL_SOURCE,
  parseManualInput,
  removeManualHouse,
} from "./manual";
import styles from "./styles.module.css";

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || "8b942f01c2c6b908b8594f86c07c1725";
const AMAP_SECURITY_CODE = import.meta.env.VITE_AMAP_SECURITY_CODE;
const AMAP_SCRIPT_ID = "house-search-amap";
const AMAP_UI_SCRIPT_ID = "house-search-amap-ui";

const MARKER_STYLES = [
  { type: "Blue", url: "/images/Blue.png" },
  { type: "PaleGreen", url: "/images/PaleGreen.png" },
  { type: "LightGreen", url: "/images/LightGreen.png" },
  { type: "PaleYellow", url: "/images/PaleYellow.png" },
  { type: "OrangeYellow", url: "/images/OrangeYellow.png" },
  { type: "PaleRed", url: "/images/PaleRed.png" },
  { type: "Red", url: "/images/Red.png" },
  { type: "Pink", url: "/images/Pink.png" },
  { type: "Violet", url: "/images/Violet.png" },
  { type: "Black", url: "/images/Black.png" },
];

type LngLatTuple = [number, number];

interface MarkerPayload {
  lnglat: LngLatTuple;
  style: number;
  name: string;
  house: HouseListItem;
  title: string;
  displayMoney: string;
  sourceContent: string;
  commute?: CommuteResult;
}

interface CommuteMatch {
  house: HouseListItem;
  lnglat: LngLatTuple;
  commute: CommuteResult;
}

const FATAL_AMAP_ERROR = /DAILY|INVALID_USER|USERKEY|SCODE|DOMAIN|INSUFFICIENT|ACCESS_DENIED|SERVICE_NOT/i;

interface FilterDraft {
  city: string;
  source: string;
  rentType: number;
  keyword: string;
  intervalDay: number;
}

const scriptPromises = new Map<string, Promise<void>>();

function loadScript(id: string, src: string) {
  if (scriptPromises.has(id)) return scriptPromises.get(id)!;
  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("脚本加载失败")), {
        once: true,
      });
      if (existing.dataset.loaded === "true") resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.charset = "utf-8";
    script.src = src;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error("地图脚本加载失败"));
    document.head.appendChild(script);
  });
  scriptPromises.set(id, promise);
  return promise;
}

async function loadAmap() {
  if (typeof AMap !== "undefined") return;
  if (AMAP_SECURITY_CODE) {
    (window as any)._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE };
  }
  const plugins = [
    "AMap.Scale",
    "AMap.Geocoder",
    "AMap.Transfer",
    "AMap.Riding",
    "AMap.AutoComplete",
    "AMap.PlaceSearch",
    "AMap.CitySearch",
    "AMap.ArrivalRange",
    "AMap.ToolBar",
  ];
  await loadScript(
    AMAP_SCRIPT_ID,
    `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&plugin=${plugins.join()}`,
  );
  await loadScript(
    AMAP_UI_SCRIPT_ID,
    "//webapi.amap.com/ui/1.1/main.js?v=1.1.1",
  ).catch(() => undefined);
}

function getNumber(value?: string | number) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getHouseLngLat(house: HouseListItem): LngLatTuple | undefined {
  const lng = getNumber(house.longitude);
  const lat = getNumber(house.latitude);
  if (lng === undefined || lat === undefined) return undefined;
  return [lng, lat];
}

function getStyleIndex(house: HouseListItem) {
  if (house.icon) {
    const iconIndex = MARKER_STYLES.findIndex((style) =>
      house.icon?.includes(style.type)
    );
    if (iconIndex >= 0) return iconIndex;
  }
  if (!house.price || house.price < 0) return 0;
  return Math.min(Math.floor(house.price / 1000), MARKER_STYLES.length - 1);
}

function getSearchFilter(searchParams: URLSearchParams): FilterDraft {
  return {
    city: searchParams.get("city") || "上海",
    source: searchParams.get("source") || "all",
    rentType: Number(searchParams.get("rentType") || -1),
    keyword: searchParams.get("keyword") || "",
    intervalDay: Number(searchParams.get("intervalDay") || 30),
  };
}

export default function MapPage() {
  const cities = useCities();
  const { userInfo } = useUserInfo(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const routeFilter = useMemo(() => getSearchFilter(searchParams), [searchParams]);
  const [draft, setDraft] = useState<FilterDraft>(routeFilter);
  const [loading, setLoading] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [workAddress, setWorkAddress] = useState(searchParams.get("work") || "");
  const [commuteMinutes, setCommuteMinutes] = useState(45);
  const [commuteMode, setCommuteMode] = useState("");
  const [ebikeSpeed, setEbikeSpeed] = useState(18);
  const [maxPrice, setMaxPrice] = useState(6000);
  const [pageCount, setPageCount] = useState(1);
  const [commuteRunning, setCommuteRunning] = useState(false);
  const [commuteProgress, setCommuteProgress] = useState({ done: 0, total: 0 });
  const [commuteMatches, setCommuteMatches] = useState<CommuteMatch[]>();
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualHouses, setManualHouses] = useState<HouseListItem[]>([]);
  const [routePanelOpen, setRoutePanelOpen] = useState(false);
  const [routeSidebarOpen, setRouteSidebarOpen] = useState(false);
  const [commutePosition, setCommutePosition] = useState<LngLatTuple>();

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const routePanelRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>();
  const geocoderRef = useRef<any>();
  const massMarksRef = useRef<any>();
  const markersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<any>();
  const transferRef = useRef<any>();
  const polygonsRef = useRef<any[]>([]);
  const markerPayloadsRef = useRef(new Map<string, MarkerPayload>());
  const housesRef = useRef<HouseListItem[]>([]);
  const commuteAbortRef = useRef(false);
  const commutePositionRef = useRef<LngLatTuple>();
  commutePositionRef.current = commutePosition;

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  useEffect(() => {
    setDraft(routeFilter);
  }, [routeFilter]);

  const selectedCity = useMemo(
    () => cities.find((item) => item.city === routeFilter.city),
    [cities, routeFilter.city],
  );

  const sourceOptions = useMemo(() => {
    const sources = selectedCity?.sources || [];
    return [
      { label: "全部", value: "all" },
      ...sources.map((source) => ({
        label: source.displaySource,
        value: source.source,
      })),
    ];
  }, [selectedCity]);

  const clearMapOverlays = useCallback(() => {
    if (massMarksRef.current) {
      massMarksRef.current.clear();
      massMarksRef.current.setMap(null);
      massMarksRef.current = undefined;
    }
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];
    if (infoWindowRef.current) {
      infoWindowRef.current.close();
    }
  }, []);

  const collectHouse = useCallback(async (house: HouseListItem) => {
    if (!userInfo) {
      message.warning("请先登录");
      return;
    }
    try {
      await housesService.addCollection(userInfo.id, house.id);
      message.success("收藏成功");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "收藏失败");
    }
  }, [userInfo]);

  const resolveAddress = useCallback((address: string) => {
    return new Promise<LngLatTuple | undefined>((resolve) => {
      const geocoder = geocoderRef.current;
      const text = address.trim();
      if (!geocoder || !text) {
        resolve(undefined);
        return;
      }
      // AMap never calls back for some addresses lacking a city prefix.
      const timer = setTimeout(() => resolve(undefined), 8000);
      const city = routeFilter.city;
      const query = text.startsWith(city) ? text : `${city}${text}`;
      geocoder.getLocation(query, (status: string, result: any) => {
        clearTimeout(timer);
        const location = result?.geocodes?.[0]?.location;
        if (status === "complete" && location) {
          resolve([location.lng, location.lat]);
          return;
        }
        resolve(undefined);
      });
    });
  }, [routeFilter.city]);

  const ensureCommutePosition = useCallback(async () => {
    if (commutePositionRef.current) return commutePositionRef.current;
    const position = (workAddress.trim() && await searchPoi(routeFilter.city, workAddress.trim())) ||
      await resolveAddress(workAddress || routeFilter.city);
    if (position) {
      setCommutePosition(position);
      return position;
    }
    message.warning("没有找到出发位置");
    return undefined;
  }, [resolveAddress, routeFilter.city, workAddress]);

  const startTransfer = useCallback(async (
    destination: LngLatTuple,
    commute?: CommuteResult,
  ) => {
    const map = mapRef.current;
    const start = await ensureCommutePosition();
    if (!map || !start) return;
    if (transferRef.current) transferRef.current.clear();
    if (routePanelRef.current) routePanelRef.current.innerHTML = "";
    setRoutePanelOpen(true);
    setRouteSidebarOpen(true);
    const transfer = commute?.mode === "ebike"
      ? new AMap.Riding({ map, panel: routePanelRef.current })
      : new AMap.Transfer({
        city: routeFilter.city,
        map,
        panel: routePanelRef.current,
        extensions: "all",
        policy: AMap.TransferPolicy.LEAST_TIME,
      });
    transferRef.current = transfer;
    transfer.search(
      new AMap.LngLat(start[0], start[1]),
      new AMap.LngLat(destination[0], destination[1]),
      (status: string) => {
        if (status !== "complete") message.warning("没有找到合适路线");
      },
    );
  }, [ensureCommutePosition, routeFilter.city]);

  const openInfoWindow = useCallback((payload: MarkerPayload) => {
    const map = mapRef.current;
    if (!map) return;
    const content = document.createElement("div");
    content.className = styles.infoWindow;

    const isManual = payload.house.source === MANUAL_SOURCE;
    const title = document.createElement("a");
    title.className = styles.infoTitle;
    if (!isManual) title.href = `/houses/${payload.house.id}`;
    else if (payload.house.onlineURL) title.href = payload.house.onlineURL;
    title.target = "_blank";
    title.rel = "noreferrer";
    title.textContent = payload.title;
    content.appendChild(title);

    const meta = document.createElement("div");
    meta.className = styles.infoMeta;
    meta.textContent = `${payload.displayMoney || "价格未知"} · ${payload.sourceContent}`;
    content.appendChild(meta);

    const address = document.createElement("div");
    address.className = styles.infoAddress;
    address.textContent = payload.house.location || payload.house.district || "";
    content.appendChild(address);

    if (payload.commute) {
      const commute = document.createElement("div");
      commute.className = styles.infoCommute;
      commute.textContent = `通勤约 ${payload.commute.minutes} 分钟：${payload.commute.summary}`;
      content.appendChild(commute);
      payload.commute.alternatives?.slice(0, 2).forEach((alt) => {
        const line = document.createElement("div");
        line.className = styles.infoMeta;
        line.textContent = `备选 ${alt.minutes} 分钟：${alt.summary}`;
        content.appendChild(line);
      });
    }

    const actions = document.createElement("div");
    actions.className = styles.infoActions;

    const collect = document.createElement("button");
    collect.type = "button";
    collect.textContent = "收藏";
    collect.addEventListener("click", () => collectHouse(payload.house));
    if (!isManual) actions.appendChild(collect);

    const route = document.createElement("button");
    route.type = "button";
    route.textContent = "导航";
    route.addEventListener("click", () => startTransfer(payload.lnglat, payload.commute));
    actions.appendChild(route);

    content.appendChild(actions);

    if (!infoWindowRef.current) {
      infoWindowRef.current = new AMap.InfoWindow({
        offset: new AMap.Pixel(8, 0),
      });
    }
    infoWindowRef.current.setContent(content);
    infoWindowRef.current.open(map, payload.lnglat);
  }, [collectHouse, startTransfer]);

  const renderMarkers = useCallback((
    data: HouseListItem[],
    commuteData?: Map<string, CommuteMatch>,
    fit = true,
  ) => {
    const map = mapRef.current;
    if (!map) return;
    clearMapOverlays();
    const payloads = data
      .map((house) => {
        const match = commuteData?.get(house.id);
        const lnglat = match?.lnglat || getHouseLngLat(house);
        if (!lnglat) return undefined;
        const title = house.title || house.location;
        return {
          lnglat,
          style: getStyleIndex(house),
          name: title,
          house,
          title,
          displayMoney: house.price > 0 ? `￥${house.price}/月` : "",
          sourceContent: house.displaySource || house.source,
          commute: match?.commute,
        };
      })
      .filter(Boolean) as MarkerPayload[];

    markerPayloadsRef.current = new Map(
      payloads.map((payload) => [payload.house.id, payload]),
    );

    if (!payloads.length) return;

    const style = MARKER_STYLES.map((item) => ({
      url: item.url,
      anchor: new AMap.Pixel(3, 3),
      size: new AMap.Size(19, 30),
    }));

    if (AMap.MassMarks) {
      const massMarks = new AMap.MassMarks([], {
        zIndex: 120,
        zooms: [3, 19],
        style,
      });
      massMarks.on("click", (event: any) => {
        openInfoWindow(event.data as MarkerPayload);
      });
      massMarks.setMap(map);
      massMarks.setData(payloads);
      massMarksRef.current = massMarks;
    } else {
      markersRef.current = payloads.map((payload) => {
        const marker = new AMap.Marker({
          map,
          position: payload.lnglat,
          title: payload.title,
        });
        marker.on("click", () => openInfoWindow(payload));
        return marker;
      });
    }

    if (!fit) return;
    const center = payloads.reduce<LngLatTuple>(
      (acc, payload) => [acc[0] + payload.lnglat[0], acc[1] + payload.lnglat[1]],
      [0, 0] as LngLatTuple,
    );
    map.setZoomAndCenter(payloads.length === 1 ? 16 : 12, [
      center[0] / payloads.length,
      center[1] / payloads.length,
    ]);
  }, [clearMapOverlays, openInfoWindow]);

  const loadHouses = useCallback(async () => {
    if (!mapReady) return;
    setLoading(true);
    commuteAbortRef.current = true;
    setCommuteMatches(undefined);
    try {
      const seen = new Set<string>();
      const list: HouseListItem[] = [];
      for (let page = 0; page < pageCount; page++) {
        const items = await housesService.getMapHouses({
          city: routeFilter.city,
          source: routeFilter.source,
          rentType: routeFilter.rentType,
          keyword: routeFilter.keyword,
          page,
          size: 1200,
        });
        items.forEach((item) => {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            list.push(item);
          }
        });
        if (items.length < 1200) break;
      }
      const manual = loadManualHouses(routeFilter.city);
      setManualHouses(manual);
      if (routeFilter.source === "all") list.unshift(...manual);
      housesRef.current = list;
      renderMarkers(list);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "加载房源失败");
    } finally {
      setLoading(false);
    }
  }, [mapReady, pageCount, renderMarkers, routeFilter]);

  useEffect(() => {
    let disposed = false;
    loadAmap()
      .then(() => {
        if (disposed || !mapContainerRef.current) return;
        const map = new AMap.Map(mapContainerRef.current, {
          zoom: 12,
          resizeEnable: true,
          viewMode: "2D",
        });
        map.addControl(new AMap.ToolBar());
        map.addControl(new AMap.Scale());
        mapRef.current = map;
        geocoderRef.current = new AMap.Geocoder({
          city: routeFilter.city,
          radius: 1000,
        });
        setMapReady(true);
      })
      .catch((error) => {
        message.error(error instanceof Error ? error.message : "地图初始化失败");
        setLoading(false);
      });
    return () => {
      disposed = true;
      clearMapOverlays();
      transferRef.current?.clear?.();
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const geocoder = geocoderRef.current;
    if (!mapReady || !map || !geocoder) return;
    geocoder.setCity(routeFilter.city);
    map.setCity(routeFilter.city);
    resolveAddress(routeFilter.city).then((position) => {
      if (position) map.setZoomAndCenter(12, position);
    });
  }, [mapReady, resolveAddress, routeFilter.city]);

  useEffect(() => {
    loadHouses();
  }, [loadHouses]);

  useEffect(() => {
    if (!mapReady || typeof AMap === "undefined") return;
    const autocomplete = new AMap.AutoComplete({
      input: "map-work-address",
      city: routeFilter.city,
    });
    autocomplete.on("select", (event: any) => {
      const location = event?.poi?.location;
      if (location) {
        setWorkAddress(event.poi.name || event.poi.address || "");
        setCommutePosition([location.lng, location.lat]);
        mapRef.current?.setZoomAndCenter(14, [location.lng, location.lat]);
      }
    });
  }, [mapReady, routeFilter.city]);

  const applyFilter = () => {
    const next = new URLSearchParams();
    next.set("city", draft.city || "上海");
    if (draft.source && draft.source !== "all") next.set("source", draft.source);
    if (draft.rentType !== -1) next.set("rentType", String(draft.rentType));
    if (draft.keyword.trim()) next.set("keyword", draft.keyword.trim());
    if (workAddress.trim()) next.set("work", workAddress.trim());
    setSearchParams(next);
  };

  const runCommuteFilter = async (only?: HouseListItem[]) => {
    if (commuteRunning) {
      if (!only) commuteAbortRef.current = true;
      else message.warning("正在筛选，完成后会包含新添加的房源");
      return;
    }
    const office = await ensureCommutePosition();
    if (!office) return;
    const houses = (only || housesRef.current).filter(
      (house) => !house.price || house.price <= maxPrice,
    );
    if (!houses.length) {
      message.warning("当前没有房源");
      return;
    }
    const settings = {
      city: routeFilter.city,
      office,
      maxMinutes: commuteMinutes,
      ebikeSpeedKmh: ebikeSpeed,
    };
    const matches = new Map<string, CommuteMatch>(
      only ? (commuteMatches || []).map((item) => [item.house.id, item]) : [],
    );
    const unlocated: string[] = [];
    let done = 0;
    let fatal: Error | undefined;
    commuteAbortRef.current = false;
    setCommuteRunning(true);
    setRouteSidebarOpen(true);
    if (!only) setCommuteMatches([]);
    setCommuteProgress({ done: 0, total: houses.length });
    const publish = (fit: boolean) => {
      const list = [...matches.values()].sort(
        (a, b) => a.commute.minutes - b.commute.minutes || a.house.price - b.house.price,
      );
      setCommuteMatches(list);
      renderMarkers(list.map((item) => item.house), matches, fit);
    };
    await runPool(houses, 6, async (house) => {
      if (commuteAbortRef.current || fatal) return;
      try {
        const isManual = house.source === MANUAL_SOURCE;
        const lnglat = getHouseLngLat(house) || await locateHouse(house, office);
        if (!lnglat && isManual) unlocated.push(house.title);
        if (lnglat) {
          const commute = await computeCommute(lnglat, settings);
          // Manual candidates are always listed so their time is visible even when too long.
          if (commute && (commute.minutes <= commuteMinutes || isManual)) {
            matches.set(house.id, { house, lnglat, commute });
          } else if (!commute && isManual) {
            unlocated.push(`${house.title}（太远或无路线）`);
          }
        }
      } catch (error) {
        if (error instanceof Error && FATAL_AMAP_ERROR.test(error.message)) {
          fatal = error;
        }
      }
      done++;
      if (done % 25 === 0) {
        setCommuteProgress({ done, total: houses.length });
        publish(false);
      }
    });
    setCommuteProgress({ done, total: houses.length });
    publish(true);
    setCommuteRunning(false);
    if (fatal) message.error(`高德地图接口不可用：${fatal.message}`);
    else if (only) {
      const lines = only
        .map((house) => matches.get(house.id))
        .filter((item): item is CommuteMatch => !!item)
        .map((item) => `${item.house.title}：${item.commute.minutes} 分钟`);
      message.success(lines.length ? lines.join("；") : "已添加");
    } else {
      message.success(`找到 ${matches.size} 套 ${commuteMinutes} 分钟内可达的房源`);
    }
    if (unlocated.length) {
      message.warning(`定位不到：${unlocated.join("、")}。可以换成更完整的地址再试`, 8);
    }
  };

  const exportCsv = () => {
    const rows = (commuteMatches || []).filter((item) => item.commute.minutes <= commuteMinutes);
    if (!rows.length) {
      message.warning("没有可导出的结果");
      return;
    }
    // Prefix formula-like cells so Excel won't evaluate them.
    const cell = (value: unknown) => {
      const text = String(value ?? "").replace(/^([=+\-@])/, "'$1");
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ["通勤(分钟)", "通勤方式", "月租", "小区", "标题", "区域", "平台", "类型", "发布日期", "链接"];
    const lines = rows.map(({ house, commute }) => [
      commute.minutes,
      commute.summary,
      house.price || "",
      (house.title || "").split(/\s+/)[0],
      house.title,
      house.district,
      house.displaySource || house.source,
      house.displayRentType || "",
      house.publishDate,
      house.onlineURL,
    ].map(cell).join(","));
    const blob = new Blob(["\ufeff" + [header.map(cell).join(","), ...lines].join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `通勤${commuteMinutes}分钟房源-${routeFilter.city}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const submitManual = () => {
    const added = parseManualInput(manualText, routeFilter.city);
    if (!added.length) {
      message.warning("请至少填写一个小区名或地址");
      return;
    }
    addManualHouses(added);
    setManualHouses((list) => [...list, ...added]);
    housesRef.current = [...added, ...housesRef.current];
    setManualText("");
    setManualOpen(false);
    runCommuteFilter(added);
  };

  const deleteManual = (id: string) => {
    removeManualHouse(id);
    setManualHouses((list) => list.filter((house) => house.id !== id));
    housesRef.current = housesRef.current.filter((house) => house.id !== id);
    if (commuteMatches) {
      const rest = commuteMatches.filter((item) => item.house.id !== id);
      setCommuteMatches(rest);
      renderMarkers(
        rest.map((item) => item.house),
        new Map(rest.map((item) => [item.house.id, item])),
        false,
      );
    }
  };

  const resetFilter = () => {
    setDraft({
      city: routeFilter.city,
      source: "all",
      rentType: -1,
      keyword: "",
      intervalDay: 30,
    });
    setSearchParams({ city: routeFilter.city });
  };

  const runArrivalRange = async () => {
    const map = mapRef.current;
    if (!map || !AMap.ArrivalRange) {
      message.warning("当前地图 SDK 不支持到达圈");
      return;
    }
    const position = await ensureCommutePosition();
    if (!position) return;
    if (polygonsRef.current.length) {
      map.remove(polygonsRef.current);
      polygonsRef.current = [];
    }
    const arrivalRange = new AMap.ArrivalRange();
    arrivalRange.search(
      new AMap.LngLat(position[0], position[1]),
      commuteMinutes,
      (status: string, result: any) => {
        if (status !== "complete" || !result?.bounds?.length) {
          message.warning("没有找到可达范围");
          return;
        }
        const polygons = result.bounds.map((bound: any) => {
          const polygon = new AMap.Polygon({
            fillColor: "#00a3ca",
            fillOpacity: 0.22,
            strokeColor: "#00a3ca",
            strokeOpacity: 0.72,
            strokeWeight: 1,
          });
          polygon.setPath(bound);
          return polygon;
        });
        polygonsRef.current = polygons;
        map.add(polygons);
        map.setFitView(polygons);
      },
      { policy: commuteMode },
    );
  };

  return (
    <div className={styles.mapPage}>
      <Helmet>
        <title>{`地图搜租房-${routeFilter.city}`}</title>
      </Helmet>

      <a
        className={styles.noticeBar}
        href="https://wj.qq.com/s/2953926/aabe"
        target="_blank"
        rel="noreferrer"
      >
        特此声明:房源信息来自网络，请自行鉴别。合租需谨慎，群租有风险，长租公寓多当心。
      </a>

      <header className={styles.topBar}>
        <div className={styles.headerTitle}>
          <a href="/" className={styles.topBrand}>
            <img src="/logo.png" alt="地图搜租房" />
            <span>地图搜租房</span>
          </a>
          <div className={styles.topCity}>
            <EnvironmentOutlined />
            <Select
              value={draft.city}
              variant="borderless"
              options={cities.map((city) => ({ label: city.city, value: city.city }))}
              onChange={(city) =>
                setDraft((value) => ({ ...value, city, source: "all" }))}
            />
          </div>
        </div>
        <div className={styles.headerSearch}>
          <Button className={styles.addKeywordButton}>
            + 关键词
          </Button>
          <Button type="primary" onClick={applyFilter} loading={loading}>
            搜索
          </Button>
        </div>
      </header>

      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>房源类型:</span>
        <Select
          className={styles.typeSelect}
          value={draft.rentType}
          options={HomeFilterOptions.types.map((item) => ({
            label: item.label,
            value: item.value,
          }))}
          onChange={(rentType) => setDraft((value) => ({ ...value, rentType }))}
        />
        <span className={styles.filterLabel}>房源:</span>
        <div className={styles.sourceTabs}>
          {sourceOptions.map((source) => (
            <button
              key={source.value}
              className={draft.source === source.value ? styles.sourceTabActive : ""}
              type="button"
              onClick={() => setDraft((value) => ({ ...value, source: source.value }))}
            >
              {source.label}
            </button>
          ))}
        </div>
        <Button className={styles.resetButton} onClick={resetFilter}>
          重置
        </Button>
        <span className={styles.filterLabel}>房源量:</span>
        <Select
          style={{ width: 150 }}
          value={pageCount}
          options={[1, 2, 3, 5, 8].map((value) => ({
            label: `最新 ${value * 1200} 条`,
            value,
          }))}
          onChange={setPageCount}
        />
        <span className={styles.filterLabel}>电动车时速:</span>
        <InputNumber
          style={{ width: 130 }}
          min={8}
          max={25}
          value={ebikeSpeed}
          onChange={(value) => setEbikeSpeed(value || 18)}
          addonAfter="km/h"
        />
        <span className={styles.filterLabel}>最高月租:</span>
        <InputNumber
          style={{ width: 120 }}
          min={500}
          step={500}
          value={maxPrice}
          onChange={(value) => setMaxPrice(value || 6000)}
        />
        <Button type="primary" onClick={() => runCommuteFilter()} disabled={loading}>
          {commuteRunning ? "停止" : `通勤 ${commuteMinutes} 分钟筛选`}
        </Button>
        <Button onClick={() => setManualOpen(true)} disabled={loading}>
          + 手动添加（{manualHouses.length}）
        </Button>
        <Button onClick={exportCsv} disabled={!commuteMatches?.length || commuteRunning}>
          导出表格
        </Button>
      </div>

      <Modal
        title="手动添加候选房源"
        open={manualOpen}
        okText="添加并计算通勤"
        cancelText="取消"
        onOk={submitManual}
        onCancel={() => setManualOpen(false)}
      >
        <p className={styles.manualHint}>
          每行一套：小区名或地址、价格、链接（价格和链接可省略，空格或逗号分隔）。
          小区名尽量写完整，必要时加上区名，如“番禺 万科欧泊”。
        </p>
        <Input.TextArea
          rows={6}
          value={manualText}
          onChange={(event) => setManualText(event.target.value)}
          placeholder={"万科欧泊 4300 https://www.xiaohongshu.com/explore/...\n海珠 广州四建职工宿舍 1250\n奥园城市天地"}
        />
        {manualHouses.length > 0 && (
          <div className={styles.manualList}>
            <strong>已添加（{routeFilter.city}）</strong>
            {manualHouses.map((house) => (
              <div key={house.id} className={styles.manualRow}>
                <span>
                  {house.title}
                  {house.price ? ` · ￥${house.price}` : ""}
                </span>
                <Button type="link" size="small" danger onClick={() => deleteManual(house.id)}>
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <div
        className={`${styles.mapBody} ${
          routeSidebarOpen ? "" : styles.mapBodyCollapsed
        }`}
      >
        <aside className={styles.navigationPanel}>
          {commuteMatches && (
            <div className={styles.commutePanel}>
              <div className={styles.routeHeader}>
                <span>
                  通勤 {commuteMinutes} 分钟内（
                  {commuteMatches.filter((item) => item.commute.minutes <= commuteMinutes).length} 套）
                </span>
              </div>
              {commuteRunning && (
                <Progress
                  className={styles.commuteProgress}
                  percent={Math.floor(
                    (commuteProgress.done / Math.max(commuteProgress.total, 1)) * 100,
                  )}
                  size="small"
                />
              )}
              {commuteMatches.map((item) => (
                <div
                  key={item.house.id}
                  role="button"
                  tabIndex={0}
                  className={styles.commuteItem}
                  onClick={() => {
                    mapRef.current?.setZoomAndCenter(15, item.lnglat);
                    const payload = markerPayloadsRef.current.get(item.house.id);
                    if (payload) openInfoWindow(payload);
                  }}
                >
                  <strong
                    className={item.commute.minutes > commuteMinutes ? styles.overLimit : ""}
                  >
                    {item.commute.minutes} 分钟 · {item.house.price ? `￥${item.house.price}` : "价格未知"}
                  </strong>
                  <span>
                    {item.house.source === MANUAL_SOURCE ? "【手动】" : ""}
                    {item.house.title}
                  </span>
                  <em>
                    {item.house.district ? `${item.house.district} · ` : ""}
                    {item.commute.summary}
                  </em>
                  <small>
                    {item.house.displaySource || item.house.source}
                    {item.house.displayRentType ? ` · ${item.house.displayRentType}` : ""}
                    {item.house.publishDate ? ` · ${item.house.publishDate}` : ""}
                    {item.house.onlineURL && (
                      <a
                        href={item.house.onlineURL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        看原帖
                      </a>
                    )}
                  </small>
                </div>
              ))}
            </div>
          )}
          <div className={styles.routePanel}>
            <div className={styles.routeHeader}>
              <span>路线</span>
              <Button type="text" onClick={() => setRouteSidebarOpen(false)}>
                收起
              </Button>
            </div>
            <div
              ref={routePanelRef}
              className={`${styles.routeContent} ${
                routePanelOpen ? "" : styles.routeContentCollapsed
              }`}
            />
            {!routePanelOpen && (
              <div className={styles.routePlaceholder}>
                点击房源标记里的“导航”，路线会显示在这里。
              </div>
            )}
          </div>
        </aside>

        <Button
          className={styles.sidebarToggle}
          type="primary"
          icon={routeSidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
          onClick={() => setRouteSidebarOpen((open) => !open)}
          aria-label={routeSidebarOpen ? "收起路线" : "展开路线"}
        />

        <main className={styles.mapArea}>
          <div className={styles.mapToolbar}>
            <div className={styles.workInput}>
              <Input
                id="map-work-address"
                value={workAddress}
                prefix={<EnvironmentOutlined />}
                placeholder="上班地点"
                onChange={(event) => {
                  setWorkAddress(event.target.value);
                  setCommutePosition(undefined);
                }}
                onPressEnter={runArrivalRange}
              />
            </div>
            <div className={styles.minutes}>
              <Slider
                min={1}
                max={60}
                value={commuteMinutes}
                onChange={setCommuteMinutes}
              />
              <span>{commuteMinutes} 分钟</span>
            </div>
            <Select
              className={styles.modeSelect}
              value={commuteMode}
              options={[
                { label: "地铁+公交", value: "" },
                { label: "地铁", value: "SUBWAY" },
                { label: "公交", value: "BUS" },
              ]}
              onChange={setCommuteMode}
            />
            <Button type="primary" icon={<AimOutlined />} onClick={runArrivalRange}>
              到达圈
            </Button>
          </div>

          <div ref={mapContainerRef} className={styles.mapCanvas} />

          <Button
            className={styles.locateButton}
            icon={<EnvironmentOutlined />}
            onClick={async () => {
              const position = await ensureCommutePosition();
              if (position) mapRef.current?.setZoomAndCenter(15, position);
            }}
          >
            我在哪
          </Button>
        </main>
      </div>
    </div>
  );
}
