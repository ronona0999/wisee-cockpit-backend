const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
// Railway provides the PORT, locally it uses 3000
const PORT = process.env.PORT || 3000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Helper: Parse the numbers
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

    // Launch browser with specific flags for low-RAM environments
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(UA);

        for (const url of urls) {
            try {
                // Wait for the minimal amount of data
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

                // Extract meta content
                const content = await page.evaluate(() => {
                    const og = document.querySelector('meta[property="og:description"]')?.getAttribute("content");
                    const twitter = document.querySelector('meta[name="twitter:description"]')?.getAttribute("content");
                    return og || twitter || "";
                });

                // Regex: 100 Followers, 50 Following, 10 Posts
                const match = content.match(/([\d.,]+[KMB]?)\s+Followers?,\s+([\d.,]+[KMB]?)\s+Following,\s+([\d.,]+[KMB]?)\s+Posts?/i);

                results.push({
                    url,
                    success: !!match,
                    followers: match ? parseAbbrev(match[1]) : null,
                    following: match ? parseAbbrev(match[2]) : null,
                    posts: match ? parseAbbrev(match[3]) : null
                });

                // 2-second breath so Instagram doesn't panic
                await new Promise(r => setTimeout(r, 2000));

            } catch (err) {
                results.push({ url, success: false, error: "Timeout or blocked" });
            }
        }
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        await browser.close(); // Crucial to prevent RAM leaks!
    }
});

app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));