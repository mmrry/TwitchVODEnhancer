// ==UserScript==
// @name         TwitchVODEnhancer (2026)
// @namespace    https://github.com/sooqua/
// @version      1.0.0
// @author       mmrry <sl2007 at yandex dot com>
// @description  Chat-activity heatmap on the Twitch VOD seekbar (GQL rewrite of sooqua/TwitchVODEnhancer)
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @license      MIT
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    // ------------------------------------------------------------------ config
    const CFG = {
        binSec: 60,          // ширина одного столбца тепловой карты, сек
        stripHeight: 6,      // высота полосы над seekbar, px
        concurrency: 4,      // параллельных «воркеров» по сегментам VOD
        reqDelay: 60,        // пауза между запросами внутри воркера, мс
        percentile: 0.98,    // нормализация по перцентилю, чтобы один спайк не «гасил» всё
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
        if (st.canvas && bar.contains(st.canvas)) return true;
        if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';

        const cv = st.canvas || document.createElement('canvas');
        Object.assign(cv.style, {
            position: 'absolute', left: '0', bottom: '100%', width: '100%',
            height: CFG.stripHeight + 'px', imageRendering: 'pixelated',
            pointerEvents: 'none', zIndex: '5',
        });
        const lb = st.label || document.createElement('div');
        Object.assign(lb.style, {
            position: 'absolute', right: '0', bottom: `calc(100% + ${CFG.stripHeight + 2}px)`,
            font: '10px/1.2 monospace', color: '#fff', background: 'rgba(0,0,0,.55)',
            padding: '1px 4px', borderRadius: '2px', pointerEvents: 'none', zIndex: '5',
        });
        bar.append(cv, lb);
        st.canvas = cv; st.label = lb;
        log('canvas attached to seekbar');
        return true;
    }

    function draw(st) {
        if (!st.bins || !ensureUI(st)) return;
        const bins = st.bins, n = bins.length;
        const nz = Array.from(bins).filter(x => x > 0).sort((a, b) => a - b);
        const norm = nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * CFG.percentile))] : 1;

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

        const prog = st.segProgress.reduce((a, b) => a + b, 0) / st.segProgress.length;
        st.label.textContent = st.done
            ? `chat: ${st.total.toLocaleString()} msgs`
            : `chat: ${Math.round(prog * 100)}% · ${st.total.toLocaleString()}`;
    }

    function scheduleDraw(st) {
        if (st.drawPending) return;
        st.drawPending = true;
        requestAnimationFrame(() => { st.drawPending = false; if (!st.aborted) draw(st); });
    }

    function setError(st, msg) {
        if (ensureUI(st)) { st.label.textContent = 'TVE: ' + msg; st.label.style.color = '#ff8080'; }
    }

    // ------------------------------------------------------- 5. контроллер SPA
    const cache = new Map();   // vid -> завершённый state
    let state = null;

    const currentVid = () => (location.pathname.match(/^\/videos\/(\d+)/) || [])[1] || null;

    async function start(vid) {
        if (cache.has(vid)) {
            state = cache.get(vid);
            state.canvas = state.label = null;
            log('from cache', vid);
            return;
        }
        const st = state = {
            vid, aborted: false, done: false, bins: null, total: 0,
            segProgress: [], canvas: null, label: null, duration: 0,
        };
        window.__tve = st;   // для отладки из консоли
        try {
            log('video', vid);
            const ok = await waitHeaders();
            if (!ok) log('integrity headers not captured in 15s, trying with client-id only');
            st.duration = await getDuration(vid);
            log('duration', st.duration, 's');
            if (st.aborted) return;

            st.bins = new Uint32Array(Math.max(1, Math.ceil(st.duration / CFG.binSec)));
            const K = CFG.concurrency, seg = st.duration / K;
            st.segProgress = new Array(K).fill(0);
            const t0 = performance.now();
            await Promise.all([...Array(K)].map((_, k) =>
                crawlSegment(st, k, k * seg, k === K - 1 ? Infinity : (k + 1) * seg)));
            if (st.aborted) return;
            st.done = true;
            draw(st);
            cache.set(vid, st);
            log(`done: ${st.total} msgs in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) {
            console.error('[TVE]', e);
            setError(st, e.message.slice(0, 80));
        }
    }

    function stop() {
        if (!state) return;
        state.aborted = !state.done;
        state.canvas && state.canvas.remove();
        state.label && state.label.remove();
        state = null;
    }

    setInterval(() => {
        const vid = currentVid();
        if (state && state.vid !== vid) stop();
        if (!vid) return;
        if (!state) start(vid);
        else if (state.bins) draw(state);   // переподключение canvas после ререндера плеера
    }, 1000);
})();
