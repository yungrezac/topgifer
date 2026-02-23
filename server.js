const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');
const http = require('http'); // Добавляем встроенный модуль http

// Настройки Supabase (теперь берем из переменных окружения Railway)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Логин стримера в TikTok (тоже из переменных окружения)
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;

// === СОЗДАЕМ ВЕБ-СЕРВЕР ДЛЯ RAILWAY ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Виджет TikTok Топ-1 работает и слушает стрим: ' + TIKTOK_USERNAME);
}).listen(PORT, () => {
    console.log(`HTTP сервер запущен на порту ${PORT}`);
});
// ======================================

// Создаем подключение
let tiktokLiveConnection = new WebcastPushConnection(TIKTOK_USERNAME);

// Функция старта с авто-реконнектом
function connectToTikTok() {
    console.log(`Подключение к стриму @${TIKTOK_USERNAME}...`);
    
    tiktokLiveConnection.connect().then(state => {
        console.log(`✅ Подключено! Стрим ID: ${state.roomId}`);
    }).catch(err => {
        console.error('❌ Ошибка подключения. Повтор через 10 секунд...', err.message);
        setTimeout(connectToTikTok, 10000);
    });
}

// === СОБЫТИЕ 1: ПОЛЬЗОВАТЕЛЬ ЗАШЕЛ НА СТРИМ ===
tiktokLiveConnection.on('member', async (data) => {
    const username = data.uniqueId;
    const avatar = data.profilePictureUrl;

    console.log(`👋 Зашел: ${username}`);

    // Отправляем событие в Supabase
    await supabase.from('stream_events').insert([{
        type: 'join',
        username: username,
        avatar_url: avatar
    }]);
});

// === СОБЫТИЕ 2: ПОДАРОК ===
tiktokLiveConnection.on('gift', async (data) => {
    // Учитываем только подарки, которые полностью отправились (не комбо в процессе)
    if (data.giftType === 1 && !data.repeatEnd) return;

    const username = data.uniqueId;
    const coins = data.diamondCount * data.repeatCount;
    const avatar = data.profilePictureUrl;

    console.log(`🎁 Подарок от ${username}: ${coins} монет!`);

    // Обновляем счетчик дарителя в Supabase (Upsert - добавит или обновит)
    // 1. Получаем текущие монеты
    const { data: userRecord } = await supabase
        .from('top_donators')
        .select('coins')
        .eq('username', username)
        .single();

    const currentCoins = userRecord ? userRecord.coins : 0;

    // 2. Сохраняем новую сумму
    await supabase.from('top_donators').upsert([{
        username: username,
        coins: currentCoins + coins,
        avatar_url: avatar
    }], { onConflict: 'username' });
});

// Обработка дисконнекта (например стрим закончился или лаг сети)
tiktokLiveConnection.on('disconnected', () => {
    console.warn('⚠️ Отключено от TikTok. Пробуем переподключиться...');
    setTimeout(connectToTikTok, 5000);
});

// Запуск
connectToTikTok();
