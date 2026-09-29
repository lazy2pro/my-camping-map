// api/holidays.js
// 프론트엔드 달력의 공휴일 표기를 위해, 공공데이터포털의 "특일 정보"(getRestDeInfo) API를
// 서버에서 호출해 연도별 대한민국 공휴일 목록을 넘겨준다.
// - CORS 회피 및 서비스키 노출 방지 목적 (다른 api/*.js와 동일한 방식)
// - 반환 형식: { holidays: [{ date: 'YYYY-MM-DD', name: '설날' }, ...] }
//
// 서비스키: 공공데이터포털에서 발급한 "디코딩" 키. 특일 정보 전용 키(HOLIDAY_SERVICE_KEY)가
// 있으면 그것을, 없으면 이미 쓰고 있는 GOCAMPING_SERVICE_KEY를 재사용한다.
// (한 계정의 포털 키로 특일 정보 API 활용신청을 해두면 동일 키로 호출 가능)
export default async function handler(req, res) {
  try {
    const year = String(req.query.year || new Date().getFullYear()).slice(0, 4);
    if (!/^\d{4}$/.test(year)) {
      return res.status(400).json({ error: 'year 파라미터는 4자리 연도여야 합니다.' });
    }

    const serviceKey = process.env.HOLIDAY_SERVICE_KEY || process.env.GOCAMPING_SERVICE_KEY;
    if (!serviceKey) {
      return res.status(500).json({
        error: 'HOLIDAY_SERVICE_KEY(또는 GOCAMPING_SERVICE_KEY) 환경변수가 설정되어 있지 않습니다.',
      });
    }

    const baseUrl = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

    // 월별로 요청해야 누락이 없으므로 1~12월을 모두 조회한다.
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
    const holidays = [];
    const seen = new Set();

    const results = await Promise.all(
      months.map(async (mm) => {
        const params = new URLSearchParams({
          serviceKey,
          solYear: year,
          solMonth: mm,
          numOfRows: '50',
          _type: 'json',
        });
        const url = `${baseUrl}?${params.toString()}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        try {
          const apiRes = await fetch(url, { signal: controller.signal });
          const text = await apiRes.text();
          try {
            return JSON.parse(text);
          } catch {
            return null; // 서비스키 오류 등으로 XML 에러가 오면 그 달은 건너뛴다
          }
        } catch {
          return null;
        } finally {
          clearTimeout(timeoutId);
        }
      })
    );

    for (const data of results) {
      const body = data && data.response && data.response.body;
      if (!body) continue;
      let items = (body.items && body.items.item) || [];
      if (!Array.isArray(items)) items = [items];
      for (const it of items) {
        // locdate: 20260101 (숫자/문자). isHoliday === 'Y' 인 것만 공휴일로 취급.
        if (it.isHoliday && String(it.isHoliday).toUpperCase() !== 'Y') continue;
        const loc = String(it.locdate || '');
        if (!/^\d{8}$/.test(loc)) continue;
        const date = `${loc.slice(0, 4)}-${loc.slice(4, 6)}-${loc.slice(6, 8)}`;
        const name = (it.dateName || '공휴일').trim();
        const key = date + name;
        if (seen.has(key)) continue;
        seen.add(key);
        holidays.push({ date, name });
      }
    }

    holidays.sort((a, b) => a.date.localeCompare(b.date));

    // 공휴일은 거의 바뀌지 않으니 하루 캐시로 원본 API 호출을 크게 아낀다.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ year, count: holidays.length, holidays });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
