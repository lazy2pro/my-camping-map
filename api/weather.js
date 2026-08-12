// api/weather.js
// Open-Meteo(https://open-meteo.com)는 별도 인증키 없이 쓸 수 있는 무료 공개 날씨 API라서,
// 지도 위 작은 날씨 배지에 필요한 값만 추려서 그대로 프록시한다.
export default async function handler(req, res) {
  try {
    const { lat, lng } = req.query;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
    }

    const params = new URLSearchParams({
      latitude: latNum.toFixed(4),
      longitude: lngNum.toFixed(4),
      current: 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,precipitation',
      timezone: 'Asia/Seoul',
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    let apiRes;
    let data;
    try {
      apiRes = await fetch(url, { signal: controller.signal });
      data = await apiRes.json();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!apiRes.ok || !data.current) {
      return res.status(502).json({ error: '날씨 정보를 불러오지 못했습니다.' });
    }

    const c = data.current;
    const payload = {
      temperature: c.temperature_2m,
      apparentTemperature: c.apparent_temperature,
      weatherCode: c.weather_code,
      humidity: c.relative_humidity_2m,
      windSpeed: c.wind_speed_10m,
      precipitation: c.precipitation,
    };

    // 날씨는 자주 바뀌지 않으니 20분 캐시로 원본 API 호출을 아낀다.
    res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=3600');
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
