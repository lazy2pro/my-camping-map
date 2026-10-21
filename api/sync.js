import { applyChanges, validChanges, normalizeState } from '../lib/state-core.mjs';
const STATE_KEY = 'campmap:state', BACKUP_KEY = 'campmap:backups:v2';
const CAS = "local current = redis.call('GET', KEYS[1]) or ''\nif current ~= ARGV[1] then return 0 end\nif current ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[3] then\nredis.call('LPUSH', KEYS[2], ARGV[4])\nredis.call('LTRIM', KEYS[2], 0, 19)\nredis.call('SET', KEYS[3], ARGV[3])\nend\nredis.call('SET', KEYS[1], ARGV[2])\nreturn 1";
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: '서버 저장소 연결을 확인해 주세요.' });
  async function redis(command) {
    const response = await fetch(kvUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + kvToken, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(6500) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error('저장소 요청에 실패했습니다.');
    return data.result;
  }
  try {
    if (req.method === 'GET') {
      if (req.query?.action === 'backups') {
        const snapshots = await redis(['LRANGE', BACKUP_KEY, 0, 19]);
        return res.status(200).json({ backups: (snapshots || []).map(x => JSON.parse(x)) });
      }
      const raw = await redis(['GET', STATE_KEY]);
      return res.status(200).json({ state: raw ? normalizeState(JSON.parse(raw)) : null, protocol: 2 });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: '허용되지 않는 요청입니다.' }); }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (body?.protocol !== 2) return res.status(409).json({ error: '앱이 업데이트되었습니다. 새로고침 후 다시 저장해 주세요.', upgradeRequired: true });
    if (!validChanges(body.changes) || JSON.stringify(body).length > 1500000) return res.status(400).json({ error: '저장할 변경사항이 올바르지 않습니다.' });
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await redis(['GET', STATE_KEY]);
      const state = normalizeState(raw ? JSON.parse(raw) : {});
      const merged = applyChanges(state, body.changes);
      if (merged.conflicts.length) return res.status(409).json({ error: '같은 항목이 다른 기기에서 변경되었습니다.', state, conflicts: merged.conflicts });
      const nextRaw = JSON.stringify(merged.state);
      if (nextRaw.length > 1500000) return res.status(413).json({ error: '저장 데이터가 너무 큽니다.' });
      const day = new Date().toISOString().slice(0, 10);
      const backup = JSON.stringify({ at: new Date().toISOString(), label: body.backupLabel ? String(body.backupLabel).slice(0, 100) : '자동 복원본', state });
      const group = body.backupLabel ? day + ':' + Date.now() + ':' + Math.random() : day;
      const saved = await redis(['EVAL', CAS, 3, STATE_KEY, BACKUP_KEY, 'campmap:backup-day:v2', raw || '', nextRaw, group, backup]);
      if (Number(saved) === 1) return res.status(200).json({ ok: true, state: merged.state, protocol: 2 });
    }
    return res.status(409).json({ error: '다른 기기에서 저장 중입니다. 잠시 후 다시 시도해 주세요.', retryable: true });
  } catch (err) {
    console.error('campmap sync:', err.message);
    return res.status(503).json({ error: '서버 저장에 실패했습니다. 이 기기의 변경사항은 유지됩니다.' });
  }
}
