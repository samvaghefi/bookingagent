/**
 * Bimbly Intel Monitor — Competitive Intelligence Cron Job
 *
 * Required environment variables:
 *   SUPABASE_URL            — Supabase project URL (already on Render)
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (NOT anon key) for server-side writes
 *   SENDGRID_API_KEY        — SendGrid API key (already on Render)
 *   ANTHROPIC_API_KEY       — Anthropic API key (already on Render)
 *
 * Run standalone: node competitor-monitor/index.js
 * Or require as module: const monitor = require('./competitor-monitor'); await monitor.run();
 *
 * NOTE: Run the SQL in competitor-monitor/supabase-migration.sql in your Supabase
 * SQL editor before first use.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');
const cheerio = require('cheerio');
const RssParser = require('rss-parser');

const competitors = require('./competitors');
const bimblyContext = require('./bimbly-context');

// ─── Supabase (service role for server-side writes) ───────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = 'hello@bimblyai.com';
const TO_EMAIL = 'vaghefi@gmail.com';

const rssParser = new RssParser({ timeout: 10000 });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Toronto',
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Extract pricing-relevant text from HTML using cheerio
function extractPricingText($) {
  const pricingKeywords = /\$|\/mo|per month|free|plan|tier|price|pricing|month/i;
  const candidates = [];
  $('*').each((_, el) => {
    const tag = el.name;
    if (['script', 'style', 'head', 'noscript', 'svg', 'path'].includes(tag)) return;
    const text = $(el).clone().children().remove().end().text().trim();
    if (text && pricingKeywords.test(text)) {
      candidates.push(text);
    }
  });
  // Deduplicate while preserving order
  const seen = new Set();
  return candidates.filter(t => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  }).join('\n').slice(0, 8000);
}

// Extract main site text from structural elements
function extractMainText($) {
  const tags = ['h1', 'h2', 'h3', 'p', 'nav'];
  const parts = [];
  tags.forEach(tag => {
    $(tag).each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text.length > 10) parts.push(text);
    });
  });
  const seen = new Set();
  return parts.filter(t => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  }).join('\n').slice(0, 8000);
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getSnapshot(competitorName, snapshotType, guid = null) {
  const query = supabase
    .from('competitor_snapshots')
    .select('content_hash, content_text, updated_at')
    .eq('competitor_name', competitorName)
    .eq('snapshot_type', snapshotType);
  if (guid) query.eq('guid', guid);
  else query.is('guid', null);
  const { data } = await query.maybeSingle();
  return data;
}

async function upsertSnapshot(competitorName, snapshotType, { hash, text, guid = null } = {}) {
  const record = {
    competitor_name: competitorName,
    snapshot_type: snapshotType,
    content_hash: hash || null,
    content_text: text || null,
    guid: guid || null,
    updated_at: new Date().toISOString(),
  };
  await supabase.from('competitor_snapshots').upsert(record, {
    onConflict: 'competitor_name,snapshot_type,guid',
    ignoreDuplicates: false,
  });
}

async function newsGuidSeen(competitorName, guid) {
  const { data } = await supabase
    .from('competitor_snapshots')
    .select('id')
    .eq('competitor_name', competitorName)
    .eq('snapshot_type', 'news_guid')
    .eq('guid', guid)
    .maybeSingle();
  return !!data;
}

async function markNewsGuid(competitorName, guid) {
  await supabase.from('competitor_snapshots').upsert({
    competitor_name: competitorName,
    snapshot_type: 'news_guid',
    guid,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'competitor_name,snapshot_type,guid', ignoreDuplicates: true });
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchPageText(url, extractor) {
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BimblyIntelBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-CA,en;q=0.9',
    },
    maxRedirects: 5,
  });
  const $ = cheerio.load(resp.data);
  return extractor($);
}

async function fetchNewsItems(competitor) {
  const query = encodeURIComponent(competitor.newsQuery);
  const feedUrl = `https://news.google.com/rss/search?q=${query}&hl=en-CA&gl=CA&ceid=CA:en`;
  const feed = await rssParser.parseURL(feedUrl);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (feed.items || []).filter(item => {
    const pub = item.pubDate ? new Date(item.pubDate).getTime() : 0;
    return pub >= cutoff;
  }).map(item => ({
    title: item.title || '(no title)',
    link: item.link || item.guid,
    pubDate: item.pubDate,
    source: (item['source'] && item['source']['$'] && item['source']['$']['url'])
      ? item['source']['$']['url']
      : (item['source'] ? String(item['source']) : 'Google News'),
    guid: item.guid || item.link,
  }));
}

// ─── Per-competitor check ─────────────────────────────────────────────────────

async function checkCompetitor(competitor, isFirstRun) {
  const result = {
    name: competitor.name,
    news: [],       // new articles
    pricingChange: null,
    mainChange: null,
    errors: [],
  };

  // 1. News
  try {
    const items = await fetchNewsItems(competitor);
    for (const item of items) {
      const seen = await newsGuidSeen(competitor.name, item.guid);
      if (!seen) {
        if (!isFirstRun) result.news.push(item);
        await markNewsGuid(competitor.name, item.guid);
      }
    }
  } catch (err) {
    result.errors.push(`News fetch failed: ${err.message}`);
  }

  await sleep(500); // gentle rate limiting between requests

  // 2. Pricing page
  try {
    const text = await fetchPageText(competitor.pricingUrl, extractPricingText);
    const hash = sha256(text);
    const prev = await getSnapshot(competitor.name, 'pricing');
    if (!prev) {
      // First run — store baseline
      await upsertSnapshot(competitor.name, 'pricing', { hash, text });
    } else if (prev.content_hash !== hash) {
      result.pricingChange = {
        oldText: prev.content_text ? prev.content_text.slice(0, 300) : null,
        newText: text.slice(0, 300),
      };
      await upsertSnapshot(competitor.name, 'pricing', { hash, text });
    }
  } catch (err) {
    result.errors.push(`Pricing fetch failed: ${err.message}`);
  }

  await sleep(500);

  // 3. Main site
  try {
    const text = await fetchPageText(competitor.url, extractMainText);
    const hash = sha256(text);
    const prev = await getSnapshot(competitor.name, 'main');
    if (!prev) {
      await upsertSnapshot(competitor.name, 'main', { hash, text });
    } else if (prev.content_hash !== hash) {
      result.mainChange = {
        oldText: prev.content_text ? prev.content_text.slice(0, 300) : null,
        newText: text.slice(0, 300),
      };
      await upsertSnapshot(competitor.name, 'main', { hash, text });
    }
  } catch (err) {
    result.errors.push(`Main site fetch failed: ${err.message}`);
  }

  return result;
}

// ─── AI Analysis ─────────────────────────────────────────────────────────────

async function getAiAnalysis(allResults) {
  const changesSummary = allResults.map(r => {
    const parts = [];
    if (r.news.length) parts.push(`News (${r.news.length} articles): ${r.news.map(n => n.title).join('; ')}`);
    if (r.pricingChange) parts.push(`Pricing page changed.`);
    if (r.mainChange) parts.push(`Main site content changed.`);
    if (!parts.length) parts.push('No changes detected.');
    return `${r.name}: ${parts.join(' | ')}`;
  }).join('\n');

  const userPrompt = `Here is what Bimbly's competitors did in the last 24 hours:

${changesSummary}

Here is Bimbly's current state:
- Name: ${bimblyContext.name}
- Tagline: ${bimblyContext.tagline}
- Pricing: ${bimblyContext.pricing.map(p => `${p.plan} CA$${p.price}/mo`).join(', ')}
- Key features: ${bimblyContext.keyFeatures.join('; ')}
- Missing features (backlog): ${bimblyContext.missingFeatures.join('; ')}
- Target customer: ${bimblyContext.targetCustomer}
- Geographic focus: ${bimblyContext.geographicFocus}

Respond with ONLY a valid JSON object (no markdown, no commentary) with these fields:
{
  "edges": ["string", ...],
  "blindspots": ["string", ...],
  "pricingSignal": "string",
  "urgentFlag": "string or null",
  "summary": "string"
}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: 'You are a sharp, opinionated product strategist advising an early-stage AI SaaS startup called Bimbly AI. You will be given a summary of what Bimbly\'s competitors have done in the last 24 hours and Bimbly\'s current state. Write a concise strategic analysis. Be direct. No fluff. No em dashes. Use plain language a founder can act on.',
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const raw = response.data.content[0].text.trim();
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// ─── HTML Email Builder ───────────────────────────────────────────────────────

function buildHtml(allResults, analysis, isFirstRun, date, briefOnly = false) {
  const today = formatDate(date);

  const urgentBanner = analysis && analysis.urgentFlag
    ? `<div style="background:#dc2626;color:#fff;padding:14px 24px;font-size:14px;font-weight:600;border-radius:6px;margin-bottom:16px;">
        ⚠ URGENT: ${analysis.urgentFlag}
      </div>`
    : '';

  // Analysis section (dark navy)
  const analysisSection = analysis
    ? `<div style="background:#0f172a;border-radius:8px;padding:24px;margin-top:24px;color:#e2e8f0;">
        <div style="font-size:16px;font-weight:700;color:#f1f5f9;margin-bottom:16px;letter-spacing:0.5px;">BIMBLY STRATEGIC ANALYSIS</div>
        ${analysis.urgentFlag ? `<div style="background:#7f1d1d;border-left:4px solid #dc2626;padding:10px 14px;border-radius:4px;margin-bottom:14px;color:#fca5a5;font-size:13px;"><strong>Urgent:</strong> ${analysis.urgentFlag}</div>` : ''}
        ${analysis.edges && analysis.edges.length ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Edges</div>
            ${analysis.edges.map(e => `<div style="margin-bottom:4px;font-size:13px;">✅ ${e}</div>`).join('')}
          </div>` : ''}
        ${analysis.blindspots && analysis.blindspots.length ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Blindspots</div>
            ${analysis.blindspots.map(b => `<div style="margin-bottom:4px;font-size:13px;">⚠️ ${b}</div>`).join('')}
          </div>` : ''}
        ${analysis.pricingSignal ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Pricing Signal</div>
            <div style="font-size:13px;color:#cbd5e1;">${analysis.pricingSignal}</div>
          </div>` : ''}
        ${analysis.summary ? `
          <div style="border-top:1px solid #1e293b;padding-top:14px;margin-top:14px;">
            <div style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Summary</div>
            <div style="font-size:13px;color:#cbd5e1;line-height:1.6;">${analysis.summary}</div>
          </div>` : ''}
      </div>`
    : `<div style="background:#1e293b;border-radius:8px;padding:20px;margin-top:24px;color:#94a3b8;font-size:13px;">Strategic analysis unavailable for this run.</div>`;

  if (briefOnly) {
    return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:16px;background:#f8fafc;">
      <div style="background:#1e293b;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:18px;font-weight:700;">Bimbly Intel Report</span>
        <span style="font-size:13px;color:#94a3b8;">${today}</span>
      </div>
      <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        ${urgentBanner}
        <p style="color:#475569;font-size:14px;margin:0 0 16px;">The full report is attached as a PDF. The strategic analysis is shown below.</p>
        ${analysisSection}
        <div style="text-align:center;margin-top:28px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:16px;">
          Generated by Bimbly Intel Monitor &middot; Next run tomorrow at 7:00 AM ET
        </div>
      </div>
    </body></html>`;
  }

  // Full inline email — competitor cards
  const competitorCards = allResults
    .filter(r => r.news.length || r.pricingChange || r.mainChange)
    .map(r => {
      const badges = [];
      const items = [];

      r.news.forEach(n => {
        const pub = n.pubDate ? new Date(n.pubDate).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' }) : '';
        badges.push('<span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;">News</span>');
        items.push(`<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
          <a href="${n.link}" style="color:#1e40af;text-decoration:none;font-size:13px;font-weight:500;">${n.title}</a>
          <div style="font-size:11px;color:#94a3b8;margin-top:3px;">${n.source} &middot; ${pub}</div>
        </div>`);
      });

      if (r.pricingChange) {
        badges.push('<span style="background:#ffedd5;color:#c2410c;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;">Pricing Change</span>');
        items.push(`<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:13px;font-weight:500;color:#374151;">Pricing page changed</div>
          ${r.pricingChange.newText ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;font-family:monospace;background:#f9fafb;padding:6px;border-radius:4px;overflow:hidden;max-height:60px;">${r.pricingChange.newText.slice(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
        </div>`);
      }

      if (r.mainChange) {
        badges.push('<span style="background:#f3f4f6;color:#4b5563;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;">Site Change</span>');
        items.push(`<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:13px;font-weight:500;color:#374151;">Main site content changed</div>
          ${r.mainChange.newText ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;font-family:monospace;background:#f9fafb;padding:6px;border-radius:4px;overflow:hidden;max-height:60px;">${r.mainChange.newText.slice(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
        </div>`);
      }

      const uniqueBadges = [...new Set(badges)];
      return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:16px;background:#fff;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:6px;">
          <div style="font-size:14px;font-weight:700;color:#0f172a;">${r.name}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${uniqueBadges.join('')}</div>
        </div>
        ${items.join('')}
      </div>`;
    }).join('');

  const noChanges = !competitorCards
    ? '<p style="color:#94a3b8;font-size:14px;">No competitor changes detected today.</p>'
    : '';

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:16px;background:#f8fafc;">
    <div style="background:#1e293b;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-size:18px;font-weight:700;">Bimbly Intel Report</span>
      <span style="font-size:13px;color:#94a3b8;">${today}${isFirstRun ? ' (Baseline)' : ''}</span>
    </div>
    <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      ${urgentBanner}
      ${competitorCards}
      ${noChanges}
      ${analysisSection}
      <div style="text-align:center;margin-top:28px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:16px;">
        Generated by Bimbly Intel Monitor &middot; Next run tomorrow at 7:00 AM ET
      </div>
    </div>
  </body></html>`;
}

// ─── PDF via Puppeteer ────────────────────────────────────────────────────────

async function generatePdf(html, outputPath) {
  // Lazy-require puppeteer so missing package doesn't crash non-PDF runs
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({ path: outputPath, format: 'A4', margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
  await browser.close();
}

// ─── Send Email ───────────────────────────────────────────────────────────────

async function sendEmail(subject, html, pdfPath) {
  const msg = {
    to: TO_EMAIL,
    from: FROM_EMAIL,
    subject,
    html,
  };

  if (pdfPath && fs.existsSync(pdfPath)) {
    const pdfContent = fs.readFileSync(pdfPath);
    msg.attachments = [{
      content: pdfContent.toString('base64'),
      filename: path.basename(pdfPath),
      type: 'application/pdf',
      disposition: 'attachment',
    }];
  }

  await sgMail.send(msg);
  console.log(`[email] Sent: ${subject}`);
}

// ─── Main run ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n========================================');
  console.log('Bimbly Intel Monitor starting...');
  console.log(`Run date: ${todayStr()}`);
  console.log('========================================\n');

  console.log('IMPORTANT: Run the SQL in competitor-monitor/supabase-migration.sql');
  console.log('in your Supabase SQL editor before first use.\n');

  // Determine if this is the first run (no snapshots in DB at all)
  const { count } = await supabase
    .from('competitor_snapshots')
    .select('id', { count: 'exact', head: true });
  const isFirstRun = count === 0;

  if (isFirstRun) {
    console.log('[first-run] No existing snapshots found. Storing baselines...');
  }

  // Check all competitors
  const allResults = [];
  for (const competitor of competitors) {
    console.log(`[check] ${competitor.name}...`);
    try {
      const result = await checkCompetitor(competitor, isFirstRun);
      allResults.push(result);
      if (result.errors.length) {
        result.errors.forEach(e => console.warn(`  [warn] ${competitor.name}: ${e}`));
      }
      const changes = result.news.length + (result.pricingChange ? 1 : 0) + (result.mainChange ? 1 : 0);
      console.log(`  news=${result.news.length} pricing=${result.pricingChange ? 'CHANGED' : 'same'} main=${result.mainChange ? 'CHANGED' : 'same'}`);
    } catch (err) {
      console.error(`  [error] ${competitor.name} failed entirely: ${err.message}`);
      allResults.push({ name: competitor.name, news: [], pricingChange: null, mainChange: null, errors: [err.message] });
    }
    await sleep(1000); // polite delay between competitors
  }

  // Count total changes
  const totalChanges = allResults.reduce((sum, r) => {
    return sum + r.news.length + (r.pricingChange ? 1 : 0) + (r.mainChange ? 1 : 0);
  }, 0);

  console.log(`\n[summary] Total changes detected: ${totalChanges}`);

  const shouldSend = isFirstRun || totalChanges > 0;

  let analysis = null;
  let emailSent = false;
  let pdfPath = null;

  if (shouldSend) {
    // AI analysis
    try {
      console.log('[ai] Requesting strategic analysis from Claude...');
      analysis = await getAiAnalysis(allResults);
      console.log('[ai] Analysis received.');
    } catch (err) {
      console.error(`[ai] Analysis failed: ${err.message}`);
      analysis = null;
    }

    const date = new Date();
    const dateStr = todayStr();
    const totalItems = allResults.reduce((sum, r) => sum + r.news.length + (r.pricingChange ? 1 : 0) + (r.mainChange ? 1 : 0), 0);

    let subject, html;

    if (isFirstRun) {
      subject = `Bimbly Intel -- Baseline Report -- ${dateStr}`;
      html = buildHtml(allResults, analysis, true, date, false);
    } else {
      subject = `Bimbly Intel Report -- ${dateStr} -- ${totalItems} update${totalItems !== 1 ? 's' : ''} detected`;

      if (totalItems > 6) {
        // Generate full HTML for PDF
        const fullHtml = buildHtml(allResults, analysis, false, date, false);

        pdfPath = path.join(__dirname, `bimbly-intel-${dateStr}.pdf`);
        try {
          console.log('[pdf] Generating PDF...');
          await generatePdf(fullHtml, pdfPath);
          console.log(`[pdf] Written to ${pdfPath}`);
        } catch (err) {
          console.error(`[pdf] Generation failed: ${err.message}`);
          pdfPath = null;
        }

        // Brief HTML for email body
        html = buildHtml(allResults, analysis, false, date, true);
      } else {
        html = buildHtml(allResults, analysis, false, date, false);
      }
    }

    // Save HTML for local inspection
    const htmlOutputPath = path.join(__dirname, 'last-report.html');
    fs.writeFileSync(htmlOutputPath, html);
    console.log(`[html] Report saved to ${htmlOutputPath}`);

    try {
      await sendEmail(subject, html, pdfPath);
      emailSent = true;
    } catch (err) {
      console.error(`[email] SendGrid failed: ${JSON.stringify(err.response?.body || err.message)}`);
    }
  } else {
    console.log('[skip] No changes detected. No email will be sent.');
  }

  // Log run to DB
  const reportSummary = allResults.map(r => {
    const parts = [];
    if (r.news.length) parts.push(`${r.news.length} news`);
    if (r.pricingChange) parts.push('pricing change');
    if (r.mainChange) parts.push('main change');
    if (r.errors.length) parts.push(`${r.errors.length} error(s)`);
    return `${r.name}: ${parts.join(', ') || 'no changes'}`;
  }).join(' | ');

  const { error: logError } = await supabase.from('competitor_report_log').insert({
    run_date: todayStr(),
    changes_detected: totalChanges,
    email_sent: emailSent,
    report_summary: reportSummary.slice(0, 2000),
  });

  if (logError) console.error('[db] Failed to log run:', logError.message);

  // Cleanup temp PDF
  if (pdfPath && fs.existsSync(pdfPath)) {
    fs.unlinkSync(pdfPath);
  }

  console.log('\n[done] Run complete.');
  console.log(`  Changes detected: ${totalChanges}`);
  console.log(`  Email sent: ${emailSent}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}
