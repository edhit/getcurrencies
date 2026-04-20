require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const { google } = require("googleapis");
const fs = require("fs");
const { log } = require("console");

const bot = new Bot(process.env.BOT_TOKEN);

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const API_KEY = process.env.API_KEY;
const RANGE = "Лист1!A:B";
const DB_FILE = process.env.DB_FILE || "currency_cache.json";

const sheets = google.sheets({ version: "v4", auth: API_KEY });

let cache = { text: "", lastUpdated: 0 };

// Функция для обрезки строки (как вы просили через substr)
const formatValue = (val) => {
    if (!val) return "—";
    
    // 1. Превращаем строку "20,331" в число 20.331
    let num = parseFloat(val.toString().replace(',', '.'));
    
    if (isNaN(num)) return "—";

    // 2. Округляем ВВЕРХ до 2 знаков
    // Умножаем на 100, округляем до целого вверх, делим на 100
    const rounded = Math.ceil(num * 100) / 100;

    // 3. Возвращаем строку с заменой точки на запятую
    // toFixed(2) гарантирует, что будет всегда два знака (например, 20,30)
    return rounded.toFixed(2).replace('.', ',');
};

const formatValue2 = (val) => {
    if (!val) return "—";
    let s = val.toString().replace('.', ','); 
    const commaIndex = s.indexOf(',');
    if (commaIndex === -1) return s;
    return s.substr(0, commaIndex + 3);
};

// Вспомогательная функция для сравнения и выбора иконки
const getTrend = (current, previous) => {
    if (!previous) return "";
    const curr = parseFloat(current.toString().replace(',', '.'));
    const prev = parseFloat(previous.toString().replace(',', '.'));
    if (curr > prev) return " 📈";
    if (curr < prev) return " 📉";
    return "";
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

        // Загружаем старые данные из файла для сравнения
        let oldData = {};
        if (fs.existsSync(DB_FILE)) {
            oldData = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
        }

        // Основные пары
        const sarrub = formatValue(newData["SARRUB"]);
        const usdrub = formatValue(newData["USDRUB"]);
        const usdsar = formatValue2(newData["USDSAR"]);

        // Новые пары (СНГ)
        const sarkgs = formatValue(newData["SARKGS"]);
        const sarkzt = formatValue(newData["SARKZT"]);
        const saruzs = formatValue(newData["SARUZS"]);

        // Сохраняем данные
        fs.writeFileSync(DB_FILE, JSON.stringify(newData, null, 2));

        const timeStr = new Date().toLocaleString('ru-RU', { 
            timeZone: 'Asia/Riyadh',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        // Итоговое сообщение с флагами
        let message = `🇸🇦 1 SAR = <b>${sarrub}</b> RUB 🇷🇺\n`;
        message += `🇺🇸 1 USD = <b>${usdrub}</b> RUB 🇷🇺\n`;
        message += `🇺🇸 1 USD = <b>${usdsar}</b> SAR 🇸🇦\n`;
        message += `--------------------------\n`;
        message += `🇸🇦 1 SAR = <b>${sarkgs}</b> KGS 🇰🇬\n`;
        message += `🇸🇦 1 SAR = <b>${sarkzt}</b> KZT 🇰🇿\n`;
        message += `🇸🇦 1 SAR = <b>${saruzs}</b> UZS 🇺🇿\n\n`;
        message += `<i>📊 Обновлено: ${timeStr}</i>`;

        
        cache.text = message;
        cache.lastUpdated = now;

        return { text: message, updated: true };
    } catch (error) {
        console.error("Ошибка API:", error.message);
        return { text: cache.text || "⚠️ Ошибка сервера", updated: false };
    }
}

const keyboard = new InlineKeyboard().text("🔄 Обновить", "refresh_rates");

// 1. Список ID администраторов (узнать свой ID можно у бота @userinfobot)
const ADMINS = [
    parseInt(process.env.ADMIN_USER_ID.split(',')[0]), // Ваш ID
    // Можно добавить еще ID через запятую
];

// 2. Middleware для проверки прав
const adminOnly = async (ctx, next) => {
    // Проверяем, есть ли ID пользователя в списке админов
    if (ctx.from && ADMINS.includes(ctx.from.id)) {
        return next(); // Если админ — продолжаем выполнение (вызываем команду)
    }
    
    // Если не админ — вежливо отвечаем или просто игнорируем
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({
            text: "⛔️ У вас нет прав для обновления курса.",
            show_alert: true
        });
    } else {
        await ctx.reply("❌ Эта команда доступна только администраторам.");
    }
};

// 3. Применяем middleware к команде и колбэку
bot.command("rates", adminOnly, async (ctx) => {
    const result = await getCurrencyRates(true);
    await ctx.reply(result.text, { reply_markup: keyboard, parse_mode: "HTML" });
});

bot.callbackQuery("refresh_rates", async (ctx) => {
    const result = await getCurrencyRates();

    if (!result.updated) {
        return await ctx.answerCallbackQuery({
            text: "✅ Данные актуальны",
            show_alert: false 
        });
    }

    try {
        await ctx.editMessageText(result.text, { reply_markup: keyboard, parse_mode: "HTML" });
        await ctx.answerCallbackQuery({ text: "✅ Обновлено" });
    } catch (e) {
        if (e.description && e.description.includes("message is not modified")) {
            await ctx.answerCallbackQuery({ text: "Изменений нет" });
        } else {
            console.error(e);
            await ctx.answerCallbackQuery();
        }
    }
});

bot.start();
console.log("Бот запущен с системой отслеживания трендов...");