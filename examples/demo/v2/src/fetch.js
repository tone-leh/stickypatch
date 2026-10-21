// weather-cli 1.1.0 — pretend this lives in /usr/local/lib/node_modules/weather-cli
const DEFAULTS = { timeoutMs: 5000, retries: Number(process.env.WEATHER_RETRIES ?? 3) };

export async function fetchForecast(city, options = {}) {
  const { timeoutMs, retries } = { ...DEFAULTS, ...options };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await get(`https://api.example.com/forecast/${city}`, { timeoutMs });
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

export function sendTelemetry(event) {
  return get('https://telemetry.example.com/collect', { body: event });
}

async function get(url, options) {
  return { url, options };
}
