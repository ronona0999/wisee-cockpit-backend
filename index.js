const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Utility to parse abbreviated numbers (28K -> 28000)
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
        console.log('🚀 Launching browser...');

        browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                "--no-zygote",
                "--disable-blink-features=AutomationControlled",
            ],
        });

        console.log('✅ Browser launched successfully');
        const page = await browser.newPage();
        console.log('✅ New page created');

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
                    console.error('❌ Error parsing API response:', e.message);
                }
            };

            page.on("response", responseHandler);

            try {
                console.log('🌐 Navigating to:', url);
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
                console.log('✅ Page loaded');

                await new Promise((r) => setTimeout(r, 3000));

                // Check if we got blocked
                const pageTitle = await page.title();
                const pageContent = await page.content();
                console.log('📄 Page title:', pageTitle);
                console.log('📏 Page content length:', pageContent.length);

                if (pageTitle.includes('Instagram')) {
                    console.log('✅ Instagram page detected');
                } else {
                    console.log('⚠️ Unexpected page title');
                }

                if (userDataFromAPI) {
                    console.log('✅ Using API data');
                    results.push({
                        url,
                        success: true,
                        followers: userDataFromAPI.edge_followed_by?.count ?? userDataFromAPI.follower_count ?? null,
                        following: userDataFromAPI.edge_follow?.count ?? userDataFromAPI.following_count ?? null,
                        posts: userDataFromAPI.edge_owner_to_timeline_media?.count ?? userDataFromAPI.media_count ?? null,
                    });
                } else {
                    console.log('⚠️ No API data, trying page scraping...');

                    const stats = await page.evaluate(() => {
                        const scripts = document.querySelectorAll("script");
                        console.log('Found', scripts.length, 'script tags');

                        for (const script of scripts) {
                            const text = script.textContent || "";

                            if (text.includes("edge_followed_by")) {
                                console.log('Found edge_followed_by in script');
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
                                } catch (e) {
                                    console.error('Error parsing script:', e);
                                }
                            }
                        }

                        const metaDesc = document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
                        console.log('Meta description:', metaDesc);

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
                    posts: null
                });
            }
        }

        res.json(results);

    } catch (e) {
        console.error('❌ Fatal error:', e.message);
        console.error('Stack:', e.stack);
        res.status(500).json({ error: e.message, stack: e.stack });
    } finally {
        if (browser) {
            console.log('🔒 Closing browser...');
            await browser.close();
            console.log('✅ Browser closed');
        }

        if (global.gc) {
            global.gc();
        }
    }
});

// Health check endpoint
app.get("/health", (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: "ok",
        memory: {
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        },
    });
});

app.listen(PORT, () => console.log(`✅ Instagram stat getter running on port ${PORT}`));