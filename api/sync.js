// api/sync.js
// 로그인 없이, 이 앱을 쓰는 사람들끼리 하나의 공유 데이터를 여러 기기에서 동기화하기 위한 저장소.
// Vercel KV(Upstash Redis 호환 REST API)를 그대로 fetch로 호출한다 (별도 npm 패키지 불필요).
//
// 사용 전 준비: Vercel 프로젝트 대시보드 > Storage 탭에서 KV(Redis) 데이터베이스를 하나 만들어
// 이 프로젝트에 연결하면, KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 자동으로 추가된다.
const STATE_KEY = 'campmap:state';

export default async function handler(req, res) {
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (!kvUrl || !kvToken) {
      return res.status(500).json({
        error: 'KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 설정되어 있지 않습니다. Vercel 프로젝트에 KV(Redis) 데이터베이스를 연결해주세요.',
      });
    }

    if (req.method === 'GET') {
      const getRes = await fetch(`${kvUrl}/get/${STATE_KEY}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const getData = await getRes.json();
      if (!getRes.ok) {
        return res.status(502).json({ error: '동기화 데이터를 불러오지 못했습니다.' });
      }
      const state = getData && getData.result ? JSON.parse(getData.result) : null;
      return res.status(200).json({ state });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: '요청 본문이 올바르지 않습니다.' });
      }

      const setRes = await fetch(`${kvUrl}/set/${STATE_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}` },
        body: JSON.stringify(body),
      });
      if (!setRes.ok) {
        return res.status(502).json({ error: '동기화 데이터를 저장하지 못했습니다.' });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: '허용되지 않는 메서드입니다.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
