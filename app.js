"use strict";

const CACHE_KEY = "newsCache.v2";
const $ = (id) => document.getElementById(id);

let feedData = {};     // name -> { t: 取得時刻, items: [{title, link, ts}] }
let feedStatus = {};   // name -> "loading" | "ok" | "error"
let filter = "all";
let renderedOnce = false;
let applyNow = false;  // true の間は、スクロール中でも即反映する（手動更新時）
let rafId = 0;

const FEEDS_KEY = "customFeeds.v1";
const DEFAULT_FEEDS = JSON.parse(JSON.stringify(RSS_FEEDS));
(function applyCustomFeeds() {
    try {
        const raw = localStorage.getItem(FEEDS_KEY);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr) || !arr.length) return;
        const ok = arr.filter(f => f && typeof f.name === "string" && f.name &&
            (typeof f.url === "string" || (Array.isArray(f.url) && f.url.length)));
        if (!ok.length) return;
        RSS_FEEDS.length = 0;
        ok.forEach(f => RSS_FEEDS.push({ name: f.name, url: f.url, siteUrl: f.siteUrl || "", off: !!f.off }));
    } catch {}
})();

const HUES = new Map(RSS_FEEDS.map((f, i) => [f.name, f.hue ?? Math.round((i * 137.5) % 360)]));
function hueOf(name) {
    if (!HUES.has(name)) HUES.set(name, Math.round((HUES.size * 137.5) % 360));
    return HUES.get(name);
}
function activeFeeds() { return RSS_FEEDS.filter(f => !f.off); }
function saveCustomFeeds() { try { localStorage.setItem(FEEDS_KEY, JSON.stringify(RSS_FEEDS)); } catch {} }

/* ---------- utils ---------- */
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : "#"; }

// rss2json の日時 "YYYY-MM-DD HH:mm:ss" はUTC。そのままだとローカル時刻扱いで9時間ずれる
function toTs(v) {
    if (typeof v === "number") return v;
    if (!v) return NaN;
    let s = String(v).trim();
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) s = s.replace(" ", "T") + "Z";
    return Date.parse(s);
}
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    const base = `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`;
    return diff === 0 ? "今日 " + base : diff === 1 ? "昨日 " + base : base;
}

/* ---------- 広告・固定記事の除外 ---------- */
function clean(items) {
    const limit = Date.now() + FUTURE_TOLERANCE;
    return items.filter(it =>
        Number.isFinite(it.ts) &&
        !(FUTURE_TOLERANCE > 0 && it.ts > limit) &&
        !EXCLUDE_TITLE_WORDS.some(w => it.title.includes(w))
    );
}

/* ---------- cache（フィード単位） ---------- */
function loadCache() {
    try {
        localStorage.removeItem("newsCache"); // 旧形式
        const o = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        const now = Date.now();
        for (const f of RSS_FEEDS) {
            const e = o[f.name];
            if (e && Array.isArray(e.items) && now - e.t < CACHE_MAX_AGE) {
                e.items = clean(e.items);
                feedData[f.name] = e;
            }
        }
    } catch {}
}
function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(feedData)); } catch {}
}

/* ---------- fetch ---------- */
// rss2json / allOrigins はURL単位で結果をキャッシュするため、動的フィードには
// 毎回時刻パラメータを付けて古いキャッシュを掴まないようにする。
// 静的ファイル（index.rdf等）はクエリ付きだと取得失敗するため、そのまま使う。
function freshUrl(url) {
    if (url.includes("?") || /\/feed\/?$/i.test(url)) {
        return url + (url.includes("?") ? "&" : "?") + "_=" + Date.now();
    }
    return url;
}

async function rss2jsonFetch(url, signal) {
    const res = await fetch(RSS2JSON_API + encodeURIComponent(url), { signal });
    if (!res.ok) throw new Error("rss2json " + res.status);
    const j = await res.json();
    if (j.status !== "ok" || !j.items?.length) throw new Error(j.message || "rss2json empty");
    return j.items.slice(0, MAX_ITEMS_PER_FEED).map(it => ({
        title: (it.title || "").trim() || "(no title)",
        link: it.link,
        ts: toTs(it.pubDate) || Date.now()
    }));
}

async function viaRss2Json(feed, signal) {
    try {
        return await rss2jsonFetch(freshUrl(feed.url), signal);
    } catch (e) {
        if (signal.aborted) throw e;
        return await rss2jsonFetch(feed.url, signal); // クエリ付きを嫌うサーバー用
    }
}

function parseXmlItems(xmlText) {
    if (/^\s*<(!doctype html|html)/i.test(xmlText)) throw new Error("HTMLが返却された(404 or bot対策)");
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("xml parse error");
    const first = (el, ...names) => {
        for (const n of names) { const x = el.getElementsByTagName(n)[0]; if (x) return x; }
        return null;
    };
    const out = [];
    const els = doc.querySelectorAll("item, entry");
    for (let i = 0; i < els.length && i < MAX_ITEMS_PER_FEED; i++) {
        const el = els[i];
        const linkEl = first(el, "link");
        out.push({
            title: first(el, "title")?.textContent?.trim() || "(no title)",
            link: linkEl ? (linkEl.getAttribute("href") || linkEl.textContent.trim()) : "",
            ts: toTs(first(el, "pubDate", "updated", "published", "dc:date", "date")?.textContent) || Date.now()
        });
    }
    if (!out.length) throw new Error("no items");
    return out;
}

async function allOriginsFetch(url, signal) {
    const res = await fetch(ALLORIGINS_API + encodeURIComponent(url), { signal });
    if (!res.ok) throw new Error("allorigins " + res.status);
    const j = await res.json();
    if (!j.contents) throw new Error("allorigins empty");
    return parseXmlItems(j.contents);
}

async function viaAllOrigins(feed, signal) {
    try {
        return await allOriginsFetch(freshUrl(feed.url), signal);
    } catch (e) {
        if (signal.aborted) throw e;
        return await allOriginsFetch(feed.url, signal); // クエリ付きを嫌うサーバー用
    }
}

// rss2json を先に試し、遅い/失敗ならallOriginsも並行して走らせ、先に成功した方を採用。
// FETCH_TIMEOUT で必ず打ち切る。
function fetchOne(feed) {
    const ctrl = new AbortController();
    const killTimer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    let hedgeTimer, started = false;
    const primary = viaRss2Json(feed, ctrl.signal);
    const backup = new Promise((resolve, reject) => {
        const start = () => {
            if (started) return;
            started = true;
            clearTimeout(hedgeTimer);
            viaAllOrigins(feed, ctrl.signal).then(resolve, reject);
        };
        hedgeTimer = setTimeout(start, HEDGE_DELAY);
        primary.catch(start);
    });
    return Promise.any([primary, backup]).finally(() => {
        started = true;
        clearTimeout(killTimer);
        clearTimeout(hedgeTimer);
        ctrl.abort();
    });
}

// feed.url は文字列でも配列でもOK。配列なら先頭から順に試し、最初に成功したものを採用する。
async function fetchFeed(feed) {
    const errors = [];
    for (const url of [].concat(feed.url)) {
        try { return await fetchOne({ ...feed, url }); }
        catch (e) { errors.push(`${url} → ${(e.errors || [e]).map(x => x.message).join(" / ")}`); }
    }
    throw new Error(errors.join("\n"));
}

// 期限切れ（または force）のフィードだけを並列取得。1件終わるごとに画面へ反映する。
async function refresh(force = false) {
    const now = Date.now();
    const targets = activeFeeds().filter(f => force || !feedData[f.name] || now - feedData[f.name].t > CACHE_DURATION);
    if (!targets.length) return;
    targets.forEach(f => { feedStatus[f.name] = "loading"; });
    updateChrome();
    await Promise.all(targets.map(async f => {
        try {
            const items = clean(await fetchFeed(f));
            feedData[f.name] = { t: Date.now(), items };
            feedStatus[f.name] = "ok";
            saveCache();
        } catch (e) {
            console.warn("fetch failed: " + f.name + "\n" + e.message);
            feedStatus[f.name] = "error";
        }
        updateChrome();
        scheduleRender();
    }));
}

/* ---------- render ---------- */
function render() {
    const list = [];
    for (const f of activeFeeds()) {
        if (filter !== "all" && f.name !== filter) continue;
        const d = feedData[f.name];
        if (d) for (const it of clean(d.items)) list.push({ it, f });
    }
    const el = $("news");
    $("new-bar").hidden = true;

    if (!list.length) {
        const busy = RSS_FEEDS.some(f => feedStatus[f.name] === "loading");
        if (busy) return; // スケルトン表示のまま待つ
        el.innerHTML = `<p class="empty">記事がありません。「↻ 更新」で再取得してください。</p>`;
        return;
    }

    list.sort((a, b) => b.it.ts - a.it.ts);
    let html = "", lastKey = 0;
    for (const { it, f } of list) {
        const d = new Date(it.ts);
        const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
        if (key !== lastKey) { html += `<h2 class="day">${dayLabel(it.ts)}</h2>`; lastKey = key; }
        html += `<div class="item" style="--h:${hueOf(f.name)}">` +
            `<a class="src" title="${esc(f.name)}へ移動" href="${esc(safeUrl(f.siteUrl))}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` +
            `<time class="time" datetime="${d.toISOString()}">${hhmm(d)}</time>` +
            `<a class="title" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></div>`;
    }
    el.innerHTML = html;
    renderedOnce = true;
}

// 読んでいる途中で記事が差し込まれてズレないよう、スクロール中は「新着あり」バーで知らせる
function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (renderedOnce && window.scrollY > 150 && !applyNow) $("new-bar").hidden = false;
        else render();
    });
}

function renderNav() {
    const total = activeFeeds().reduce((n, f) => n + (feedData[f.name]?.items.length || 0), 0);
    const chip = (name, label, count, hue) => {
        const st = hue == null ? "" : feedStatus[name];
        const mark = hue == null ? "" : st === "error" ? `<i class="dot err">!</i>` : `<i class="dot${st === "loading" ? " pulse" : ""}"></i>`;
        return `<button type="button" class="chip${filter === name ? " active" : ""}" data-f="${esc(name)}"${hue == null ? "" : ` style="--h:${hue}"`}>${mark}<span>${esc(label)}</span><small>${count}</small></button>`;
    };
    $("source-nav").innerHTML = chip("all", "すべて", total, null) +
        activeFeeds().map(f => chip(f.name, f.name, feedData[f.name]?.items.length || 0, hueOf(f.name))).join("");
}

function updateStatus() {
    const feeds = activeFeeds();
    const loading = feeds.filter(f => feedStatus[f.name] === "loading").length;
    const errs = feeds.filter(f => feedStatus[f.name] === "error").map(f => f.name);
    const last = Math.max(0, ...Object.values(feedData).map(d => d.t));
    let h = "";
    if (loading) h = `取得中… ${feeds.length - loading}/${feeds.length}`;
    else if (last) { const d = new Date(last); h = `最終更新 ${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`; }
    if (!loading && errs.length) h += ` <span class="err">取得失敗: ${esc(errs.join("、"))}</span>`;
    $("status").innerHTML = h;
    const btn = $("refresh-btn");
    btn.disabled = loading > 0;
    btn.classList.toggle("busy", loading > 0);
}

function updateChrome() { renderNav(); updateStatus(); updateNavCollapse(); }

// チップが2行に収まらない場合だけ「すべて表示」ボタンを出す
let navExpanded = false;
function updateNavCollapse() {
    const nav = $("source-nav");
    const row = document.querySelector(".nav-more-row");
    const btn = $("nav-more");
    nav.classList.remove("collapsed");
    const chip = nav.querySelector(".chip");
    if (!chip) { row.hidden = true; return; }
    const two = chip.offsetHeight * 2 + 6;
    if (nav.scrollHeight > two + 2) {
        if (!navExpanded) nav.classList.add("collapsed");
        nav.style.setProperty("--nav2", two + "px");
        row.hidden = false;
        btn.textContent = navExpanded ? "閉じる" : "すべて表示";
    } else {
        row.hidden = true;
        navExpanded = false;
    }
}

/* ---------- theme ---------- */
function effectiveTheme() {
    return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function syncThemeBtn() {
    $("theme-btn").textContent = effectiveTheme() === "dark" ? "☀️" : "🌙";
}

/* ---------- feed settings ---------- */
function settingsMsg(t) { $("settings-msg").textContent = t || ""; }

function renderFeedList() {
    const el = $("feed-list");
    el.innerHTML = RSS_FEEDS.map((f, i) =>
        `<div class="feed-row"><label class="feed-toggle"><input type="checkbox" data-toggle="${i}"${f.off ? "" : " checked"}>` +
        `<span class="feed-name">${esc(f.name)}</span></label>` +
        `<span class="feed-url">${esc([].concat(f.url)[0])}${[].concat(f.url).length > 1 ? " 他" : ""}</span>` +
        `<button type="button" class="btn danger" data-del="${i}">削除</button></div>`
    ).join("") || `<p class="empty">フィードがありません。</p>`;
}

function afterFeedsChanged() {
    if (filter !== "all" && !activeFeeds().some(f => f.name === filter)) filter = "all";
    saveCustomFeeds();
    updateChrome();
    render();
}

function normalizeUrl(u) {
    u = String(u || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
}

function addFeed(name, url, siteUrl) {
    name = String(name || "").trim() || (() => { try { return new URL(siteUrl || url).hostname; } catch { return url; } })();
    if (RSS_FEEDS.some(f => f.name === name)) { settingsMsg("同名のフィードがあります: " + name); return false; }
    RSS_FEEDS.push({ name, url, siteUrl: siteUrl || "" });
    afterFeedsChanged();
    refresh(false);
    settingsMsg("追加しました: " + name);
    renderFeedList();
    return true;
}

async function discoverFeeds(siteUrl) {
    const res = await fetch(ALLORIGINS_API + encodeURIComponent(freshUrl(siteUrl)));
    if (!res.ok) throw new Error("サイト取得失敗 " + res.status);
    const j = await res.json();
    if (!j.contents) throw new Error("サイトが空でした");
    const doc = new DOMParser().parseFromString(j.contents, "text/html");
    const out = [];
    const push = (h) => {
        try {
            const u = new URL(h, siteUrl).href;
            if (new URL(u).origin === new URL(siteUrl).origin && !out.includes(u)) out.push(u);
        } catch {}
    };
    doc.querySelectorAll('link[rel="alternate"]').forEach(l => {
        if (/rss|atom|xml/i.test(l.type || "") && l.href) push(l.href);
    });
    doc.querySelectorAll("a[href]").forEach(a => {
        const h = a.getAttribute("href");
        if (h && /rss|feed|\.rdf|atom|\.xml$/i.test(h)) push(h);
    });
    ["feed", "feed/", "rss", "rss.xml", "atom.xml", "index.rdf"].forEach(p => {
        try { push(new URL(p, siteUrl).href); } catch {}
    });
    const title = (doc.querySelector('meta[property="og:site_name"]')?.content || doc.title || "").trim().slice(0, 24);
    return { title: title || new URL(siteUrl).hostname, candidates: out.slice(0, 8) };
}

function renderCandidates(siteUrl, title, candidates) {
    const el = $("discover-result");
    if (!candidates.length) { el.innerHTML = `<p class="empty">RSSが見つかりませんでした。</p>`; return; }
    el.innerHTML = `<p class="cand-title">候補（${esc(title)}）</p>` + candidates.map((u, i) =>
        `<div class="cand-row"><span class="feed-url">${esc(u)}</span>` +
        `<span class="cand-status" id="cand-${i}"></span>` +
        `<button type="button" class="btn" data-test="${i}" data-url="${esc(u)}">確認</button>` +
        `<button type="button" class="btn" data-addcand="${i}" data-url="${esc(u)}" data-site="${esc(siteUrl)}">追加</button></div>`
    ).join("");
}

function initSettings() {
    $("settings-btn").addEventListener("click", () => {
        renderFeedList();
        settingsMsg("");
        $("settings-overlay").hidden = false;
    });
    $("settings-close").addEventListener("click", () => { $("settings-overlay").hidden = true; });
    $("settings-overlay").addEventListener("click", (e) => {
        if (e.target.id === "settings-overlay") $("settings-overlay").hidden = true;
    });

    $("feed-list").addEventListener("change", (e) => {
        const i = e.target.dataset.toggle;
        if (i == null) return;
        RSS_FEEDS[+i].off = !e.target.checked;
        afterFeedsChanged();
        renderFeedList();
    });
    $("feed-list").addEventListener("click", (e) => {
        const i = e.target.dataset.del;
        if (i == null) return;
        const [rm] = RSS_FEEDS.splice(+i, 1);
        if (rm) delete feedData[rm.name];
        afterFeedsChanged();
        renderFeedList();
    });

    $("discover-btn").addEventListener("click", async () => {
        const siteUrl = normalizeUrl($("add-url").value);
        if (!siteUrl) { settingsMsg("URLを入力してください"); return; }
        settingsMsg("検索中…");
        $("discover-result").innerHTML = "";
        try {
            const { title, candidates } = await discoverFeeds(siteUrl);
            if (!$("add-name").value.trim()) $("add-name").value = title;
            renderCandidates(siteUrl, title, candidates);
            settingsMsg(candidates.length ? `${candidates.length}件見つかりました。「確認」で件数を調べられます` : "");
        } catch (e) {
            console.warn(e);
            settingsMsg("見つかりませんでした: " + e.message);
        }
    });

    $("add-direct-btn").addEventListener("click", () => {
        const url = normalizeUrl($("add-url").value);
        if (!url) { settingsMsg("URLを入力してください"); return; }
        let siteUrl = "";
        try { siteUrl = new URL(url).origin + "/"; } catch {}
        addFeed($("add-name").value, url, siteUrl);
    });

    $("discover-result").addEventListener("click", async (e) => {
        const t = e.target.dataset.test;
        const a = e.target.dataset.addcand;
        if (t != null) {
            const url = e.target.dataset.url;
            const st = $("cand-" + t);
            st.textContent = "確認中…";
            try {
                const items = await fetchOne({ url });
                st.textContent = items.length + "件";
            } catch (err) {
                st.textContent = "取得失敗";
            }
        } else if (a != null) {
            addFeed($("add-name").value, e.target.dataset.url, e.target.dataset.site);
        }
    });

    $("feeds-reset").addEventListener("click", () => {
        try { localStorage.removeItem(FEEDS_KEY); } catch {}
        RSS_FEEDS.length = 0;
        DEFAULT_FEEDS.forEach(f => RSS_FEEDS.push(JSON.parse(JSON.stringify(f))));
        filter = "all";
        updateChrome();
        render();
        renderFeedList();
        refresh(false);
        settingsMsg("初期状態に戻しました");
    });
}

/* ---------- init ---------- */
function init() {
    loadCache();

    $("source-nav").addEventListener("click", (e) => {
        const b = e.target.closest(".chip");
        if (!b) return;
        filter = b.dataset.f;
        renderNav();
        render();
        $("source-nav").querySelector(".chip.active")?.scrollIntoView({ inline: "center", block: "nearest" });
    });
    $("refresh-btn").addEventListener("click", async () => {
        applyNow = true;
        await refresh(true);
        applyNow = false;
    });
    $("new-bar").addEventListener("click", () => { render(); window.scrollTo({ top: 0 }); });
    $("nav-more").addEventListener("click", () => {
        navExpanded = !navExpanded;
        $("source-nav").classList.toggle("collapsed", !navExpanded);
        $("nav-more").textContent = navExpanded ? "閉じる" : "すべて表示";
    });
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(updateNavCollapse, 200);
    });
    $("theme-btn").addEventListener("click", () => {
        const next = effectiveTheme() === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("theme", next); } catch {}
        syncThemeBtn();
    });
    syncThemeBtn();
    initSettings();

    updateChrome();
    if (Object.keys(feedData).length) render(); // キャッシュがあれば即表示
    refresh(false);                             // 期限切れ分だけ裏で更新
}

init();
