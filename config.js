// ---- フィード設定 ---------------------------------------------------------
// url は文字列、または候補の配列（先頭から順に試す）。
// hue（0-360）を指定するとサイトごとのバッジ色を固定できます（省略時は自動）
const RSS_FEEDS = [
    { name: "モナニュース",       url: ["https://mona-news.com/index.rdf", "https://mona-news.com/feed", "https://mona-news.com/feed/"], siteUrl: "https://mona-news.com/" },
    { name: "痛いニュース",       url: ["https://itainews.com/index.rdf", "https://itainews.com/feed"], siteUrl: "https://itainews.com/" },
    { name: "常識的に考えた",     url: "http://blog.livedoor.jp/jyoushiki43/index.rdf",      siteUrl: "http://blog.livedoor.jp/jyoushiki43/" },
    { name: "watch@2ちゃんねる",  url: "http://www.watch2chan.com/index.rdf",                siteUrl: "http://www.watch2chan.com/" },
    { name: "FX2ちゃんねる",      url: "https://www.fx2ch.net/index.rdf",                    siteUrl: "https://www.fx2ch.net/" },
    { name: "市況かぶ全力２階建", url: "https://kabumatome.doorblog.jp/index.rdf",           siteUrl: "https://kabumatome.doorblog.jp/" },
    { name: "メガニケ",             url: ["https://mega-nikke.com/feed", "https://mega-nikke.com/feed/", "https://mega-nikke.com/?feed=rss2"], siteUrl: "https://mega-nikke.com/" },
    { name: "川口マガジン",         url: ["https://kawaguchi-magazine.com/feed", "https://kawaguchi-magazine.com/feed/", "https://kawaguchi-magazine.com/?feed=rss2"], siteUrl: "https://kawaguchi-magazine.com/" },
    { name: "mitaku.net",           url: "https://mitaku.net/feed/", siteUrl: "https://mitaku.net/" },
    { name: "IT速報",               url: ["https://itsoku.org/index.rdf", "https://itsoku.org/atom.xml"], siteUrl: "https://itsoku.org/" }
];

// ---- API ------------------------------------------------------------------
const RSS2JSON_API   = "https://api.rss2json.com/v1/api.json?rss_url=";
const ALLORIGINS_API = "https://api.allorigins.win/get?url=";
// 自前の中継サーバー (Cloudflare Workers) のURL。空なら使わない。
// ⚙設定からも変更できる（そちらが優先）。
const RELAY_API = "https://newsoku.mikumikublog.workers.dev";

// ---- 広告・固定記事の除外 ---------------------------------------------------
// 支援のお願いなどの「固定記事」は、常に先頭へ出すため未来の日時が付いていることが多い。
// 現在時刻より FUTURE_TOLERANCE 以上先の記事は自動で除外する（0以下で無効）。
const FUTURE_TOLERANCE = 3 * 60 * 60 * 1000;
// 上に加えて、タイトルにこれらの語句を含む記事も除外する（空配列で無効）。
const EXCLUDE_TITLE_WORDS = [
    "ご支援をお願いします",
    "noteサブスク"
];

// ---- 動作設定 -------------------------------------------------------------
const MAX_ITEMS_PER_FEED = 30;
const CACHE_DURATION = 5 * 60 * 1000;        // この時間内のフィードは再取得しない
const CACHE_MAX_AGE  = 24 * 60 * 60 * 1000;  // 古くてもこの時間内なら先に表示する
const FETCH_TIMEOUT  = 10000;                // 1フィードの最大待ち時間(ms)
const HEDGE_DELAY    = 2500;                 // rss2jsonがこれ以上遅ければ予備経路も並行して試す(ms)
