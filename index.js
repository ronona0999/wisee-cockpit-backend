const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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
    if (!urlParam) return res.status(400).json({ error: "Provide ?urls=" });

    const urls = urlParam.split(",").map(u => u.trim());
    const results = [];

    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(UA);

        for (const url of urls) {
            try {
                await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
                await new Promise(r => setTimeout(r, 3000));

                const stats = await page.evaluate(() => {
                    // Strategy 1: Look for list items with stats
                    const listItems = document.querySelectorAll('ul li');
                    let posts = null, followers = null, following = null;

                    listItems.forEach(li => {
                        const text = li.innerText.toLowerCase();
                        if (text.includes('post')) {
                            posts = li.innerText.match(/[\d.,]+[kmb]?/i)?.[0];
                        }
                        if (text.includes('follower')) {
                            followers = li.innerText.match(/[\d.,]+[kmb]?/i)?.[0];
                        }
                        if (text.includes('following')) {
                            following = li.innerText.match(/[\d.,]+[kmb]?/i)?.[0];
                        }
                    });

                    if (followers) return { posts, followers, following };

                    // Strategy 2: Header section fallback
                    const headerSection = document.querySelector('header section');
                    if (headerSection) {
                        const text = headerSection.innerText;
                        const lines = text.split('\n').map(l => l.trim()).filter(l => l);

                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase() === 'posts' && i > 0) {
                                posts = lines[i - 1];
                            }
                            if (lines[i].toLowerCase() === 'followers' && i > 0) {
                                followers = lines[i - 1];
                            }
                            if (lines[i].toLowerCase() === 'following' && i > 0) {
                                following = lines[i - 1];
                            }
                        }

                        if (followers) return { posts, followers, following };
                    }

                    return { posts: null, followers: null, following: null };
                });

                results.push({
                    url,
                    success: !!(stats.followers),
                    followers: parseAbbrev(stats.followers),
                    following: parseAbbrev(stats.following),
                    posts: parseAbbrev(stats.posts)
                });

                await new Promise(r => setTimeout(r, 2000));

            } catch (err) {
                results.push({ url, success: false, error: err.message });
            }
        }
        res.json(results);

        // ✅ Auto restart after response
        setTimeout(() => {
            process.exit(0);
        }, 3000);
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        await browser.close();
    }
});

app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));