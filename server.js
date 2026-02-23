const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');
const http = require('http'); 
const fs = require('fs'); 
const path = require('path'); 
const url = require('url');

// Настройки Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Не заданы ключи Supabase!");
    process.exit(1); 
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Хранилище активных подключений к разным стримерам
const activeStreams = new Map(); 

function broadcastToWidgets(streamer, eventData) {
    if (activeStreams.has(streamer)) {
        const payload = `data: ${JSON.stringify(eventData)}\n\n`;
        activeStreams.get(streamer).sseClients.forEach(client => {
            try {
                client.write(payload);
            } catch (e) {
                console.error(`Ошибка отправки данных клиенту:`, e);
            }
        });
    }
}

// === ВЕБ-СЕРВЕР ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    // 1. Канал связи для виджета (SSE)
    if (parsedUrl.pathname === '/events') {
        const targetStreamer = parsedUrl.query.user;
        
        if (!targetStreamer) {
            res.writeHead(400); 
            res.end('Missing user parameter'); 
            return;
        }

        const normalizedStreamer = targetStreamer.toLowerCase();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Если к этому стримеру еще не подключены - подключаемся
        if (!activeStreams.has(normalizedStreamer)) {
            startTikTokConnection(normalizedStreamer);
        }

        const streamData = activeStreams.get(normalizedStreamer);
        streamData.sseClients.push(res);

        // Отправляем виджету текущий статус
        res.write(`data: ${JSON.stringify({ type: 'status', online: streamData.isOnline })}\n\n`);

        // KEEP-ALIVE: Пингуем Railway каждые 25 сек, чтобы он не закрыл соединение с OBS
        const keepAliveInterval = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 25000);

        req.on('close', () => {
            clearInterval(keepAliveInterval);
            if (activeStreams.has(normalizedStreamer)) {
                streamData.sseClients = streamData.sseClients.filter(c => c !== res);
            }
        });
        return;
    }

    // 2. Отдача самого HTML файла
    if (parsedUrl.pathname.startsWith('/tiktok_top_widget.html')) {
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
    res.end(`Сервер виджетов работает! Активных TikTok-подключений: ${activeStreams.size}`);
    
}).listen(PORT, () => {
    console.log(`HTTP сервер запущен на порту ${PORT}`);
});

// === ЛОГИКА TIKTOK ПОДКЛЮЧЕНИЯ ===
async function startTikTokConnection(streamerUsername) {
    console.log(`[${streamerUsername}] Создаем новое подключение...`);
    
    const streamData = {
        connection: new WebcastPushConnection(streamerUsername, {
            enableExtendedGiftInfo: true,
            enableWebsocketUpgrade: true
        }),
        sseClients: [],
        currentTop1: { username: null, coins: 0, lastAnnounced: 0 },
        isOnline: false
    };
    activeStreams.set(streamerUsername, streamData);

    // Безопасное обновление Топ-1
    const updateTop1 = async () => {
        try {
            // Используем limit(1) вместо single(), чтобы избежать краша при пустой БД
            const { data, error } = await supabase
                .from('top_donators')
                .select('username, coins')
                .order('coins', { ascending: false })
                .limit(1);
            
            if (error) throw error;

            if (data && data.length > 0) {
                const topUser = data[0];
                const normalizedTopUser = topUser.username.toLowerCase();

                // Проверяем, сменился ли лидер
                if (streamData.currentTop1.username !== normalizedTopUser) {
                    console.log(`[${streamerUsername}] 🏆 Новый ТОП-1: ${topUser.username} (${topUser.coins} монет)`);
                    streamData.currentTop1.lastAnnounced = 0; // Сбрасываем кулдаун
                }
                
                streamData.currentTop1.username = normalizedTopUser;
                streamData.currentTop1.coins = topUser.coins;
            } else {
                console.log(`[${streamerUsername}] База донатеров пока пуста.`);
            }
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка обновления Топ 1:`, e.message);
        }
    };

    await updateTop1();

    // Попытка подключения
    const connectToStream = () => {
        streamData.connection.connect().then(state => {
            console.log(`[${streamerUsername}] ✅ Подключено! Стрим ID: ${state.roomId}`);
            streamData.isOnline = true;
            broadcastToWidgets(streamerUsername, { type: 'status', online: true });
        }).catch(err => {
            console.error(`[${streamerUsername}] ❌ Офлайн или ошибка. Повтор через 15 сек...`);
            streamData.isOnline = false;
            broadcastToWidgets(streamerUsername, { type: 'status', online: false });
            setTimeout(connectToStream, 15000);
        });
    };
    connectToStream();

    // ЕДИНАЯ ФУНКЦИЯ ПРОВЕРКИ АКТИВНОСТИ ТОП-1
    const checkAndAnnounceTop1 = async (rawUsername, avatar, actionType) => {
        if (!streamData.currentTop1.username || !rawUsername) return;

        const incomingUser = rawUsername.toLowerCase();

        if (incomingUser === streamData.currentTop1.username) {
            const now = Date.now();
            
            // Кулдаун 2 минуты
            if (now - streamData.currentTop1.lastAnnounced > 120000) {
                console.log(`[${streamerUsername}] 👑 ВНИМАНИЕ! ТОП 1 АКТИВЕН (${actionType}): ${rawUsername}`);
                streamData.currentTop1.lastAnnounced = now;

                broadcastToWidgets(streamerUsername, {
                    type: 'entrance',
                    username: rawUsername, // Отправляем оригинальный ник для красивого отображения
                    avatar: avatar,
                    coins: streamData.currentTop1.coins
                });

                // Пишем в БД асинхронно, не блокируя поток
                supabase.from('stream_events')
                    .insert([{ type: 'join', username: rawUsername, avatar_url: avatar }])
                    .then(({ error }) => { if (error) console.error("Ошибка записи события:", error); });
            }
        }
    };

    // Слушаем активность
    streamData.connection.on('member', (data) => checkAndAnnounceTop1(data.uniqueId, data.profilePictureUrl, 'зашел на стрим'));
    streamData.connection.on('chat', (data) => checkAndAnnounceTop1(data.uniqueId, data.profilePictureUrl, 'написал в чат'));
    streamData.connection.on('like', (data) => checkAndAnnounceTop1(data.uniqueId, data.profilePictureUrl, 'отправил лайк'));

    // Обработка подарков
    streamData.connection.on('gift', async (data) => {
        if (data.giftType === 1 && !data.repeatEnd) return; // Игнорируем промежуточные комбо

        const rawUsername = data.uniqueId;
        const normalizedUsername = rawUsername.toLowerCase();
        const coins = data.diamondCount * data.repeatCount;
        const avatar = data.profilePictureUrl;

        console.log(`[${streamerUsername}] 🎁 Подарок от ${rawUsername}: ${coins} монет!`);

        try {
            // Ищем пользователя (без учета регистра)
            const { data: userRecord } = await supabase
                .from('top_donators')
                .select('coins')
                .ilike('username', normalizedUsername)
                .limit(1);

            const currentCoins = (userRecord && userRecord.length > 0) ? userRecord[0].coins : 0;

            await supabase.from('top_donators').upsert([{
                username: rawUsername, // Храним оригинальный кейс
                coins: currentCoins + coins,
                avatar_url: avatar
            }], { onConflict: 'username' });

            await updateTop1();
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка сохранения подарка:`, e.message);
        }
    });

    // Обработка дисконнекта
    streamData.connection.on('disconnected', () => {
        console.warn(`[${streamerUsername}] ⚠️ Стрим закончился или отключен.`);
        streamData.isOnline = false;
        broadcastToWidgets(streamerUsername, { type: 'status', online: false });
        setTimeout(connectToStream, 15000);
    });
}
