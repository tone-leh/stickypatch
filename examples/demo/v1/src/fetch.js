// weather-cli 1.0.0 — pretend this lives in /usr/local/lib/node_modules/weather-cli
export async function fetchForecast(city) {
  const timeoutMs = 5000;
  const retries = 1;
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
