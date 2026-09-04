const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

let keysCollection;

async function start() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        // Cắm vào đúng DB và collection của bạn
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

// Endpoint kiểm tra server còn sống hay không
app.get("/api/health", (req, res) => {
    res.json({ status: "OK", server: "Render-Global-API" });
});

// Endpoint xác thực License
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
    const MODULE_SESSION_KEY = "LyraSecureKey2026_GCM_PROTECT!9!";

    if (hwids.includes(hwid)) {
        return res.status(200).json({
            success: true,
            message: `HWID verified - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    if (hwids.length < maxHwid) {
        hwids.push(hwid);
        await keysCollection.updateOne({ key }, { $set: { hwids, hwid: undefined } });
        return res.status(200).json({
            success: true,
            session_key: MODULE_SESSION_KEY,
            message: `New device registered - Access granted (${hwids.length}/${maxHwid} slots used)`,
        });
    }

    return res.status(200).json({
        success: false,
        message: `Device limit reached (${maxHwid}/${maxHwid} slots full). Please reset HWID via Discord or contact Owner.`,
    });
});

start();
