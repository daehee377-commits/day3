const { toolDefinitions, toolHandlers } = require("./tools");

const MAX_STEPS = 6;
const MAX_MESSAGES = 10;
const MAX_CHARS = 1000;

const SYSTEM = `너는 제주도 여행 추천 도우미다. 오늘 날짜는 {TODAY} 이다.
- 사용자의 요청에서 지역(동쪽 · 서쪽 · 서귀포 · 제주시)을 파악해 get_weather 로 날씨를 확인하고, find_spots 로 후보 장소를 찾는다. 두 도구는 서로 독립이므로 한 번에 같이 호출해도 된다.
- 비 · 강풍 · 낮은 기온이면 실내를, 맑으면 야외를 우선 추천한다. 사용자가 실내/야외를 직접 정하면 그 뜻을 따르고, 날씨가 나쁜 점은 짧게 알린다.
- 추천은 find_spots 결과에 있는 장소만 한다. 목록 밖의 장소는 없는 것으로 취급하고, 지어내지 않는다. 지역이 불분명하면 제주시 · 서귀포 · 동쪽 · 서쪽 중 어디가 좋을지 되묻는다.
- 운영시간 · 요금은 모른다고 하고 방문 전 공식 안내 확인을 권한다.
- 답은 한국어로, 날씨 한 줄 요약 + 추천 장소 3~5곳(이름과 이유 한 줄씩) 형식으로 간결하게 쓴다.`;

// Claude 형식(input_schema)으로 만든 도구 정의를 Gemini functionDeclarations 로 변환
const functionDeclarations = toolDefinitions.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
}));

// 앞 모델이 막혀 있으면(더 이상 제공되지 않음 · 없음) 다음 모델로 넘어간다.
const MODELS = [...new Set([process.env.GEMINI_MODEL, "gemini-3.8-flash", "gemini-flash-latest"].filter(Boolean))];
let workingModel = null;

const RETRY_WAITS_MS = [2000, 4000]; // 429/503 이면 2초, 4초 뒤에 다시 시도 (최대 2번)
const MAX_HINTED_WAIT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini 오류 응답의 RetryInfo("retryDelay": "12s")가 있으면 초 단위로 꺼낸다.
function serverRetryDelaySec(data) {
  const info = data?.error?.details?.find((d) => typeof d?.retryDelay === "string");
  const n = info ? parseFloat(info.retryDelay) : NaN;
  return Number.isFinite(n) ? Math.ceil(n) : null;
}

async function callGemini(contents, debug) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM.replace("{TODAY}", new Date().toISOString().slice(0, 10)) }] },
    contents,
    tools: [{ functionDeclarations }],
    generationConfig: { maxOutputTokens: 2048 },
  });

  const order = workingModel ? [workingModel] : MODELS;
  let lastError;
  for (const model of order) {
    let data;
    // 한도 초과(429)나 서버 혼잡(503)이면 잠깐 기다렸다가 다시 시도한다.
    for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body,
      });
      const rawText = await res.text();
      let raw = rawText; // JSON 이 아니면 원문 문자열 그대로
      try { data = JSON.parse(rawText); raw = data; } catch { data = { error: { message: rawText.slice(0, 500) } }; }
      // 제미나이가 보낸 응답을 가공하지 않고 그대로 담는다.
      debug.push({ model, status: res.status, raw });
      if (res.ok) {
        workingModel = model;
        return data;
      }

      lastError = new Error(`[${model}] ${data?.error?.message || res.status}`);
      if (res.status !== 429 && res.status !== 503) break;

      lastError.rateLimited = true;
      lastError.retryAfter = serverRetryDelaySec(data) ?? 15;
      if (attempt === RETRY_WAITS_MS.length) break;
      const hinted = serverRetryDelaySec(data);
      const wait = hinted && hinted * 1000 <= MAX_HINTED_WAIT_MS ? hinted * 1000 : RETRY_WAITS_MS[attempt];
      await sleep(wait + Math.random() * 500);
    }

    if (lastError.rateLimited) break; // 한도 문제는 다른 모델로 바꿔도 같으니 멈춘다.
    const msg = data?.error?.message || "";
    const modelProblem = /no longer available|not found|not supported/i.test(msg) || data?.error?.code === 404;
    if (!modelProblem) break;
  }
  workingModel = null;
  throw lastError;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다." });
  }

  const input = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const contents = input
    .slice(-MAX_MESSAGES)
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content.slice(0, MAX_CHARS) }] }));
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "마지막 메시지는 사용자 입력이어야 합니다." });
  }

  const toolCalls = [];
  const debug = [];
  const toolResults = [];
  const spots = new Map();

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callGemini(contents, debug);
      const content = data.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        const why = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "빈 응답";
        throw new Error(`Gemini 가 답을 만들지 못했습니다(${why}).`);
      }
      contents.push(content);

      const calls = content.parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
        return res.status(200).json({ reply: text, toolCalls, spots: [...spots.values()], debug, toolResults });
      }

      const responses = await Promise.all(
        calls.map(async ({ functionCall: fc }) => {
          const args = fc.args || {};
          toolCalls.push({ name: fc.name, input: args });
          const handler = toolHandlers[fc.name];
          const output = handler ? await handler(args) : { error: `알 수 없는 도구: ${fc.name}` };
          toolResults.push({ name: fc.name, input: args, output });
          if (fc.name === "find_spots" && output.spots) output.spots.forEach((s) => spots.set(s.name, s));
          return { functionResponse: { name: fc.name, response: output } };
        })
      );
      contents.push({ role: "user", parts: responses });
    }
    res.status(200).json({ reply: "도구 호출이 너무 길어져 중단했습니다. 질문을 조금 더 구체적으로 해주세요.", toolCalls, spots: [...spots.values()], debug, toolResults });
  } catch (e) {
    if (e.rateLimited) {
      return res.status(429).json({
        error: "사용자가 많아 잠시 기다리는 중입니다. 곧 다시 시도합니다.",
        rateLimited: true,
        retryAfter: e.retryAfter,
        debug,
        toolResults,
      });
    }
    res.status(502).json({ error: e.message, debug, toolResults });
  }
};
