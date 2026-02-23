import React, { useState, useEffect, useRef } from 'react';
// Подключаем Supabase (используем ESM сборку для работы напрямую в браузере)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ==========================================
// 🔧 НАСТРОЙКИ SUPABASE (Вставьте свои ключи)
// ==========================================
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Если ключи не указаны, включаем демо-режим для предпросмотра
const isDemoMode = SUPABASE_URL === 'YOUR_SUPABASE_URL';

const supabase = isDemoMode ? null : createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  const [top1, setTop1] = useState({ username: 'Загрузка...', coins: 0, avatar: '' });
  const [entranceData, setEntranceData] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const timeoutRef = useRef(null);

  // Подгрузка скрипта для конфетти
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js';
    document.body.appendChild(script);
  }, []);

  // Основная логика подключения
  useEffect(() => {
    if (isDemoMode) {
      runDemoMode();
      return;
    }

    // 1. Загружаем текущего Топ-1 при старте
    fetchTop1();

    // 2. Подписываемся на изменения в реальном времени (Авто-реконнект встроен в Supabase)
    const channel = supabase
      .channel('tiktok-stream-data')
      // Слушаем изменения в таблице дарителей (чтобы обновлять плашку)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'top_donators' }, fetchTop1)
      // Слушаем события входа (таблица stream_events)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stream_events' }, (payload) => {
        handleStreamEvent(payload.new);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setIsConnected(true);
        if (status === 'CLOSED' || status === 'CHANNEL_ERROR') setIsConnected(false);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchTop1 = async () => {
    if (isDemoMode) return;
    const { data, error } = await supabase
      .from('top_donators')
      .select('*')
      .order('coins', { ascending: false })
      .limit(1)
      .single();

    if (data && !error) {
      setTop1({
        username: data.username,
        coins: data.coins,
        avatar: data.avatar_url
      });
    }
  };

  const handleStreamEvent = (event) => {
    // Если это событие входа и зашел именно наш текущий Топ-1
    if (event.type === 'join' && event.username === top1.username) {
      triggerEntranceAnimation(event.username, event.avatar_url || top1.avatar);
    }
  };

  const triggerEntranceAnimation = (username, avatar) => {
    // Сбрасываем предыдущий таймаут, если он был
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    setEntranceData({ username, avatar });
    fireConfetti();

    // Через 4 секунды скрываем анимацию (фон снова становится полностью прозрачным)
    timeoutRef.current = setTimeout(() => {
      setEntranceData(null);
    }, 4000);
  };

  const fireConfetti = () => {
    if (!window.confetti) return;
    const duration = 3000;
    const end = Date.now() + duration;

    const frame = () => {
      window.confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 }, colors: ['#FFD700', '#FFA500', '#FFFFFF'] });
      window.confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#FFD700', '#FFA500', '#FFFFFF'] });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  };

  // Демонстрационный режим для предпросмотра
  const runDemoMode = () => {
    const demoUser = { username: 'Спонсор_Джон', coins: 150000, avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=John&backgroundColor=b6e3f4' };
    setTop1(demoUser);
    setIsConnected(true);
    
    // Каждые 8 секунд симулируем вход Топ 1
    const interval = setInterval(() => {
      triggerEntranceAnimation(demoUser.username, demoUser.avatar);
    }, 8000);
    return () => clearInterval(interval);
  };

  return (
    // Главный контейнер абсолютно прозрачный
    <div className="w-screen h-screen overflow-hidden bg-transparent relative font-sans text-white">
      
      {/* 1. Постоянный виджет Топ-1 (Слева сверху) */}
      <div className="absolute top-8 left-8 bg-black/60 backdrop-blur-md border border-yellow-500/30 shadow-[0_4px_30px_rgba(0,0,0,0.5),0_0_15px_rgba(255,215,0,0.2)] rounded-2xl p-4 flex items-center space-x-4 transition-all duration-300">
        <div className="relative w-14 h-14 rounded-full border-2 border-yellow-400 overflow-hidden bg-gray-800 shrink-0">
          {top1.avatar && <img src={top1.avatar} alt="Avatar" className="w-full h-full object-cover" />}
          <div className="absolute bottom-0 w-full bg-yellow-500 text-[10px] text-black font-bold text-center leading-tight">ТОП 1</div>
        </div>
        <div>
          <div className="text-xs text-gray-300 font-semibold uppercase tracking-wider flex items-center gap-2">
            Король Стрима
            {/* Маленький индикатор коннекта к Supabase */}
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></span>
          </div>
          <div className="text-xl font-bold truncate max-w-[200px] bg-gradient-to-r from-yellow-400 via-yellow-200 to-yellow-400 bg-clip-text text-transparent drop-shadow-[0_0_5px_rgba(255,215,0,0.5)]">
            {top1.username}
          </div>
          <div className="text-sm font-medium text-yellow-300 flex items-center gap-1">
            {top1.coins.toLocaleString()} 
            <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 14a6 6 0 110-12 6 6 0 010 12zm0-9a1 1 0 00-1 1v2.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V8a1 1 0 00-1-1z" clipRule="evenodd" fillRule="evenodd"></path></svg>
          </div>
        </div>
      </div>

      {/* 2. Эпичная анимация входа (Появляется по центру, затем исчезает) */}
      <div 
        className={`absolute inset-0 flex items-center justify-center transition-all duration-700 ease-out z-50 pointer-events-none
          ${entranceData ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}
      >
        <div className="bg-black/80 backdrop-blur-xl border-2 border-yellow-400 rounded-3xl p-10 flex flex-col items-center shadow-[0_0_50px_rgba(255,215,0,0.6)]">
          <div className="text-6xl mb-4 animate-bounce">👑</div>
          
          <div className="relative w-40 h-40 rounded-full border-4 border-yellow-400 overflow-hidden mb-6 shadow-2xl">
            {/* Эффект пульсации вокруг аватара */}
            <div className="absolute inset-0 rounded-full animate-ping bg-yellow-400/30"></div>
            <img src={entranceData?.avatar} alt="Avatar" className="relative z-10 w-full h-full object-cover" />
          </div>
          
          <h2 className="text-3xl text-yellow-200 font-bold mb-2 uppercase tracking-widest drop-shadow-md">
            На стрим зашел
          </h2>
          <h1 className="text-6xl font-extrabold bg-gradient-to-r from-yellow-400 via-yellow-100 to-yellow-400 bg-clip-text text-transparent drop-shadow-[0_0_10px_rgba(255,215,0,0.8)] mb-4">
            {entranceData?.username}
          </h1>
          
          <div className="bg-yellow-500/20 px-8 py-3 rounded-full border border-yellow-500/50">
            <span className="text-yellow-400 font-bold text-xl">ТОП 1 ДАРИТЕЛЬ ЗА ВСЕ ВРЕМЯ</span>
          </div>
        </div>
      </div>

    </div>
  );
}
