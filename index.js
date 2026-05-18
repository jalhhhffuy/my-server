const express = require("express");

const app = express();
app.use(express.json());

const SERVER_URL = "https://my-server-i40i.onrender.com";
const GAME_DEEP_LINK = "pirateclash://google-login-success";

function getPlayFabConfig() {
    return {
        titleId: process.env.PLAYFAB_TITLE_ID,
        secretKey: process.env.PLAYFAB_SECRET_KEY
    };
}

async function playFabPost(path, body) {
    const { titleId, secretKey } = getPlayFabConfig();

    if (!titleId || !secretKey) {
        return { code: 0, error: "PLAYFAB ENV MISSING" };
    }

    const url = "https://" + titleId + ".playfabapi.com" + path;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-SecretKey": secretKey
        },
        body: JSON.stringify(body)
    });

    const text = await res.text();

    if (!text) {
        return { code: res.status, error: "EMPTY_PLAYFAB_RESPONSE", url: url };
    }

    try {
        return JSON.parse(text);
    } catch {
        return { code: res.status, error: "INVALID_JSON_FROM_PLAYFAB", raw: text, url: url };
    }
}

async function getGoogleUser(code, redirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.log("GOOGLE ENV MISSING");
        return null;
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
            "code=" + encodeURIComponent(code) +
            "&client_id=" + encodeURIComponent(clientId) +
            "&client_secret=" + encodeURIComponent(clientSecret) +
            "&redirect_uri=" + encodeURIComponent(redirectUri) +
            "&grant_type=authorization_code"
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
        console.log("TOKEN ERROR:", tokenData);
        return null;
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + tokenData.access_token }
    });

    return await userRes.json();
}

app.get("/", (req, res) => {
    res.send("Server is working 🔥");
});

app.get("/health", (req, res) => {
    res.json({ ok: true, message: "server awake" });
});

app.post("/guest", (req, res) => {
    const installId = req.body.installId;

    if (!installId) {
        return res.status(400).json({
            success: false,
            message: "installId required"
        });
    }

    return res.json({
        success: true,
        playerId: "guest_" + installId
    });
});

// ===============================
// ربط Google بحساب اللاعب الحالي
// ===============================

app.get("/auth/google", (req, res) => {
    const playFabId = String(req.query.playFabId || "").trim();

    if (!playFabId) return res.send("playFabId مفقود");

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.send("GOOGLE_CLIENT_ID ناقص");

    const redirectUri = SERVER_URL + "/auth/google/callback";

    const scope =
        "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

    const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        "?client_id=" + encodeURIComponent(clientId) +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&response_type=code" +
        "&scope=" + encodeURIComponent(scope) +
        "&state=" + encodeURIComponent(playFabId) +
        "&prompt=select_account";

    return res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
    try {
        const code = req.query.code;
        const playFabId = String(req.query.state || "").trim();

        if (!code || !playFabId) return res.send("فشل الربط: بيانات ناقصة");

        const redirectUri = SERVER_URL + "/auth/google/callback";
        const user = await getGoogleUser(code, redirectUri);

        if (!user) return res.send("فشل أخذ توكن Google");

        const email = String(user.email || "").trim().toLowerCase();
        const googleId = String(user.id || "").trim();

        if (!email || !googleId) return res.send("فشل قراءة بيانات Google");

        const googleCustomId = "google_" + googleId;
        const googleIdMapKey = "google_id_map_" + googleId;
        const googleEmailMapKey = "google_email_map_" + email;
        const googleCustomMapKey = "google_custom_map_" + email;

        const checkMap = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [googleIdMapKey, googleEmailMapKey]
        });

        const maps =
            checkMap.data && checkMap.data.Data
                ? checkMap.data.Data
                : {};

        if (maps[googleIdMapKey] && maps[googleIdMapKey] !== playFabId) {
            return res.send("هذا Google مربوط بحساب آخر");
        }

        if (maps[googleEmailMapKey] && maps[googleEmailMapKey] !== playFabId) {
            return res.send("هذا البريد مربوط بحساب آخر");
        }

        const savePlayer = await playFabPost("/Server/UpdateUserData", {
            PlayFabId: playFabId,
            Data: {
                google_email: email,
                google_id: googleId,
                google_custom_id: googleCustomId,
                google_linked: "true",
                account_email: email,
                account_email_verified: "1",
                account_status: "official",
                login_provider: "google"
            }
        });

        if (savePlayer.code !== 200) {
            console.log("SAVE PLAYER ERROR:", JSON.stringify(savePlayer));
            return res.send("فشل حفظ الربط");
        }

        await playFabPost("/Server/SetTitleInternalData", {
            Key: googleIdMapKey,
            Value: playFabId
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: googleEmailMapKey,
            Value: playFabId
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: googleCustomMapKey,
            Value: googleCustomId
        });

        return res.send(`
            <html>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>تم ربط Google بنجاح ✅</h2>
                <p>${email}</p>
                <p>ارجع إلى اللعبة</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.log("GOOGLE LINK ERROR:", e);
        return res.send("حدث خطأ في السيرفر");
    }
});

// ===============================
// تسجيل دخول Google من شاشة Login
// ===============================

app.get("/auth/google/login", (req, res) => {
    const session = String(req.query.session || "").trim();

    if (!session) return res.send("session مفقود");

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.send("GOOGLE_CLIENT_ID ناقص");

    const redirectUri = SERVER_URL + "/auth/google/login/callback";

    const scope =
        "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

    const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        "?client_id=" + encodeURIComponent(clientId) +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&response_type=code" +
        "&scope=" + encodeURIComponent(scope) +
        "&state=" + encodeURIComponent(session) +
        "&prompt=select_account";

    return res.redirect(authUrl);
});

app.get("/auth/google/login/callback", async (req, res) => {
    try {
        const code = req.query.code;
        const session = String(req.query.state || "").trim();

        if (!code || !session) return res.send("فشل تسجيل الدخول: بيانات ناقصة");

        const redirectUri = SERVER_URL + "/auth/google/login/callback";
        const user = await getGoogleUser(code, redirectUri);

        if (!user) return res.send("فشل تسجيل Google");

        const email = String(user.email || "").trim().toLowerCase();

        if (!email) return res.send("فشل قراءة البريد");

        const emailMapKey = "google_email_map_" + email;
        const customMapKey = "google_custom_map_" + email;

        const mapResult = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [emailMapKey, customMapKey]
        });

        const maps =
            mapResult.data && mapResult.data.Data
                ? mapResult.data.Data
                : {};

        const playFabId = maps[emailMapKey];
        const googleCustomId = maps[customMapKey];

        if (!playFabId || !googleCustomId) {
            await playFabPost("/Server/SetTitleInternalData", {
                Key: "google_login_session_" + session,
                Value: JSON.stringify({
                    ok: false,
                    message: "هذا البريد غير مربوط بحساب",
                    email: email
                })
            });

            return res.send(`
                <html>
                <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                    <h2>هذا البريد غير مربوط بحساب ❌</h2>
                    <p>${email}</p>
                    <p>ارجع إلى اللعبة</p>
                </body>
                </html>
            `);
        }

        await playFabPost("/Server/SetTitleInternalData", {
            Key: "google_login_session_" + session,
            Value: JSON.stringify({
                ok: true,
                email: email,
                playFabId: playFabId,
                customId: googleCustomId
            })
        });

        return res.send(`
            <html>
            <head>
                <meta charset="UTF-8">
                <script>
                    setTimeout(function () {
                        window.location.href = "${GAME_DEEP_LINK}";
                    }, 1500);
                </script>
            </head>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>تم تسجيل الدخول بنجاح ✅</h2>
                <p>${email}</p>
                <p>جاري الرجوع إلى اللعبة...</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.log("GOOGLE LOGIN ERROR:", e);
        return res.send("حدث خطأ أثناء تسجيل الدخول");
    }
});

app.get("/auth/google/login/status", async (req, res) => {
    const session = String(req.query.session || "").trim();

    if (!session) {
        return res.json({
            ok: false,
            done: false,
            message: "session مفقود"
        });
    }

    const key = "google_login_session_" + session;

    const result = await playFabPost("/Server/GetTitleInternalData", {
        Keys: [key]
    });

    const raw =
        result.data &&
        result.data.Data &&
        result.data.Data[key]
            ? result.data.Data[key]
            : "";

    if (!raw) {
        return res.json({
            ok: false,
            done: false,
            message: "انتظار تسجيل Google"
        });
    }

    try {
        const data = JSON.parse(raw);
        data.done = true;
        return res.json(data);
    } catch {
        return res.json({
            ok: false,
            done: true,
            message: "رد غير صالح"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
