/**
 * researchReport.js — One-time deep competitor research report generator
 *
 * Researches all competitors via Anthropic API with web search,
 * generates a PDF report, and emails it to vaghefi@gmail.com.
 *
 * Required env vars: ANTHROPIC_API_KEY, SENDGRID_API_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');
const competitors = require('./competitors');
const bimblyContext = require('./bimbly-context');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const FROM_EMAIL = 'hello@bimblyai.com';
const TO_EMAIL = 'vaghefi@gmail.com';
const RESEARCH_MODEL = 'claude-sonnet-4-20250514';
const SYSTEM_PROMPT = 'You are a sharp product analyst researching SaaS competitors for bimblyai, an AI voice receptionist for independent barbershops, hair salons, and nail salons in Canada. Research thoroughly and be specific with pricing numbers, feature lists, and target markets. No fluff.';

// ─── Anthropic helper ─────────────────────────────────────────────────────────

async function anthropicCall(system, userContent, useWebSearch = false) {
  const headers = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  const body = {
    model: RESEARCH_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: userContent }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const resp = await axios.post('https://api.anthropic.com/v1/messages', body, {
    headers,
    timeout: 120000,
  });

  // Extract text blocks — Anthropic server-side web search returns mixed content
  const content = resp.data.content || [];
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
  return text.trim();
}

// ─── Step 1: Research each competitor ─────────────────────────────────────────

async function researchCompetitor(competitor) {
  const prompt = `Research ${competitor.name} (website: ${competitor.url}, pricing: ${competitor.pricingUrl}) and provide a detailed analysis in JSON format with these exact fields:
{
  "name": "string",
  "tagline": "string (their main value prop in one sentence)",
  "pricingModel": "string (how they charge — per booking, monthly, commission, etc)",
  "pricingTiers": [{ "name": "string", "price": "string", "period": "string", "features": ["string"] }],
  "targetMarket": "string (who they primarily sell to)",
  "industries": ["string"],
  "geographicFocus": "string",
  "keyFeatures": ["string (top 5-7 features)"],
  "strengths": ["string"],
  "weaknesses": ["string"],
  "bookingChannels": ["string"],
  "hasVoiceAI": false,
  "hasMultilingual": false,
  "hasWalkInWaitlist": false,
  "perBookingFee": false,
  "setupFee": false,
  "recentNews": "string or null"
}
Return ONLY the JSON object, no markdown, no preamble.`;

  const raw = await anthropicCall(SYSTEM_PROMPT, prompt, true);
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// ─── Step 2: Strategic analysis ───────────────────────────────────────────────

async function generateStrategicAnalysis(researchResults) {
  const prompt = `Based on this competitive research data and bimblyai's current state, generate a strategic analysis in JSON:

RESEARCH DATA:
${JSON.stringify(researchResults.filter(r => !r.error), null, 2)}

BIMBLYAI CONTEXT:
${JSON.stringify(bimblyContext, null, 2)}

Return JSON with these exact fields:
{
  "executiveSummary": "string (3-4 sentences on the overall competitive landscape)",
  "bimblyaiEdges": ["string"],
  "bimblyaiBlindspots": ["string"],
  "pricingAnalysis": "string (how bimblyai pricing compares, is it competitive, what to watch)",
  "biggestThreat": "string (which competitor poses the most risk and why)",
  "biggestOpportunity": "string (the clearest market gap bimblyai should move into)",
  "recommendations": ["string (3-5 specific actionable recommendations)"]
}
Return ONLY the JSON object, no markdown, no preamble.`;

  const raw = await anthropicCall(SYSTEM_PROMPT, prompt, false);
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// ─── Step 3: HTML report ──────────────────────────────────────────────────────

function buildReportHtml(researchResults, analysis, dateStr) {
  const icon = v => v ? '✅' : '❌';
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const tocItems = researchResults.map((r, i) =>
    `<li><a href="#c${i}" style="color:#534ab7;text-decoration:none;">${esc(r.name)}</a></li>`
  ).join('');

  const competitorSections = researchResults.map((r, i) => {
    if (r.error) {
      return `<div id="c${i}" style="margin-bottom:40px;padding:24px;border:1px solid #fecaca;border-radius:12px;background:#fff;">
        <h2 style="margin:0 0 8px;color:#0f172a;">${esc(r.name)}</h2>
        <p style="color:#ef4444;font-size:13px;">Research failed: ${esc(r.error)}</p>
      </div>`;
    }

    const pricingTable = (r.pricingTiers || []).length
      ? `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;">
          <thead><tr style="background:#f8fafc;">
            <th style="padding:7px 10px;text-align:left;border:1px solid #e2e8f0;">Plan</th>
            <th style="padding:7px 10px;text-align:left;border:1px solid #e2e8f0;">Price</th>
            <th style="padding:7px 10px;text-align:left;border:1px solid #e2e8f0;">Billing</th>
            <th style="padding:7px 10px;text-align:left;border:1px solid #e2e8f0;">Includes</th>
          </tr></thead>
          <tbody>${(r.pricingTiers || []).map(t =>
            `<tr>
              <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:600;">${esc(t.name)}</td>
              <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#059669;font-weight:600;">${esc(t.price)}</td>
              <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#6b7280;">${esc(t.period)}</td>
              <td style="padding:7px 10px;border:1px solid #e2e8f0;">${(t.features || []).map(esc).join(', ')}</td>
            </tr>`
          ).join('')}</tbody>
        </table>`
      : '<p style="color:#9ca3af;font-size:12px;margin:4px 0;">Pricing not available</p>';

    const pills = (r.industries || []).map(ind =>
      `<span style="display:inline-block;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:999px;font-size:11px;font-weight:600;padding:2px 10px;margin:2px;">${esc(ind)}</span>`
    ).join('');

    const features = (r.keyFeatures || []).map(f =>
      `<li style="padding:3px 0;color:#374151;font-size:12px;">${esc(f)}</li>`
    ).join('');

    const strengths = (r.strengths || []).map(s =>
      `<div style="padding:5px 9px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:3px;margin-bottom:5px;font-size:12px;color:#166534;">✓ ${esc(s)}</div>`
    ).join('');

    const weaknesses = (r.weaknesses || []).map(w =>
      `<div style="padding:5px 9px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:3px;margin-bottom:5px;font-size:12px;color:#991b1b;">✗ ${esc(w)}</div>`
    ).join('');

    const channels = (r.bookingChannels || []).map(c =>
      `<span style="display:inline-block;background:#f3f4f6;color:#374151;border-radius:4px;font-size:11px;padding:2px 7px;margin:2px;">${esc(c)}</span>`
    ).join('');

    const newsBox = r.recentNews
      ? `<div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;margin-top:14px;">
          <div style="font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Recent News</div>
          <div style="font-size:12px;color:#78350f;">${esc(r.recentNews)}</div>
        </div>`
      : '';

    return `<div id="c${i}" style="margin-bottom:44px;padding:24px 28px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="border-bottom:2px solid #e5e7eb;padding-bottom:14px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
          <div>
            <h2 style="margin:0 0 3px;color:#0f172a;font-size:20px;">${esc(r.name)}</h2>
            <a href="${esc(r.url || '#')}" style="color:#534ab7;font-size:12px;">${esc(r.url || '')}</a>
            ${r.tagline ? `<p style="margin:6px 0 0;color:#6b7280;font-size:13px;font-style:italic;">"${esc(r.tagline)}"</p>` : ''}
          </div>
          <div style="font-size:12px;line-height:1.9;text-align:right;">
            ${icon(r.hasVoiceAI)} Voice AI &nbsp;|&nbsp; ${icon(r.hasMultilingual)} Multilingual<br>
            ${icon(r.hasWalkInWaitlist)} Walk-in Waitlist &nbsp;|&nbsp; ${icon(r.perBookingFee)} Per-booking Fee<br>
            ${icon(r.setupFee)} Setup Fee
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">
        <div>
          <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Target Market</div>
          <div style="font-size:12px;color:#374151;">${esc(r.targetMarket)}</div>
          <div style="margin-top:6px;">${pills}</div>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Geographic Focus</div>
          <div style="font-size:12px;color:#374151;">${esc(r.geographicFocus)}</div>
          <div style="margin-top:8px;">
            <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Booking Channels</div>
            <div>${channels}</div>
          </div>
        </div>
      </div>

      <div style="margin-bottom:14px;">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Pricing — ${esc(r.pricingModel)}</div>
        ${pricingTable}
      </div>

      <div style="margin-bottom:14px;">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Key Features</div>
        <ul style="margin:0;padding-left:18px;">${features}</ul>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:4px;">
        <div>
          <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Strengths</div>
          ${strengths || '<p style="color:#9ca3af;font-size:11px;margin:0;">None listed</p>'}
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Weaknesses</div>
          ${weaknesses || '<p style="color:#9ca3af;font-size:11px;margin:0;">None listed</p>'}
        </div>
      </div>

      ${newsBox}
    </div>`;
  }).join('');

  const strategicSection = analysis ? `
    <div id="strategic" style="margin-top:48px;padding:28px 32px;border-radius:12px;background:#0f172a;color:#e2e8f0;">
      <h2 style="margin:0 0 22px;color:#fff;font-size:20px;border-bottom:1px solid #1e293b;padding-bottom:14px;">bimblyai Strategic Analysis</h2>

      <div style="margin-bottom:20px;">
        <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Executive Summary</div>
        <p style="color:#cbd5e1;font-size:13px;line-height:1.7;margin:0;">${esc(analysis.executiveSummary)}</p>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
        <div>
          <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Our Edges</div>
          ${(analysis.bimblyaiEdges || []).map(e =>
            `<div style="margin-bottom:5px;font-size:12px;color:#86efac;">✅ ${esc(e)}</div>`
          ).join('')}
        </div>
        <div>
          <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Blindspots</div>
          ${(analysis.bimblyaiBlindspots || []).map(b =>
            `<div style="margin-bottom:5px;font-size:12px;color:#fde68a;">⚠️ ${esc(b)}</div>`
          ).join('')}
        </div>
      </div>

      <div style="padding:14px;background:#1e293b;border-radius:8px;margin-bottom:20px;">
        <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Pricing Analysis</div>
        <p style="color:#cbd5e1;font-size:12px;margin:0;line-height:1.6;">${esc(analysis.pricingAnalysis)}</p>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px;">
        <div style="padding:14px;background:#7f1d1d;border-radius:8px;">
          <div style="font-size:10px;color:#fca5a5;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">⚠ Biggest Threat</div>
          <p style="color:#fecaca;font-size:12px;margin:0;line-height:1.6;">${esc(analysis.biggestThreat)}</p>
        </div>
        <div style="padding:14px;background:#14532d;border-radius:8px;">
          <div style="font-size:10px;color:#86efac;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">✦ Biggest Opportunity</div>
          <p style="color:#bbf7d0;font-size:12px;margin:0;line-height:1.6;">${esc(analysis.biggestOpportunity)}</p>
        </div>
      </div>

      <div>
        <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Recommendations</div>
        <ol style="margin:0;padding-left:18px;">
          ${(analysis.recommendations || []).map(r =>
            `<li style="margin-bottom:7px;color:#cbd5e1;font-size:12px;line-height:1.6;">${esc(r)}</li>`
          ).join('')}
        </ol>
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>bimblyai Competitive Intelligence Research Report — ${dateStr}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; margin: 0; padding: 0; background: #f8fafc; color: #0f172a; }
</style>
</head>
<body>
  <!-- Header -->
  <div style="background:#0f172a;padding:28px 40px;">
    <div style="max-width:960px;margin:0 auto;">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;">bimblyai</div>
      <h1 style="margin:0 0 6px;color:#fff;font-size:24px;font-weight:700;">Competitive Intelligence Research Report</h1>
      <div style="color:#94a3b8;font-size:12px;">Generated ${dateStr} &nbsp;·&nbsp; ${researchResults.length} competitors analyzed</div>
    </div>
  </div>

  <div style="max-width:960px;margin:0 auto;padding:32px 40px;">
    <!-- Table of Contents -->
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 24px;margin-bottom:36px;">
      <h3 style="margin:0 0 12px;color:#0f172a;font-size:14px;">Contents</h3>
      <ol style="margin:0;padding-left:18px;columns:2;column-gap:24px;font-size:13px;">
        ${tocItems}
        <li><a href="#strategic" style="color:#534ab7;text-decoration:none;">Strategic Analysis</a></li>
      </ol>
    </div>

    ${competitorSections}
    ${strategicSection}

    <div style="text-align:center;margin-top:40px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
      Generated by bimblyai intel monitor &middot; ${dateStr}
    </div>
  </div>
</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function generateResearchReport() {
  const startTime = Date.now();
  const dateStr = new Date().toISOString().slice(0, 10);

  console.log('\n========================================');
  console.log('bimblyai Research Report Generator');
  console.log(`Date: ${dateStr} | Competitors: ${competitors.length}`);
  console.log('========================================\n');

  // Step 1 — Research each competitor
  const researchResults = [];
  for (let i = 0; i < competitors.length; i++) {
    const competitor = competitors[i];
    const idx = `[${i + 1}/${competitors.length}]`;
    process.stdout.write(`${idx} Researching ${competitor.name}... `);
    const t0 = Date.now();
    try {
      const data = await researchCompetitor(competitor);
      researchResults.push(data);
      console.log(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      // Retry once on 429
      if (err.response && err.response.status === 429) {
        console.log(`rate limited — retrying in 10s...`);
        await delay(10000);
        try {
          const data = await researchCompetitor(competitor);
          researchResults.push(data);
          console.log(`${idx} ${competitor.name} retry done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } catch (retryErr) {
          console.log(`${idx} ${competitor.name} retry FAILED: ${retryErr.message}`);
          researchResults.push({ name: competitor.name, error: retryErr.message });
        }
      } else {
        console.log(`FAILED: ${err.message}`);
        researchResults.push({ name: competitor.name, error: err.message });
      }
    }
    if (i < competitors.length - 1) await delay(3000);
  }

  // Step 2 — Strategic analysis
  let analysis = null;
  try {
    console.log('\nGenerating strategic analysis...');
    analysis = await generateStrategicAnalysis(researchResults);
    console.log('Strategic analysis complete');
  } catch (err) {
    console.error(`Strategic analysis failed: ${err.message}`);
  }

  // Step 3 — Build HTML
  console.log('\nBuilding HTML report...');
  const reportHtml = buildReportHtml(researchResults, analysis, dateStr);

  // Step 4 — Generate PDF
  const pdfPath = `/tmp/bimblyai-research-${dateStr}.pdf`;
  let pdfGenerated = false;
  try {
    console.log('Generating PDF via Puppeteer...');
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(reportHtml, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
    });
    await browser.close();
    pdfGenerated = true;
    console.log(`PDF saved: ${pdfPath}`);
  } catch (err) {
    console.error(`PDF generation failed (${err.message}) — will send HTML as email body`);
  }

  // Step 5 — Send email
  console.log('\nSending email...');
  const emailBodyHtml = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0f172a;padding:24px 32px;border-radius:8px 8px 0 0;">
        <div style="font-size:11px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">bimblyai</div>
        <div style="color:#fff;font-size:18px;font-weight:700;">Competitive Research Report</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${dateStr}</div>
      </div>
      <div style="background:#fff;padding:24px 32px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px;">
        <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 14px;">
          Your competitive research report is attached. This covers all ${competitors.length} competitors with pricing, features, target markets, and strategic analysis.
        </p>
        <ul style="color:#374151;font-size:13px;line-height:1.9;padding-left:20px;margin:0 0 14px;">
          ${competitors.map(c => `<li>${c.name}</li>`).join('')}
        </ul>
        <p style="color:#6b7280;font-size:12px;margin:0;">
          The report includes bimblyai's competitive edges, blindspots, biggest threat, biggest opportunity, and specific recommendations.
        </p>
      </div>
    </div>`;

  const msg = {
    to: TO_EMAIL,
    from: { email: FROM_EMAIL, name: 'bimblyai' },
    subject: `bimblyai Competitive Research Report — ${dateStr}`,
    html: pdfGenerated ? emailBodyHtml : reportHtml,
  };

  if (pdfGenerated && fs.existsSync(pdfPath)) {
    msg.attachments = [{
      content: fs.readFileSync(pdfPath).toString('base64'),
      filename: `bimblyai-research-${dateStr}.pdf`,
      type: 'application/pdf',
      disposition: 'attachment',
    }];
  }

  await sgMail.send(msg);
  console.log(`Email sent to ${TO_EMAIL}`);

  // Step 6 — Cleanup
  if (pdfGenerated && fs.existsSync(pdfPath)) {
    fs.unlinkSync(pdfPath);
    console.log('Temp PDF deleted');
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ Research report complete in ${elapsed}s`);
}

module.exports = { generateResearchReport };

if (require.main === module) {
  generateResearchReport().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}
