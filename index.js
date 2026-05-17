const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Server is working 🔥");
});

app.get("/health", (req, res) => {
    res.status(200).json({
        ok: true,
        message: "server awake"
    });
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

app.get("/test-google-log", (req, res) => {
    console.log("TEST GOOGLE LOG WORKING");
    res.send("test ok");
});

app.get("/auth/google", (req, res) => {
    const playFabId = String(req.query.playFabId || "").trim();

    if (!playFabId) {
        return res.send("playFabId مفقود");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!clientId) {
        return res.send("GOOGLE_CLIENT_ID ناقص في Render");
    }

    const redirectUri = "https://my-server-i40i.onrender.com/auth/google/callback";

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

    console.log("GOOGLE LOGIN START:", playFabId);

    return res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
    try {
        console.log("GOOGLE CALLBACK HIT");
        console.log("QUERY:", req.query);

        const code = req.query.code;
        const playFabId = String(req.query.state || "").trim();

        if (!code || !playFabId) {
            return res.send("فشل تسجيل الدخول: بيانات ناقصة");
        }

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const titleId = process.env.PLAYFAB_TITLE_ID;
        const secretKey = process.env.PLAYFAB_SECRET_KEY;

        if (!clientId || !clientSecret || !titleId || !secretKey) {
            console.log("MISSING ENV", {
                clientId: !!clientId,
                clientSecret: !!clientSecret,
                titleId: !!titleId,
                secretKey: !!secretKey
            });
            return res.send("إعدادات السيرفر ناقصة");
        }

        const redirectUri = "https://my-server-i40i.onrender.com/auth/google/callback";

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body:
                "code=" + encodeURIComponent(code) +
                "&client_id=" + encodeURIComponent(clientId) +
                "&client_secret=" + encodeURIComponent(clientSecret) +
                "&redirect_uri=" + encodeURIComponent(redirectUri) +
                "&grant_type=authorization_code"
        });

        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.log("TOKEN ERROR:", JSON.stringify(tokenData));
            return res.send("فشل أخذ توكن Google");
        }

        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: {
                Authorization: "Bearer " + tokenData.access_token
            }
        });

        const user = await userRes.json();

        const email = String(user.email || "").trim().toLowerCase();
        const googleId = String(user.id || "").trim();

        console.log("GOOGLE USER:", JSON.stringify({ email, googleId, playFabId }));

        if (!email || !googleId) {
            return res.send("فشل قراءة بيانات Google");
        }

        const googleIdMapKey = "google_id_map_" + googleId;
        const googleEmailMapKey = "google_email_map_" + email;

        const playerDataRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/GetUserData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    PlayFabId: playFabId,
                    Keys: [
                        "google_linked",
                        "google_email",
                        "google_id",
                        "account_email",
                        "account_email_verified",
                        "account_status"
                    ]
                })
            }
        );

        const playerData = await playerDataRes.json();
        console.log("PLAYER DATA FULL:", JSON.stringify(playerData));

        if (playerData.code !== 200) {
            return res.send("فشل فحص بيانات اللاعب: " + JSON.stringify(playerData));
        }

        const userData =
            playerData.data && playerData.data.Data
                ? playerData.data.Data
                : {};

        const oldEmail =
            userData.account_email && userData.account_email.Value
                ? String(userData.account_email.Value).trim().toLowerCase()
                : "";

        const oldGoogleLinked =
            userData.google_linked &&
            userData.google_linked.Value === "true";

        if (oldGoogleLinked || oldEmail) {
            return res.send("هذا الحساب مربوط مسبقاً ببريد: " + oldEmail);
        }

        const checkMapRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/GetTitleInternalData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    Keys: [googleIdMapKey, googleEmailMapKey]
                })
            }
        );

        const checkMapData = await checkMapRes.json();
        console.log("CHECK MAP FULL:", JSON.stringify(checkMapData));

        if (checkMapData.code !== 200) {
            return res.send("فشل فحص الحساب من PlayFab");
        }

        const maps =
            checkMapData.data && checkMapData.data.Data
                ? checkMapData.data.Data
                : {};

        if (maps[googleIdMapKey]) {
            return res.send("هذا حساب Google مستخدم مسبقاً");
        }

        if (maps[googleEmailMapKey]) {
            return res.send("هذا البريد مستخدم مسبقاً");
        }

        const savePlayerRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/UpdateUserData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    PlayFabId: playFabId,
                    Data: {
                        google_email: email,
                        google_id: googleId,
                        google_linked: "true",
                        account_email: email,
                        account_email_verified: "1",
                        account_status: "official",
                        login_provider: "google"
                    }
                })
            }
        );

        const savePlayerData = await savePlayerRes.json();
        console.log("SAVE PLAYER FULL:", JSON.stringify(savePlayerData));

        if (savePlayerData.code !== 200) {
            return res.send("فشل حفظ الحساب في PlayFab");
        }

        const saveGoogleIdMapRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/SetTitleInternalData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    Key: googleIdMapKey,
                    Value: playFabId
                })
            }
        );

        const saveEmailMapRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/SetTitleInternalData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    Key: googleEmailMapKey,
                    Value: playFabId
                })
            }
        );

        const saveGoogleIdMapData = await saveGoogleIdMapRes.json();
        const saveEmailMapData = await saveEmailMapRes.json();

        console.log("SAVE GOOGLE ID MAP:", JSON.stringify(saveGoogleIdMapData));
        console.log("SAVE EMAIL MAP:", JSON.stringify(saveEmailMapData));

        if (saveGoogleIdMapData.code !== 200 || saveEmailMapData.code !== 200) {
            return res.send("تم حفظ البريد لكن فشل حفظ منع التكرار");
        }

        return res.send(`
            <html>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>تم ربط حساب Google بنجاح ✅</h2>
                <p>${email}</p>
                <p>ارجع إلى اللعبة</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.log("CALLBACK ERROR:", e);
        return res.send("حدث خطأ في السيرفر");
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
