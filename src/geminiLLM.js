// Minimal Gemini client via fetch. Returns plain text from candidates[0].content.parts[0].text

const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/**
 * Call Gemini with a single prompt string or a prebuilt contents array.
 * @param {string | Array<{role: string, parts: Array<{text: string}>}>} input
 * @returns {Promise<string>} model text
 */
export async function geminiChat(input) {
  const key = import.meta.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error("Missing VITE_GEMINI_API_KEY in environment. Create .env with VITE_GEMINI_API_KEY=... and restart.");

  const contents = Array.isArray(input)
    ? input
    : [ { role: "user", parts: [ { text: String(input ?? "") } ] } ];

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({ contents }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini request failed: ${res.status} ${res.statusText} ${text}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("Gemini response missing candidates[0].content.parts[0].text");
  return text;
}
