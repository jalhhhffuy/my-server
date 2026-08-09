const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.use(
    express.json({
        verify: (
            req,
            res,
            buffer
        ) => {
            /*
             * Cloudinary Webhook Signature:
             * نحتاج النص الخام كما وصل من Cloudinary حتى نتحقق من
             * X-Cld-Signature + X-Cld-Timestamp بدون إعادة بناء JSON.
             */
            req.rawBody =
                buffer &&
                buffer.length
                    ? buffer.toString("utf8")
                    : "";
        }
    })
);

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
// Avatar Image Moderation
// Amazon Rekognition AI Moderation
//
// السلوك:
// - صورة الملف الشخصي ترفع كمسودة فقط.
// - Cloudinary يفحصها بواسطة aws_rek أثناء الرفع.
// - لا يرجع avatarUrl إلى Unity إلا إذا الحالة approved.
// - rejected تُحذف مباشرة من Cloudinary.
// - pending / missing / أي حالة غير approved تُرفض احتياطياً.
// =====================================================

const AVATAR_IMAGE_MODERATION_KIND =
    "aws_rek";


function getCloudinaryModerationStatus(
    uploadResult,
    kind
) {
    const moderation =
        uploadResult &&
        Array.isArray(
            uploadResult.moderation
        )
            ? uploadResult.moderation
            : [];

    const wantedKind =
        String(
            kind || ""
        )
            .trim()
            .toLowerCase();

    for (
        const item
        of moderation
    ) {
        if (
            !item ||
            typeof item !== "object"
        ) {
            continue;
        }

        const itemKind =
            String(
                item.kind || ""
            )
                .trim()
                .toLowerCase();

        if (
            itemKind ===
            wantedKind
        ) {
            return String(
                item.status || ""
            )
                .trim()
                .toLowerCase();
        }
    }

    return "";
}


async function deleteCloudinaryImage(
    publicId
) {
    const id =
        String(
            publicId || ""
        ).trim();

    if (!id) {
        return false;
    }

    try {
        const result =
            await cloudinary.uploader.destroy(
                id,
                {
                    resource_type:
                        "image",

                    type:
                        "upload",

                    invalidate:
                        true
                }
            );

        console.log(
            "CLOUDINARY IMAGE DELETE:",
            id,
            result &&
            result.result
                ? result.result
                : result
        );

        return true;
    }
    catch (error) {
        console.log(
            "CLOUDINARY IMAGE DELETE ERROR:",
            id,
            error &&
            error.message
                ? error.message
                : error
        );

        return false;
    }
}


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
                    "نوع الصورة غير مدعوم"
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
                "SessionTicket غير موجود"
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
                "جلسة PlayFab غير صالحة",

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
            "Server is working 🔥"
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
// كلمة مرور داخل اللعبة
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
                            "playFabId / email / password مطلوب"
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
                            "كلمة المرور لازم تكون 6 أحرف أو أكثر"
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
                            "فشل فحص الحساب"
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
                            "البريد لا يطابق الحساب"
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
                            "الحساب غير موثق"
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
                            "google_custom_id غير موجود"
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
                    "تم حفظ كلمة مرور اللعبة"
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
                        "خطأ في السيرفر"
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
                            "email / password مطلوب"
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
                            "فشل فحص الحساب"
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
                            "هذا البريد لا يملك كلمة مرور لعبة"
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
                            "كلمة المرور غير صحيحة"
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
                        "خطأ في السيرفر"
                });
        }
    }
);


// =====================================================
// ربط Google بحساب اللاعب الحالي
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
                "playFabId مفقود"
            );
        }

        const clientId =
            process.env
                .GOOGLE_CLIENT_ID;

        if (!clientId) {
            return res.send(
                "GOOGLE_CLIENT_ID ناقص"
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
                    "فشل الربط: بيانات ناقصة"
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
                    "فشل أخذ توكن Google"
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
                    "فشل قراءة بيانات Google"
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
                    "فشل فحص الربط: " +
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
                    "هذا Google مربوط بحساب آخر"
                );
            }

            if (
                maps[googleEmailMapKey] &&
                maps[googleEmailMapKey] !==
                    playFabId
            ) {
                return res.send(
                    "هذا البريد مربوط بحساب آخر"
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
                    "فشل حفظ الربط: " +
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
                    <h2>ارجع إلى اللعبة</h2>
                    <p>سيتم تحديث البريد من داخل اللعبة</p>
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
                "حدث خطأ في السيرفر"
            );
        }
    }
);


// =====================================================
// تسجيل دخول Google من شاشة Login
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
                "session مفقود"
            );
        }

        const clientId =
            process.env
                .GOOGLE_CLIENT_ID;

        if (!clientId) {
            return res.send(
                "GOOGLE_CLIENT_ID ناقص"
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
                    "فشل تسجيل الدخول: بيانات ناقصة"
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
                    "فشل تسجيل Google"
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
                    "فشل قراءة بيانات Google"
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
                    "فشل فحص الحساب: " +
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
                                    "هذا البريد غير مربوط بحساب",

                                email:
                                    email
                            })
                    }
                );

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
                    <h2>تم تسجيل الدخول بنجاح ✅</h2>
                    <p>${email}</p>
                    <p>جاري الرجوع إلى اللعبة...</p>
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
                "حدث خطأ أثناء تسجيل الدخول"
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
                    "session مفقود"
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
                    "انتظار تسجيل Google"
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
                    "رد غير صالح"
            });
        }
    }
);


// =====================================================
// رفع الصورة الشخصية مؤقتًا فقط
//
// POST /upload-avatar
//
// مهم:
// - يتحقق من جلسة PlayFab.
// - يرفع الصورة إلى Cloudinary فقط.
// - يفحص الصورة عبر Amazon Rekognition قبل إرجاع الرابط.
// - لا يحفظ رابط الصورة في PlayFab.
// - لا يستدعي UpdateAvatarUrl.
// - لا يستدعي UpdateUserData.
// - الحفظ الرسمي والخصم يتمان فقط داخل:
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
                            "جلسة اللاعب غير موجودة"
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
                            "لم يتم إرسال الصورة"
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
                            "جلسة PlayFab غير صالحة"
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
                            "معرف اللاعب غير صالح"
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
             * لا نرفع فوق player_avatars/<PlayFabId>
             * لأن ذلك يستبدل ملف الصورة الحالية في Cloudinary
             * حتى قبل نجاح الخصم.
             *
             * كل محاولة تحصل على رابط مؤقت مستقل.
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

                                        // حماية صورة الملف الشخصي.
                                        moderation:
                                            AVATAR_IMAGE_MODERATION_KIND,

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
                !uploadResult.public_id
            ) {
                return res
                    .status(500)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "لم يتم إنشاء الصورة على Cloudinary"
                    });
            }

            const uploadedPublicId =
                String(
                    uploadResult.public_id
                ).trim();

            const moderationStatus =
                getCloudinaryModerationStatus(
                    uploadResult,
                    AVATAR_IMAGE_MODERATION_KIND
                );

            console.log(
                "AVATAR MODERATION:",
                playFabId,
                uploadedPublicId,
                moderationStatus ||
                    "missing"
            );

            /*
             * Fail Closed:
             * لا نعتمد الصورة إلا عند approved بشكل صريح.
             */
            if (
                moderationStatus !==
                "approved"
            ) {
                await deleteCloudinaryImage(
                    uploadedPublicId
                );

                if (
                    moderationStatus ===
                    "rejected"
                ) {
                    return res
                        .status(422)
                        .json({
                            ok: false,

                            success: false,

                            moderationRejected:
                                true,

                            moderationStatus:
                                "rejected",

                            message:
                                "تم رفض الصورة لأنها تخالف قوانين الصور"
                        });
                }

                return res
                    .status(503)
                    .json({
                        ok: false,

                        success: false,

                        moderationRejected:
                            false,

                        moderationStatus:
                            moderationStatus ||
                            "missing",

                        message:
                            "تعذر فحص الصورة الآن، حاول مرة أخرى بعد قليل"
                    });
            }

            if (
                !uploadResult.secure_url
            ) {
                await deleteCloudinaryImage(
                    uploadedPublicId
                );

                return res
                    .status(500)
                    .json({
                        ok: false,

                        success: false,

                        message:
                            "لم يتم إنشاء رابط الصورة"
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
             * لا يوجد أي استدعاء PlayFab لتحديث الصورة هنا.
             *
             * Unity يأخذ avatarUrl و avatarVersion فقط بعد approved
             * ثم يرسلها إلى:
             * SaveProfileChangesWithRubies
             *
             * CloudScript هو المسؤول عن:
             * - التأكد من السعر.
             * - خصم الياقوت.
             * - زيادة العداد.
             * - حفظ avatar_url و avatar_version.
             * - تحديث UpdateAvatarUrl الرسمي.
             */

            console.log(
                "AVATAR DRAFT APPROVED AND UPLOADED:",
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
                        "تم رفع الصورة مؤقتًا",

                    draft: true,

                    moderationApproved:
                        true,

                    moderationStatus:
                        "approved",

                    playFabId:
                        playFabId,

                    requestId:
                        safeRequestId,

                    draftId:
                        draftId,

                    draftPublicId:
                        uploadedPublicId,

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

            /*
             * إذا Cloudinary نفسه رجع خطأ من خدمة moderation
             * لا نعتبر الصورة ناجحة ولا نحفظ أي رابط.
             */
            return res
                .status(500)
                .json({
                    ok: false,

                    success: false,

                    message:
                        "تعذر رفع أو فحص الصورة، حاول مرة أخرى"
                });
        }
    }
);


// =====================================================
// معالجة أخطاء رفع الصور
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
                            "حجم الصورة أكبر من 4 ميجابايت"
                    });
            }

            return res
                .status(400)
                .json({
                    ok: false,

                    success: false,

                    message:
                        "فشل استقبال الصورة"
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
                        "حدث خطأ أثناء استقبال الطلب"
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
