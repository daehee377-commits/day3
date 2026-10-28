const { toolDefinitions, toolHandlers } = require("./tools");

const MODEL = "claude-sonnet-5-5";
const MAX_STEPS = 6;
const MAX_MESSAGES = 10;
const MAX_CHARS = 1000;

const SYSTEM = `너는 제주도 여행 추천 도우미다. 오늘 날짜는 ${"{TODAY}"} 이다.
- 사용자의 요청에서 지역(동쪽 · 서쪽 · 서귀포 · 제주시)을 파악해 get_weather 로 날씨를 확인하고, find_spots 로 후보 장소를 찾는다. 두 도구는 서로 독립이므로 한 번에 같이 호출해도 된다.
- 비 · 강풍 · 낮은 기온이면 실내를, 맑으면 야외를 우선 추천한다. 사용자가 실내/야외를 직접 정하면 그 뜻을 따르고, 날씨가 나쁜 점은 짧게 알린다.
- 추천은 find_spots 결과에 있는 장소만 한다. 목록 밖의 장소는 없는 것으로 취급하고, 지어내지 않는다. 지역이 불분명하면 제주시 · 서귀포 · 동쪽 · 서쪽 중 어디가 좋을지 되묻는다.
- 운영시간 · 요금은 모른다고 하고 방문 전 공식 안내 확인을 권한다.
- 답은 한국어로, 날씨 한 줄 요약 + 추천 장소 3~5곳(이름과 이유 한 줄씩) 형식으로 간결하게 쓴다.`;

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM.replace("{TODAY}", new Date().toISOString().slice(0, 10)),
      tools: toolDefinitions,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API ${res.status}`);
  return data;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다." });
  }

  const input = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = input
    .slice(-MAX_MESSAGES)
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "마지막 메시지는 사용자 입력이어야 합니다." });
  }

  const toolCalls = [];
  const spots = new Map();

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await callClaude(messages);
      messages.push({ role: "assistant", content: reply.content });

      if (reply.stop_reason !== "tool_use") {
        const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        return res.status(200).json({ reply: text, toolCalls, spots: [...spots.values()] });
      }

      const results = await Promise.all(
        reply.content
          .filter((b) => b.type === "tool_use")
          .map(async (b) => {
            toolCalls.push({ name: b.name, input: b.input });
            const handler = toolHandlers[b.name];
            const output = handler ? await handler(b.input) : { error: `알 수 없는 도구: ${b.name}` };
            if (b.name === "find_spots" && output.spots) output.spots.forEach((s) => spots.set(s.name, s));
            return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(output) };
          })
      );
      messages.push({ role: "user", content: results });
    }
    res.status(200).json({ reply: "도구 호출이 너무 길어져 중단했습니다. 질문을 조금 더 구체적으로 해주세요.", toolCalls, spots: [...spots.values()] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
