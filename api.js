const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const REAL_MODULE_KEY = process.env.MODULE_DECRYPT_KEY;

// Secret dùng để KÝ RESPONSE (HMAC-SHA256). PHẢI đặt giống hệt trên cả bot Pikahost
// và bot Render (cùng 1 giá trị) vì client chỉ verify bằng 1 secret duy nhất.
// Tạo 1 lần bằng: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Đây là secret KHÁC với MODULE_DECRYPT_KEY và khác API_SECRET hiện có.
const RESPONSE_SIGN_SECRET = process.env.RESPONSE_SIGN_SECRET;

const SESSION_TTL_MS = 5 * 60 * 1000; // session key sống 5 phút

let keysCollection;
let sessionsCollection;

async function start() {
    if (!MONGODB_URI) {
        console.error("❌ Missing MONGODB_URI env var");
        process.exit(1);
    }
    if (!REAL_MODULE_KEY) {
        console.error("❌ Missing MODULE_DECRYPT_KEY env var");
        process.exit(1);
    }
    if (!RESPONSE_SIGN_SECRET) {
        console.error("❌ Missing RESPONSE_SIGN_SECRET env var");
        process.exit(1);
    }

    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();

        keysCollection = client.db("whitelist").collection("keys");
        sessionsCollection = client.db("whitelist").collection("sessions");

        await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

        console.log("✅ MongoDB connected successfully for Global API");

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`🌐 Global API running on port ${PORT}`);
        });
    } catch (err) {
        console.error("❌ MongoDB connection error:", err);
        process.exit(1);
    }
}

function normalizeHwids(keyData) {
    if (!keyData) return [];
    if (Array.isArray(keyData.hwids)) return keyData.hwids;
    if (keyData.hwid) return [keyData.hwid];
    return [];
}

function generateSessionKey() {
    return crypto.randomBytes(32).toString('hex');
}

async function issueSession(key, hwid) {
    const sessionKey = generateSessionKey();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await sessionsCollection.insertOne({
        sessionKey,
        key,
        hwid,
        expiresAt,
        used: false,
        createdAt: new Date(),
    });

    return { sessionKey, expiresInSeconds: SESSION_TTL_MS / 1000 };
}

// ---- Ký response bằng HMAC-SHA256 ----
// Bọc MỌI res.json(...) bằng hàm này, kể cả nhánh success:false, để kẻ tấn công
// không thể phân biệt "nhánh nào cần giả" dựa trên có/không có chữ ký.
function signPayload(payloadObj) {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const canonical = JSON.stringify(payloadObj) + '|' + timestamp + '|' + nonce;

    const signature = crypto
        .createHmac('sha256', RESPONSE_SIGN_SECRET)
        .update(canonical)
        .digest('hex');

    return { ...payloadObj, timestamp, nonce, signature };
}

function sendSigned(res, statusCode, payloadObj) {
    return res.status(statusCode).json(signPayload(payloadObj));
}

app.get("/api/health", (req, res) => {
    // Endpoint health-check không cần ký — không mang dữ liệu nhạy cảm, không ảnh hưởng license flow.
    res.json({ status: "OK", server: "Render-Global-API" });
});

app.post("/api/verify", async (req, res) => {
    const { key, hwid } = req.body;

    if (!key || !hwid) {
        return sendSigned(res, 400, { success: false, message: "Key and HWID are required" });
    }

    const keyData = await keysCollection.findOne({ key });

    if (!keyData) {
        return sendSigned(res, 200, { success: false, message: "Invalid key - Key does not exist" });
    }

    if (!keyData.active) {
        return sendSigned(res, 200, {
            success: false,
            message: "Key is blacklisted and cannot be used",
        });
    }

    if (keyData.expiresAt && Date.now() > keyData.expiresAt) {
        return sendSigned(res, 200, { success: false, message: "Key has expired" });
    }

    if (!keyData.userId) {
        return sendSigned(res, 200, {
            success: false,
            message: "Key not redeemed yet - Please redeem key first using Discord bot",
        });
    }

    const hwids = normalizeHwids(keyData);
    const maxHwid = keyData.maxHwid ?? 1;

    if (hwids.includes(hwid)) {
        const { sessionKey, expiresInSeconds } = await issueSession(key, hwid);
        return sendSigned(res, 200, {
            success: true,
            session_key: sessionKey,
            expires_in: expiresInSeconds,
            message: `HWID verified - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    if (hwids.length < maxHwid) {
        // Atomic: điều kiện $expr đảm bảo không vượt maxHwid dù nhiều request đến cùng lúc.
        const result = await keysCollection.findOneAndUpdate(
            { key, $expr: { $lt: [{ $size: { $ifNull: ["$hwids", []] } }, maxHwid] } },
            { $addToSet: { hwids: hwid }, $unset: { hwid: "" } },
            { returnDocument: 'after' }
        );

        if (!result.value) {
            return sendSigned(res, 200, {
                success: false,
                message: `Device limit reached (${maxHwid}/${maxHwid} slots full). Please reset HWID via Discord or contact Owner.`,
            });
        }

        const newHwids = normalizeHwids(result.value);
        const { sessionKey, expiresInSeconds } = await issueSession(key, hwid);
        return sendSigned(res, 200, {
            success: true,
            session_key: sessionKey,
            expires_in: expiresInSeconds,
            message: `New device registered - Access granted (${newHwids.length}/${maxHwid} slots used)`,
        });
    }

    return sendSigned(res, 200, {
        success: false,
        message: `Device limit reached (${maxHwid}/${maxHwid} slots full). Please reset HWID via Discord or contact Owner.`,
    });
});

app.post("/api/module-key", async (req, res) => {
    const { session_key } = req.body;

    if (!session_key) {
        return sendSigned(res, 400, { success: false, message: "Missing session_key" });
    }

    const session = await sessionsCollection.findOne({ sessionKey: session_key });

    if (!session) {
        return sendSigned(res, 200, { success: false, message: "Invalid or expired session" });
    }
    if (session.used) {
        return sendSigned(res, 200, { success: false, message: "Session already used" });
    }
    if (session.expiresAt < new Date()) {
        return sendSigned(res, 200, { success: false, message: "Session expired" });
    }

    const result = await sessionsCollection.findOneAndUpdate(
        { sessionKey: session_key, used: false },
        { $set: { used: true, usedAt: new Date() } }
    );

    if (!result.value) {
        return sendSigned(res, 200, { success: false, message: "Session already used" });
    }

    return sendSigned(res, 200, {
        success: true,
        module_key: REAL_MODULE_KEY,
    });
});

start();
