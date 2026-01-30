// Apify SDK - toolkit for building Apify Actors
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor
await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://example.com'],
  maxRequestsPerCrawl = 200,
  detectPdfLinks = true,
  followInternalOnly = true,
} = input;

// Use Apify proxy (recommended)
const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new CheerioCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl,
  // Optionally set additional CheerioCrawler options here (concurrency, requestTimeoutMillis, etc.)
  async requestHandler({ request, $, enqueueLinks, log }) {
    const loadedUrl = request.loadedUrl ?? request.url;
    log.info('Processing', { url: loadedUrl });

    // Enqueue relevant links: try to follow site pages and pdfs
    await enqueueLinks({
      globs: ['**/*'],
      transformRequestFunction: (r) => {
        // If followInternalOnly, restrict host to the original start URL's host
        if (followInternalOnly) {
          try {
            const startHost = new URL(request.userData.startHost || request.url).host;
            const candidateHost = new URL(r.url).host;
            if (candidateHost !== startHost) return null;
          } catch (e) {
            // ignore malformed URL
          }
        }
        return r;
      },
    });

    // Heuristics: collect candidate report links and metadata on the page
    try {
      // Company heuristics
      const company =
        $('meta[property="og:site_name"]').attr('content') ||
        $('meta[name="application-name"]').attr('content') ||
        $('meta[name="author"]').attr('content') ||
        $('header h1, header h2').first().text().trim() ||
        '';

      // Title heuristics
      const title =
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        $('h1').first().text().trim() ||
        $('title').text().trim() ||
        '';

      // Date heuristics
      let date =
        $('meta[name="article:published_time"]').attr('content') ||
        $('time').first().attr('datetime') ||
        $('time').first().text().trim() ||
        '';
      if (!date) {
        // Look for common date patterns in page (YYYY, MMM DD, etc.)
        const body = $('body').text().slice(0, 1200);
        const m = body.match(/\b(20\d{2}|19\d{2})\b/);
        if (m) date = m[0];
      }

      // Executive summary: try to locate headings
      let exec_summary = '';
      const execHeading = $('*:contains("Executive Summary"), *:contains("EXECUTIVE SUMMARY"), *:contains("Summary")')
        .filter((i, el) => /executive summary|summary/i.test($(el).text()))
        .first();

      if (execHeading && execHeading.length) {
        // take next sibling paragraphs up to a limit
        let node = execHeading.next();
        const parts = [];
        let tries = 0;
        while (node && tries < 6) {
          const txt = node.text().trim();
          if (txt) parts.push(txt);
          node = node.next();
          tries++;
        }
        exec_summary = parts.join('\n\n').slice(0, 4000);
      } else {
        // fallback: look for a blockquote or first substantial paragraph
        const p = $('article p, .content p, .report p').first().text().trim();
        exec_summary = p ? p.slice(0, 4000) : '';
      }

      // Find PDF links if requested
      const pdfs = [];
      if (detectPdfLinks) {
        $('a[href]').each((i, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          const abs = new URL(href, loadedUrl).toString();
          if (abs.toLowerCase().endsWith('.pdf') || /esg|sustainability|sustainability-report|annual-report|csr/i.test(href)) {
            pdfs.push(abs);
          }
        });
      }

      // Tags: look for 'ESG' 'Sustainability' occurrences or meta keywords
      const tags = [];
      const metaKeywords = $('meta[name="keywords"]').attr('content');
      if (metaKeywords) tags.push(...metaKeywords.split(',').map((t) => t.trim()));
      if (/esg/i.test($('body').text())) tags.push('esg');
      if (/sustainability/i.test($('body').text())) tags.push('sustainability');

      // Save one record per discovered PDF or the page itself (if no pdf)
      if (pdfs.length) {
        for (const pdfUrl of Array.from(new Set(pdfs)).slice(0, 5)) {
          await Dataset.pushData({
            company,
            title,
            date,
            pdf_url: pdfUrl,
            exec_summary,
            tags: Array.from(new Set(tags)),
            url: loadedUrl,
          });
          log.info('Saved PDF candidate', { pdf_url: pdfUrl });
        }
      } else {
        // Save metadata for pages that look like reports or contain exec_summary
        const isLikelyReport =
          exec_summary ||
          /sustainability|esg|csr|environmental|social|governance|sustainability report|esg report/i.test($('body').text().slice(0, 2000));
        if (isLikelyReport) {
          await Dataset.pushData({
            company,
            title,
            date,
            pdf_url: '',
            exec_summary,
            tags: Array.from(new Set(tags)),
            url: loadedUrl,
          });
          log.info('Saved HTML report candidate', { url: loadedUrl });
        } else {
          log.debug('No report-like content detected on page', { url: loadedUrl });
        }
      }
    } catch (err) {
      log.warning('Extraction error', { url: loadedUrl, message: err.message });
    }
  },
});

await crawler.run(startUrls);

// Exit
await Actor.exit();
