import { env } from "@/lib/constants";
import { processSocialLink } from "@/lib/process-link";

type TelegramMessage = {
    message_id?: number;
    chat?: { id: number };
    text?: string;
    caption?: string;
};

type TelegramUpdate = {
    update_id?: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
    channel_post?: TelegramMessage;
    edited_channel_post?: TelegramMessage;
};

const URL_REGEX = /https?:\/\/[^\s]+/i;
const UPDATE_TTL_MS = 30 * 60 * 1000;

declare global {
    // Keep a short-lived memory of updates to avoid duplicate webhook retries.
    var __telegramInFlightUpdates: Map<string, number> | undefined;
    var __telegramProcessedUpdates: Map<string, number> | undefined;
}

const inFlightUpdates =
    globalThis.__telegramInFlightUpdates ||
    (globalThis.__telegramInFlightUpdates = new Map<string, number>());
const processedUpdates =
    globalThis.__telegramProcessedUpdates ||
    (globalThis.__telegramProcessedUpdates = new Map<string, number>());

function getAllowedChatIds(): Set<string> {
    if (!env.TELEGRAM_ALLOWED_CHAT_IDS) {
        return new Set<string>();
    }

    return new Set(
        env.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
            .map((id) => id.trim())
            .filter(Boolean)
    );
}

function getDefaultTags(): string[] {
    if (!env.TELEGRAM_DEFAULT_TAGS) {
        return [];
    }

    return env.TELEGRAM_DEFAULT_TAGS.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
}

function extractMessage(update: TelegramUpdate): TelegramMessage | null {
    return update.message || update.channel_post || null;
}

function cleanupExpiredUpdates(now: number) {
    for (const [id, timestamp] of inFlightUpdates.entries()) {
        if (now - timestamp > UPDATE_TTL_MS) {
            inFlightUpdates.delete(id);
        }
    }

    for (const [id, timestamp] of processedUpdates.entries()) {
        if (now - timestamp > UPDATE_TTL_MS) {
            processedUpdates.delete(id);
        }
    }
}

function getUpdateKey(update: TelegramUpdate, message: TelegramMessage): string {
    if (typeof update.update_id === "number") {
        return `u:${update.update_id}`;
    }

    const chatId = message.chat?.id ?? "unknown-chat";
    const messageId = message.message_id ?? "unknown-message";
    return `m:${chatId}:${messageId}`;
}

async function sendTelegramMessage(chatId: number, text: string) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return;
    }

    const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        console.error("Failed to send Telegram message", response.status, body);
    }
}

export async function POST(req: Request) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        return Response.json(
            { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" },
            { status: 500 }
        );
    }

    if (env.TELEGRAM_WEBHOOK_SECRET) {
        const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
        if (!secretHeader || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
            return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }
    }

    try {
        const update = (await req.json()) as TelegramUpdate;
        const message = extractMessage(update);
        const now = Date.now();

        cleanupExpiredUpdates(now);

        if (!message?.chat?.id) {
            return Response.json({ ok: true, ignored: "No message payload" });
        }

        const updateKey = getUpdateKey(update, message);
        if (inFlightUpdates.has(updateKey) || processedUpdates.has(updateKey)) {
            return Response.json({ ok: true, ignored: "Duplicate update" });
        }

        inFlightUpdates.set(updateKey, now);

        try {
            const chatId = message.chat.id;
            const allowedChatIds = getAllowedChatIds();

            if (allowedChatIds.size > 0 && !allowedChatIds.has(String(chatId))) {
                return Response.json({ ok: true, ignored: "Chat not allowed" });
            }

            const text = (message.text || message.caption || "").trim();
            if (!text) {
                await sendTelegramMessage(
                    chatId,
                    "Send a social media post link and I will import it to Mealie."
                );
                return Response.json({ ok: true, ignored: "No text" });
            }

            if (/^(\/start|\/help)\b/i.test(text)) {
                await sendTelegramMessage(
                    chatId,
                    "Send a social media post URL (Instagram, TikTok, Facebook, YouTube Shorts, Pinterest) and I will create a recipe in Mealie."
                );
                return Response.json({ ok: true, handled: "help" });
            }

            const urlMatch = text.match(URL_REGEX);
            if (!urlMatch?.[0]) {
                await sendTelegramMessage(
                    chatId,
                    "I could not find a URL in your message. Please send a full link."
                );
                return Response.json({ ok: true, handled: "missing_url" });
            }

            const url = urlMatch[0].replace(/[),.;!?]+$/, "");
            await sendTelegramMessage(chatId, `Processing link:\n${url}`);

            try {
                const { createdRecipe } = await processSocialLink(url, getDefaultTags());

                await sendTelegramMessage(
                    chatId,
                    `Recipe created: ${createdRecipe.name}\n${createdRecipe.url}`
                );
            } catch (error: any) {
                console.error("Telegram processing failed:", error);
                await sendTelegramMessage(
                    chatId,
                    `Failed to create recipe: ${error.message || "Unknown error"}`
                );
            }

            return Response.json({ ok: true, handled: "processed" });
        } finally {
            inFlightUpdates.delete(updateKey);
            processedUpdates.set(updateKey, Date.now());
        }
    } catch (error: any) {
        console.error("Telegram webhook processing error:", error);
        return Response.json({ ok: true, error: error.message || "Unknown error" });
    }
}
