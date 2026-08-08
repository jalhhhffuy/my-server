"use strict";

// ============================================================================
// Luxury Chat Server - Persistent 30 Days + Reports
// Node 18+ / Express / multer / Cloudinary / PlayFab
//
// server.js:
// const installLuxuryChat = require("./luxury-chat-server");
// installLuxuryChat(app, cloudinary);
//
// Required env:
// PLAYFAB_TITLE_ID
// PLAYFAB_SECRET_KEY
//
// Optional env:
// CHAT_REPORTS_KEY=LUXURY_CHAT_REPORTS
//
// السلوك:
// - تاريخ الشات محفوظ دائماً في Cloudinary وليس RAM فقط.
// - كل رسالة تبقى 30 يوماً كاملة، وعند دخولها اليوم 31 تُحذف.
// - السيرفر لا يحذف الرسالة رقم 101. Unity هو الذي يحتفظ محلياً بآخر 100.
// - كل طلب History يرجع بحد أقصى 100 رسالة فقط.
// - البلاغات تحفظ في PlayFab Title Internal Data داخل مفتاح LUXURY_CHAT_REPORTS.
// - الرسائل الجديدة تحمل اسم اللاعب ورابط صورته ونسخة الصورة.
// - clientMessageId يمنع تكرار نفس الرسالة عند Retry.
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

  const REPORTS_KEY =
    String(process.env.CHAT_REPORTS_KEY || "LUXURY_CHAT_REPORTS").trim() ||
    "LUXURY_CHAT_REPORTS";

  const MAX_TEXT_LENGTH = 200;
  const MAX_FETCH_LIMIT = 100;

  // 30 يوم كاملة. عند تجاوزها يبدأ اليوم 31 وتحذف الرسالة.
  const RETENTION_DAYS = 30;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // حماية حجم مفتاح البلاغات.
  const MAX_REPORTS_IN_KEY = 500;

  const PROFILE_CACHE_MS = 60 * 1000;
  const HISTORY_FOLDER = "luxury_chat_history";

  const rooms = new Map();
  const profileCache = new Map();
  const sendRate = new Map();

  let reportsLoaded = false;
  let reports = [];
  let reportsLoadPromise = null;
  let reportsWriteChain = Promise.resolve();

  function nowMs() {
    return Date.now();
  }

  function cleanRoom(value) {
    const room = String(value || "global").trim().toLowerCase();
    return /^[a-z0-9_-]{1,40}$/.test(room) ? room : "global";
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u0000/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
  }

  function cleanReason(value) {
    return String(value || "")
      .replace(/\u0000/g, "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 300);
  }

  function safeString(value, max) {
    const text = String(value || "").trim();
    return max && text.length > max ? text.slice(0, max) : text;
  }

  function cleanClientMessageId(value) {
    return safeString(value, 100);
  }

  function checkRate(playFabId, minimumMs) {
    const now = nowMs();
    const last = Number(sendRate.get(playFabId) || 0);

    if (now - last < minimumMs) return false;

    sendRate.set(playFabId, now);
    return true;
  }

  // ==========================================================================
  // PLAYFAB
  // ==========================================================================

  async function playFabCall(group, endpoint, body) {
    if (!TITLE_ID || !SECRET_KEY) {
      throw new Error("PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY missing");
    }

    const response = await fetch(
      `https://${TITLE_ID}.playfabapi.com/${group}/${endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SecretKey": SECRET_KEY,
        },
        body: JSON.stringify(body || {}),
      }
    );

    const json = await response.json().catch(() => null);

    if (!response.ok || !json || json.code !== 200 || json.data === undefined) {
      const message =
        json && json.errorMessage
          ? json.errorMessage
          : `PlayFab ${group}/${endpoint} failed`;

      throw new Error(message);
    }

    return json.data;
  }

  function playFabServerCall(endpoint, body) {
    return playFabCall("Server", endpoint, body);
  }

  function playFabAdminCall(endpoint, body) {
    return playFabCall("Admin", endpoint, body);
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

  async function getPlayerProfile(playFabId) {
    const cached = profileCache.get(playFabId);

    if (cached && cached.expires > nowMs()) {
      return cached.profile;
    }

    let playerName = "لاعب";
    let avatarUrl = "";
    let avatarVersion = "0";

    try {
      const data = await playFabServerCall("GetUserData", {
        PlayFabId: playFabId,
        Keys: [
          "player_display_name",
          "avatar_uploaded",
          "avatar_url",
          "avatar_version",
        ],
      });

      if (data && data.Data) {
        const nameRecord = data.Data.player_display_name;
        const uploadedRecord = data.Data.avatar_uploaded;
        const urlRecord = data.Data.avatar_url;
        const versionRecord = data.Data.avatar_version;

        if (nameRecord && nameRecord.Value) {
          playerName = safeString(nameRecord.Value, 32) || "لاعب";
        }

        const avatarUploaded =
          uploadedRecord && String(uploadedRecord.Value || "") === "1";

        if (avatarUploaded && urlRecord && urlRecord.Value) {
          avatarUrl = safeString(urlRecord.Value, 1000);
        }

        if (versionRecord && versionRecord.Value) {
          avatarVersion = safeString(versionRecord.Value, 100) || "0";
        }
      }
    } catch (_) {}

    if (playerName === "لاعب") {
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

        if (display) playerName = display.slice(0, 32);
      } catch (_) {}
    }

    const profile = {
      playerName,
      avatarUrl,
      avatarVersion,
    };

    profileCache.set(playFabId, {
      profile,
      expires: nowMs() + PROFILE_CACHE_MS,
    });

    return profile;
  }

  // ==========================================================================
  // ROOM / CLOUDINARY PERSISTENCE
  // ==========================================================================

  function getRoom(roomId) {
    const id = cleanRoom(roomId);

    if (!rooms.has(id)) {
      rooms.set(id, {
        id,
        seq: 0,
        messages: [],
        loaded: false,
        loadingPromise: null,
        writeChain: Promise.resolve(),
      });
    }

    return rooms.get(id);
  }

  function historyPublicId(roomId) {
    return `${HISTORY_FOLDER}/room_${cleanRoom(roomId)}.json`;
  }

  function historyUrl(roomId) {
    const base = cloudinary.url(historyPublicId(roomId), {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });

    return `${base}${base.includes("?") ? "&" : "?"}ts=${nowMs()}`;
  }

  function uploadRawJson(publicId, object) {
    const buffer = Buffer.from(JSON.stringify(object), "utf8");

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "raw",
          type: "upload",
          public_id: publicId,
          overwrite: true,
          invalidate: true,
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error("cloudinary_no_result"));
          resolve(result);
        }
      );

      stream.end(buffer);
    });
  }

  function normalizeMessage(raw, roomId) {
    if (!raw || typeof raw !== "object") return null;

    const id = safeString(raw.id, 100);
    const sentUnixMs = Math.max(0, Number(raw.sentUnixMs) || 0);

    if (!id || !sentUnixMs) return null;

    return {
      id,
      clientMessageId: cleanClientMessageId(raw.clientMessageId),
      seq: Math.max(0, Number(raw.seq) || 0),
      room: cleanRoom(raw.room || roomId),
      senderId: safeString(raw.senderId, 100),
      senderName: safeString(raw.senderName, 64) || "لاعب",
      senderAvatarUrl: safeString(raw.senderAvatarUrl, 1000),
      senderAvatarVersion: safeString(raw.senderAvatarVersion, 100) || "0",
      sentUnixMs,
      kind: String(raw.kind || "").toLowerCase() === "voice" ? "voice" : "text",
      text: cleanText(raw.text || ""),
      voiceUrl: safeString(raw.voiceUrl, 1200),
      voiceDuration: Math.min(180, Math.max(0, Number(raw.voiceDuration) || 0)),
      replyToId: safeString(raw.replyToId, 100),
      replyToName: safeString(raw.replyToName, 64),
      replyToPreview: safeString(raw.replyToPreview, 120),
    };
  }

  function pruneExpired(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    const cutoff = nowMs() - RETENTION_MS;
    const oldLength = room.messages.length;

    room.messages = room.messages.filter((message) => {
      if (!message) return false;

      const sent = Number(message.sentUnixMs) || 0;

      // sent <= cutoff يعني أكملت 30 يوم ودخلت اليوم 31.
      return sent > cutoff;
    });

    return room.messages.length !== oldLength;
  }

  async function loadRoomFromStorage(roomId) {
    const room = getRoom(roomId);

    const response = await fetch(historyUrl(roomId), {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
    });

    if (response.status === 404) {
      room.seq = 0;
      room.messages = [];
      room.loaded = true;
      return room;
    }

    if (!response.ok) {
      throw new Error(`chat_history_load_http_${response.status}`);
    }

    const text = await response.text();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (_) {
      throw new Error("chat_history_invalid_json");
    }

    const source =
      parsed && Array.isArray(parsed.messages) ? parsed.messages : [];

    const messages = [];
    let maxSeq = 0;

    for (const raw of source) {
      const message = normalizeMessage(raw, roomId);
      if (!message) continue;

      messages.push(message);
      if (message.seq > maxSeq) maxSeq = message.seq;
    }

    messages.sort((a, b) => {
      const t = a.sentUnixMs - b.sentUnixMs;
      if (t !== 0) return t;

      const s = a.seq - b.seq;
      if (s !== 0) return s;

      return String(a.id).localeCompare(String(b.id));
    });

    room.messages = messages;
    room.seq = Math.max(maxSeq, Math.max(0, Number(parsed && parsed.seq) || 0));
    room.loaded = true;

    if (pruneExpired(room)) {
      await enqueueRoomSave(roomId);
    }

    return room;
  }

  async function ensureRoomLoaded(roomId) {
    const room = getRoom(roomId);

    if (room.loaded) return room;
    if (room.loadingPromise) return room.loadingPromise;

    room.loadingPromise = loadRoomFromStorage(roomId)
      .then((loaded) => {
        room.loadingPromise = null;
        return loaded;
      })
      .catch((error) => {
        room.loadingPromise = null;
        room.loaded = false;
        throw error;
      });

    return room.loadingPromise;
  }

  async function saveRoomNow(roomId) {
    const room = getRoom(roomId);

    pruneExpired(room);

    await uploadRawJson(historyPublicId(roomId), {
      version: 2,
      room: cleanRoom(roomId),
      seq: Math.max(0, Number(room.seq) || 0),
      retentionDays: RETENTION_DAYS,
      savedAtUnixMs: nowMs(),
      messages: room.messages,
    });
  }

  function enqueueRoomSave(roomId) {
    const room = getRoom(roomId);

    room.writeChain = room.writeChain
      .catch(() => {})
      .then(() => saveRoomNow(roomId));

    return room.writeChain;
  }

  function findMessage(room, messageId) {
    if (!room || !messageId) return null;

    for (let i = room.messages.length - 1; i >= 0; i--) {
      const message = room.messages[i];
      if (message && message.id === messageId) return message;
    }

    return null;
  }

  function findClientMessage(room, senderId, clientMessageId) {
    if (!room || !senderId || !clientMessageId) return null;

    for (let i = room.messages.length - 1; i >= 0; i--) {
      const message = room.messages[i];

      if (
        message &&
        message.senderId === senderId &&
        message.clientMessageId === clientMessageId
      ) {
        return message;
      }
    }

    return null;
  }

  async function replySnapshot(roomId, replyToMessageId) {
    const id = String(replyToMessageId || "").trim();

    if (!id) {
      return {
        replyToId: "",
        replyToName: "",
        replyToPreview: "",
      };
    }

    const room = await ensureRoomLoaded(roomId);
    const original = findMessage(room, id);

    if (!original) {
      return {
        replyToId: "",
        replyToName: "",
        replyToPreview: "",
      };
    }

    let preview = "";

    if (original.kind === "voice") {
      const total = Math.max(0, Math.round(Number(original.voiceDuration) || 0));
      const mm = String(Math.floor(total / 60)).padStart(2, "0");
      const ss = String(total % 60).padStart(2, "0");
      preview = `ملاحظة صوتية ${mm}:${ss}`;
    } else {
      preview = String(original.text || "")
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 100);
    }

    return {
      replyToId: original.id,
      replyToName: original.senderName || "لاعب",
      replyToPreview: preview,
    };
  }

  function makeMessage({
    roomId,
    senderId,
    profile,
    kind,
    reply,
    clientMessageId,
  }) {
    return {
      id: crypto.randomUUID(),
      clientMessageId: cleanClientMessageId(clientMessageId),
      seq: 0,
      room: cleanRoom(roomId),
      senderId: safeString(senderId, 100),
      senderName: safeString(profile.playerName, 64) || "لاعب",
      senderAvatarUrl: safeString(profile.avatarUrl, 1000),
      senderAvatarVersion: safeString(profile.avatarVersion, 100) || "0",
      sentUnixMs: nowMs(),
      kind: kind === "voice" ? "voice" : "text",
      text: "",
      voiceUrl: "",
      voiceDuration: 0,
      replyToId: reply.replyToId || "",
      replyToName: reply.replyToName || "",
      replyToPreview: reply.replyToPreview || "",
    };
  }

  async function pushMessage(roomId, message) {
    const room = await ensureRoomLoaded(roomId);

    pruneExpired(room);

    room.seq += 1;
    message.seq = room.seq;
    room.messages.push(message);

    // لا يوجد حذف بسبب عدد الرسائل.
    // الحذف الوحيد من السيرفر هو عمر 30 يوماً.
    await enqueueRoomSave(roomId);

    return message;
  }

  // ==========================================================================
  // AUDIO
  // ==========================================================================

  function uploadAudioBuffer(buffer, playFabId) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder: "chat_voice_notes",
          public_id: `${playFabId}_${Date.now()}_${crypto
            .randomBytes(4)
            .toString("hex")}`,
          overwrite: false,
        },
        (error, result) => {
          if (error) return reject(error);

          if (!result || !result.secure_url) {
            return reject(new Error("cloudinary_no_url"));
          }

          resolve(result.secure_url);
        }
      );

      stream.end(buffer);
    });
  }

  // ==========================================================================
  // REPORTS -> PLAYFAB TITLE INTERNAL DATA KEY
  // ==========================================================================

  async function loadReports() {
    if (reportsLoaded) return reports;
    if (reportsLoadPromise) return reportsLoadPromise;

    reportsLoadPromise = (async () => {
      const data = await playFabServerCall("GetTitleInternalData", {
        Keys: [REPORTS_KEY],
      });

      const raw =
        data && data.Data && data.Data[REPORTS_KEY]
          ? String(data.Data[REPORTS_KEY])
          : "";

      let loaded = [];

      if (raw) {
        try {
          const parsed = JSON.parse(raw);

          if (Array.isArray(parsed)) {
            loaded = parsed;
          } else if (parsed && Array.isArray(parsed.reports)) {
            loaded = parsed.reports;
          }
        } catch (_) {
          loaded = [];
        }
      }

      reports = loaded
        .filter((item) => item && typeof item === "object")
        .slice(-MAX_REPORTS_IN_KEY);

      reportsLoaded = true;
      reportsLoadPromise = null;

      return reports;
    })().catch((error) => {
      reportsLoaded = false;
      reportsLoadPromise = null;
      throw error;
    });

    return reportsLoadPromise;
  }

  function saveReports() {
    reportsWriteChain = reportsWriteChain
      .catch(() => {})
      .then(async () => {
        const payload = {
          version: 1,
          updatedAtUnixMs: nowMs(),
          reports: reports.slice(-MAX_REPORTS_IN_KEY),
        };

        await playFabAdminCall("SetTitleInternalData", {
          Key: REPORTS_KEY,
          Value: JSON.stringify(payload),
        });
      });

    return reportsWriteChain;
  }

  async function createReport(reporterId, roomId, message, reason) {
    await loadReports();

    const existing = reports.find(
      (report) =>
        report &&
        report.reporterId === reporterId &&
        report.messageId === message.id
    );

    if (existing) {
      return {
        report: existing,
        duplicate: true,
      };
    }

    const report = {
      reportId: crypto.randomUUID(),
      createdAtUnixMs: nowMs(),
      room: cleanRoom(roomId),

      reporterId: safeString(reporterId, 100),

      messageId: safeString(message.id, 100),
      messageSeq: Math.max(0, Number(message.seq) || 0),
      messageSentUnixMs: Math.max(0, Number(message.sentUnixMs) || 0),

      reportedSenderId: safeString(message.senderId, 100),
      reportedSenderName: safeString(message.senderName, 64) || "لاعب",

      kind: message.kind === "voice" ? "voice" : "text",

      text:
        message.kind === "voice"
          ? ""
          : safeString(message.text, MAX_TEXT_LENGTH),

      voiceUrl:
        message.kind === "voice"
          ? safeString(message.voiceUrl, 1200)
          : "",

      voiceDuration:
        message.kind === "voice"
          ? Math.min(180, Math.max(0, Number(message.voiceDuration) || 0))
          : 0,

      replyToId: safeString(message.replyToId, 100),

      reason: cleanReason(reason) || "بلاغ من داخل الشات",
    };

    reports.push(report);

    if (reports.length > MAX_REPORTS_IN_KEY) {
      reports = reports.slice(-MAX_REPORTS_IN_KEY);
    }

    await saveReports();

    return {
      report,
      duplicate: false,
    };
  }

  // ==========================================================================
  // HISTORY
  // ==========================================================================

  app.post("/chat/messages", async (req, res) => {
    try {
      await authenticateSessionTicket(req.body && req.body.sessionTicket);

      const roomId = cleanRoom(req.body && req.body.room);
      const afterSeq = Math.max(0, Number(req.body && req.body.afterSeq) || 0);

      const limit = Math.min(
        MAX_FETCH_LIMIT,
        Math.max(1, Number(req.body && req.body.limit) || 50)
      );

      const room = await ensureRoomLoaded(roomId);

      if (pruneExpired(room)) {
        await enqueueRoomSave(roomId);
      }

      let messages;

      if (afterSeq > 0) {
        messages = room.messages
          .filter((message) => message.seq > afterSeq)
          .slice(0, limit);
      } else {
        messages = room.messages.slice(
          Math.max(0, room.messages.length - limit)
        );
      }

      res.json({
        ok: true,
        messages,
        latestSeq: room.seq,
        retentionDays: RETENTION_DAYS,
      });
    } catch (error) {
      console.error("/chat/messages", error);

      res.status(500).json({
        ok: false,
        error: "تعذر تحميل رسائل الشات",
      });
    }
  });

  // ==========================================================================
  // SEND TEXT
  // ==========================================================================

  app.post("/chat/send", async (req, res) => {
    try {
      const playFabId = await authenticateSessionTicket(
        req.body && req.body.sessionTicket
      );

      if (!checkRate(playFabId, 500)) {
        return res.status(429).json({
          ok: false,
          error: "أرسل بهدوء قليلاً",
        });
      }

      const roomId = cleanRoom(req.body && req.body.room);
      const text = cleanText(req.body && req.body.text);

      if (!text) {
        return res.status(400).json({
          ok: false,
          error: "الرسالة فارغة",
        });
      }

      const clientMessageId = cleanClientMessageId(
        req.body && req.body.clientMessageId
      );

      const room = await ensureRoomLoaded(roomId);

      if (clientMessageId) {
        const duplicate = findClientMessage(
          room,
          playFabId,
          clientMessageId
        );

        if (duplicate) {
          return res.json({
            ok: true,
            duplicate: true,
            message: duplicate,
          });
        }
      }

      const profile = await getPlayerProfile(playFabId);

      const reply = await replySnapshot(
        roomId,
        req.body && req.body.replyToMessageId
      );

      const message = makeMessage({
        roomId,
        senderId: playFabId,
        profile,
        kind: "text",
        reply,
        clientMessageId,
      });

      message.text = text;

      await pushMessage(roomId, message);

      res.json({
        ok: true,
        message,
      });
    } catch (error) {
      console.error("/chat/send", error);

      res.status(500).json({
        ok: false,
        error: "تعذر إرسال الرسالة",
      });
    }
  });

  // ==========================================================================
  // SEND VOICE
  // ==========================================================================

  app.post("/chat/voice", upload.single("clip"), async (req, res) => {
    try {
      const playFabId = await authenticateSessionTicket(
        req.body && req.body.sessionTicket
      );

      if (!checkRate(playFabId, 900)) {
        return res.status(429).json({
          ok: false,
          error: "انتظر قليلاً قبل الإرسال",
        });
      }

      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({
          ok: false,
          error: "ملف الصوت غير موجود",
        });
      }

      const roomId = cleanRoom(req.body && req.body.room);

      const clientMessageId = cleanClientMessageId(
        req.body && req.body.clientMessageId
      );

      const room = await ensureRoomLoaded(roomId);

      if (clientMessageId) {
        const duplicate = findClientMessage(
          room,
          playFabId,
          clientMessageId
        );

        if (duplicate) {
          return res.json({
            ok: true,
            duplicate: true,
            message: duplicate,
          });
        }
      }

      const duration = Math.min(
        180,
        Math.max(0, Number(req.body && req.body.duration) || 0)
      );

      const profile = await getPlayerProfile(playFabId);

      const reply = await replySnapshot(
        roomId,
        req.body && req.body.replyToMessageId
      );

      const voiceUrl = await uploadAudioBuffer(
        req.file.buffer,
        playFabId
      );

      const message = makeMessage({
        roomId,
        senderId: playFabId,
        profile,
        kind: "voice",
        reply,
        clientMessageId,
      });

      message.voiceUrl = voiceUrl;
      message.voiceDuration = duration;

      await pushMessage(roomId, message);

      res.json({
        ok: true,
        message,
      });
    } catch (error) {
      console.error("/chat/voice", error);

      res.status(500).json({
        ok: false,
        error: "تعذر رفع الملاحظة الصوتية",
      });
    }
  });

  // ==========================================================================
  // REPORT MESSAGE
  //
  // POST /chat/report
  // {
  //   sessionTicket,
  //   room,
  //   messageId,
  //   reason
  // }
  //
  // البلاغ يحفظ في PlayFab:
  // Title Internal Data -> LUXURY_CHAT_REPORTS
  // ==========================================================================

  app.post("/chat/report", async (req, res) => {
    try {
      const reporterId = await authenticateSessionTicket(
        req.body && req.body.sessionTicket
      );

      const roomId = cleanRoom(req.body && req.body.room);
      const messageId = safeString(
        req.body && req.body.messageId,
        100
      );

      if (!messageId) {
        return res.status(400).json({
          ok: false,
          error: "معرف الرسالة غير موجود",
        });
      }

      const room = await ensureRoomLoaded(roomId);

      if (pruneExpired(room)) {
        await enqueueRoomSave(roomId);
      }

      const message = findMessage(room, messageId);

      if (!message) {
        return res.status(404).json({
          ok: false,
          error: "الرسالة غير موجودة على السيرفر",
        });
      }

      if (message.senderId === reporterId) {
        return res.status(400).json({
          ok: false,
          error: "لا يمكنك الإبلاغ عن رسالتك",
        });
      }

      const result = await createReport(
        reporterId,
        roomId,
        message,
        req.body && req.body.reason
      );

      console.log("[LuxuryChat][REPORT]", {
        reportId: result.report.reportId,
        reporterId: result.report.reporterId,
        messageId: result.report.messageId,
        reportedSenderId: result.report.reportedSenderId,
        duplicate: result.duplicate,
      });

      res.json({
        ok: true,
        duplicate: result.duplicate,
        reportId: result.report.reportId,
        reportKey: REPORTS_KEY,
      });
    } catch (error) {
      console.error("/chat/report", error);

      res.status(500).json({
        ok: false,
        error: "تعذر إرسال البلاغ",
      });
    }
  });

  console.log("[LuxuryChat] installed", {
    persistentHistory: "Cloudinary raw JSON",
    retentionDays: RETENTION_DAYS,
    fetchLimit: MAX_FETCH_LIMIT,
    maxTextLength: MAX_TEXT_LENGTH,
    reportsKey: REPORTS_KEY,
  });
};
