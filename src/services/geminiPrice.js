const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');

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
 * Fallback service using Groq API with llama-3.3-70b-versatile model.
 */
async function fetchStockPricesWithGroq(chunk) {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) {
    console.warn('[groq] GROQ_API_KEY is not set in environment. Cannot perform Groq fallback.');
    return null;
  }

  const stockListText = chunk
    .map((s, idx) => `${idx + 1}. Symbol: ${s.symbol}${s.companyName ? `, Company: ${s.companyName}` : ''}`)
    .join('\n');

  console.log(`[groq] Calling Groq model (llama-3.3-70b-versatile) for ${chunk.length} symbols...`);

  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content:
              'You are a financial data assistant. Return ONLY a raw, valid JSON object mapping each Indian stock Symbol (traded on NSE/BSE) to its current or estimated stock price in INR (e.g. {"RELIANCE": 2980.5, "TCS": 3850.0}). If unknown, map to null.',
          },
          {
            role: 'user',
            content: `Find the stock price in INR for these stocks:\n${stockListText}`,
          },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const content = res.data?.choices?.[0]?.message?.content;
    const parsed = parseJsonFromResponse(content);
    if (parsed && typeof parsed === 'object') {
      console.log(`[groq] Groq model (llama-3.3-70b-versatile) response successful!`);
      return parsed;
    }
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error(`[groq] Groq API error (${err.response?.status || 'network'}):`, errMsg);
  }
  return null;
}

/**
 * Fetch current stock prices in INR for a list of items using Gemini Flash with Google Search Grounding.
 * Falls back to Groq (llama-3.3-70b-versatile) on Gemini failure.
 * @param {Array<{symbol: string, companyName?: string}|string>} items List of stock symbols or objects
 * @returns {Promise<Record<string, number|null>>} Map of symbol -> lastPrice (number or null)
 */
async function fetchStockPricesWithGemini(items) {
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

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const primaryModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const BATCH_SIZE = Number(process.env.GEMINI_BATCH_SIZE) || 25;
  const totalBatches = Math.ceil(toFetch.length / BATCH_SIZE);

  const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`[price-service] Processing batch ${batchNum}/${totalBatches} (${chunk.length} symbols)...`);

    let parsed = null;

    // 1. Try Gemini primary call if GEMINI_API_KEY is available
    if (ai) {
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

      try {
        const response = await ai.models.generateContent({
          model: primaryModel,
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }],
          },
        });

        parsed = parseJsonFromResponse(response.text);
      } catch (err) {
        console.warn(`[gemini] Gemini call failed for batch ${batchNum}:`, err.message);
      }
    } else {
      console.warn(`[gemini] GEMINI_API_KEY not provided. Skipping Gemini.`);
    }

    // 2. If Gemini failed or didn't return valid data, fallback to Groq (llama-3.3-70b-versatile)
    if (!parsed || typeof parsed !== 'object') {
      console.log(`[fallback] Gemini failed for batch ${batchNum}. Triggering Groq (llama-3.3-70b-versatile) fallback...`);
      parsed = await fetchStockPricesWithGroq(chunk);
    }

    if (parsed && typeof parsed === 'object') {
      for (const item of chunk) {
        const sym = item.symbol;
        const rawVal = parsed[sym] !== undefined ? parsed[sym] : parsed[sym.toLowerCase()];
        const price = typeof rawVal === 'number' && rawVal > 0 ? Number(rawVal.toFixed(2)) : null;
        results[sym] = price;
        cache.set(sym, { at: now, price });
      }
    } else {
      console.error(`[price-service] Batch ${batchNum} failed for both Gemini and Groq. Setting prices to null.`);
      for (const item of chunk) {
        results[item.symbol] = null;
      }
    }

    // Brief 500ms delay between batches
    if (i + BATCH_SIZE < toFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}

module.exports = { fetchStockPricesWithGemini, fetchStockPricesWithGroq };

