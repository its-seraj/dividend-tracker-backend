const { GoogleGenAI } = require('@google/genai');

const cache = new Map();
const TTL_MS = 60 * 60 * 1000; // 1 hour cache

function cleanSymbol(symbol) {
  if (!symbol) return '';
  return symbol.trim().toUpperCase();
}

function parseJsonFromResponse(text) {
  if (!text) return null;
  const raw = text.trim();
  // Strip code block wrappers if model includes them
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Fallback: match first JSON object pattern in output
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        return null;
      }
    }
    return null;
  }
}

/**
 * Fetch current stock prices in INR for a list of items using Gemini Flash with Google Search Grounding.
 * @param {Array<{symbol: string, companyName?: string}|string>} items List of stock symbols or objects
 * @returns {Promise<Record<string, number|null>>} Map of symbol -> lastPrice (number or null)
 */
async function fetchStockPricesWithGemini(items) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[gemini] GEMINI_API_KEY is not set. Skipping Gemini price lookup.');
    return {};
  }

  if (!Array.isArray(items) || items.length === 0) return {};

  const normalized = items
    .map((item) => {
      if (typeof item === 'string') return { symbol: cleanSymbol(item), companyName: '' };
      return { symbol: cleanSymbol(item?.symbol), companyName: item?.companyName || '' };
    })
    .filter((item) => Boolean(item.symbol));

  if (normalized.length === 0) return {};

  const results = {};
  const toFetch = [];

  // Check cache first
  const now = Date.now();
  for (const item of normalized) {
    const cached = cache.get(item.symbol);
    if (cached && now - cached.at < TTL_MS) {
      results[item.symbol] = cached.price;
    } else {
      toFetch.push(item);
    }
  }

  if (toFetch.length === 0) return results;

  const ai = new GoogleGenAI({ apiKey });
  const BATCH_SIZE = 10;
  const totalBatches = Math.ceil(toFetch.length / BATCH_SIZE);

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`[gemini] Processing batch ${batchNum}/${totalBatches} (${chunk.length} symbols: ${chunk.map((c) => c.symbol).join(', ')})`);

    const stockListText = chunk
      .map((s, idx) => `${idx + 1}. Symbol: ${s.symbol}${s.companyName ? `, Company: ${s.companyName}` : ''}`)
      .join('\n');

    const prompt = `You are a financial data assistant. Search Google to find today's or current stock price in Indian Rupees (INR) for the following Indian stocks (traded on NSE/BSE):

${stockListText}

Instructions:
1. Use Google Search to find the latest stock price (CMP/last price) in INR for each stock symbol.
2. Return ONLY a raw, valid JSON object mapping each Symbol to its numeric price (e.g. {"RELIANCE": 2980.5, "TCS": 3850.00}).
3. Do not include markdown formatting or backticks around the JSON.
4. If a stock price cannot be found, map its symbol to null.`;

    let success = false;
    const MAX_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }],
          },
        });

        const parsed = parseJsonFromResponse(response.text);

        if (parsed && typeof parsed === 'object') {
          for (const item of chunk) {
            const sym = item.symbol;
            const rawVal = parsed[sym] !== undefined ? parsed[sym] : parsed[sym.toLowerCase()];
            const price = typeof rawVal === 'number' && rawVal > 0 ? Number(rawVal.toFixed(2)) : null;
            results[sym] = price;
            cache.set(sym, { at: now, price });
          }
          success = true;
          break;
        } else {
          console.warn(`[gemini] Attempt ${attempt}/${MAX_RETRIES + 1}: Failed to parse JSON response for batch ${batchNum}`);
        }
      } catch (err) {
        console.warn(`[gemini] Attempt ${attempt}/${MAX_RETRIES + 1} error for batch ${batchNum}:`, err.message);
        if (attempt <= MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
    }

    if (!success) {
      console.error(`[gemini] Batch ${batchNum} failed after retries. Setting symbols to null.`);
      for (const item of chunk) {
        results[item.symbol] = null;
      }
    }

    // Delay 1 second between batches to avoid rate limits
    if (i + BATCH_SIZE < toFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}

module.exports = { fetchStockPricesWithGemini };
