const STORAGE_KEY = "house-map-manual-houses-v1";
export const MANUAL_SOURCE = "manual";

function loadAll(): HouseListItem[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveAll(list: HouseListItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function loadManualHouses(city: string) {
  return loadAll().filter((house) => house.city === city);
}

export function addManualHouses(houses: HouseListItem[]) {
  saveAll([...loadAll(), ...houses]);
}

export function removeManualHouse(id: string) {
  saveAll(loadAll().filter((house) => house.id !== id));
}

const PRICE_TOKEN = /^[¥￥]?(\d{3,5})(元|块|\/月|每月)?$/;

// One listing per line: "<community or address> [price] [link]", in any order.
export function parseManualInput(text: string, city: string): HouseListItem[] {
  const now = new Date();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const url = line.match(/https?:\/\/[^\s，,]+/)?.[0] || "";
      let price = 0;
      const nameTokens: string[] = [];
      for (const token of line.replace(url, " ").split(/[\s,，|、]+/).filter(Boolean)) {
        const match = token.match(PRICE_TOKEN);
        if (!price && match) price = Number(match[1]);
        else nameTokens.push(token);
      }
      const name = nameTokens.join(" ");
      return {
        id: `manual-${now.getTime()}-${index}`,
        city,
        district: "",
        location: name,
        title: name,
        price,
        onlineURL: url,
        source: MANUAL_SOURCE,
        displaySource: "手动添加",
        pictures: [""],
        rentType: 0,
        status: 1,
        createTime: now.toISOString(),
        updateTime: now.toISOString(),
        publishDate: now.toISOString().slice(0, 10),
        pubTime: now.toISOString(),
        timestamp: now.getTime(),
      } as HouseListItem;
    })
    .filter((house) => house.title);
}
