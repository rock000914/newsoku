// Cloudflare Workers 用のRSS中継サーバー
// 使い方: Workers → Create → このコードを貼り付け → Deploy
// 使う: アプリ側の RELAY_API (または⚙設定) に https://<名前>.<アカウント>.workers.dev を設定
export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response(JSON.stringify({ error: "missing ?url=" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        },
        cf: { cacheTtl: 60, cacheEverything: true },
        signal: AbortSignal.timeout(15000),
      });
      const body = await upstream.arrayBuffer();
      const headers = { ...cors };
      const ct = upstream.headers.get("content-type");
      if (ct) headers["Content-Type"] = ct;
      return new Response(body, { status: upstream.status, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
