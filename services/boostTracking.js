async function initBoostTracking(client, guildId, db, keyFunctions, boostWebhookUrl, generateKey) {
    const { getAllKeys, setKey } = keyFunctions;

    client.on("guildMemberUpdate", async (oldMember, newMember) => {
        if (oldMember.guild.id !== guildId) return;

        const wasBoosting = oldMember.premiumSince;
        const isBoosting = newMember.premiumSince;

        // Member started boosting
        if (!wasBoosting && isBoosting) {
            console.log(`🚀 ${newMember.user.tag} started boosting!`);

            try {
                // Generate a free key for booster
                const key = generateKey("PRM01", newMember.id.slice(-5));

                await setKey(key, {
                    key,
                    type: "PRM01",
                    active: true,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 30 * 86_400_000,
                    source: "boost_reward",
                    boosterId: newMember.id,
                });

                // Send DM to booster
                try {
                    const dm = await newMember.createDM();
                    await dm.send(
                        `🎉 Cảm ơn bạn đã boost server!\n🔑 Đây là key thưởng 1 tháng Premium của bạn:\n\`\`\`${key}\`\`\``
                    );
                } catch (e) {
                    console.log("Could not DM booster:", e.message);
                }

                // Send to webhook if configured
                if (boostWebhookUrl) {
                    await fetch(boostWebhookUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            content: `🚀 **${newMember.user.tag}** vừa boost server! Key thưởng đã được gửi qua DM.`,
                        }),
                    }).catch(() => {});
                }
            } catch (err) {
                console.error("Error handling boost reward:", err);
            }
        }

        // Member stopped boosting
        if (wasBoosting && !isBoosting) {
            console.log(`💔 ${newMember.user.tag} stopped boosting!`);

            if (boostWebhookUrl) {
                await fetch(boostWebhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        content: `💔 **${newMember.user.tag}** đã dừng boost server.`,
                    }),
                }).catch(() => {});
            }
        }
    });

    console.log("✅ Boost tracking initialized");
}

module.exports = { initBoostTracking };
