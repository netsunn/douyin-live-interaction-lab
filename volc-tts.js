const WebSocket = require('ws');
const crypto = require('crypto');

const URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const MSG_FULL_CLIENT = 0x1;
const MSG_FULL_SERVER = 0x9;
const MSG_AUDIO_SERVER = 0xb;
const MSG_ERROR = 0xf;
const FLAG_WITH_EVENT = 0x4;

const EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSResponse: 352,
  TTSSubtitle: 353,
};

function subtitleUnits(payloads) {
  const units = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const text = value.text ?? value.content ?? value.word;
    const millisecondTime = value.end_time != null || value.end_time_ms != null;
    const end = value.end_time ?? value.end_time_ms ?? value.endTime ?? value.end;
    const start = value.start_time ?? value.start_time_ms ?? value.startTime ?? value.start;
    if (typeof text === 'string' && Number.isFinite(Number(end))) {
      const scale=millisecondTime?1000:1;
      units.push({ text, startTime: Math.max(0, Number(start) || 0) / scale, endTime: Math.max(0, Number(end)) / scale });
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  payloads.forEach(visit);
  return units.filter(x => x.text.trim() && x.endTime > 0).sort((a,b) => a.endTime-b.endTime);
}

function sentenceMarks(payloads) {
  const units = subtitleUnits(payloads), marks = [];
  let text = '';
  for (const unit of units) {
    if (marks.length && unit.endTime <= marks[marks.length - 1].endTime + .005) continue;
    text += unit.text;
    if (/[。！？!?；;]\s*$/.test(text)) {
      marks.push({ text: text.trim(), endTime: Number(unit.endTime.toFixed(3)) });
      text = '';
    }
  }
  if (text.trim() && units.length) marks.push({ text: text.trim(), endTime: Number(units[units.length - 1].endTime.toFixed(3)) });
  return marks;
}

function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function i32(value) { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }

function makeMessage(event, payload = {}, sessionId = '') {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const parts = [Buffer.from([0x11, (MSG_FULL_CLIENT << 4) | FLAG_WITH_EVENT, 0x10, 0x00]), i32(event)];
  if (![EVENT.StartConnection, EVENT.FinishConnection].includes(event)) {
    const sid = Buffer.from(sessionId, 'utf8');
    parts.push(u32(sid.length), sid);
  }
  parts.push(u32(json.length), json);
  return Buffer.concat(parts);
}

function parseMessage(data) {
  const b = Buffer.from(data); let offset = (b[0] & 0x0f) * 4;
  const type = b[1] >> 4, flag = b[1] & 0x0f;
  if (flag === 1 || flag === 3) offset += 4;
  if (type === MSG_ERROR) {
    const code = b.readUInt32BE(offset); offset += 4;
    const size = b.readUInt32BE(offset); offset += 4;
    return { type, code, payload: b.subarray(offset, offset + size) };
  }
  let event = 0;
  if (flag === FLAG_WITH_EVENT) {
    event = b.readInt32BE(offset); offset += 4;
    if (![EVENT.ConnectionStarted, EVENT.ConnectionFailed, EVENT.ConnectionFinished].includes(event)) {
      const sidSize = b.readUInt32BE(offset); offset += 4 + sidSize;
    } else {
      const connectSize = b.readUInt32BE(offset); offset += 4 + connectSize;
    }
  }
  const size = b.readUInt32BE(offset); offset += 4;
  return { type, event, payload: b.subarray(offset, offset + size) };
}

function synthesize({ apiKey, text, speaker, speechRate = -4, pitch = 0, contextTexts = [] }) {
  return new Promise((resolve, reject) => {
    const connectId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    const audio = [], subtitles = []; let settled = false, sessionStarted = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { ws.close(); } catch {}
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('火山语音合成超时')), 90000);
    const ws = new WebSocket(URL, {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'seed-tts-2.0',
        'X-Api-Connect-Id': connectId,
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      maxPayload: 16 * 1024 * 1024,
    });
    const base = {
      req_params: {
        speaker,
        audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 128000, speech_rate: speechRate, enable_subtitle: true },
        post_process: { pitch },
        context_texts: contextTexts,
        additions: JSON.stringify({ disable_markdown_filter: false, disable_emoji_filter: false }),
      },
    };
    ws.on('open', () => ws.send(makeMessage(EVENT.StartConnection, {})));
    ws.on('message', raw => {
      try {
        const msg = parseMessage(raw);
        if (msg.type === MSG_ERROR) return finish(new Error(`火山语音错误 ${msg.code}: ${msg.payload.toString('utf8')}`));
        if (msg.event === EVENT.ConnectionFailed || msg.event === EVENT.SessionFailed) return finish(new Error(msg.payload.toString('utf8') || '火山语音会话失败'));
        if (msg.event === EVENT.ConnectionStarted) ws.send(makeMessage(EVENT.StartSession, { ...base, event: EVENT.StartSession }, sessionId));
        else if (msg.event === EVENT.SessionStarted && !sessionStarted) {
          sessionStarted = true;
          ws.send(makeMessage(EVENT.TaskRequest, { ...base, event: EVENT.TaskRequest, req_params: { ...base.req_params, text } }, sessionId));
          ws.send(makeMessage(EVENT.FinishSession, {}, sessionId));
        } else if (msg.type === MSG_AUDIO_SERVER && msg.event === EVENT.TTSResponse) audio.push(msg.payload);
        else if (msg.event === EVENT.SessionFinished) {
          if (!audio.length) return finish(new Error('火山语音没有返回音频'));
          finish(null, { audio: Buffer.concat(audio), sentenceMarks: sentenceMarks(subtitles) });
        }
        else if (msg.type === MSG_FULL_SERVER && msg.payload.length) {
          try { const data=JSON.parse(msg.payload.toString('utf8')); if(msg.event===EVENT.TTSSubtitle || JSON.stringify(data).match(/(?:start|end)[_A-Za-z]*time/i)) subtitles.push(data); } catch {}
        }
      } catch (error) { finish(error); }
    });
    ws.on('error', error => finish(error));
    ws.on('close', () => { if (!settled) finish(new Error('火山语音连接提前关闭')); });
  });
}

module.exports = { synthesize };
