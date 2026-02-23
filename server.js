const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');
const http = require('http'); 
const fs = require('fs'); 
const path = require('path'); 

// Настройки Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Не заданы ключи Supabase!");
    process.exit(1); 
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;

if (!TIKTOK_USERNAME) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Не задан логин TikTok!");
    process.exit(1);
}

// === УПРАВЛЕНИЕ ВИДЖЕТАМИ (Прямая связь с OBS) ===
let sseClients = [];

function broadcastToWidgets(eventData) {
    const payload = `data: ${JSON.stringify(eventData)}\n\n`;
    sseClients.forEach(client => client.write(payload));
}

// === ВЕБ-СЕРВЕР ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    // 1. Канал связи для виджета
    if (req.url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        sseClients.push(res);
        req.on('close', () => {
            sseClients = sseClients.filter(c => c !== res);
        });
        return;
    }

    // 2. Отдача самого HTML файла
    if (req.url.startsWith('/tiktok_top_widget.html')) {
        const filePath = path.join(__dirname, 'tiktok_top_widget.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Файл виджета не найден.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    } 
    
    // 3. Главная страница
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Сервер работает! Подключен к TikTok: @${TIKTOK_USERNAME}. Подключено виджетов OBS: ${sseClients.length}`);
    
}).listen(PORT, () => {
    console.log(`HTTP сервер запущен на порту ${PORT}`);
});

// === TIKTOK КОННЕКТОР ===
let tiktokLiveConnection = new WebcastPushConnection(TIKTOK_USERNAME);
let currentTop1 = { username: null, coins: 0 };

async function updateTop1Cache() {
    try {
        const { data, error } = await supabase
            .from('top_donators')
            .select('username, coins')
            .order('coins', { ascending: false })
            .limit(1)
            .single();
        
        if (data && !error) {
            currentTop1 = { username: data.username, coins: data.coins };
            console.log(`🏆 Текущий ТОП-1 в памяти: ${currentTop1.username} (${currentTop1.coins} монет)`);
        }
    } catch (e) {
        console.error("Ошибка при получении Топ 1:", e);
    }
}

// Слушаем изменения в базе (если вы накрутили монеты руками)
supabase
    .channel('server-db-listener')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'top_donators' }, () => {
        updateTop1Cache();
    })
    .subscribe();

function connectToTikTok() {
    console.log(`Подключение к стриму @${TIKTOK_USERNAME}...`);
    updateTop1Cache();
    
    tiktokLiveConnection.connect().then(state => {
        console.log(`✅ Подключено! Стрим ID: ${state.roomId}`);
    }).catch(err => {
        console.error('❌ Ошибка подключения. Повтор через 10 секунд...', err.message);
        setTimeout(connectToTikTok, 10000);
    });
}

// === СОБЫТИЕ 1: ВХОД ===
tiktokLiveConnection.on('member', async (data) => {
    const username = data.uniqueId;
    const avatar = data.profilePictureUrl;

    if (currentTop1.username && username === currentTop1.username) {
        console.log(`👑 ВНИМАНИЕ! ЗАШЕЛ ТОП 1: ${username}. Отправляем команду в OBS...`);

        // Прямая команда в виджет OBS показать анимацию!
        broadcastToWidgets({
            type: 'entrance',
            username: username,
            avatar: avatar,
            coins: currentTop1.coins
        });

        // Запись в базу для истории
        await supabase.from('stream_events').insert([{ type: 'join', username: username, avatar_url: avatar }]);
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

    await updateTop1Cache();
});

tiktokLiveConnection.on('disconnected', () => {
    console.warn('⚠️ Отключено от TikTok. Пробуем переподключиться...');
    setTimeout(connectToTikTok, 5000);
});

connectToTikTok();
