// api/weather-forecast.js
// 예정 캠핑 일정(입실~퇴실) 기간 동안의 날짜별 날씨 예보를 Open-Meteo에서 가져온다.
// Open-Meteo 예보는 대략 16일 앞까지만 제공되므로, 그보다 먼 미래 날짜는
// daily 배열이 비어있거나 일부만 채워져 올 수 있다 (에러로 취급하지 않는다).
export default async function handler(req, res) {
  try {
    const { lat, lng, start, end } = req.query;
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
    }
    if (!start) {
      return res.status(400).json({ error: 'start 파라미터가 필요합니다.' });
    }
    const endDate = end || start;

    const params = new URLSearchParams({
      latitude: latNum.toFixed(4),
      longitude: lngNum.toFixed(4),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'Asia/Seoul',
      start_date: start,
      end_date: endDate,
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

    if (!apiRes.ok) {
      return res.status(502).json({ error: '날씨 예보를 불러오지 못했습니다.' });
    }

    const daily = data.daily;
    const days = (daily && Array.isArray(daily.time))
      ? daily.time.map((date, i) => ({
          date,
          weatherCode: daily.weather_code ? daily.weather_code[i] : null,
          tempMax: daily.temperature_2m_max ? daily.temperature_2m_max[i] : null,
          tempMin: daily.temperature_2m_min ? daily.temperature_2m_min[i] : null,
          precipitationProbability: daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null,
        })).filter((d) => d.tempMax !== null && d.tempMin !== null)
      : [];

    // 예보는 자주 바뀌지 않으니 30분 캐시로 원본 API 호출을 아낀다.
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ days });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
