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
const activeStreams = new Map(); 

function broadcastToWidgets(streamer, eventData) {
    if (activeStreams.has(streamer)) {
        const payload = `data: ${JSON.stringify(eventData)}\n\n`;
        activeStreams.get(streamer).sseClients.forEach(client => {
            try {
                client.write(payload);
            } catch (e) {
                // Игнорируем закрытые соединения
            }
        });
    }
}

// === ВЕБ-СЕРВЕР ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/events') {
        const targetStreamer = parsedUrl.query.user;
        if (!targetStreamer) {
            res.writeHead(400); 
            res.end('Missing user parameter'); 
            return;
        }

        const normalizedStreamer = targetStreamer.replace('@', '').trim().toLowerCase();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        if (!activeStreams.has(normalizedStreamer)) {
            startTikTokConnection(normalizedStreamer);
        }

        const streamData = activeStreams.get(normalizedStreamer);
        streamData.sseClients.push(res);
        res.write(`data: ${JSON.stringify({ type: 'status', online: streamData.isOnline })}\n\n`);

        // KEEP-ALIVE: Пингуем Railway каждые 20 сек
        const keepAliveInterval = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 20000);

        req.on('close', () => {
            clearInterval(keepAliveInterval);
            if (activeStreams.has(normalizedStreamer)) {
                streamData.sseClients = streamData.sseClients.filter(c => c !== res);
            }
        });
        return;
    }

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
    
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Сервер виджетов работает! Активных стримов: ${activeStreams.size}`);
    
}).listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP сервер запущен на порту ${PORT} (0.0.0.0)`);
});

// === ЛОГИКА TIKTOK ПОДКЛЮЧЕНИЯ ===
async function startTikTokConnection(streamerUsername) {
    console.log(`[${streamerUsername}] Создаем новое подключение...`);
    
    const streamData = {
        connection: new WebcastPushConnection(streamerUsername, {
            enableExtendedGiftInfo: true
        }),
        sseClients: [],
        currentTop1: { username: null, coins: 0, lastAnnounced: 0 },
        isOnline: false
    };
    activeStreams.set(streamerUsername, streamData);

    const updateTop1 = async () => {
        try {
            const { data, error } = await supabase
                .from('top_donators')
                .select('username, coins')
                .order('coins', { ascending: false })
                .limit(1);
            
            if (error) throw error;

            if (data && data.length > 0) {
                const topUser = data[0];
                const normalizedTopUser = topUser.username.toLowerCase();

                if (streamData.currentTop1.username !== normalizedTopUser) {
                    console.log(`[${streamerUsername}] 🏆 Новый ТОП-1: ${topUser.username} (${topUser.coins} монет)`);
                    streamData.currentTop1.lastAnnounced = 0; 
                }
                
                streamData.currentTop1.username = normalizedTopUser;
                streamData.currentTop1.coins = topUser.coins;
            }
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка БД:`, e.message);
        }
    };

    await updateTop1();

    const connectToStream = () => {
        streamData.connection.connect().then(state => {
            console.log(`[${streamerUsername}] ✅ Подключено! Стрим ID: ${state.roomId}`);
            streamData.isOnline = true;
            broadcastToWidgets(streamerUsername, { type: 'status', online: true });
        }).catch(err => {
            console.error(`[${streamerUsername}] ❌ Ошибка подключения. Повтор через 15 сек...`);
            streamData.isOnline = false;
            broadcastToWidgets(streamerUsername, { type: 'status', online: false });
            setTimeout(connectToStream, 15000);
        });
    };
    connectToStream();

    // === СОБЫТИЕ 1: СТРОГО ВХОД НА СТРИМ (member) ===
    streamData.connection.on('member', (data) => {
        const rawUsername = data.uniqueId;
        const incomingUser = rawUsername.toLowerCase();
        const avatar = data.profilePictureUrl;

        // Логируем всех, кто заходит (для проверки)
        console.log(`[${streamerUsername}] Зашел зритель: ${rawUsername}`);

        if (streamData.currentTop1.username && incomingUser === streamData.currentTop1.username) {
            const now = Date.now();
            
            // Кулдаун 2 минуты, чтобы не спамить анимацией, если человек перезаходит (например, лагает интернет)
            if (now - streamData.currentTop1.lastAnnounced > 120000) {
                console.log(`[${streamerUsername}] 👑 ТОП 1 ЗАШЕЛ НА СТРИМ: ${rawUsername}. Запуск анимации!`);
                streamData.currentTop1.lastAnnounced = now;

                broadcastToWidgets(streamerUsername, {
                    type: 'entrance',
                    username: rawUsername,
                    avatar: avatar,
                    coins: streamData.currentTop1.coins
                });

                supabase.from('stream_events')
                    .insert([{ type: 'join', username: rawUsername, avatar_url: avatar }])
                    .then(({ error }) => { if (error) console.error("Ошибка записи лога:", error); });
            }
        }
    });

    // === СОБЫТИЕ 2: ПОДАРКИ ===
    streamData.connection.on('gift', async (data) => {
        if (data.giftType === 1 && !data.repeatEnd) return;

        const rawUsername = data.uniqueId;
        const normalizedUsername = rawUsername.toLowerCase();
        const coins = data.diamondCount * data.repeatCount;
        const avatar = data.profilePictureUrl;

        console.log(`[${streamerUsername}] 🎁 Подарок от ${rawUsername}: ${coins} монет`);

        try {
            const { data: userRecord } = await supabase
                .from('top_donators')
                .select('coins')
                .ilike('username', normalizedUsername)
                .limit(1);

            const currentCoins = (userRecord && userRecord.length > 0) ? userRecord[0].coins : 0;

            await supabase.from('top_donators').upsert([{
                username: rawUsername,
                coins: currentCoins + coins,
                avatar_url: avatar
            }], { onConflict: 'username' });

            await updateTop1();
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка сохранения:`, e.message);
        }
    });

    // === ОБРЫВ СВЯЗИ ===
    streamData.connection.on('disconnected', () => {
        console.warn(`[${streamerUsername}] ⚠️ Стрим отключен.`);
        streamData.isOnline = false;
        broadcastToWidgets(streamerUsername, { type: 'status', online: false });
        setTimeout(connectToStream, 15000);
    });
}
