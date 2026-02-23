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
// Позволяет подключать виджеты к разным стримерам одновременно
const activeStreams = new Map(); 

function broadcastToWidgets(streamer, eventData) {
    if (activeStreams.has(streamer)) {
        const payload = `data: ${JSON.stringify(eventData)}\n\n`;
        activeStreams.get(streamer).sseClients.forEach(client => client.write(payload));
    }
}

// === ВЕБ-СЕРВЕР ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    // 1. Канал связи для виджета (считываем имя стримера из URL)
    if (parsedUrl.pathname === '/events') {
        const targetStreamer = parsedUrl.query.user;
        
        if (!targetStreamer) {
            res.writeHead(400); 
            res.end('Missing user parameter'); 
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Если к этому стримеру еще не подключены - подключаемся
        if (!activeStreams.has(targetStreamer)) {
            startTikTokConnection(targetStreamer);
        }

        const streamData = activeStreams.get(targetStreamer);
        streamData.sseClients.push(res);

        // Сразу отправляем виджету текущий статус (онлайн или офлайн)
        res.write(`data: ${JSON.stringify({ type: 'status', online: streamData.isOnline })}\n\n`);

        req.on('close', () => {
            streamData.sseClients = streamData.sseClients.filter(c => c !== res);
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
        connection: new WebcastPushConnection(streamerUsername),
        sseClients: [],
        currentTop1: { username: null, coins: 0, lastAnnounced: 0 }, // Добавили lastAnnounced для кулдауна
        isOnline: false
    };
    activeStreams.set(streamerUsername, streamData);

    // Функция обновления Топ-1 для этого стримера
    const updateTop1 = async () => {
        try {
            const { data, error } = await supabase
                .from('top_donators')
                .select('username, coins')
                .order('coins', { ascending: false })
                .limit(1)
                .single();
            
            if (data && !error) {
                // Если Топ 1 сменился, пишем в лог
                if (streamData.currentTop1.username !== data.username) {
                    console.log(`[${streamerUsername}] 🏆 Новый ТОП-1: ${data.username} (${data.coins} монет)`);
                    streamData.currentTop1.lastAnnounced = 0; // Сбрасываем кулдаун для нового лидера
                }
                streamData.currentTop1.username = data.username;
                streamData.currentTop1.coins = data.coins;
            }
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка обновления Топ 1:`, e);
        }
    };

    // Загружаем лидера сразу
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

    // === ЕДИНАЯ ФУНКЦИЯ ПРОВЕРКИ АКТИВНОСТИ ТОП-1 ===
    // TikTok часто "глотает" события входа. Поэтому мы ловим любую активность!
    const checkAndAnnounceTop1 = async (username, avatar, actionType) => {
        if (streamData.currentTop1.username && username === streamData.currentTop1.username) {
            const now = Date.now();
            
            // Кулдаун 2 минуты (120000 мс). Чтобы виджет не спамил, если ТОП-1 активно пишет в чат.
            if (now - streamData.currentTop1.lastAnnounced > 120000) {
                console.log(`[${streamerUsername}] 👑 ВНИМАНИЕ! ТОП 1 АКТИВЕН (${actionType}): ${username}`);
                streamData.currentTop1.lastAnnounced = now;

                broadcastToWidgets(streamerUsername, {
                    type: 'entrance',
                    username: username,
                    avatar: avatar,
                    coins: streamData.currentTop1.coins
                });

                await supabase.from('stream_events').insert([{ type: 'join', username: username, avatar_url: avatar }]);
            }
        }
    };

    // Слушаем сразу ТРИ типа событий для максимальной надежности:
    streamData.connection.on('member', (data) => checkAndAnnounceTop1(data.uniqueId, data.profilePictureUrl, 'зашел на стрим'));
    streamData.connection.on('chat', (data) => checkAndAnnounceTop1(data.uniqueId, data.profilePictureUrl, 'написал в чат'));
    streamData.connection.on('like', (data) => checkAndAnnounceTop1(data.uniqueId, data.profilePictureUrl, 'отправил лайк'));

    // === СОБЫТИЕ 2: ПОДАРОК ===
    streamData.connection.on('gift', async (data) => {
        if (data.giftType === 1 && !data.repeatEnd) return;

        const username = data.uniqueId;
        const coins = data.diamondCount * data.repeatCount;
        const avatar = data.profilePictureUrl;

        console.log(`[${streamerUsername}] 🎁 Подарок от ${username}: ${coins} монет!`);

        const { data: userRecord } = await supabase.from('top_donators').select('coins').eq('username', username).single();
        const currentCoins = userRecord ? userRecord.coins : 0;

        await supabase.from('top_donators').upsert([{
            username: username,
            coins: currentCoins + coins,
            avatar_url: avatar
        }], { onConflict: 'username' });

        // Важно: После каждого подарка сразу пересчитываем лидера!
        await updateTop1();
    });

    // === ОБРЫВ СВЯЗИ ===
    streamData.connection.on('disconnected', () => {
        console.warn(`[${streamerUsername}] ⚠️ Стрим закончился или отключен.`);
        streamData.isOnline = false;
        broadcastToWidgets(streamerUsername, { type: 'status', online: false });
        setTimeout(connectToStream, 15000); // Пытаемся переподключиться
    });
}
