const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Key thật dùng để giải mã module phía client.
// PHẢI đặt trong biến môi trường (.env / Render Environment), KHÔNG hardcode.
// Đổi hẳn sang giá trị mới, khác với "LyraSecureKey2026_GCM_PROTECT!9!" cũ vì giá trị đó coi như đã lộ.
const REAL_MODULE_KEY = process.env.MODULE_DECRYPT_KEY;

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

    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();

        // Cắm vào đúng DB và collection của bạn
        keysCollection = client.db("whitelist").collection("keys");
        sessionsCollection = client.db("whitelist").collection("sessions");

        // TTL index: Mongo tự xoá document khi expiresAt tới hạn.
        // Chỉ cần chạy 1 lần (nếu index đã tồn tại, lệnh này no-op).
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
    return crypto.randomBytes(32).toString('hex'); // 64 ký tự hex, ngẫu nhiên mỗi lần gọi
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

// Endpoint kiểm tra server còn sống hay không
app.get("/api/health", (req, res) => {
    res.json({ status: "OK", server: "Render-Global-API" });
});

// Endpoint xác thực License — trả về session_key TẠM THỜI, không trả module key thật nữa
app.post("/api/verify", async (req, res) => {
    const { key, hwid } = req.body;

    if (!key || !hwid) {
        return res.status(400).json({ success: false, message: "Key and HWID are required" });
    }

    const keyData = await keysCollection.findOne({ key });

    if (!keyData) {
        return res.status(200).json({ success: false, message: "Invalid key - Key does not exist" });
    }

    if (!keyData.active) {
        return res.status(200).json({
            success: false,
            message: "Key is blacklisted and cannot be used",
        });
    }

    if (keyData.expiresAt && Date.now() > keyData.expiresAt) {
        return res.status(200).json({ success: false, message: "Key has expired" });
    }

    if (!keyData.userId) {
        return res.status(200).json({
            success: false,
            message: "Key not redeemed yet - Please redeem key first using Discord bot",
        });
    }

    const hwids = normalizeHwids(keyData);
    const maxHwid = keyData.maxHwid ?? 1;

    if (hwids.includes(hwid)) {
        const { sessionKey, expiresInSeconds } = await issueSession(key, hwid);
        return res.status(200).json({
            success: true,
            session_key: sessionKey,
            expires_in: expiresInSeconds,
            message: `HWID verified - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    if (hwids.length < maxHwid) {
        hwids.push(hwid);
        await keysCollection.updateOne({ key }, { $set: { hwids, hwid: undefined } });

        const { sessionKey, expiresInSeconds } = await issueSession(key, hwid);
        return res.status(200).json({
            success: true,
            session_key: sessionKey,
            expires_in: expiresInSeconds,
            message: `New device registered - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    return res.status(200).json({
        success: false,
        message: `Device limit reached (${maxHwid}/${maxHwid} slots full). Please reset HWID via Discord or contact Owner.`,
    });
});

// Endpoint mới: đổi session_key (dùng 1 lần, hạn 5 phút) lấy module_key thật
app.post("/api/module-key", async (req, res) => {
    const { session_key } = req.body;

    if (!session_key) {
        return res.status(400).json({ success: false, message: "Missing session_key" });
    }

    const session = await sessionsCollection.findOne({ sessionKey: session_key });

    if (!session) {
        return res.status(200).json({ success: false, message: "Invalid or expired session" });
    }
    if (session.used) {
        return res.status(200).json({ success: false, message: "Session already used" });
    }
    if (session.expiresAt < new Date()) {
        return res.status(200).json({ success: false, message: "Session expired" });
    }

    // Đánh dấu đã dùng NGAY LẬP TỨC để chặn dùng lại (kể cả 2 request gần như đồng thời).
    // findOneAndUpdate với điều kiện used:false đảm bảo chỉ 1 request thắng trong race condition.
    const result = await sessionsCollection.findOneAndUpdate(
        { sessionKey: session_key, used: false },
        { $set: { used: true, usedAt: new Date() } }
    );

    if (!result) {
        // Đã có request khác dùng session này trước đó (race condition) → từ chối.
        return res.status(200).json({ success: false, message: "Session already used" });
    }

    return res.status(200).json({
        success: true,
        module_key: REAL_MODULE_KEY,
    });
});

start();
