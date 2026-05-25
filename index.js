const express = require("express");
const bcrypt = require("bcryptjs");

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

    if (!titleId || !secretKey)
        return { code: 0, error: "PLAYFAB ENV MISSING" };

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

    if (!text)
        return { code: res.status, error: "EMPTY_PLAYFAB_RESPONSE", url };

    try {
        return JSON.parse(text);
    } catch {
        return { code: res.status, error: "INVALID_JSON_FROM_PLAYFAB", raw: text, url };
    }
}

async function getGoogleUser(code, redirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret)
        return null;

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

    if (!tokenData.access_token)
        return null;

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + tokenData.access_token }
    });

    return await userRes.json();
}

function cleanEmail(email) {
    return String(email || "").trim().toLowerCase();
}

function cleanPassword(password) {
    return String(password || "").trim();
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
// كلمة مرور داخل اللعبة
// ===============================

app.post("/account/set-password", async (req, res) => {
    try {
        const playFabId = String(req.body.playFabId || "").trim();
        const email = cleanEmail(req.body.email);
        const password = cleanPassword(req.body.password);

        if (!playFabId || !email || !password) {
            return res.status(400).json({
                ok: false,
                message: "playFabId / email / password مطلوب"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                ok: false,
                message: "كلمة المرور لازم تكون 6 أحرف أو أكثر"
            });
        }

        const userData = await playFabPost("/Server/GetUserData", {
            PlayFabId: playFabId,
            Keys: [
                "google_email",
                "account_email",
                "account_email_verified",
                "account_status",
                "google_custom_id"
            ]
        });

        if (userData.code !== 200) {
            return res.status(500).json({
                ok: false,
                message: "فشل فحص الحساب"
            });
        }

        const data = userData.data && userData.data.Data ? userData.data.Data : {};

        const accountEmail =
            data.account_email && data.account_email.Value
                ? cleanEmail(data.account_email.Value)
                : "";

        const googleEmail =
            data.google_email && data.google_email.Value
                ? cleanEmail(data.google_email.Value)
                : "";

        const verified =
            data.account_email_verified &&
            data.account_email_verified.Value === "1";

        const official =
            data.account_status &&
            data.account_status.Value === "official";

        if (email !== accountEmail && email !== googleEmail) {
            return res.status(403).json({
                ok: false,
                message: "البريد لا يطابق الحساب"
            });
        }

        if (!verified || !official) {
            return res.status(403).json({
                ok: false,
                message: "الحساب غير موثق"
            });
        }

        const googleCustomId =
            data.google_custom_id && data.google_custom_id.Value
                ? String(data.google_custom_id.Value)
                : "";

        if (!googleCustomId) {
            return res.status(400).json({
                ok: false,
                message: "google_custom_id غير موجود"
            });
        }

        const hash = await bcrypt.hash(password, 12);

        await playFabPost("/Server/SetTitleInternalData", {
            Key: "email_password_hash_" + email,
            Value: hash
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: "email_password_playfab_" + email,
            Value: playFabId
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: "email_password_custom_" + email,
            Value: googleCustomId
        });

        return res.json({
            ok: true,
            message: "تم حفظ كلمة مرور اللعبة"
        });

    } catch (e) {
        console.log("SET PASSWORD ERROR:", e);
        return res.status(500).json({
            ok: false,
            message: "خطأ في السيرفر"
        });
    }
});

app.post("/account/login-email-password", async (req, res) => {
    try {
        const email = cleanEmail(req.body.email);
        const password = cleanPassword(req.body.password);

        if (!email || !password) {
            return res.status(400).json({
                ok: false,
                message: "email / password مطلوب"
            });
        }

        const hashKey = "email_password_hash_" + email;
        const playFabKey = "email_password_playfab_" + email;
        const customKey = "email_password_custom_" + email;

        const result = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [hashKey, playFabKey, customKey]
        });

        if (result.code !== 200) {
            return res.status(500).json({
                ok: false,
                message: "فشل فحص الحساب"
            });
        }

        const maps = result.data && result.data.Data ? result.data.Data : {};

        const passwordHash = maps[hashKey] || "";
        const playFabId = maps[playFabKey] || "";
        const customId = maps[customKey] || "";

        if (!passwordHash || !playFabId || !customId) {
            return res.status(404).json({
                ok: false,
                message: "هذا البريد لا يملك كلمة مرور لعبة"
            });
        }

        const match = await bcrypt.compare(password, passwordHash);

        if (!match) {
            return res.status(401).json({
                ok: false,
                message: "كلمة المرور غير صحيحة"
            });
        }

        return res.json({
            ok: true,
            email,
            playFabId,
            customId
        });

    } catch (e) {
        console.log("EMAIL PASSWORD LOGIN ERROR:", e);
        return res.status(500).json({
            ok: false,
            message: "خطأ في السيرفر"
        });
    }
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

        const email = cleanEmail(user.email);
        const googleId = String(user.id || "").trim();

        if (!email || !googleId) return res.send("فشل قراءة بيانات Google");

        const googleCustomId = "google_" + googleId;

        const googleIdMapKey = "google_id_map_" + googleId;
        const googleEmailMapKey = "google_email_map_" + email;
        const googleCustomMapKey = "google_custom_map_" + email;

        const checkMap = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [googleIdMapKey, googleEmailMapKey, googleCustomMapKey]
        });

        if (checkMap.code !== 200)
            return res.send("فشل فحص الربط: " + JSON.stringify(checkMap));

        const maps = checkMap.data && checkMap.data.Data ? checkMap.data.Data : {};

        if (maps[googleIdMapKey] && maps[googleIdMapKey] !== playFabId)
            return res.send("هذا Google مربوط بحساب آخر");

        if (maps[googleEmailMapKey] && maps[googleEmailMapKey] !== playFabId)
            return res.send("هذا البريد مربوط بحساب آخر");

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

        if (savePlayer.code !== 200)
            return res.send("فشل حفظ الربط: " + JSON.stringify(savePlayer));

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

        await playFabPost("/Server/SetTitleInternalData", {
            Key: "google_playfab_map_" + googleCustomId,
            Value: playFabId
        });

        return res.send(`
            <html>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>ارجع إلى اللعبة</h2>
                <p>سيتم تحديث البريد من داخل اللعبة</p>
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

        const email = cleanEmail(user.email);
        const googleId = String(user.id || "").trim();

        if (!email || !googleId) return res.send("فشل قراءة بيانات Google");

        const googleCustomId = "google_" + googleId;

        const emailMapKey = "google_email_map_" + email;
        const customMapKey = "google_custom_map_" + email;

        const mapResult = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [emailMapKey, customMapKey]
        });

        if (mapResult.code !== 200)
            return res.send("فشل فحص الحساب: " + JSON.stringify(mapResult));

        const maps = mapResult.data && mapResult.data.Data ? mapResult.data.Data : {};

        const playFabId = maps[emailMapKey];
        const savedCustomId = maps[customMapKey] || googleCustomId;

        if (!playFabId) {
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
            Key: customMapKey,
            Value: savedCustomId
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: "google_login_session_" + session,
            Value: JSON.stringify({
                ok: true,
                email: email,
                playFabId: playFabId,
                customId: savedCustomId
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
