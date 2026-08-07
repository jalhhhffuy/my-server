 const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.use(express.json());

const SERVER_URL =
    "https://my-server-i40i.onrender.com";

const GAME_DEEP_LINK =
    "pirateclash://google-login-success";


// =====================================================
// Cloudinary
// =====================================================

cloudinary.config({
    cloud_name:
        process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
        process.env.CLOUDINARY_API_KEY,

    api_secret:
        process.env.CLOUDINARY_API_SECRET,

    secure: true
});


// =====================================================
// Luxury Global Chat
// =====================================================

const installLuxuryChat =
    require("./luxury-chat-server");

installLuxuryChat(
    app,
    cloudinary
);


// =====================================================
// Avatar Upload Configuration
// =====================================================

const avatarUpload = multer({
    storage:
        multer.memoryStorage(),

    limits: {
        fileSize:
            4 * 1024 * 1024
    },

    fileFilter: (
        req,
        file,
        callback
    ) => {
        const allowedTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp"
        ];

        if (
            !file ||
            !allowedTypes.includes(
                file.mimetype
            )
        ) {
            return callback(
                new Error(
                    "ÙÙØ¹ Ø§ÙØµÙØ±Ø© ØºÙØ± ÙØ¯Ø¹ÙÙ"
                )
            );
        }

        callback(null, true);
    }
});


// =====================================================
// PlayFab Configuration
// =====================================================

function getPlayFabConfig() {
    return {
        titleId:
            process.env.PLAYFAB_TITLE_ID,

        secretKey:
            process.env.PLAYFAB_SECRET_KEY
    };
}


// =====================================================
// PlayFab Server Request
// =====================================================

async function playFabPost(
    path,
    body
) {
    const {
        titleId,
        secretKey
    } = getPlayFabConfig();

    if (!titleId || !secretKey) {
        return {
            code: 0,
            error:
                "PLAYFAB ENV MISSING"
        };
    }

    const url =
        "https://" +
        titleId +
        ".playfabapi.com" +
        path;

    try {
        const response =
            await fetch(
                url,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "X-SecretKey":
                            secretKey
                    },

                    body:
                        JSON.stringify(
                            body
                        )
                }
            );

        const text =
            await response.text();

        if (!text) {
            return {
                code:
                    response.status,

                error:
                    "EMPTY_PLAYFAB_RESPONSE",

                url
            };
        }

        try {
            return JSON.parse(
                text
            );
        }
        catch {
            return {
                code:
                    response.status,

                error:
                    "INVALID_JSON_FROM_PLAYFAB",

                raw:
                    text,

                url
            };
        }
    }
    catch (error) {
        return {
            code: 0,

            error:
                "PLAYFAB_REQUEST_FAILED",

            message:
                error.message,

            url
        };
    }
}


// =====================================================
// Verify PlayFab Session Ticket
// =====================================================

async function authenticatePlayFabSession(
    sessionTicket
) {
    if (!sessionTicket) {
        return {
            success: false,

            message:
                "SessionTicket ØºÙØ± ÙÙØ¬ÙØ¯"
        };
    }

    const result =
        await playFabPost(
            "/Server/AuthenticateSessionTicket",
            {
                SessionTicket:
                    sessionTicket
            }
        );

    if (
        result.code !== 200 ||
        !result.data ||
        !result.data.UserInfo ||
        !result.data.UserInfo.PlayFabId
    ) {
        return {
            success: false,

            message:
                "Ø¬ÙØ³Ø© PlayFab ØºÙØ± ØµØ§ÙØ­Ø©",

            details:
                result
        };
    }

    return {
        success: true,

        playFabId:
            result.data
                .UserInfo
                .PlayFabId
    };
}


// =====================================================
// Google User
// =====================================================

async function getGoogleUser(
    code,
    redirectUri
) {
    const clientId =
        process.env.GOOGLE_CLIENT_ID;

    const clientSecret =
        process.env.GOOGLE_CLIENT_SECRET;

    if (
        !clientId ||
        !clientSecret
    ) {
        return null;
    }

    const tokenRes =
        await fetch(
            "https://oauth2.googleapis.com/token",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },

                body:
                    "code=" +
                    encodeURIComponent(code) +

                    "&client_id=" +
                    encodeURIComponent(
                        clientId
                    ) +

                    "&client_secret=" +
                    encodeURIComponent(
                        clientSecret
                    ) +

                    "&redirect_uri=" +
                    encodeURIComponent(
                        redirectUri
                    ) +

                    "&grant_type=authorization_code"
            }
        );

    const tokenData =
        await tokenRes.json();

    if (!tokenData.access_token) {
        return null;
    }

    const userRes =
        await fetch(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            {
                headers: {
                    Authorization:
                        "Bearer " +
                        tokenData.access_token
                }
            }
        );

    return await userRes.json();
}


// =====================================================
// Clean Helpers
// =====================================================

function cleanEmail(email) {
    return String(
        email || ""
    )
        .trim()
        .toLowerCase();
}

function cleanPassword(password) {
    return String(
        password || ""
    ).trim();
}


// =====================================================
// Root
// =====================================================

app.get(
    "/",
    (req, res) => {
        res.send(
            "Server is working ð¥"
        );
    }
);


// =====================================================
// Health
// =====================================================

app.get(
    "/health",
    (req, res) => {
        res.json({
            ok: true,

            message:
                "server awake"
        });
    }
);


// =====================================================
// Guest
// =====================================================

app.post(
    "/guest",
    (req, res) => {
        const installId =
            req.body.installId;

        if (!installId) {
            return res
                .status(400)
                .json({
                    success: false,

                    message:
                        "installId required"
                });
        }

        return res.json({
            success: true,

            playerId:
                "guest_" +
                installId
        });
    }
);


// =====================================================
// ÙÙÙØ© ÙØ±ÙØ± Ø¯Ø§Ø®Ù Ø§ÙÙØ¹Ø¨Ø©
// =====================================================

app.post(
    "/account/set-password",
    async (req, res) => {
        try {
            const playFabId =
                String(
                    req.body.playFabId ||
                    ""
                ).trim();

            const email =
                cleanEmail(
                    req.body.email
                );

            const password =
                cleanPassword(
                    req.body.password
                );

            if (
                !playFabId ||
                !email ||
                !password
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        message:
                            "playFabId / email / password ÙØ·ÙÙØ¨"
                    });
            }

            if (
                password.length < 6
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        message:
                            "ÙÙÙØ© Ø§ÙÙØ±ÙØ± ÙØ§Ø²Ù ØªÙÙÙ 6 Ø£Ø­Ø±Ù Ø£Ù Ø£ÙØ«Ø±"
                    });
            }

            const userData =
                await playFabPost(
                    "/Server/GetUserData",
                    {
                        PlayFabId:
                            playFabId,

                        Keys: [
                            "google_email",
                            "account_email",
                            "account_email_verified",
                            "account_status",
                            "google_custom_id"
                        ]
                    }
                );

            if (
                userData.code !== 200
            ) {
                return res
                    .status(500)
                    .json({
                        ok: false,

                        message:
                            "ÙØ´Ù ÙØ­Øµ Ø§ÙØ­Ø³Ø§Ø¨"
                    });
            }

            const data =
                userData.data &&
                userData.data.Data
                    ? userData.data.Data
                    : {};

            const accountEmail =
                data.account_email &&
                data.account_email.Value
                    ? cleanEmail(
                        data.account_email
                            .Value
                    )
                    : "";

            const googleEmail =
                data.google_email &&
                data.google_email.Value
                    ? cleanEmail(
                        data.google_email
                            .Value
                    )
                    : "";

            const verified =
                data.account_email_verified &&
                data.account_email_verified
                    .Value === "1";

            const official =
                data.account_status &&
                data.account_status.Value ===
                    "official";

            if (
                email !== accountEmail &&
                email !== googleEmail
            ) {
                return res
                    .status(403)
                    .json({
                        ok: false,

                        message:
                            "Ø§ÙØ¨Ø±ÙØ¯ ÙØ§ ÙØ·Ø§Ø¨Ù Ø§ÙØ­Ø³Ø§Ø¨"
                    });
            }

            if (
                !verified ||
                !official
            ) {
                return res
                    .status(403)
                    .json({
                        ok: false,

                        message:
                            "Ø§ÙØ­Ø³Ø§Ø¨ ØºÙØ± ÙÙØ«Ù"
                    });
            }

            const googleCustomId =
                data.google_custom_id &&
                data.google_custom_id.Value
                    ? String(
                        data.google_custom_id
                            .Value
                    )
                    : "";

            if (!googleCustomId) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        message:
                            "google_custom_id ØºÙØ± ÙÙØ¬ÙØ¯"
                    });
            }

            const hash =
                await bcrypt.hash(
                    password,
                    12
                );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        "email_password_hash_" +
                        email,

                    Value:
                        hash
                }
            );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        "email_password_playfab_" +
                        email,

                    Value:
                        playFabId
                }
            );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        "email_password_custom_" +
                        email,

                    Value:
                        googleCustomId
                }
            );

            return res.json({
                ok: true,

                message:
                    "ØªÙ Ø­ÙØ¸ ÙÙÙØ© ÙØ±ÙØ± Ø§ÙÙØ¹Ø¨Ø©"
            });
        }
        catch (error) {
            console.log(
                "SET PASSWORD ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    ok: false,

                    message:
                        "Ø®Ø·Ø£ ÙÙ Ø§ÙØ³ÙØ±ÙØ±"
                });
        }
    }
);


// =====================================================
// Login With Email Password
// =====================================================

app.post(
    "/account/login-email-password",
    async (req, res) => {
        try {
            const email =
                cleanEmail(
                    req.body.email
                );

            const password =
                cleanPassword(
                    req.body.password
                );

            if (
                !email ||
                !password
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        message:
                            "email / password ÙØ·ÙÙØ¨"
                    });
            }

            const hashKey =
                "email_password_hash_" +
                email;

            const playFabKey =
                "email_password_playfab_" +
                email;

            const customKey =
                "email_password_custom_" +
                email;

            const result =
                await playFabPost(
                    "/Server/GetTitleInternalData",
                    {
                        Keys: [
                            hashKey,
                            playFabKey,
                            customKey
                        ]
                    }
                );

            if (
                result.code !== 200
            ) {
                return res
                    .status(500)
                    .json({
                        ok: false,

                        message:
                            "ÙØ´Ù ÙØ­Øµ Ø§ÙØ­Ø³Ø§Ø¨"
                    });
            }

            const maps =
                result.data &&
                result.data.Data
                    ? result.data.Data
                    : {};

            const passwordHash =
                maps[hashKey] || "";

            const playFabId =
                maps[playFabKey] || "";

            const customId =
                maps[customKey] || "";

            if (
                !passwordHash ||
                !playFabId ||
                !customId
            ) {
                return res
                    .status(404)
                    .json({
                        ok: false,

                        message:
                            "ÙØ°Ø§ Ø§ÙØ¨Ø±ÙØ¯ ÙØ§ ÙÙÙÙ ÙÙÙØ© ÙØ±ÙØ± ÙØ¹Ø¨Ø©"
                    });
            }

            const match =
                await bcrypt.compare(
                    password,
                    passwordHash
                );

            if (!match) {
                return res
                    .status(401)
                    .json({
                        ok: false,

                        message:
                            "ÙÙÙØ© Ø§ÙÙØ±ÙØ± ØºÙØ± ØµØ­ÙØ­Ø©"
                    });
            }

            return res.json({
                ok: true,

                email,

                playFabId,

                customId
            });
        }
        catch (error) {
            console.log(
                "EMAIL PASSWORD LOGIN ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    ok: false,

                    message:
                        "Ø®Ø·Ø£ ÙÙ Ø§ÙØ³ÙØ±ÙØ±"
                });
        }
    }
);


// =====================================================
// Ø±Ø¨Ø· Google Ø¨Ø­Ø³Ø§Ø¨ Ø§ÙÙØ§Ø¹Ø¨ Ø§ÙØ­Ø§ÙÙ
// =====================================================

app.get(
    "/auth/google",
    (req, res) => {
        const playFabId =
            String(
                req.query.playFabId ||
                ""
            ).trim();

        if (!playFabId) {
            return res.send(
                "playFabId ÙÙÙÙØ¯"
            );
        }

        const clientId =
            process.env
                .GOOGLE_CLIENT_ID;

        if (!clientId) {
            return res.send(
                "GOOGLE_CLIENT_ID ÙØ§ÙØµ"
            );
        }

        const redirectUri =
            SERVER_URL +
            "/auth/google/callback";

        const scope =
            "https://www.googleapis.com/auth/userinfo.email " +
            "https://www.googleapis.com/auth/userinfo.profile";

        const authUrl =
            "https://accounts.google.com/o/oauth2/v2/auth" +
            "?client_id=" +
            encodeURIComponent(
                clientId
            ) +
            "&redirect_uri=" +
            encodeURIComponent(
                redirectUri
            ) +
            "&response_type=code" +
            "&scope=" +
            encodeURIComponent(
                scope
            ) +
            "&state=" +
            encodeURIComponent(
                playFabId
            ) +
            "&prompt=select_account";

        return res.redirect(
            authUrl
        );
    }
);


app.get(
    "/auth/google/callback",
    async (req, res) => {
        try {
            const code =
                req.query.code;

            const playFabId =
                String(
                    req.query.state ||
                    ""
                ).trim();

            if (
                !code ||
                !playFabId
            ) {
                return res.send(
                    "ÙØ´Ù Ø§ÙØ±Ø¨Ø·: Ø¨ÙØ§ÙØ§Øª ÙØ§ÙØµØ©"
                );
            }

            const redirectUri =
                SERVER_URL +
                "/auth/google/callback";

            const user =
                await getGoogleUser(
                    code,
                    redirectUri
                );

            if (!user) {
                return res.send(
                    "ÙØ´Ù Ø£Ø®Ø° ØªÙÙÙ Google"
                );
            }

            const email =
                cleanEmail(
                    user.email
                );

            const googleId =
                String(
                    user.id || ""
                ).trim();

            if (
                !email ||
                !googleId
            ) {
                return res.send(
                    "ÙØ´Ù ÙØ±Ø§Ø¡Ø© Ø¨ÙØ§ÙØ§Øª Google"
                );
            }

            const googleCustomId =
                "google_" +
                googleId;

            const googleIdMapKey =
                "google_id_map_" +
                googleId;

            const googleEmailMapKey =
                "google_email_map_" +
                email;

            const googleCustomMapKey =
                "google_custom_map_" +
                email;

            const checkMap =
                await playFabPost(
                    "/Server/GetTitleInternalData",
                    {
                        Keys: [
                            googleIdMapKey,
                            googleEmailMapKey,
                            googleCustomMapKey
                        ]
                    }
                );

            if (
                checkMap.code !== 200
            ) {
                return res.send(
                    "ÙØ´Ù ÙØ­Øµ Ø§ÙØ±Ø¨Ø·: " +
                    JSON.stringify(
                        checkMap
                    )
                );
            }

            const maps =
                checkMap.data &&
                checkMap.data.Data
                    ? checkMap.data.Data
                    : {};

            if (
                maps[googleIdMapKey] &&
                maps[googleIdMapKey] !==
                    playFabId
            ) {
                return res.send(
                    "ÙØ°Ø§ Google ÙØ±Ø¨ÙØ· Ø¨Ø­Ø³Ø§Ø¨ Ø¢Ø®Ø±"
                );
            }

            if (
                maps[googleEmailMapKey] &&
                maps[googleEmailMapKey] !==
                    playFabId
            ) {
                return res.send(
                    "ÙØ°Ø§ Ø§ÙØ¨Ø±ÙØ¯ ÙØ±Ø¨ÙØ· Ø¨Ø­Ø³Ø§Ø¨ Ø¢Ø®Ø±"
                );
            }

            const savePlayer =
                await playFabPost(
                    "/Server/UpdateUserData",
                    {
                        PlayFabId:
                            playFabId,

                        Data: {
                            google_email:
                                email,

                            google_id:
                                googleId,

                            google_custom_id:
                                googleCustomId,

                            google_linked:
                                "true",

                            account_email:
                                email,

                            account_email_verified:
                                "1",

                            account_status:
                                "official",

                            login_provider:
                                "google"
                        }
                    }
                );

            if (
                savePlayer.code !== 200
            ) {
                return res.send(
                    "ÙØ´Ù Ø­ÙØ¸ Ø§ÙØ±Ø¨Ø·: " +
                    JSON.stringify(
                        savePlayer
                    )
                );
            }

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        googleIdMapKey,

                    Value:
                        playFabId
                }
            );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        googleEmailMapKey,

                    Value:
                        playFabId
                }
            );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        googleCustomMapKey,

                    Value:
                        googleCustomId
                }
            );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        "google_playfab_map_" +
                        googleCustomId,

                    Value:
                        playFabId
                }
            );

            return res.send(`
                <html>
                <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                    <h2>Ø§Ø±Ø¬Ø¹ Ø¥ÙÙ Ø§ÙÙØ¹Ø¨Ø©</h2>
                    <p>Ø³ÙØªÙ ØªØ­Ø¯ÙØ« Ø§ÙØ¨Ø±ÙØ¯ ÙÙ Ø¯Ø§Ø®Ù Ø§ÙÙØ¹Ø¨Ø©</p>
                </body>
                </html>
            `);
        }
        catch (error) {
            console.log(
                "GOOGLE LINK ERROR:",
                error
            );

            return res.send(
                "Ø­Ø¯Ø« Ø®Ø·Ø£ ÙÙ Ø§ÙØ³ÙØ±ÙØ±"
            );
        }
    }
);


// =====================================================
// ØªØ³Ø¬ÙÙ Ø¯Ø®ÙÙ Google ÙÙ Ø´Ø§Ø´Ø© Login
// =====================================================

app.get(
    "/auth/google/login",
    (req, res) => {
        const session =
            String(
                req.query.session ||
                ""
            ).trim();

        if (!session) {
            return res.send(
                "session ÙÙÙÙØ¯"
            );
        }

        const clientId =
            process.env
                .GOOGLE_CLIENT_ID;

        if (!clientId) {
            return res.send(
                "GOOGLE_CLIENT_ID ÙØ§ÙØµ"
            );
        }

        const redirectUri =
            SERVER_URL +
            "/auth/google/login/callback";

        const scope =
            "https://www.googleapis.com/auth/userinfo.email " +
            "https://www.googleapis.com/auth/userinfo.profile";

        const authUrl =
            "https://accounts.google.com/o/oauth2/v2/auth" +
            "?client_id=" +
            encodeURIComponent(
                clientId
            ) +
            "&redirect_uri=" +
            encodeURIComponent(
                redirectUri
            ) +
            "&response_type=code" +
            "&scope=" +
            encodeURIComponent(
                scope
            ) +
            "&state=" +
            encodeURIComponent(
                session
            ) +
            "&prompt=select_account";

        return res.redirect(
            authUrl
        );
    }
);


app.get(
    "/auth/google/login/callback",
    async (req, res) => {
        try {
            const code =
                req.query.code;

            const session =
                String(
                    req.query.state ||
                    ""
                ).trim();

            if (
                !code ||
                !session
            ) {
                return res.send(
                    "ÙØ´Ù ØªØ³Ø¬ÙÙ Ø§ÙØ¯Ø®ÙÙ: Ø¨ÙØ§ÙØ§Øª ÙØ§ÙØµØ©"
                );
            }

            const redirectUri =
                SERVER_URL +
                "/auth/google/login/callback";

            const user =
                await getGoogleUser(
                    code,
                    redirectUri
                );

            if (!user) {
                return res.send(
                    "ÙØ´Ù ØªØ³Ø¬ÙÙ Google"
                );
            }

            const email =
                cleanEmail(
                    user.email
                );

            const googleId =
                String(
                    user.id || ""
                ).trim();

            if (
                !email ||
                !googleId
            ) {
                return res.send(
                    "ÙØ´Ù ÙØ±Ø§Ø¡Ø© Ø¨ÙØ§ÙØ§Øª Google"
                );
            }

            const googleCustomId =
                "google_" +
                googleId;

            const emailMapKey =
                "google_email_map_" +
                email;

            const customMapKey =
                "google_custom_map_" +
                email;

            const mapResult =
                await playFabPost(
                    "/Server/GetTitleInternalData",
                    {
                        Keys: [
                            emailMapKey,
                            customMapKey
                        ]
                    }
                );

            if (
                mapResult.code !== 200
            ) {
                return res.send(
                    "ÙØ´Ù ÙØ­Øµ Ø§ÙØ­Ø³Ø§Ø¨: " +
                    JSON.stringify(
                        mapResult
                    )
                );
            }

            const maps =
                mapResult.data &&
                mapResult.data.Data
                    ? mapResult.data.Data
                    : {};

            const playFabId =
                maps[emailMapKey];

            const savedCustomId =
                maps[customMapKey] ||
                googleCustomId;

            if (!playFabId) {
                await playFabPost(
                    "/Server/SetTitleInternalData",
                    {
                        Key:
                            "google_login_session_" +
                            session,

                        Value:
                            JSON.stringify({
                                ok: false,

                                message:
                                    "ÙØ°Ø§ Ø§ÙØ¨Ø±ÙØ¯ ØºÙØ± ÙØ±Ø¨ÙØ· Ø¨Ø­Ø³Ø§Ø¨",

                                email:
                                    email
                            })
                    }
                );

                return res.send(`
                    <html>
                    <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                        <h2>ÙØ°Ø§ Ø§ÙØ¨Ø±ÙØ¯ ØºÙØ± ÙØ±Ø¨ÙØ· Ø¨Ø­Ø³Ø§Ø¨ â</h2>
                        <p>${email}</p>
                        <p>Ø§Ø±Ø¬Ø¹ Ø¥ÙÙ Ø§ÙÙØ¹Ø¨Ø©</p>
                    </body>
                    </html>
                `);
            }

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        customMapKey,

                    Value:
                        savedCustomId
                }
            );

            await playFabPost(
                "/Server/SetTitleInternalData",
                {
                    Key:
                        "google_login_session_" +
                        session,

                    Value:
                        JSON.stringify({
                            ok: true,

                            email:
                                email,

                            playFabId:
                                playFabId,

                            customId:
                                savedCustomId
                        })
                }
            );

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
                    <h2>ØªÙ ØªØ³Ø¬ÙÙ Ø§ÙØ¯Ø®ÙÙ Ø¨ÙØ¬Ø§Ø­ â</h2>
                    <p>${email}</p>
                    <p>Ø¬Ø§Ø±Ù Ø§ÙØ±Ø¬ÙØ¹ Ø¥ÙÙ Ø§ÙÙØ¹Ø¨Ø©...</p>
                </body>
                </html>
            `);
        }
        catch (error) {
            console.log(
                "GOOGLE LOGIN ERROR:",
                error
            );

            return res.send(
                "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«ÙØ§Ø¡ ØªØ³Ø¬ÙÙ Ø§ÙØ¯Ø®ÙÙ"
            );
        }
    }
);


// =====================================================
// Google Login Status
// =====================================================

app.get(
    "/auth/google/login/status",
    async (req, res) => {
        const session =
            String(
                req.query.session ||
                ""
            ).trim();

        if (!session) {
            return res.json({
                ok: false,

                done: false,

                message:
                    "session ÙÙÙÙØ¯"
            });
        }

        const key =
            "google_login_session_" +
            session;

        const result =
            await playFabPost(
                "/Server/GetTitleInternalData",
                {
                    Keys: [
                        key
                    ]
                }
            );

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

                message:
                    "Ø§ÙØªØ¸Ø§Ø± ØªØ³Ø¬ÙÙ Google"
            });
        }

        try {
            const data =
                JSON.parse(raw);

            data.done = true;

            return res.json(
                data
            );
        }
        catch {
            return res.json({
                ok: false,

                done: true,

                message:
                    "Ø±Ø¯ ØºÙØ± ØµØ§ÙØ­"
            });
        }
    }
);


// =====================================================
// Ø±ÙØ¹ Ø§ÙØµÙØ±Ø© Ø§ÙØ´Ø®ØµÙØ© ÙØ¤ÙØªÙØ§ ÙÙØ·
//
// POST /upload-avatar
//
// ÙÙÙ:
// - ÙØªØ­ÙÙ ÙÙ Ø¬ÙØ³Ø© PlayFab.
// - ÙØ±ÙØ¹ Ø§ÙØµÙØ±Ø© Ø¥ÙÙ Cloudinary ÙÙØ·.
// - ÙØ§ ÙØ­ÙØ¸ Ø±Ø§Ø¨Ø· Ø§ÙØµÙØ±Ø© ÙÙ PlayFab.
// - ÙØ§ ÙØ³ØªØ¯Ø¹Ù UpdateAvatarUrl.
// - ÙØ§ ÙØ³ØªØ¯Ø¹Ù UpdateUserData.
// - Ø§ÙØ­ÙØ¸ Ø§ÙØ±Ø³ÙÙ ÙØ§ÙØ®ØµÙ ÙØªÙØ§Ù ÙÙØ· Ø¯Ø§Ø®Ù:
//   SaveProfileChangesWithRubies
// =====================================================

app.post(
    "/upload-avatar",
    avatarUpload.single("avatar"),
    async (req, res) => {
        try {
            const authorizationHeader =
                String(
                    req.headers["authorization"] ||
                    ""
                ).trim();

            const bearerTicket =
                authorizationHeader
                    .toLowerCase()
                    .startsWith("bearer ")
                    ? authorizationHeader
                        .substring(7)
                        .trim()
                    : "";

            const sessionTicket =
                String(
                    req.headers["x-authorization"] ||
                    bearerTicket ||
                    req.body.sessionTicket ||
                    ""
                ).trim();

            if (!sessionTicket) {
                console.log(
                    "AVATAR UPLOAD: SESSION TICKET MISSING"
                );

                return res
                    .status(401)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "Ø¬ÙØ³Ø© Ø§ÙÙØ§Ø¹Ø¨ ØºÙØ± ÙÙØ¬ÙØ¯Ø©"
                    });
            }

            if (
                !req.file ||
                !req.file.buffer
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "ÙÙ ÙØªÙ Ø¥Ø±Ø³Ø§Ù Ø§ÙØµÙØ±Ø©"
                    });
            }

            const authResult =
                await authenticatePlayFabSession(
                    sessionTicket
                );

            if (!authResult.success) {
                console.log(
                    "AVATAR SESSION ERROR:",
                    authResult.details ||
                    authResult.message
                );

                return res
                    .status(401)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            authResult.message ||
                            "Ø¬ÙØ³Ø© PlayFab ØºÙØ± ØµØ§ÙØ­Ø©"
                    });
            }

            const playFabId =
                String(
                    authResult.playFabId ||
                    ""
                ).trim();

            const safePlayFabId =
                playFabId.replace(
                    /[^a-zA-Z0-9_-]/g,
                    ""
                );

            if (!safePlayFabId) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "ÙØ¹Ø±Ù Ø§ÙÙØ§Ø¹Ø¨ ØºÙØ± ØµØ§ÙØ­"
                    });
            }

            const rawRequestId =
                String(
                    req.body.requestId ||
                    ""
                ).trim();

            const safeRequestId =
                rawRequestId
                    .replace(
                        /[^a-zA-Z0-9_-]/g,
                        ""
                    )
                    .substring(
                        0,
                        100
                    );

            const draftId =
                safeRequestId ||
                (
                    Date.now() +
                    "_" +
                    crypto
                        .randomBytes(8)
                        .toString("hex")
                );

            /*
             * ÙØ§ ÙØ±ÙØ¹ ÙÙÙ player_avatars/<PlayFabId>
             * ÙØ£Ù Ø°ÙÙ ÙØ³ØªØ¨Ø¯Ù ÙÙÙ Ø§ÙØµÙØ±Ø© Ø§ÙØ­Ø§ÙÙØ© ÙÙ Cloudinary
             * Ø­ØªÙ ÙØ¨Ù ÙØ¬Ø§Ø­ Ø§ÙØ®ØµÙ.
             *
             * ÙÙ ÙØ­Ø§ÙÙØ© ØªØ­ØµÙ Ø¹ÙÙ Ø±Ø§Ø¨Ø· ÙØ¤ÙØª ÙØ³ØªÙÙ.
             */
            const publicId =
                "player_avatar_drafts/" +
                safePlayFabId +
                "/" +
                draftId;

            const uploadResult =
                await new Promise(
                    (
                        resolve,
                        reject
                    ) => {
                        const uploadStream =
                            cloudinary.uploader
                                .upload_stream(
                                    {
                                        public_id:
                                            publicId,

                                        overwrite:
                                            true,

                                        invalidate:
                                            true,

                                        resource_type:
                                            "image",

                                        format:
                                            "jpg",

                                        transformation: [
                                            {
                                                width: 512,

                                                height: 512,

                                                crop:
                                                    "fill",

                                                gravity:
                                                    "auto"
                                            },
                                            {
                                                quality:
                                                    "auto:good"
                                            }
                                        ]
                                    },
                                    (
                                        error,
                                        result
                                    ) => {
                                        if (error) {
                                            reject(
                                                error
                                            );

                                            return;
                                        }

                                        resolve(
                                            result
                                        );
                                    }
                                );

                        uploadStream.end(
                            req.file.buffer
                        );
                    }
                );

            if (
                !uploadResult ||
                !uploadResult.secure_url
            ) {
                return res
                    .status(500)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "ÙÙ ÙØªÙ Ø¥ÙØ´Ø§Ø¡ Ø±Ø§Ø¨Ø· Ø§ÙØµÙØ±Ø©"
                    });
            }

            const avatarUrl =
                String(
                    uploadResult.secure_url
                ).trim();

            const avatarVersion =
                uploadResult.version
                    ? String(
                        uploadResult.version
                    )
                    : String(
                        Date.now()
                    );

            const updatedUnix =
                Math.floor(
                    Date.now() / 1000
                );

            /*
             * ÙØ§ ÙÙØ¬Ø¯ Ø£Ù Ø§Ø³ØªØ¯Ø¹Ø§Ø¡ PlayFab ÙØªØ­Ø¯ÙØ« Ø§ÙØµÙØ±Ø© ÙÙØ§.
             *
             * Unity ÙØ£Ø®Ø° avatarUrl Ù avatarVersion Ø«Ù ÙØ±Ø³ÙÙØ§ Ø¥ÙÙ:
             * SaveProfileChangesWithRubies
             *
             * CloudScript ÙÙ Ø§ÙÙØ³Ø¤ÙÙ Ø¹Ù:
             * - Ø§ÙØªØ£ÙØ¯ ÙÙ Ø§ÙØ³Ø¹Ø±.
             * - Ø®ØµÙ Ø§ÙÙØ§ÙÙØª.
             * - Ø²ÙØ§Ø¯Ø© Ø§ÙØ¹Ø¯Ø§Ø¯.
             * - Ø­ÙØ¸ avatar_url Ù avatar_version.
             * - ØªØ­Ø¯ÙØ« UpdateAvatarUrl Ø§ÙØ±Ø³ÙÙ.
             */

            console.log(
                "AVATAR DRAFT UPLOADED:",
                playFabId,
                draftId,
                avatarVersion,
                avatarUrl
            );

            return res
                .status(200)
                .json({
                    ok: true,

                    success: true,

                    message:
                        "ØªÙ Ø±ÙØ¹ Ø§ÙØµÙØ±Ø© ÙØ¤ÙØªÙØ§",

                    draft: true,

                    playFabId:
                        playFabId,

                    requestId:
                        safeRequestId,

                    draftId:
                        draftId,

                    draftPublicId:
                        publicId,

                    avatarUrl:
                        avatarUrl,

                    imageUrl:
                        avatarUrl,

                    secureUrl:
                        avatarUrl,

                    secure_url:
                        avatarUrl,

                    url:
                        avatarUrl,

                    avatarVersion:
                        avatarVersion,

                    version:
                        avatarVersion,

                    avatarUpdatedUnix:
                        updatedUnix
                });
        }
        catch (error) {
            console.log(
                "UPLOAD AVATAR ERROR:",
                error
            );

            return res
                .status(500)
                .json({
                    ok: false,

                    success: false,

                    message:
                        error &&
                        error.message
                            ? error.message
                            : "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«ÙØ§Ø¡ Ø±ÙØ¹ Ø§ÙØµÙØ±Ø©"
                });
        }
    }
);


// =====================================================
// ÙØ¹Ø§ÙØ¬Ø© Ø£Ø®Ø·Ø§Ø¡ Ø±ÙØ¹ Ø§ÙØµÙØ±
// =====================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        if (
            error instanceof
            multer.MulterError
        ) {
            if (
                error.code ===
                "LIMIT_FILE_SIZE"
            ) {
                return res
                    .status(413)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "Ø­Ø¬Ù Ø§ÙØµÙØ±Ø© Ø£ÙØ¨Ø± ÙÙ 4 ÙÙØ¬Ø§Ø¨Ø§ÙØª"
                    });
            }

            return res
                .status(400)
                .json({
                    ok: false,

                    success: false,

                    message:
                        "ÙØ´Ù Ø§Ø³ØªÙØ¨Ø§Ù Ø§ÙØµÙØ±Ø©"
                });
        }

        if (error) {
            console.log(
                "SERVER MIDDLEWARE ERROR:",
                error
            );

            return res
                .status(400)
                .json({
                    ok: false,

                    success: false,

                    message:
                        error.message ||
                        "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«ÙØ§Ø¡ Ø§Ø³ØªÙØ¨Ø§Ù Ø§ÙØ·ÙØ¨"
                });
        }

        next();
    }
);


// =====================================================
// Start Server
// =====================================================

const PORT =
    process.env.PORT ||
    3000;

app.listen(
    PORT,
    () => {
        console.log(
            "Server running on port " +
            PORT
        );
    }
);
