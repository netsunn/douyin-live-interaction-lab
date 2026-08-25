const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { synthesize: synthesizeVolc } = require("./volc-tts");
const physicalPrinter = require("./physical-printer");

const root = __dirname;
const envFile = path.join(root, ".env.local");
if (fs.existsSync(envFile))
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
};
const giftClients = new Set();
let giftEventId = 0;
const giftHistory = [];
const commentClients = new Set();
let commentEventId = 0;
const commentHistory = [];
const messageSettingsFile = path.join(root, "message-settings.json");
const defaultMessageSettings = {
  types: { comment: true, member: true, gift: true, follow: true, like: true, fansclub: true },
  avatars: true,
};
let messageSettings = defaultMessageSettings;
try {
  const saved = JSON.parse(fs.readFileSync(messageSettingsFile, "utf8"));
  messageSettings = { types: { ...defaultMessageSettings.types, ...(saved.types || {}) }, avatars: saved.avatars !== false };
} catch {}
function saveMessageSettings() {
  fs.writeFileSync(messageSettingsFile, JSON.stringify(messageSettings, null, 2), "utf8");
}
function sseMessage(type, event, replay = false) {
  return `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(replay ? { ...event, replay: true } : event)}\n\n`;
}
function giftReply({ userName, giftName, count }) {
  const who = String(userName || "这位朋友").slice(0, 30),
    gift = String(giftName || "礼物").slice(0, 30),
    qty = Math.max(1, Math.min(9999, Number(count) || 1));
  return `感谢${who}送的${qty}个${gift}`;
}
function printableAvatarUrl(value) {
  const url = String(value || "").trim();
  if (!/^https?:\/\//i.test(url)) return "";
  const lowered = url.toLowerCase();
  const markers = ["default_avatar", "default-avatar", "avatar_default", "avatar-default", "default_user", "default-user", "user_default", "user-default", "defavatar", "def_avatar", "def-avatar", "mosaic-legacy/3795/3047680722", "mosaic-legacy/3791/5070639578"];
  return markers.some((marker) => lowered.includes(marker)) ? "" : url.slice(0, 1000);
}
function enqueuePhysicalCopies(type, event) {
  const copies = 1;
  const printableEvent = messageSettings.avatars ? event : { ...event, avatarUrl: "" };
  let accepted = false;
  for (let index = 0; index < copies; index += 1)
    accepted = physicalPrinter.enqueue(type, printableEvent) || accepted;
  return accepted;
}
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/message-settings") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, ...messageSettings }));
  }
  if (req.method === "POST" && req.url === "/api/message-settings") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 3000) req.destroy(); });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}"), types = { ...messageSettings.types };
        for (const type of Object.keys(defaultMessageSettings.types))
          if (typeof input.types?.[type] === "boolean") types[type] = input.types[type];
        messageSettings = { types, avatars: typeof input.avatars === "boolean" ? input.avatars : messageSettings.avatars };
        saveMessageSettings();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...messageSettings }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/physical-printer/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, ...physicalPrinter.status() }));
  }
  if (req.method === "GET" && req.url === "/api/debug/latest-gift") {
    const event = giftHistory.at(-1) || null;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: true, event, printer: physicalPrinter.status() }),
    );
  }
  if (req.method === "POST" && req.url === "/api/physical-printer/reset") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1000) req.destroy();
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const state = physicalPrinter.reset(Boolean(input.enabled));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: true, ...state }));
      } catch (e) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/physical-printer/text") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 3000) req.destroy();
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const text = String(input.text || "")
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 500);
        if (!text) throw new Error("打印内容为空");
        const accepted = physicalPrinter.enqueueText(text);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({ ok: true, accepted, ...physicalPrinter.status() }),
        );
      } catch (e) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/comment-events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const lastId = Number(req.headers["last-event-id"] || 0);
    for (const event of commentHistory.filter((x) => x.id > lastId))
      res.write(sseMessage("comment", event, true));
    commentClients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      commentClients.delete(res);
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/douyin/comment-event") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 20000) req.destroy();
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}"),
          userName = String(input.userName || "")
            .trim()
            .slice(0, 80),
          content = String(input.content || "")
            .trim()
            .slice(0, 500),
          eventType =
            input.eventType === "member"
              ? "member"
              : input.eventType === "fansclub"
                ? "fansclub"
              : input.eventType === "follow"
                ? "follow"
                : input.eventType === "like"
                  ? "like"
                  : "comment",
          avatarUrl = printableAvatarUrl(input.avatarUrl);
        if (!userName || !content)
          throw new Error("评论事件缺少用户昵称或正文");
        if (!messageSettings.types[eventType]) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: true, ignored: true, eventType }));
        }
        const event = {
          id: ++commentEventId,
          eventType,
          userName,
          avatarUrl,
          content,
          count: eventType === "like" ? Math.max(1, Math.min(99999, Number(input.count) || 1)) : undefined,
          total: eventType === "like" ? Math.max(0, Number(input.total) || 0) : undefined,
          memberCount: eventType === "member" ? Math.max(0, Number(input.memberCount) || 0) : undefined,
          fansclubType: eventType === "fansclub" ? Math.max(0, Number(input.fansclubType) || 0) : undefined,
          source: String(input.source || "dom").slice(0, 20),
          countSource: String(input.countSource || "").slice(0, 30),
          receivedAt: input.receivedAt || new Date().toISOString(),
        };
        commentHistory.push(event);
        if (commentHistory.length > 200) commentHistory.shift();
        event.physicalPrinted = enqueuePhysicalCopies(eventType, event);
        const message = sseMessage("comment", event);
        for (const client of commentClients) {
          try {
            client.write(message);
          } catch {
            commentClients.delete(client);
          }
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: true, event }));
      } catch (e) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/gift-events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const lastId = Number(req.headers["last-event-id"] || 0);
    for (const event of giftHistory.filter((x) => x.id > lastId))
      res.write(sseMessage("gift", event, true));
    giftClients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      giftClients.delete(res);
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/douyin/gift-event") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8000) req.destroy();
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        if (
          !String(input.userName || "").trim() ||
          !String(input.giftName || "").trim()
        )
          throw new Error("礼物事件缺少用户或礼物名称");
        if (!messageSettings.types.gift) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: true, ignored: true, eventType: "gift" }));
        }
        const event = {
          id: ++giftEventId,
          userName: String(input.userName).trim().slice(0, 30),
          avatarUrl: printableAvatarUrl(input.avatarUrl),
          avatarDebug: String(input.avatarDebug || "").slice(0, 200),
          giftName: String(input.giftName).trim().slice(0, 30),
          count: Math.max(1, Math.min(9999, Number(input.count) || 1)),
          value: Math.max(0, Number(input.value) || 0),
          source: String(input.source || "unknown").slice(0, 20),
          receivedAt: new Date().toISOString(),
        };
        event.reply = giftReply(event);
        giftHistory.push(event);
        if (giftHistory.length > 100) giftHistory.shift();
        event.physicalPrinted = enqueuePhysicalCopies("gift", event);
        const message = sseMessage("gift", event);
        for (const client of giftClients) {
          try {
            client.write(message);
          } catch {
            giftClients.delete(client);
          }
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: true, event }));
      } catch (e) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/generate-script") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 12000) req.destroy();
    });
    req.on("end", async () => {
      try {
        if (!process.env.DEEPSEEK_API_KEY)
          throw new Error("DeepSeek API Key 未配置");
        const input = JSON.parse(body || "{}");
        const targetLength = Math.min(
          3000,
          Math.max(10, Number(input.targetLength) || 1000),
        );
        const continuation = Boolean(
          input.continuation && input.previousScript,
        );
        const continuationRule = continuation
          ? `这是上一轮已经播过的直播稿：\n---\n${String(input.previousScript).slice(-5000)}\n---\n请生成紧接着它继续讲的下一篇约${targetLength}字直播稿。不要重新从开场白开始，不要大段重复上一稿；用“刚才我们讲到”“接下来再看”“有朋友刚问到”等自然承接方式，从新的使用细节、场景、选购判断、常见问题、规格确认、售后提醒或互动角度继续展开。即使欢迎新观众，也只能简短插入，不能重置整场直播。`
          : "这是本场直播的第一篇稿件，可以从欢迎新观众自然开始。";
        const prompt = `你是电商直播间的现场主播，不是短视频编剧。${continuationRule}\n请根据真实商品资料写约${targetLength}字、可连续播报的中文直播话术，正文长度尽量控制在目标字数上下10%以内。输出第一行必须是“【商品名称：${input.name || "当前商品"}】”，第二行必须是“【本次讲解核心：不超过22个字的具体总结】”，准确概括本篇新增的讲解重点，不能写成“继续讲解商品”之类空泛标题。之后再输出正文。整篇始终只围绕同一个当前商品展开，不能说“接下来介绍别的商品”“下面换一个商品”“好了接下去要介绍别的了”或任何暗示切换商品的话。只能使用资料中出现的事实，不得编造功效、销量、库存、最低价、赠品或权威背书；不使用“绝对、第一、百分百、根治、保证”等夸大词。稿件要口语化、自然、有停顿感，并标出每一段的【作用｜语气】。结尾必须保持对当前商品的继续讲解，引导留言、查看当前商品卡或衔接当前商品的下一轮细节，不能结束直播。严禁出现：拜拜、再见、下期见、视频结束、感谢观看、我们下个视频、不见不散、晚安、关注我下期、接下去介绍别的、介绍另一个商品等短视频收尾或换品词。商品资料：${JSON.stringify({ ...input, previousScript: undefined, targetLength })}`;
        const api = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            temperature: 0.75,
            max_tokens: Math.min(6000, Math.ceil(targetLength * 1.8) + 500),
            stream: true,
            messages: [
              { role: "system", content: "你是严谨、自然的中文直播话术编辑。" },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!api.ok) {
          const data = await api.json();
          throw new Error(data.error?.message || `DeepSeek ${api.status}`);
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of api.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") {
              res.write('data: {"done":true}\n\n');
              continue;
            }
            try {
              const data = JSON.parse(raw);
              const delta = data.choices?.[0]?.delta?.content;
              if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            } catch {}
          }
        }
        res.end();
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        } else res.end();
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/tts") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const {
          text,
          voice = "zh_female_gaolengyujie_uranus_bigtts",
          rate = "-4%",
          pitch = "+0Hz",
          context = "live",
          refresh = false,
        } = JSON.parse(body || "{}");
        const edgeVoices = [
          "zh-CN-XiaoxiaoNeural",
          "zh-CN-XiaoyiNeural",
          "zh-CN-YunxiNeural",
          "zh-CN-YunjianNeural",
        ];
        const volcVoices = [
          "zh_female_vivi_uranus_bigtts",
          "zh_female_xiaohe_uranus_bigtts",
          "zh_male_wenrouahu_uranus_bigtts",
          "zh_male_jieshuoxiaoming_uranus_bigtts",
          "zh_female_wenroumama_uranus_bigtts",
          "zh_female_gaolengyujie_uranus_bigtts",
        ];
        if (
          !text ||
          text.length > 5000 ||
          ![...edgeVoices, ...volcVoices].includes(voice) ||
          !/^[+-]\d{1,2}%$/.test(rate) ||
          !/^[+-]\d{1,2}Hz$/.test(pitch)
        )
          throw new Error("Invalid TTS request");
        const cacheDir = path.join(root, ".tts-cache");
        fs.mkdirSync(cacheDir, { recursive: true });
        const provider = volcVoices.includes(voice) ? "volc" : "edge";
        const name =
          crypto
            .createHash("sha1")
            .update(`${provider}|${voice}|${rate}|${pitch}|${context}|${text}`)
            .digest("hex") + ".mp3";
        const out = path.join(cacheDir, name),
          metaOut = `${out}.json`;
        const readMarks = () => {
          try {
            const data = JSON.parse(fs.readFileSync(metaOut, "utf8"));
            return Array.isArray(data.sentenceMarks) ? data.sentenceMarks : [];
          } catch {
            return [];
          }
        };
        const done = (
          usedProvider = provider,
          warning = "",
          marks = readMarks(),
        ) => {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(
            JSON.stringify({
              ok: true,
              url: `/.tts-cache/${name}`,
              provider: usedProvider,
              warning,
              sentenceMarks: marks,
            }),
          );
        };
        if (fs.existsSync(out) && !refresh) return done();
        const edge = (warning = "") =>
          new Promise((resolve, reject) => {
            const fallbackVoice = edgeVoices.includes(voice)
              ? voice
              : "zh-CN-XiaoxiaoNeural";
            const proc = spawn(
              path.join(root, ".venv", "Scripts", "python.exe"),
              [
                "-m",
                "edge_tts",
                "--voice",
                fallbackVoice,
                `--rate=${rate}`,
                `--pitch=${pitch}`,
                "--text",
                text,
                "--write-media",
                out,
              ],
              { windowsHide: true },
            );
            let err = "";
            proc.stderr.on("data", (d) => (err += d));
            proc.on("close", (code) =>
              code === 0 && fs.existsSync(out)
                ? resolve(
                    done(
                      provider === "volc" ? "edge-fallback" : "edge",
                      warning,
                    ),
                  )
                : reject(new Error(err || "Edge TTS failed")),
            );
          });
        if (provider === "volc") {
          if (!process.env.VOLC_TTS_API_KEY)
            throw new Error("火山语音 API Key 未配置");
          const instructions =
            context === "reply"
              ? [
                  "像经验丰富的直播间主播一样自然回答观众，亲切、有交流感，不要播音腔。",
                ]
              : [
                  "像经验丰富的电商直播间女主播，热情自然、有交流感，语速流畅，重点词适度强调，不要播音腔，不要像广告配音。",
                ];
          try {
            const result = await synthesizeVolc({
              apiKey: process.env.VOLC_TTS_API_KEY,
              text,
              speaker: voice,
              speechRate: Number(rate.replace("%", "")),
              pitch: 0,
              contextTexts: instructions,
            });
            fs.writeFileSync(out, result.audio);
            fs.writeFileSync(
              metaOut,
              JSON.stringify({ sentenceMarks: result.sentenceMarks }, null, 2),
              "utf8",
            );
            return done("volc", "", result.sentenceMarks);
          } catch (error) {
            return edge(
              `豆包语音暂时不可用，已自动切换备用音色：${error.message}`,
            );
          }
        }
        await edge();
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  let pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(root, pathname);
  if (
    !file.startsWith(root) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const stat = fs.statSync(file),
    type = mime[path.extname(file)] || "application/octet-stream",
    range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/),
      start = m && m[1] ? Number(m[1]) : 0,
      end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (!m || start > end || end >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});
const PORT = Number(process.env.PORT || 8876);
server.listen(PORT, "0.0.0.0", () =>
  console.log(`Live console: http://127.0.0.1:${PORT}`),
);
