const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');
const http = require('http'); 
const fs = require('fs'); 
const path = require('path'); 
const url = require('url');

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
            try { client.write(payload); } catch (e) {}
        });
    }
}

// === ВЕБ-СЕРВЕР И АДМИНКА ===
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 1. ПАНЕЛЬ УПРАВЛЕНИЯ (Главная страница)
    if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Панель управления TikTok Виджетом</title>
                <script src="https://cdn.tailwindcss.com"></script>
            </head>
            <body class="bg-gray-900 text-white min-h-screen p-8 font-sans">
                <div class="max-w-2xl mx-auto bg-gray-800 p-8 rounded-2xl shadow-2xl border border-gray-700">
                    <h1 class="text-3xl font-bold mb-2 text-yellow-400">Настройки Виджета 👑</h1>
                    <p class="text-gray-400 mb-8">Управление фоновым подключением к стримам TikTok</p>
                    
                    <div class="space-y-6">
                        <div class="bg-gray-700/50 p-6 rounded-xl border border-gray-600">
                            <label class="block text-sm font-medium text-gray-300 mb-2">Логин TikTok стримера (без @)</label>
                            <div class="flex gap-4">
                                <input type="text" id="streamerInput" placeholder="Например: nneensi0" class="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-yellow-500" oninput="checkStatusDebounced()">
                                <button id="connectBtn" onclick="toggleConnection()" class="bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-6 py-3 rounded-lg transition shadow-[0_0_15px_rgba(234,179,8,0.3)] min-w-[140px]">Подключить</button>
                            </div>

                            <!-- Контейнер для ссылки на виджет -->
                            <div id="widgetLinkContainer" class="hidden mt-6 p-4 bg-gray-900/80 border border-yellow-500/30 rounded-lg">
                                <p class="text-sm text-yellow-400/80 mb-2 font-semibold">✅ Подключено! Ссылка для OBS (Браузерный источник):</p>
                                <div class="flex items-center gap-2">
                                    <input type="text" id="widgetLink" readonly class="flex-1 bg-black/50 border border-gray-600 rounded px-3 py-2 text-gray-300 text-sm focus:outline-none selection:bg-yellow-500/30">
                                    <button onclick="copyLink()" class="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded text-sm transition font-medium">Копировать</button>
                                </div>
                                <p class="text-xs text-gray-500 mt-2">Установите ширину 1920 и высоту 1080 в настройках OBS.</p>
                            </div>
                        </div>

                        <div class="bg-gray-700/50 p-6 rounded-xl border border-gray-600 flex justify-between items-center">
                            <div>
                                <h3 class="font-bold text-lg">Тест Анимации</h3>
                                <p class="text-sm text-gray-400">Показать текущего Топ-1 в OBS прямо сейчас</p>
                            </div>
                            <button onclick="testAnimation()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-3 rounded-lg transition shadow-[0_0_15px_rgba(37,99,235,0.3)]">Запустить Тест</button>
                        </div>
                        
                        <div id="statusBox" class="p-4 rounded-lg bg-gray-900 border border-gray-700 text-sm font-mono text-gray-300 min-h-[120px] max-h-[200px] overflow-y-auto">
                            Статус системы: Готов.
                        </div>
                    </div>
                </div>

                <script>
                    function log(msg) {
                        const box = document.getElementById('statusBox');
                        const time = new Date().toLocaleTimeString();
                        box.innerHTML = '<span class="text-gray-500">[' + time + ']</span> ' + msg + '<br>' + box.innerHTML;
                    }

                    function updateUI(connected, user) {
                        const btn = document.getElementById('connectBtn');
                        const linkBox = document.getElementById('widgetLinkContainer');
                        const linkInput = document.getElementById('widgetLink');

                        if (connected) {
                            btn.textContent = 'Отключить';
                            btn.className = 'bg-red-600 hover:bg-red-500 text-white font-bold px-6 py-3 rounded-lg transition shadow-[0_0_15px_rgba(220,38,38,0.3)] min-w-[140px]';
                            linkBox.classList.remove('hidden');
                            
                            // Генерируем ссылку для OBS
                            const currentUrl = window.location.origin;
                            linkInput.value = currentUrl + '/tiktok_top_widget.html?user=' + user;
                        } else {
                            btn.textContent = 'Подключить';
                            btn.className = 'bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-6 py-3 rounded-lg transition shadow-[0_0_15px_rgba(234,179,8,0.3)] min-w-[140px]';
                            linkBox.classList.add('hidden');
                        }
                    }

                    let debounceTimer;
                    function checkStatusDebounced() {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(checkStatus, 500);
                    }

                    async function checkStatus() {
                        const user = document.getElementById('streamerInput').value.trim().toLowerCase();
                        if (!user) {
                            updateUI(false, '');
                            return;
                        }
                        try {
                            const res = await fetch('/api/status?user=' + user);
                            const data = await res.json();
                            updateUI(data.connected, user);
                        } catch(e) {}
                    }

                    async function toggleConnection() {
                        const user = document.getElementById('streamerInput').value.trim().toLowerCase();
                        if(!user) return alert('Введите логин стримера!');

                        const btn = document.getElementById('connectBtn');
                        const isConnected = btn.textContent === 'Отключить';

                        if (isConnected) {
                            log('Отключение от @' + user + '...');
                            try {
                                const res = await fetch('/api/disconnect?user=' + user);
                                log(await res.text());
                                updateUI(false, user);
                            } catch(e) { log('Ошибка отключения'); }
                        } else {
                            log('Запрос на подключение к @' + user + '...');
                            try {
                                const res = await fetch('/api/connect?user=' + user);
                                log(await res.text());
                                updateUI(true, user);
                            } catch(e) { log('Ошибка подключения'); }
                        }
                    }

                    async function testAnimation() {
                        const user = document.getElementById('streamerInput').value.trim().toLowerCase();
                        if(!user) return alert('Сначала введите логин стримера!');
                        log('Отправка тестового сигнала для @' + user + '...');
                        try {
                            const res = await fetch('/api/test?user=' + user);
                            log(await res.text());
                        } catch(e) { log('Ошибка тестового сигнала'); }
                    }

                    function copyLink() {
                        const linkInput = document.getElementById('widgetLink');
                        linkInput.select();
                        linkInput.setSelectionRange(0, 99999);
                        document.execCommand('copy');
                        log('Ссылка скопирована в буфер обмена!');
                    }

                    // Проверяем статус при загрузке страницы, если браузер запомнил ввод
                    window.onload = checkStatus;
                </script>
            </body>
            </html>
        `);
        return;
    }

    // 2. API: РУЧНОЕ ПОДКЛЮЧЕНИЕ
    if (pathname === '/api/connect') {
        const targetStreamer = parsedUrl.query.user?.toLowerCase();
        if (!targetStreamer) return res.end("Ошибка: не указан логин.");
        
        if (!activeStreams.has(targetStreamer)) {
            startTikTokConnection(targetStreamer);
            res.end(`✅ Фоновый процесс запущен для @${targetStreamer}. Подключение в процессе...`);
        } else {
            res.end(`ℹ️ Сервер уже подключен к @${targetStreamer}.`);
        }
        return;
    }

    // 3. API: РУЧНОЕ ОТКЛЮЧЕНИЕ
    if (pathname === '/api/disconnect') {
        const targetStreamer = parsedUrl.query.user?.toLowerCase();
        if (!targetStreamer) return res.end("Ошибка: не указан логин.");
        
        if (activeStreams.has(targetStreamer)) {
            const streamData = activeStreams.get(targetStreamer);
            streamData.intentionalDisconnect = true; // Флаг, чтобы предотвратить авто-реконнект
            
            try { streamData.connection.disconnect(); } catch (e) {}
            
            // Сообщаем открытым виджетам (если есть), что стрим отключен
            broadcastToWidgets(targetStreamer, { type: 'status', online: false });
            
            // Закрываем все активные SSE соединения
            streamData.sseClients.forEach(client => client.end());
            
            activeStreams.delete(targetStreamer);
            res.end(`🛑 Отключено от @${targetStreamer}. Фоновый процесс остановлен.`);
        } else {
            res.end(`ℹ️ Активного подключения к @${targetStreamer} не найдено.`);
        }
        return;
    }

    // 4. API: СТАТУС ПОДКЛЮЧЕНИЯ
    if (pathname === '/api/status') {
        const targetStreamer = parsedUrl.query.user?.toLowerCase();
        const isConnected = targetStreamer ? activeStreams.has(targetStreamer) : false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connected: isConnected }));
        return;
    }

    // 5. API: ТЕСТОВЫЙ ЗАПУСК АНИМАЦИИ
    if (pathname === '/api/test') {
        const targetStreamer = parsedUrl.query.user?.toLowerCase();
        if (!targetStreamer || !activeStreams.has(targetStreamer)) {
            return res.end("❌ Сначала подключитесь к стримеру (кнопка Подключить).");
        }
        
        const streamData = activeStreams.get(targetStreamer);
        if (streamData.currentTop1.username) {
            broadcastToWidgets(targetStreamer, {
                type: 'entrance',
                username: streamData.currentTop1.username,
                avatar: streamData.currentTop1.avatar,
                coins: streamData.currentTop1.coins,
                isTest: true
            });
            res.end(`✅ Сигнал отправлен! Топ-1: ${streamData.currentTop1.username}`);
        } else {
            res.end("❌ В базе пока нет Топ-1 дарителя для запуска теста.");
        }
        return;
    }

    // 6. SSE КАНАЛ ДЛЯ ВИДЖЕТА (OBS)
    if (pathname === '/events') {
        const targetStreamer = parsedUrl.query.user;
        if (!targetStreamer) return res.end();

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

        const keepAliveInterval = setInterval(() => { res.write(': keepalive\n\n'); }, 20000);

        req.on('close', () => {
            clearInterval(keepAliveInterval);
            if (activeStreams.has(normalizedStreamer)) {
                streamData.sseClients = streamData.sseClients.filter(c => c !== res);
            }
        });
        return;
    }

    // 7. ОТДАЧА HTML ВИДЖЕТА
    if (pathname.startsWith('/tiktok_top_widget.html')) {
        const filePath = path.join(__dirname, 'tiktok_top_widget.html');
        fs.readFile(filePath, (err, data) => {
            if (err) return res.end('Файл виджета не найден.');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    } 
    
    res.end();
}).listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP сервер запущен на порту ${PORT}`);
});

// === ЛОГИКА TIKTOK ПОДКЛЮЧЕНИЯ ===
async function startTikTokConnection(streamerUsername) {
    console.log(`[${streamerUsername}] Создаем фоновое подключение...`);
    
    const streamData = {
        connection: new WebcastPushConnection(streamerUsername, { enableExtendedGiftInfo: true }),
        sseClients: [],
        currentTop1: { username: null, coins: 0, avatar: '', lastAnnounced: 0 },
        isOnline: false,
        intentionalDisconnect: false
    };
    activeStreams.set(streamerUsername, streamData);

    const updateTop1 = async (checkForNewLeader = false) => {
        try {
            const { data, error } = await supabase
                .from('top_donators')
                .select('username, coins, avatar_url')
                .order('coins', { ascending: false })
                .limit(1);
            
            if (error) throw error;

            if (data && data.length > 0) {
                const topUser = data[0];
                const normalizedTopUser = topUser.username.toLowerCase();
                const oldLeader = streamData.currentTop1.username;

                // === ЛОГИКА СМЕНЫ ЛИДЕРА ===
                if (checkForNewLeader && oldLeader && oldLeader !== normalizedTopUser) {
                    console.log(`[${streamerUsername}] 🚨 НОВЫЙ ТОП-1 ДАРИТЕЛЬ: ${topUser.username} перебил рекорд!`);
                    
                    broadcastToWidgets(streamerUsername, {
                        type: 'entrance',
                        username: topUser.username,
                        avatar: topUser.avatar_url,
                        coins: topUser.coins,
                        isNewLeader: true 
                    });
                }

                if (oldLeader !== normalizedTopUser) {
                    streamData.currentTop1.lastAnnounced = 0; 
                }
                
                streamData.currentTop1.username = normalizedTopUser;
                streamData.currentTop1.coins = topUser.coins;
                streamData.currentTop1.avatar = topUser.avatar_url;
            }
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка БД:`, e.message);
        }
    };

    await updateTop1(false);

    const connectToStream = () => {
        streamData.connection.connect().then(state => {
            console.log(`[${streamerUsername}] ✅ Подключено! Стрим ID: ${state.roomId}`);
            streamData.isOnline = true;
            broadcastToWidgets(streamerUsername, { type: 'status', online: true });
        }).catch(err => {
            if (streamData.intentionalDisconnect) return;
            console.error(`[${streamerUsername}] ❌ Ошибка подключения. Повтор через 15 сек...`);
            streamData.isOnline = false;
            broadcastToWidgets(streamerUsername, { type: 'status', online: false });
            setTimeout(connectToStream, 15000);
        });
    };
    connectToStream();

    // === СОБЫТИЕ 1: ВХОД НА СТРИМ ===
    streamData.connection.on('member', (data) => {
        const rawUsername = data.uniqueId;
        const incomingUser = rawUsername.toLowerCase();
        const avatar = data.profilePictureUrl;

        if (streamData.currentTop1.username && incomingUser === streamData.currentTop1.username) {
            const now = Date.now();
            
            if (now - streamData.currentTop1.lastAnnounced > 120000) {
                console.log(`[${streamerUsername}] 👑 ТОП 1 ЗАШЕЛ НА СТРИМ: ${rawUsername}`);
                streamData.currentTop1.lastAnnounced = now;

                broadcastToWidgets(streamerUsername, {
                    type: 'entrance',
                    username: rawUsername,
                    avatar: avatar,
                    coins: streamData.currentTop1.coins,
                    isNewLeader: false
                });

                supabase.from('stream_events').insert([{ type: 'join', username: rawUsername, avatar_url: avatar }]).catch(()=>{});
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

            await updateTop1(true);
        } catch (e) {
            console.error(`[${streamerUsername}] Ошибка сохранения:`, e.message);
        }
    });

    // === ОБРЫВ СВЯЗИ ===
    streamData.connection.on('disconnected', () => {
        if (streamData.intentionalDisconnect) {
            console.log(`[${streamerUsername}] 🛑 Умышленное отключение. Авто-реконнект отменен.`);
            return;
        }
        console.warn(`[${streamerUsername}] ⚠️ Стрим отключен. Переподключение через 15 сек...`);
        streamData.isOnline = false;
        broadcastToWidgets(streamerUsername, { type: 'status', online: false });
        setTimeout(connectToStream, 15000);
    });
}
