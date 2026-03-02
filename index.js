const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PROXY_LIST = [
    { ip: "31.59.20.176", port: "6754", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "23.95.150.145", port: "6114", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "198.23.239.134", port: "6540", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "45.38.107.97", port: "6014", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "107.172.163.27", port: "6543", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "198.105.121.200", port: "6462", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "64.137.96.74", port: "6641", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "216.10.27.159", port: "6837", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "142.111.67.146", port: "5611", username: "aferckez", password: "94v6kdqoalaj" },
    { ip: "194.39.32.164", port: "6461", username: "aferckez", password: "94v6kdqoalaj" },
];

let currentProxyIndex = 0;

function getNextProxy() {
    const proxy = PROXY_LIST[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % PROXY_LIST.length;
    return proxy;
}

const parseAbbrev = (s) => {
    if (!s) return null;
    const cleaned = String(s).replace(/,/g, "").trim();
    const m = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
    if (!m) return null;
    let n = Number(m[1]);
    const suf = (m[2] || "").toUpperCase();
    if (suf === "K") n *= 1e3;
    if (suf === "M") n *= 1e6;
    if (suf === "B") n *= 1e9;
    return Math.round(n);
};

app.get("/scrape", async (req, res) => {
    const urlParam = req.query.urls;
    if (!urlParam) {
        return res.status(400).json({ error: "Provide ?urls=instagram_url1,instagram_url2" });
    }

    const urls = urlParam.split(",").map((u) => u.trim());
    const results = [];
    let browser = null;

    try {
        const proxy = getNextProxy();
        console.log(`🌐 Using proxy: ${proxy.ip}:${proxy.port}`);

        browser = await puppeteer.launch({
            headless: "new",
            args: [
                `--proxy-server=http://${proxy.ip}:${proxy.port}`,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                "--no-zygote",
                "--disable-blink-features=AutomationControlled",
            ],
        });

        console.log('✅ Browser launched');
        const page = await browser.newPage();

        await page.authenticate({
            username: proxy.username,
            password: proxy.password
        });
        console.log('✅ Proxy authenticated');

        await page.setUserAgent(UA);
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9",
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => false });
            Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
            window.chrome = { runtime: {} };
        });

        for (const url of urls) {
            let userDataFromAPI = null;

            const responseHandler = async (response) => {
                try {
                    const reqUrl = response.url();
                    if (reqUrl.includes("/api/v1/users/web_profile_info") || reqUrl.includes("graphql/query")) {
                        console.log('📡 Intercepted API call:', reqUrl);
                        const json = await response.json();
                        if (json?.data?.user) {
                            userDataFromAPI = json.data.user;
                            console.log('✅ Got user data from API');
                        }
                    }
                } catch (e) {
                    // Ignore
                }
            };

            page.on("response", responseHandler);

            try {
                console.log('🌐 Navigating to:', url);
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); // ✅ Changed
                console.log('✅ Page loaded');

                await new Promise((r) => setTimeout(r, 5000)); // ✅ Wait longer

                const pageTitle = await page.title();
                console.log('📄 Page title:', pageTitle);

                if (userDataFromAPI) {
                    console.log('✅ Using API data');
                    results.push({
                        url,
                        success: true,
                        followers: userDataFromAPI.edge_followed_by?.count ?? userDataFromAPI.follower_count ?? null,
                        following: userDataFromAPI.edge_follow?.count ?? userDataFromAPI.following_count ?? null,
                        posts: userDataFromAPI.edge_owner_to_timeline_media?.count ?? userDataFromAPI.media_count ?? null,
                        proxy: `${proxy.ip}:${proxy.port}`
                    });
                } else {
                    console.log('⚠️ No API data, trying page scraping...');

                    const stats = await page.evaluate(() => {
                        const scripts = document.querySelectorAll("script");

                        for (const script of scripts) {
                            const text = script.textContent || "";

                            if (text.includes("edge_followed_by")) {
                                try {
                                    const followerMatch = text.match(/"edge_followed_by"\s*:\s*{\s*"count"\s*:\s*(\d+)/);
                                    const followingMatch = text.match(/"edge_follow"\s*:\s*{\s*"count"\s*:\s*(\d+)/);
                                    const postsMatch = text.match(/"edge_owner_to_timeline_media"\s*:\s*{\s*"count"\s*:\s*(\d+)/);

                                    if (followerMatch) {
                                        return {
                                            followers: parseInt(followerMatch[1]),
                                            following: followingMatch ? parseInt(followingMatch[1]) : null,
                                            posts: postsMatch ? parseInt(postsMatch[1]) : null,
                                        };
                                    }
                                } catch (e) {}
                            }
                        }

                        const metaDesc = document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
                        const followerMatch = metaDesc.match(/([\d,.]+[KMB]?)\s*Followers/i);
                        const followingMatch = metaDesc.match(/([\d,.]+[KMB]?)\s*Following/i);
                        const postsMatch = metaDesc.match(/([\d,.]+[KMB]?)\s*Posts/i);

                        return {
                            followers: followerMatch ? followerMatch[1] : null,
                            following: followingMatch ? followingMatch[1] : null,
                            posts: postsMatch ? postsMatch[1] : null,
                        };
                    });

                    console.log('📊 Scraped stats:', stats);

                    const isNumber = (v) => typeof v === "number" && !isNaN(v);
                    const followerVal = isNumber(stats.followers) ? stats.followers : parseAbbrev(stats.followers);
                    const followingVal = isNumber(stats.following) ? stats.following : parseAbbrev(stats.following);
                    const postsVal = isNumber(stats.posts) ? stats.posts : parseAbbrev(stats.posts);

                    results.push({
                        url,
                        success: followerVal !== null,
                        followers: followerVal,
                        following: followingVal,
                        posts: postsVal,
                        proxy: `${proxy.ip}:${proxy.port}`
                    });
                }

                page.off("response", responseHandler);
                await new Promise((r) => setTimeout(r, 1500));

            } catch (err) {
                console.error('❌ Error scraping URL:', url, err.message);
                page.off("response", responseHandler);
                results.push({
                    url,
                    success: false,
                    error: err.message,
                    followers: null,
                    following: null,
                    posts: null,
                    proxy: `${proxy.ip}:${proxy.port}`
                });
            }
        }

        res.json(results);

    } catch (e) {
        console.error('❌ Fatal error:', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        if (browser) {
            await browser.close();
        }
        if (global.gc) {
            global.gc();
        }
    }
});

app.get("/health", (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: "ok",
        proxies_available: PROXY_LIST.length,
        memory: {
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        },
    });
});

app.listen(PORT, () => console.log(`✅ Instagram stat getter running on port ${PORT}`));