require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const { google } = require("googleapis");
const fs = require("fs");

const bot = new Bot(process.env.BOT_TOKEN);

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const API_KEY = process.env.API_KEY;
const RANGE = "Лист1!A:B";
const DB_FILE = process.env.DB_FILE || "currency_cache.json";

const sheets = google.sheets({ version: "v4", auth: API_KEY });

let cache = { text: "", lastUpdated: 0 };

function readDb() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
        }
    } catch (e) {
        console.error("Ошибка чтения БД:", e.message);
    }
    return { rates: {}, lastMessageTime: 0 };
}

// Функция для записи данных в файл
function writeDb(rates, lastMessageTime) {
    try {
        const data = {
            rates: rates,
            lastMessageTime: lastMessageTime || readDb().lastMessageTime
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Ошибка записи в БД:", e.message);
    }
}

// Парсинг списка админов из .env (например, ADMIN_USER_ID=123,456)
const ADMINS = process.env.ADMIN_USER_ID 
    ? process.env.ADMIN_USER_ID.split(',').map(id => parseInt(id.trim())) 
    : [];

const formatValue = (val) => {
    try {
        if (!val) return "—";
        let num = parseFloat(val.toString().replace(',', '.'));
        if (isNaN(num)) return "—";
        const rounded = Math.ceil(num * 100) / 100;
        return rounded.toFixed(2).replace('.', ',');
    } catch (e) {
        return "—";
    }
};

const formatValue2 = (val) => {
    try {
        if (!val) return "—";
        let s = val.toString().replace('.', ','); 
        const commaIndex = s.indexOf(',');
        if (commaIndex === -1) return s;
        return s.substr(0, commaIndex + 3);
    } catch (e) {
        return "—";
    }
};

const getTrend = (current, previous) => {
    try {
        if (!previous) return "";
        const curr = parseFloat(current.toString().replace(',', '.'));
        const prev = parseFloat(previous.toString().replace(',', '.'));
        if (curr > prev) return " 📈";
        if (curr < prev) return " 📉";
        return "";
    } catch (e) {
        return "";
    }
};

async function getCurrencyRates(force = false) {
    const now = Date.now();
    const CACHE_TIME = 30000;

    if (!force && cache.text && (now - cache.lastUpdated < CACHE_TIME)) {
        return { text: cache.text, updated: false };
    }

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return { text: "📭 Данные не найдены.", updated: false };

        const newData = {};
        rows.forEach(([pair, value]) => {
            if (pair && value) newData[pair.trim()] = value.trim();
        });

        // Сохраняем только курсы, время сообщения не трогаем здесь
        writeDb(newData);

        const sarrub = formatValue(newData["SARRUB"]);
        const usdrub = formatValue(newData["USDRUB"]);
        const usdsar = formatValue2(newData["USDSAR"]);
        const sarkgs = formatValue(newData["SARKGS"]);
        const sarkzt = formatValue(newData["SARKZT"]);
        const saruzs = formatValue(newData["SARUZS"]);

        const timeStr = new Date().toLocaleString('ru-RU', { 
            timeZone: 'Asia/Riyadh',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        let message = `🇸🇦 1 SAR = <b>${sarrub}</b> RUB 🇷🇺\n`;
        message += `🇺🇸 1 USD = <b>${usdrub}</b> RUB 🇷🇺\n`;
        message += `🇺🇸 1 USD = <b>${usdsar}</b> SAR 🇸🇦\n`;
        message += `--------------------------\n`;
        message += `🇸🇦 1 SAR = <b>${sarkgs}</b> KGS 🇰🇬\n`;
        message += `🇸🇦 1 SAR = <b>${sarkzt}</b> KZT 🇰🇿\n`;
        message += `🇸🇦 1 SAR = <b>${saruzs}</b> UZS 🇺🇿\n\n`;
        message += `📊 Курс Google\n\n`;
        message += `<i>📊 Обновлено: ${timeStr}</i>\n`;
        
        cache.text = message;
        cache.lastUpdated = now;

        return { text: message, updated: true };
    } catch (error) {
        return { text: cache.text || "⚠️ Ошибка данных.", updated: false };
    }
}

const keyboard = new InlineKeyboard().text("🔄 Обновить", "refresh_rates");

const adminOnly = async (ctx, next) => {
    try {
        if (ctx.from && ADMINS.includes(ctx.from.id)) {
            return await next();
        }
        
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
                text: "⛔️ Доступ только для администраторов.",
                show_alert: true
            });
        } else {
            await ctx.reply("❌ Эта команда доступна только администраторам.");
        }
    } catch (e) {
        console.error("Ошибка в middleware adminOnly:", e.message);
    }
};
bot.command("rates", adminOnly, async (ctx) => {
    const result = await getCurrencyRates(true);
    const sentMsg = await ctx.reply(result.text, { reply_markup: keyboard, parse_mode: "HTML" });
    
    // Сохраняем время отправки нового сообщения в JSON
    const db = readDb();
    writeDb(db.rates, Date.now());
});

bot.callbackQuery("refresh_rates", async (ctx) => {
    try {
        const result = await getCurrencyRates();
        const db = readDb();
        const now = Date.now();
        const FORTY_SEVEN_HOURS = 47 * 60 * 60 * 1000;

        const isTooOld = (now - (db.lastMessageTime || 0)) > FORTY_SEVEN_HOURS;

        if (!result.updated && !isTooOld) {
            return await ctx.answerCallbackQuery({ text: "✅ Актуально" });
        }

        if (isTooOld) {
            // Удаляем старое сообщение (опционально), чтобы не засорять чат
            await ctx.deleteMessage().catch(() => {});
            
            const sentMsg = await ctx.reply(result.text, { 
                reply_markup: keyboard, 
                parse_mode: "HTML" 
            });
            
            writeDb(db.rates, now); // Фиксируем новое время в JSON
            await ctx.pinChatMessage(sentMsg.message_id).catch(() => {});
            return await ctx.answerCallbackQuery({ text: "🔄 Сообщение пересоздано" });
        }

        await ctx.editMessageText(result.text, { 
            reply_markup: keyboard, 
            parse_mode: "HTML" 
        });
        await ctx.answerCallbackQuery({ text: "✅ Обновлено" });

    } catch (e) {
        if (e.description?.includes("message is not modified")) {
            return await ctx.answerCallbackQuery({ text: "Изменений нет" });
        }
        console.error("Ошибка обновления:", e);
    }
});

// Глобальный обработчик ошибок бота
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Ошибка при обработке обновления ${ctx.update.update_id}:`);
    console.error(err.error);
});

bot.start();
console.log("Бот запущен и защищен от критических ошибок.");