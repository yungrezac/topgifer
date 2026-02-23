const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');
const http = require('http'); 
const fs = require('fs'); 
const path = require('path'); 

// Настройки Supabase (берем из переменных окружения Railway)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Логин стримера в TikTok (тоже из переменных окружения)
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;

// === ВЕБ-СЕРВЕР (Для отдачи HTML в OBS и поддержания Railway) ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    // Если запрашивают страницу виджета
    if (req.url.startsWith('/tiktok_top_widget.html')) {
        const filePath = path.join(__dirname, 'tiktok_top_widget.html');
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Файл виджета не найден. Убедитесь, что tiktok_top_widget.html загружен на сервер.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } 
    // Для всех остальных ссылок
    else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Сервер работает и слушает TikTok стримера: @${TIKTOK_USERNAME}. Чтобы открыть виджет, добавьте к ссылке /tiktok_top_widget.html?obs=1`);
    }
}).listen(PORT, () => {
    console.log(`HTTP сервер запущен на порту ${PORT}`);
});
// ======================================

// Создаем подключение к TikTok
let tiktokLiveConnection = new WebcastPushConnection(TIKTOK_USERNAME);
let currentTop1Username = null;

// Функция для обновления текущего Топ-1 из базы
async function updateTop1Cache() {
    try {
        const { data, error } = await supabase
            .from('top_donators')
            .select('username')
            .order('coins', { ascending: false })
            .limit(1)
            .single();
        
        if (data && !error) {
            currentTop1Username = data.username;
        }
    } catch (e) {
        console.error("Ошибка при получении Топ 1:", e);
    }
}

// Функция старта с авто-реконнектом
function connectToTikTok() {
    console.log(`Подключение к стриму @${TIKTOK_USERNAME}...`);
    
    // Получаем актуального лидера перед стартом
    updateTop1Cache();
    
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

    // Срабатываем ТОЛЬКО если зашел лидер
    if (currentTop1Username && username === currentTop1Username) {
        console.log(`👑 ВНИМАНИЕ! ЗАШЕЛ ТОП 1: ${username}`);

        await supabase.from('stream_events').insert([{
            type: 'join',
            username: username,
            avatar_url: avatar
        }]);
    }
});

// === СОБЫТИЕ 2: ПОДАРОК ===
tiktokLiveConnection.on('gift', async (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;

    const username = data.uniqueId;
    const coins = data.diamondCount * data.repeatCount;
    const avatar = data.profilePictureUrl;

    console.log(`🎁 Подарок от ${username}: ${coins} монет!`);

    const { data: userRecord } = await supabase
        .from('top_donators')
        .select('coins')
        .eq('username', username)
        .single();

    const currentCoins = userRecord ? userRecord.coins : 0;

    await supabase.from('top_donators').upsert([{
        username: username,
        coins: currentCoins + coins,
        avatar_url: avatar
    }], { onConflict: 'username' });

    // Обновляем кэш Топ-1, так как после подарка лидер мог смениться
    await updateTop1Cache();
});

// === ОБРЫВ СВЯЗИ ===
tiktokLiveConnection.on('disconnected', () => {
    console.warn('⚠️ Отключено от TikTok. Пробуем переподключиться...');
    setTimeout(connectToTikTok, 5000);
});

// Запуск
connectToTikTok();
