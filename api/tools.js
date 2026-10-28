const fs = require("fs");
const path = require("path");

const SPOTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "jeju_spots.json"), "utf8")
).spots;

const AREAS = ["동쪽", "서쪽", "서귀포", "제주시"];
const MAX_RESULTS = 8;

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
        area: {
          type: "string",
          enum: AREAS,
          description: "찾을 지역: 동쪽, 서쪽, 서귀포, 제주시 중 하나",
        },
        indoor: {
          type: "boolean",
          description: "true 면 실내만, false 면 야외만. 생략하면 둘 다.",
        },
      },
      required: ["area"],
    },
  },
];

const toolHandlers = { find_spots };

module.exports = { toolDefinitions, toolHandlers, find_spots };
