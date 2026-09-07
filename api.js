const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const REAL_MODULE_KEY = process.env.MODULE_DECRYPT_KEY;
const RESPONSE_SIGN_SECRET = process.env.RESPONSE_SIGN_SECRET;

let keysCollection;

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

// ---- Ký response bằng HMAC-SHA256 ----
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

    // Trường hợp 1: HWID đã tồn tại trên key
    if (hwids.includes(hwid)) {
        return sendSigned(res, 200, {
            success: true,
            module_key: REAL_MODULE_KEY,
            message: `HWID verified - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    // Trường hợp 2: Còn slot trống, đăng ký HWID mới
    if (hwids.length < maxHwid) {
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
        return sendSigned(res, 200, {
            success: true,
            module_key: keyData.moduleKey || MODULE_DECRYPT_KEY,
            message: `New device registered - Access granted (${newHwids.length}/${maxHwid} slots used)`,
        });
    }

    return sendSigned(res, 200, {
        success: false,
        message: `Device limit reached (${maxHwid}/${maxHwid} slots full). Please reset HWID via Discord or contact Owner.`,
    });
});

start();
