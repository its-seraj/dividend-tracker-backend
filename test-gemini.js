require('dotenv').config();
const { fetchStockPricesWithGemini } = require('./src/services/geminiPrice');

async function runTest() {
  console.log('--- Gemini Flash Stock Price Lookup Test ---');
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY is not set in your .env file!');
    console.error('Please add GEMINI_API_KEY=your_key_here to .env and try again.\n');
    process.exit(1);
  }

  const testSymbols = [
    { symbol: 'RELIANCE', companyName: 'Reliance Industries Ltd' },
    { symbol: 'TCS', companyName: 'Tata Consultancy Services' },
    { symbol: 'INFY', companyName: 'Infosys Ltd' },
  ];

  console.log('Sending symbols to Gemini 2.5 Flash with Google Search Grounding...');
  console.time('Gemini Lookup Time');
  
  try {
    const prices = await fetchStockPricesWithGemini(testSymbols);
    console.timeEnd('Gemini Lookup Time');

    console.log('\nResults Received from Gemini:');
    console.table(
      Object.entries(prices).map(([symbol, price]) => ({
        Symbol: symbol,
        'Stock Price (INR)': price !== null ? `₹${price}` : 'Not Found',
        Status: price !== null ? 'SUCCESS' : 'FAILED',
      }))
    );
  } catch (err) {
    console.error('Error executing Gemini LLM call:', err.message);
  }
}

runTest();
