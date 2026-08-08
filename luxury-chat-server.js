"use strict";

// ============================================================================
// Luxury Chat Server Module
// Node 18+ / Express / multer / Cloudinary
//
// الاستخدام داخل server.js الحالي:
//
// const installLuxuryChat = require("./luxury-chat-server");
// installLuxuryChat(app, cloudinary);
//
// البيئة المطلوبة:
// PLAYFAB_TITLE_ID=xxxxx
// PLAYFAB_SECRET_KEY=xxxxx
//
// ملاحظة مهمة:
// النصوص محفوظة في الذاكرة هنا (آخر 300 رسالة لكل غرفة) ولذلك تختفي عند Restart.
// هذا ممتاز كبداية واختبار. للإنتاج الدائم انقل room.messages إلى Redis/Postgres.
// ============================================================================

const multer = require("multer");
const crypto = require("crypto");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

module.exports = function installLuxuryChat(app, cloudinary) {
  if (!app) throw new Error("installLuxuryChat: app is required");
  if (!cloudinary) throw new Error("installLuxuryChat: cloudinary is required");

  const TITLE_ID = String(process.env.PLAYFAB_TITLE_ID || "").trim();
  const SECRET_KEY = String(process.env.PLAYFAB_SECRET_KEY || "").trim();

  const MAX_MESSAGES_PER_ROOM = 300;
  const MAX_TEXT_LENGTH = 500;
  const rooms = new Map();
  const nameCache = new Map();
  const sendRate = new Map();

  function nowMs() {
    return Date.now();
  }

  function cleanRoom(value) {
    const room = String(value || "global").trim().toLowerCase();
    if (!/^[a-z0-9_\-]{1,40}$/.test(room)) return "global";
    return room;
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u0000/g, "")
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  }

  function getRoom(id) {
    const key = cleanRoom(id);
    if (!rooms.has(key)) {
      rooms.set(key, { seq: 0, messages: [] });
    }
    return rooms.get(key);
  }

  function pushMessage(roomId, message) {
    const room = getRoom(roomId);
    room.seq += 1;
    message.seq = room.seq;
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
    return message;
  }

  function findMessage(roomId, messageId) {
    if (!messageId) return null;
    const room = getRoom(roomId);
    for (let i = room.messages.length - 1; i >= 0; i--) {
      if (room.messages[i].id === messageId) return room.messages[i];
    }
    return null;
  }

  function replySnapshot(roomId, replyToMessageId) {
    const original = findMessage(roomId, String(replyToMessageId || ""));
    if (!original) {
      return { replyToId: "", replyToName: "", replyToPreview: "" };
    }

    let preview = "";
    if (original.kind === "voice") {
      const s = Math.max(0, Math.round(Number(original.voiceDuration || 0)));
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      preview = `ملاحظة صوتية ${mm}:${ss}`;
    } else {
      preview = String(original.text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
    }

    return {
      replyToId: original.id,
      replyToName: original.senderName || "لاعب",
      replyToPreview: preview,
    };
  }

  async function playFabServerCall(endpoint, body) {
    if (!TITLE_ID || !SECRET_KEY) {
      throw new Error("PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY missing");
    }

    const response = await fetch(`https://${TITLE_ID}.playfabapi.com/Server/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SecretKey": SECRET_KEY,
      },
      body: JSON.stringify(body || {}),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.code !== 200 || !json.data) {
      const msg = json && json.errorMessage ? json.errorMessage : `PlayFab ${endpoint} failed`;
      throw new Error(msg);
    }

    return json.data;
  }

  async function authenticateSessionTicket(sessionTicket) {
    const ticket = String(sessionTicket || "").trim();
    if (!ticket) throw new Error("missing_session_ticket");

    const data = await playFabServerCall("AuthenticateSessionTicket", {
      SessionTicket: ticket,
    });

    const playFabId =
      data && data.UserInfo && data.UserInfo.PlayFabId
        ? String(data.UserInfo.PlayFabId)
        : "";

    if (!playFabId) throw new Error("invalid_session_ticket");
    return playFabId;
  }

  async function getPlayerName(playFabId) {
    const cached = nameCache.get(playFabId);
    if (cached && cached.expires > nowMs()) return cached.name;

    let name = "لاعب";

    try {
      const data = await playFabServerCall("GetUserData", {
        PlayFabId: playFabId,
        Keys: ["player_display_name"],
      });

      if (
        data &&
        data.Data &&
        data.Data.player_display_name &&
        data.Data.player_display_name.Value
      ) {
        name = String(data.Data.player_display_name.Value).trim().slice(0, 32) || "لاعب";
      }
    } catch (_) {
      // fallback below
    }

    if (name === "لاعب") {
      try {
        const data = await playFabServerCall("GetUserAccountInfo", {
          PlayFabId: playFabId,
        });
        const display =
          data &&
          data.UserInfo &&
          data.UserInfo.TitleInfo &&
          data.UserInfo.TitleInfo.DisplayName
            ? String(data.UserInfo.TitleInfo.DisplayName).trim()
            : "";
        if (display) name = display.slice(0, 32);
      } catch (_) {}
    }

    nameCache.set(playFabId, { name, expires: nowMs() + 5 * 60 * 1000 });
    return name;
  }

  function checkRate(playFabId, minimumMs) {
    const now = nowMs();
    const last = Number(sendRate.get(playFabId) || 0);
    if (now - last < minimumMs) return false;
    sendRate.set(playFabId, now);
    return true;
  }

  function makeBaseMessage({ room, senderId, senderName, kind, reply }) {
    return {
      id: crypto.randomUUID(),
      seq: 0,
      room,
      senderId,
      senderName,
      sentUnixMs: nowMs(),
      kind,
      text: "",
      voiceUrl: "",
      voiceDuration: 0,
      replyToId: reply.replyToId,
      replyToName: reply.replyToName,
      replyToPreview: reply.replyToPreview,
    };
  }

  async function uploadAudioBuffer(buffer, playFabId) {
    return await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder: "chat_voice_notes",
          public_id: `${playFabId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
          overwrite: false,
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result || !result.secure_url) return reject(new Error("cloudinary_no_url"));
          resolve(result.secure_url);
        }
      );

      stream.end(buffer);
    });
  }

  // --------------------------------------------------------------------------
  // HISTORY
  // --------------------------------------------------------------------------

  app.post("/chat/messages", async (req, res) => {
    try {
      const sessionTicket = req.body && req.body.sessionTicket;
      await authenticateSessionTicket(sessionTicket);

      const roomId = cleanRoom(req.body && req.body.room);
      const afterSeq = Math.max(0, Number(req.body && req.body.afterSeq) || 0);
      const limit = Math.min(100, Math.max(1, Number(req.body && req.body.limit) || 50));

      const room = getRoom(roomId);
      let messages;

      if (afterSeq > 0) {
        messages = room.messages.filter((m) => m.seq > afterSeq).slice(0, limit);
      } else {
        messages = room.messages.slice(Math.max(0, room.messages.length - limit));
      }

      res.json({
        ok: true,
        messages,
        latestSeq: room.seq,
      });
    } catch (e) {
      console.error("/chat/messages", e);
      res.status(401).json({ ok: false, error: "تعذر التحقق من جلسة اللاعب" });
    }
  });

  // --------------------------------------------------------------------------
  // SEND TEXT
  // --------------------------------------------------------------------------

  app.post("/chat/send", async (req, res) => {
    try {
      const sessionTicket = req.body && req.body.sessionTicket;
      const playFabId = await authenticateSessionTicket(sessionTicket);

      if (!checkRate(playFabId, 500)) {
        return res.status(429).json({ ok: false, error: "أرسل بهدوء قليلاً" });
      }

      const roomId = cleanRoom(req.body && req.body.room);
      const text = cleanText(req.body && req.body.text);
      if (!text) {
        return res.status(400).json({ ok: false, error: "الرسالة فارغة" });
      }

      const senderName = await getPlayerName(playFabId);
      const reply = replySnapshot(roomId, req.body && req.body.replyToMessageId);

      const message = makeBaseMessage({
        room: roomId,
        senderId: playFabId,
        senderName,
        kind: "text",
        reply,
      });
      message.text = text;

      pushMessage(roomId, message);
      res.json({ ok: true, message });
    } catch (e) {
      console.error("/chat/send", e);
      res.status(401).json({ ok: false, error: "تعذر إرسال الرسالة" });
    }
  });

  // --------------------------------------------------------------------------
  // SEND VOICE
  // --------------------------------------------------------------------------

  app.post("/chat/voice", upload.single("clip"), async (req, res) => {
    try {
      const playFabId = await authenticateSessionTicket(req.body && req.body.sessionTicket);

      if (!checkRate(playFabId, 900)) {
        return res.status(429).json({ ok: false, error: "انتظر قليلاً قبل الإرسال" });
      }

      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ ok: false, error: "ملف الصوت غير موجود" });
      }

      const roomId = cleanRoom(req.body && req.body.room);
      const duration = Math.min(180, Math.max(0, Number(req.body && req.body.duration) || 0));
      const senderName = await getPlayerName(playFabId);
      const reply = replySnapshot(roomId, req.body && req.body.replyToMessageId);

      const voiceUrl = await uploadAudioBuffer(req.file.buffer, playFabId);

      const message = makeBaseMessage({
        room: roomId,
        senderId: playFabId,
        senderName,
        kind: "voice",
        reply,
      });
      message.voiceUrl = voiceUrl;
      message.voiceDuration = duration;

      pushMessage(roomId, message);
      res.json({ ok: true, message });
    } catch (e) {
      console.error("/chat/voice", e);
      res.status(500).json({ ok: false, error: "تعذر رفع الملاحظة الصوتية" });
    }
  });
};
