// Lightweight client for Levin LLM API (prepared, not used yet)
// Exposes levinChat which returns the assistant content string.

// Use Vite dev proxy to avoid CORS in development
const API_URL = "https://cors-anywhere.com/https://api.levi9.com/levin/v1/chat/completions";
const MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8";

/**
 * Call Levin LLM with a single string or a prebuilt messages array.
 * @param {string | Array<{role: 'user'|'assistant'|'system', content: string}>} input
 * @param {object} opts
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.top_p=0.8]
 * @param {number} [opts.top_k=20]
 * @param {number} [opts.repetition_penalty=1.05]
 * @param {number} [opts.max_tokens=1024]
 * @returns {Promise<string>} assistant content
 */
export async function levinChat(input, opts = {}) {
  const key = import.meta.env.VITE_LEVIN_API_KEY;
  if (!key) {
    throw new Error("Missing VITE_LEVIN_API_KEY in environment. Create .env with VITE_LEVIN_API_KEY=... and restart dev server.");
  }

  const messages = Array.isArray(input)
    ? input
    : [{ role: "user", content: String(input ?? "") }];

  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.top_p ?? 0.8,
    top_k: opts.top_k ?? 20,
    repetition_penalty: opts.repetition_penalty ?? 1.05,
    max_tokens: opts.max_tokens ?? 1024,
    stream: false,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": key,
    },
    body: `
    {
    "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
    "messages": [
      {
        "role": "user",
        "content": "Hello, how are you?"
      }
    ],
    "temperature": 0.7,
    "top_p": 0.8,
    "top_k": 20,
    "repetition_penalty": 1.05,
    "max_tokens": 1024,
    "stream": false
  }
    `
    //JSON.stringify(body),
  });
  console.log(res);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    
    throw new Error(`Levin LLM request failed: ${res.status} ${res.statusText} ${text}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Levin LLM response missing choices[0].message.content");
  }
  return content;
}
