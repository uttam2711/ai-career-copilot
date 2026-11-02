import assert from "node:assert/strict";
import { randomInt } from "node:crypto";

for (const key of [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN"
]) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}. Run with --env-file=.env.local`);
  }
}

// Intercept Gemini only. All Upstash requests use the real fetch.
const realFetch = globalThis.fetch;
let geminiResponses = [];
const geminiRequests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string"
    ? input
    : input?.url || String(input);

  if (url.includes("generativelanguage.googleapis.com")) {
    geminiRequests.push({ url, init });

    const next = geminiResponses.shift();

    if (!next) {
      throw new Error("Unexpected Gemini request: no mock response configured.");
    }

    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" }
    });
  }

  return realFetch(input, init);
};

const { default: handler } = await import("../api/analyze.js");

let passed = 0;

async function test(name, callback) {
  try {
    await callback();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

const testIp = `198.51.100.${randomInt(1, 255)}`;

function invoke({
  method = "POST",
  body = {},
  headers = {}
} = {}) {
  const req = {
    method,
    body,
    headers: {
      host: "localhost",
      "x-forwarded-for": testIp,
      ...headers
    },
    socket: { remoteAddress: "203.0.113.10" }
  };

  const res = {
    statusCode: 200,
    headers: {},
    payload: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },

    json(payload) {
      this.payload = payload;
      return this;
    }
  };

  return handler(req, res).then(() => res);
}

const validInputs = {
  resume: "Built a Python data analysis project using pandas and scikit-learn. Implemented model evaluation and documented project results.",
  jobDescription: "Junior Python Developer. Required: Python programming, data processing, problem solving, and practical project experience."
};

const validAnalysis = {
  requirement_evidence: [
    {
      requirement: "Python programming",
      importance: "Required",
      category: "skills",
      status: "demonstrated",
      resume_evidence: "Built a Python data analysis project.",
      reasoning: "The project demonstrates practical Python usage."
    }
  ],
  summary: "The candidate demonstrates relevant Python project experience.",
  strengths: ["Practical Python project experience"],
  matching_skills: ["Python"],
  missing_skills: [],
  missing_keywords: [],
  improvements: ["Add measurable project outcomes where supported."],
  learning_roadmap: [],
  caveats: ["This is a simulated test response."]
};

function geminiSuccess(text) {
  return {
    status: 200,
    body: {
      candidates: [{
        content: {
          parts: [{ text }]
        }
      }]
    }
  };
}

// 1. HTTP method protection
await test("GET requests are rejected", async () => {
  const res = await invoke({ method: "GET" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST");
});

// 2. Same-origin protection
await test("Cross-origin requests are rejected", async () => {
  const res = await invoke({
    headers: { origin: "https://untrusted.example" }
  });
  assert.equal(res.statusCode, 403);
});

// 3. Required fields
await test("Missing input fields are rejected", async () => {
  const res = await invoke();
  assert.equal(res.statusCode, 400);
});

// 4. Minimum input length
await test("Inputs below 50 characters are rejected", async () => {
  const res = await invoke({
    body: {
      resume: "R".repeat(49),
      jobDescription: "J".repeat(50)
    }
  });
  assert.equal(res.statusCode, 400);
});

// 5. Resume character limit
await test("Oversized resume is rejected", async () => {
  const res = await invoke({
    body: {
      resume: "R".repeat(18001),
      jobDescription: "J".repeat(50)
    }
  });
  assert.equal(res.statusCode, 413);
});

// 6. HTTP body size limit
await test("Oversized declared HTTP body is rejected", async () => {
  const res = await invoke({
    body: validInputs,
    headers: { "content-length": String(128 * 1024 + 1) }
  });
  assert.equal(res.statusCode, 413);
});

// 7. Invalid Gemini JSON
await test("Malformed Gemini JSON is rejected", async () => {
  geminiResponses = [geminiSuccess("not-valid-json")];

  const res = await invoke({ body: validInputs });

  assert.equal(res.statusCode, 502);
  assert.match(res.payload.error, /valid JSON/i);
});

// 8. Invalid Gemini response structure
await test("Incomplete Gemini response is rejected", async () => {
  geminiResponses = [geminiSuccess(JSON.stringify({ summary: "Incomplete" }))];

  const res = await invoke({ body: validInputs });

  assert.equal(res.statusCode, 502);
  assert.match(res.payload.error, /invalid analysis/i);
});

// 9. Retry and fallback behaviour
await test("503 retries and fallback model produce valid analysis", async () => {
  const primary = process.env.GEMINI_MODEL;
  const fallback = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash";

  const before = geminiRequests.length;

  const unavailable = {
    status: 503,
    body: {
      error: {
        code: 503,
        status: "UNAVAILABLE",
        message: "Simulated Gemini overload."
      }
    }
  };

  geminiResponses = [
    unavailable,
    unavailable,
    unavailable,
    geminiSuccess(JSON.stringify(validAnalysis))
  ];

  const res = await invoke({ body: validInputs });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.model, fallback);
  assert.equal(res.payload.analysis.ats_score, 100);
  assert.ok(res.payload.scoring_method);

  const modelsUsed = geminiRequests.slice(before).map(({ url }) => {
    const match = url.match(/\/models\/([^:]+):generateContent/);
    return match ? decodeURIComponent(match[1]) : "unknown";
  });

  assert.equal(modelsUsed.length, 4);
  assert.deepEqual(modelsUsed, [
    primary,
    primary,
    primary,
    fallback
  ]);
});

console.log(`\n${passed}/9 regression tests passed.`);
console.log(`Mock Gemini calls: ${geminiRequests.length}`);
console.log("No real Gemini API calls were made.");
console.log("Upstash was contacted for three valid-input test requests.");
