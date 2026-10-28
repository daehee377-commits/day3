const fs = require("fs");
const path = require("path");

const SPOTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "jeju_spots.json"), "utf8")
).spots;

const AREAS = ["동쪽", "서쪽", "서귀포", "제주시"];
const MAX_RESULTS = 8;

// 날씨 조회에 쓰는 지역별 대표 좌표
const AREA_COORDS = {
  동쪽: { latitude: 33.46, longitude: 126.93 },
  서쪽: { latitude: 33.41, longitude: 126.27 },
  서귀포: { latitude: 33.25, longitude: 126.56 },
  제주시: { latitude: 33.51, longitude: 126.53 },
};

// WMO 날씨 코드 -> 한글 설명 (Open-Meteo 문서 기준)
const WEATHER_TEXT = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림",
  45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비",
  56: "약한 어는 이슬비", 57: "강한 어는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비",
  66: "약한 어는 비", 67: "강한 어는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기",
  85: "약한 눈 소나기", 86: "강한 눈 소나기",
  95: "뇌우", 96: "우박을 동반한 뇌우", 99: "강한 우박을 동반한 뇌우",
};
const weatherText = (code) => WEATHER_TEXT[code] ?? `알 수 없음(${code})`;

// 데이터의 area 는 "동쪽(성산)" 처럼 괄호가 붙을 수 있어 앞부분으로 맞춘다.
const inArea = (spot, area) => spot.area === area || spot.area.startsWith(area + "(");

function find_spots({ area, indoor } = {}) {
  if (!AREAS.includes(area)) {
    return { error: `area 는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }

  const matched = SPOTS.filter(
    (s) => inArea(s, area) && (indoor === undefined || indoor === null || s.indoor === indoor)
  );

  return {
    total: matched.length,
    spots: matched.slice(0, MAX_RESULTS).map((s) => ({
      name: s.name,
      areas: s.area,
      indoor: s.indoor,
      description: s.type,
      lat: s.lat,
      lng: s.lng,
    })),
  };
}

async function get_weather({ area, days } = {}) {
  const coords = AREA_COORDS[area];
  if (!coords) {
    return { error: `area 는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }
  const forecastDays = Math.min(Math.max(Number.isInteger(days) ? days : 3, 1), 7);

  const params = new URLSearchParams({
    latitude: coords.latitude,
    longitude: coords.longitude,
    current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
    timezone: "Asia/Seoul",
    forecast_days: String(forecastDays),
  });

  let data;
  try {
    const res = await fetch("https://api.open-meteo.com/v1/forecast?" + params);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    return { error: `날씨 정보를 가져오지 못했습니다: ${e.message}` };
  }

  const c = data.current;
  const d = data.daily;
  return {
    area,
    current: {
      time: c.time,
      weather: weatherText(c.weather_code),
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      precipitation_mm: c.precipitation,
      wind_kmh: c.wind_speed_10m,
    },
    daily: d.time.map((date, i) => ({
      date,
      weather: weatherText(d.weather_code[i]),
      temp_min_c: d.temperature_2m_min[i],
      temp_max_c: d.temperature_2m_max[i],
      rain_probability_pct: d.precipitation_probability_max[i],
      rain_mm: d.precipitation_sum[i],
      wind_max_kmh: d.wind_speed_10m_max[i],
    })),
  };
}

const areaSchema = {
  type: "string",
  enum: AREAS,
  description: "지역: 동쪽, 서쪽, 서귀포, 제주시 중 하나",
};

const toolDefinitions = [
  {
    name: "find_spots",
    description:
      "제주 관광지 목록(jeju_spots.json)에서 지역과 실내/야외 조건에 맞는 장소를 최대 8곳 찾아 이름 · 지역 · 실내 여부 · 설명(유형)을 돌려준다. " +
      "이 목록 밖의 장소는 없다: 결과에 없는 장소를 지어내거나 추천하지 말고, 제주 밖 장소나 목록에 없는 곳은 '목록에 없다'고 답한다. " +
      "운영시간 · 요금 · 휴무 정보는 담겨 있지 않다.",
    input_schema: {
      type: "object",
      properties: {
        area: areaSchema,
        indoor: {
          type: "boolean",
          description: "true 면 실내만, false 면 야외만. 생략하면 둘 다.",
        },
      },
      required: ["area"],
    },
  },
  {
    name: "get_weather",
    description:
      "Open-Meteo 로 제주 지역(동쪽 · 서쪽 · 서귀포 · 제주시)의 현재 날씨와 일별 예보(날씨 · 기온 · 강수확률 · 강수량 · 최대 풍속)를 조회한다. " +
      "야외/실내 추천을 정하기 전에 호출한다. 풍속 단위는 km/h 이다. 오늘부터 최대 7일까지만 조회된다.",
    input_schema: {
      type: "object",
      properties: {
        area: areaSchema,
        days: {
          type: "integer",
          minimum: 1,
          maximum: 7,
          description: "예보 일수(오늘 포함). 생략하면 3.",
        },
      },
      required: ["area"],
    },
  },
];

const toolHandlers = { find_spots, get_weather };

module.exports = { toolDefinitions, toolHandlers, find_spots, get_weather };
