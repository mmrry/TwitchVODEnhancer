// ==UserScript==
// @name         TwitchVODEnhancer (2026)
// @namespace    https://github.com/sooqua/
// @version      1.3.0
// @description  Chat-activity heatmap on the Twitch VOD seekbar (GQL rewrite of sooqua/TwitchVODEnhancer)
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    // ------------------------------------------------------------------ config
    const CFG = {
        binSec: 60,          // ширина одного столбца тепловой карты, сек
        stripHeight: 6,      // высота полосы под seekbar, px
        hitPad: 3,           // доп. зона наведения сверху/снизу полосы, px
        labelOffset: 22,     // на сколько px выше seekbar показывать прогресс загрузки
        labelHideDelay: 15000, // скрыть прогресс через N мс после 100%
        concurrency: 4,      // параллельных «воркеров» по сегментам VOD
        reqDelay: 60,        // пауза между запросами внутри воркера, мс
        percentile: 0.98,    // нормализация по перцентилю, чтобы один спайк не «гасил» всё
        autoLoad: false,     // true — строить карту сразу при открытии VOD, без кнопки
        debug: true,         // логи в консоль с префиксом [TVE]
    };
    const DEFAULT_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';
    const FALLBACK_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    const GRADIENT = [
        [0, [0, 0, 0]], [25, [60, 100, 90]], [30, [132, 220, 198]], [33, [165, 255, 214]],
        [35, [255, 222, 158]], [85, [255, 166, 158]], [100, [255, 104, 107]],
    ];

    const log = (...a) => CFG.debug && console.log('%c[TVE]', 'color:#a970ff;font-weight:bold', ...a);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

    // ------------------------------------- 1. перехват заголовков GQL страницы
    // Client-Integrity сгенерировать самому нельзя — берём у самого Twitch.
    const KEEP = ['client-id', 'client-integrity', 'authorization', 'x-device-id',
        'client-session-id', 'client-version', 'accept-language'];
    const captured = { headers: null, hash: null };
    const waiters = [];
    const origFetch = window.fetch;

    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.startsWith('https://gql.twitch.tv/gql')) {
                const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
                if (h.get('client-integrity')) {
                    const o = {};
                    KEEP.forEach(k => { const v = h.get(k); if (v) o[k] = v; });
                    if (!captured.headers) log('headers captured:', Object.keys(o).join(', '));
                    captured.headers = o;
                    waiters.splice(0).forEach(fn => fn());
                }
                const body = init && init.body;
                if (typeof body === 'string' && body.includes('VideoCommentsByOffsetOrCursor')) {
                    for (const op of [].concat(JSON.parse(body))) {
                        const hash = op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
                        if (op.operationName === 'VideoCommentsByOffsetOrCursor' && hash && hash !== captured.hash) {
                            captured.hash = hash;
                            log('comments hash:', hash);
                        }
                    }
                }
            }
        } catch (e) { log('hook error', e); }
        return origFetch.apply(this, arguments);
    };

    function waitHeaders(timeout = 15000) {
        if (captured.headers) return Promise.resolve(true);
        return new Promise(res => {
            const t = setTimeout(() => res(false), timeout);
            waiters.push(() => { clearTimeout(t); res(true); });
        });
    }

    // ------------------------------------------------------------- 2. GQL
    async function gql(body) {
        const headers = {
            'Content-Type': 'text/plain;charset=UTF-8',
            ...(captured.headers || { 'client-id': FALLBACK_CLIENT_ID }),
        };
        const r = await origFetch.call(window, 'https://gql.twitch.tv/gql', {
            method: 'POST', headers, body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j)}`);
        if (j.errors && j.errors.length) throw new Error('GQL: ' + j.errors.map(e => e.message).join('; '));
        return j.data;
    }

    const commentsQuery = (videoID, vars) => ({
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables: { videoID, ...vars },
        extensions: { persistedQuery: { version: 1, sha256Hash: captured.hash || DEFAULT_HASH } },
    });

    async function fetchPage(vid, vars) {
        for (let a = 0; ; a++) {
            try { return await gql(commentsQuery(vid, vars)); }
            catch (e) {
                if (a >= 4) throw e;
                log(`retry ${a + 1} (${JSON.stringify(vars)}):`, e.message);
                if (/integrity/i.test(e.message)) {   // токен протух — ждём свежий от страницы
                    captured.headers = null;
                    await waitHeaders(30000);
                }
                await sleep(1000 * 2 ** a);
            }
        }
    }

    async function getDuration(vid) {
        try {
            const d = await gql({ query: `query{video(id:"${vid}"){lengthSeconds}}` });
            if (d && d.video && d.video.lengthSeconds) return d.video.lengthSeconds;
        } catch (e) { log('lengthSeconds via GQL failed, fallback to <video>:', e.message); }
        for (let i = 0; i < 60; i++) {
            const v = document.querySelector('video');
            if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
            await sleep(500);
        }
        throw new Error('cannot determine VOD duration');
    }

    // ---------------------------------------------------- 3. сбор комментариев
    async function crawlSegment(st, k, start, end) {
        let vars = { contentOffsetSeconds: Math.floor(start) };
        const n = st.bins.length;
        while (!st.aborted) {
            const data = await fetchPage(st.vid, vars);
            const c = data && data.video && data.video.comments;
            if (!c) throw new Error('unexpected response: ' + JSON.stringify(data).slice(0, 300));
            let cursor = null;
            for (const e of c.edges || []) {
                cursor = e.cursor || cursor;
                const t = e.node && e.node.contentOffsetSeconds;
                if (t == null || t < start) continue;   // перекрытие с предыдущим сегментом
                if (t >= end) { st.segProgress[k] = 1; return; }
                st.bins[Math.min(Math.floor(t / CFG.binSec), n - 1)]++;
                st.total++;
                st.segProgress[k] = isFinite(end) ? (t - start) / (end - start) : t / st.duration;
            }
            scheduleDraw(st);
            if (!c.pageInfo || !c.pageInfo.hasNextPage || !cursor) { st.segProgress[k] = 1; return; }
            vars = { cursor };
            await sleep(CFG.reqDelay);
        }
    }

    // ------------------------------------------------------------ 4. отрисовка
    function pickColor(p) {
        for (let i = 1; i < GRADIENT.length; i++) {
            const [x1, c1] = GRADIENT[i - 1], [x2, c2] = GRADIENT[i];
            if (p <= x2) {
                const t = (p - x1) / (x2 - x1);
                return c1.map((v, j) => Math.round(v + (c2[j] - v) * t));
            }
        }
        return GRADIENT[GRADIENT.length - 1][1];
    }

    function ensureUI(st) {
        const bar = document.querySelector('[data-a-target="player-seekbar"]');
        if (!bar) return false;
        if (st.wrap && bar.contains(st.wrap)) return true;
        if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';

        const stripBox = CFG.stripHeight + CFG.hitPad * 2;
        const below = `calc(100% + ${stripBox + 1}px)`;   // под полосой тепловой карты

        // Обёртка = зона наведения (чуть выше полосы, чтобы попадать мышью было легко)
        const isNew = !st.wrap;
        const wrap = st.wrap || document.createElement('div');
        Object.assign(wrap.style, {
            position: 'absolute', left: '0', top: '100%', width: '100%',
            height: stripBox + 'px', padding: `${CFG.hitPad}px 0`, boxSizing: 'border-box',
            zIndex: '5', cursor: 'default',
        });
        const cv = st.canvas || document.createElement('canvas');
        Object.assign(cv.style, {
            display: 'block', width: '100%', height: CFG.stripHeight + 'px',
            imageRendering: 'pixelated', pointerEvents: 'none',
        });
        const boxStyle = {
            position: 'absolute', top: below, font: '10px/1.3 monospace', color: '#fff',
            background: 'rgba(0,0,0,.7)', padding: '1px 5px', borderRadius: '3px',
            pointerEvents: 'none', zIndex: '6', whiteSpace: 'nowrap',
        };
        const lb = st.label || document.createElement('div');
        Object.assign(lb.style, boxStyle, {
            right: '0', top: 'auto', bottom: `calc(100% + ${CFG.labelOffset}px)`,
            fontSize: '11px', transition: 'opacity .5s',
            display: st.labelHidden ? 'none' : 'block', opacity: st.labelHidden ? '0' : '1',
        });
        const tip = st.tip || document.createElement('div');
        Object.assign(tip.style, boxStyle, { left: '0', display: 'none' });

        wrap.append(cv);
        bar.append(wrap, lb, tip);
        if (isNew) {
            wrap.addEventListener('mousemove', e => showTip(st, e));
            wrap.addEventListener('mouseleave', () => hideTip(st));
        }
        Object.assign(st, { wrap, canvas: cv, label: lb, tip });
        log('heatmap attached below seekbar');
        return true;
    }

    // ---------------------------------------------------------- 4b. подсказка
    function isLoaded(st, t) {
        if (st.done) return true;
        const k = Math.min(Math.floor(t / st.segLen), st.segProgress.length - 1);
        const segStart = k * st.segLen;
        return st.segProgress[k] >= 1 || (t - segStart) / st.segLen < st.segProgress[k];
    }

    function activity(st, cnt) {
        if (cnt === 0) return { text: 'чат молчал', color: '#aaa' };
        const r = st.median ? cnt / st.median : 1;
        if (r < 0.5) return { text: 'тихо', color: '#8fd' };
        if (r < 1.5) return { text: 'обычная активность', color: '#fff' };
        if (r < 3)   return { text: 'чат активен', color: '#ffde9e' };
        return { text: 'всплеск активности 🔥', color: '#ff8a8c' };
    }

    function showTip(st, e) {
        if (!st.bins || !st.tip) return;
        const r = st.wrap.getBoundingClientRect();
        const x = clamp((e.clientX - r.left) / r.width, 0, 0.9999);
        const i = Math.min(Math.floor(x * st.duration / CFG.binSec), st.bins.length - 1);
        const from = i * CFG.binSec;
        const cnt = st.bins[i];

        let text, color = '#fff';
        if (!isLoaded(st, from)) {
            text = 'ещё загружается…'; color = '#aaa';
        } else {
            const a = activity(st, cnt);
            text = `${a.text} · ${cnt} сообщ.`;
            color = a.color;
        }
        const tip = st.tip;
        tip.textContent = text;
        tip.style.color = color;
        tip.style.display = 'block';
        const w = tip.offsetWidth;
        tip.style.left = clamp(x * r.width - w / 2, 0, r.width - w) + 'px';
    }

    function hideTip(st) {
        if (st.tip) st.tip.style.display = 'none';
    }

    function draw(st) {
        if (!st.bins || !ensureUI(st)) return;
        const bins = st.bins, n = bins.length;
        const nz = Array.from(bins).filter(x => x > 0).sort((a, b) => a - b);
        const norm = nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * CFG.percentile))] : 1;
        st.median = nz.length ? nz[Math.floor(nz.length / 2)] : 0;

        const cv = st.canvas;
        if (cv.width !== n) { cv.width = n; cv.height = 1; }
        const ctx = cv.getContext('2d');
        const img = ctx.createImageData(n, 1);
        for (let i = 0; i < n; i++) {
            const has = bins[i] > 0;
            const [r, g, b] = has ? pickColor(clamp(bins[i] / norm * 100, 1, 100)) : [0, 0, 0];
            img.data.set([r, g, b, has ? 255 : 90], i * 4);
        }
        ctx.putImageData(img, 0, 0);

        if (st.error || st.labelHidden) return;
        const prog = st.done ? 1 : st.segProgress.reduce((a, b) => a + b, 0) / st.segProgress.length;
        st.label.textContent = `chat: ${Math.round(prog * 100)}% · ${st.total.toLocaleString()} msgs`;
        if (st.done && !st.hideTimer) {
            st.hideTimer = setTimeout(() => {
                st.labelHidden = true;
                if (!st.label) return;
                st.label.style.opacity = '0';
                setTimeout(() => { if (st.labelHidden && st.label) st.label.style.display = 'none'; }, 500);
            }, CFG.labelHideDelay);
        }
    }

    function scheduleDraw(st) {
        if (st.drawPending) return;
        st.drawPending = true;
        requestAnimationFrame(() => { st.drawPending = false; if (!st.aborted) draw(st); });
    }

    function setError(st, msg) {
        st.error = true;           // ошибку не скрываем и не перетираем прогрессом
        st.labelHidden = false;
        clearTimeout(st.hideTimer);
        if (ensureUI(st)) {
            Object.assign(st.label.style, { display: 'block', opacity: '1', color: '#ff8080' });
            st.label.textContent = 'TVE: ' + msg;
        }
    }

    // ------------------------------------------------- 5. кнопка «Get heatmap»
    const BTN_TEXT = { idle: 'Get heatmap', loading: 'Loading…', error: 'Retry heatmap' };
    let btn = null;
    let btnMode = 'idle';        // idle | loading | error | hidden

    // Ищем кнопку Clip и поднимаемся до прямого потомка группы правых контролов,
    // чтобы вставить нашу кнопку на том же уровне, что и Clip.
    function findClipAnchor() {
        let clip = document.querySelector('[data-a-target="player-clip-button"]');
        if (!clip) {
            const ctr = document.querySelector('.player-controls__right-control-group')
                || document.querySelector('[data-a-target="player-controls"]');
            clip = ctr && [...ctr.querySelectorAll('button')].find(b => b !== btn &&
                /\bclip\b|клип/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent));
        }
        if (!clip) return null;
        const group = clip.closest('.player-controls__right-control-group');
        let node = clip;
        if (group) while (node.parentElement && node.parentElement !== group) node = node.parentElement;
        return node;
    }

    function createButton() {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.tve = 'heatmap-btn';
        Object.assign(b.style, {
            alignSelf: 'center', height: '30px', padding: '0 10px', marginRight: '6px',
            border: 'none', borderRadius: '4px', background: 'rgba(255,255,255,.15)',
            color: '#fff', font: '600 13px/30px Inter, Roobert, "Helvetica Neue", Arial, sans-serif',
            whiteSpace: 'nowrap', transition: 'background .15s',
        });
        b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.background = 'rgba(255,255,255,.28)'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'rgba(255,255,255,.15)'; });
        b.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();          // не даём клику дойти до плеера (пауза/плей)
            const vid = currentVid();
            if (!vid || btnMode === 'loading') return;
            if (state) stop();            // повтор после ошибки — начинаем с чистого листа
            start(vid);
        });
        return b;
    }

    function setBtn(mode) { btnMode = mode; syncButton(); }

    function syncButton() {
        if (btnMode === 'hidden' || !currentVid()) { if (btn) btn.remove(); return; }
        const anchor = findClipAnchor();
        if (!anchor) return;                       // контролы ещё не отрисованы или скрыты
        if (!btn) btn = createButton();
        if (btn.nextSibling !== anchor) anchor.before(btn);
        btn.textContent = BTN_TEXT[btnMode];
        btn.disabled = btnMode === 'loading';
        btn.style.opacity = btn.disabled ? '.6' : '1';
        btn.style.cursor = btn.disabled ? 'default' : 'pointer';
    }

    // ------------------------------------------------------- 6. контроллер SPA
    const cache = new Map();   // vid -> завершённый state
    let state = null;
    let lastVid = null;

    const currentVid = () => (location.pathname.match(/^\/videos\/(\d+)/) || [])[1] || null;

    async function start(vid) {
        if (cache.has(vid)) {
            state = cache.get(vid);
            state.wrap = state.canvas = state.label = state.tip = null;
            state.labelHidden = true;   // из кеша — карта уже готова, прогресс не нужен
            setBtn('hidden');
            log('from cache', vid);
            return;
        }
        const st = state = {
            vid, aborted: false, done: false, bins: null, total: 0,
            segProgress: [], segLen: 1, median: 0, duration: 0,
            wrap: null, canvas: null, label: null, tip: null,
        };
        window.__tve = st;   // для отладки из консоли
        setBtn('loading');
        try {
            log('video', vid);
            const ok = await waitHeaders();
            if (!ok) log('integrity headers not captured in 15s, trying with client-id only');
            st.duration = await getDuration(vid);
            log('duration', st.duration, 's');
            if (st.aborted) return;

            st.bins = new Uint32Array(Math.max(1, Math.ceil(st.duration / CFG.binSec)));
            const K = CFG.concurrency, seg = st.duration / K;
            st.segLen = seg;
            st.segProgress = new Array(K).fill(0);
            const t0 = performance.now();
            await Promise.all([...Array(K)].map((_, k) =>
                crawlSegment(st, k, k * seg, k === K - 1 ? Infinity : (k + 1) * seg)));
            if (st.aborted) return;
            st.done = true;
            draw(st);
            cache.set(vid, st);
            if (state === st) setBtn('hidden');
            log(`done: ${st.total} msgs in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) {
            if (st.aborted) return;
            console.error('[TVE]', e);
            setError(st, e.message.slice(0, 80));
            if (state === st) setBtn('error');
        }
    }

    function stop() {
        if (!state) return;
        state.aborted = !state.done;
        [state.wrap, state.label, state.tip].forEach(el => el && el.remove());
        state = null;
    }

    setInterval(() => {
        const vid = currentVid();
        if (vid !== lastVid) {                     // смена страницы в SPA
            if (state) stop();
            lastVid = vid;
            btnMode = 'idle';
        }
        if (!vid) { syncButton(); return; }
        if (!state && (cache.has(vid) || (CFG.autoLoad && btnMode === 'idle'))) start(vid);
        if (state && state.bins) draw(state);      // переподключение canvas после ререндера плеера
        syncButton();                              // переподключение кнопки после ререндера контролов
    }, 1000);
})();
