'use strict';

// Shared look for the server-rendered auth pages (login, forgot, reset).
// Matches bimblyai.com: "the book fills itself" (ledger paper, pole-blue ink,
// pole-red stamps). Logo files live in dashboard/brand/ (copied from the website).

const LOGO = '<a class="auth-logo" href="https://bimblyai.com" aria-label="Bimbly home"><img src="/dashboard/brand/bimblyai-logo-primary.svg" alt="Bimblyai" width="166" height="40"></a>';

function authHead(title) {
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="theme-color" content="#FAFBF9">
  <meta name="robots" content="noindex">
  <link rel="icon" href="/dashboard/brand/bimblyai-logo-icon.svg" type="image/svg+xml">
  <link rel="icon" href="/dashboard/brand/favicon.png" sizes="32x32" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;700&family=Kalam&family=Schibsted+Grotesk:wght@600;700;800&display=swap" rel="stylesheet">
  <style>${AUTH_CSS}</style>`;
}

const AUTH_CSS = `
  :root {
    --paper: #FAFBF9; --sheet: #FEFEFC; --tint: #F0F3F6;
    --rule: #D3DFEB; --rule-strong: #A9BED5;
    --ink: #2346C8; --ink-deep: #1A36A0; --ink-soft: #E6ECFF;
    --stamp: #D7372B; --stamp-btn: #C42E21; --stamp-soft: #FCEAE8;
    --graphite: #2C2D33; --graphite-2: #575963;
    --night: #141B33; --night-2: #232C4C;
    --f-display: 'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif;
    --f-body: 'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', system-ui, sans-serif;
    --f-hand: 'Kalam', 'Bradley Hand', 'Segoe Print', cursive;
    --ease: cubic-bezier(0.16, 1, 0.3, 1);
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; min-height: 100vh; background: var(--paper); color: var(--graphite);
    font-family: var(--f-body); font-size: 1.0625rem; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  img, svg { display: block; max-width: 100%; }
  h1, h2 { font-family: var(--f-display); color: var(--graphite); margin: 0; letter-spacing: -0.03em; text-wrap: balance; }
  h1 { font-size: clamp(2rem, 1.6rem + 1.8vw, 2.75rem); font-weight: 800; line-height: 1.02; }
  p { margin: 0; }
  a { color: var(--ink-deep); text-underline-offset: 0.18em; }
  a:hover { color: var(--ink); }
  :focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; border-radius: 4px; }

  .auth-logo { display: inline-block; margin-bottom: 40px; }
  .auth-logo img { height: 40px; width: auto; }
  .sub, p.sub { margin: 10px 0 28px; color: var(--graphite-2); font-size: 1.0625rem; }

  /* Fields */
  .field { margin-bottom: 16px; }
  label { display: block; font-weight: 700; font-size: 1rem; margin-bottom: 6px; }
  input[type=email], input[type=password], input[type=text] {
    width: 100%; min-height: 52px; padding: 12px 14px;
    font: inherit; font-size: 1.0625rem; color: var(--graphite);
    background: #fff; border: 1.5px solid var(--rule-strong); border-radius: 6px;
    transition: border-color 150ms, box-shadow 150ms;
  }
  input:focus { outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px rgba(35, 70, 200, 0.18); }
  .hint { margin-top: 6px; font-size: 0.875rem; color: var(--graphite-2); }

  /* Buttons */
  .btn, form button[type=submit], form button:not([type]) {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; min-height: 54px; padding: 0 1.25rem;
    font-family: var(--f-display); font-weight: 700; font-size: 1.0625rem; letter-spacing: -0.01em;
    border-radius: 6px; border: 2px solid transparent; cursor: pointer; text-decoration: none;
    background: var(--ink); color: #fff;
    transition: background-color 150ms, border-color 150ms, transform 150ms var(--ease);
  }
  .btn:hover, form button:hover { background: var(--ink-deep); color: #fff; }
  .btn:active, form button:active { transform: translateY(1px); }
  form button:disabled { opacity: 0.7; cursor: progress; }
  .btn-google { background: #fff; color: var(--graphite); border-color: var(--rule-strong); }
  .btn-google:hover { background: var(--ink-soft); color: var(--graphite); border-color: var(--ink); }

  .or { display: flex; align-items: center; gap: 12px; margin: 22px 0; color: var(--graphite-2); font-size: 0.875rem; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--rule); }

  .row-end { display: flex; justify-content: flex-end; margin: -6px 0 18px; font-size: 0.9375rem; }

  /* Messages */
  .banner, .msg {
    padding: 12px 14px; border-radius: 6px; font-size: 0.9375rem; line-height: 1.45; margin-bottom: 18px;
    background: #FCEDEB; border: 1px solid #E8B4AE; color: #8E2A20;
  }
  .msg { display: none; margin: 16px 0 0; }
  .banner a, .msg a { color: inherit; font-weight: 700; }
  .banner--info { background: var(--ink-soft); border-color: #B9C7F5; color: var(--ink-deep); }
  .msg--success { background: #EAF6EF; border-color: #A9D8BB; color: #1F5E37; }
  .form-error { display: none; }

  .foot-link { margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--rule); font-size: 1rem; color: var(--graphite-2); }
  .foot-link a { font-weight: 700; }
  .back { display: inline-block; margin-top: 22px; font-size: 0.9375rem; }

  /* Single-card pages (forgot / reset) */
  .card-page { display: grid; place-items: center; min-height: 100vh; padding: 32px 16px; }
  .card-wrap { width: 100%; max-width: 440px; }
  .card {
    background: var(--sheet); border: 1px solid var(--rule-strong); border-radius: 4px 10px 10px 4px;
    box-shadow: -6px 0 0 -2px var(--ink), 0 26px 50px -34px rgba(31, 29, 54, 0.45);
    padding: 32px 24px 28px;
  }
  @media (min-width: 560px) { .card { padding: 40px 36px 34px; } }
  .card h1 { font-size: clamp(1.75rem, 1.5rem + 1vw, 2.25rem); }

  /* Login: split layout */
  .split { display: grid; min-height: 100vh; }
  .split-main { display: flex; justify-content: center; padding: 32px 16px 48px; }
  .split-inner { width: 100%; max-width: 420px; }
  .split-aside { display: none; }
  @media (min-width: 960px) {
    .split { grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); }
    .split-main { align-items: center; padding: 56px 48px; }
    .split-aside {
      display: flex; flex-direction: column; justify-content: center; gap: 22px;
      padding: 56px clamp(32px, 5vw, 80px);
      background: var(--tint); border-left: 1px solid var(--rule);
    }
  }
  .aside-title { font-family: var(--f-display); font-weight: 800; font-size: 1.75rem; line-height: 1.1; letter-spacing: -0.03em; max-width: 18ch; }
  .aside-note { font-size: 0.9375rem; color: var(--graphite-2); max-width: 36ch; }

  /* The appointment book (same as the homepage) */
  .book {
    margin: 0; max-width: 460px; background: var(--sheet);
    border: 1px solid var(--rule-strong); border-radius: 4px 10px 10px 4px;
    box-shadow: -6px 0 0 -2px var(--ink), 0 1px 0 var(--rule), 0 22px 40px -28px rgba(31, 29, 54, 0.45);
    overflow: hidden; transform: rotate(-0.8deg);
  }
  .book-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; border-bottom: 2px solid var(--ink); }
  .book-day { font-family: var(--f-display); font-weight: 800; font-size: 1.375rem; letter-spacing: -0.02em; color: var(--ink-deep); }
  .book-date { font-family: var(--f-display); font-weight: 600; color: var(--graphite-2); }
  .book-rows { list-style: none; margin: 0; padding: 0; }
  .slot { display: grid; grid-template-columns: 4.25rem 1fr; align-items: center; min-height: 56px; border-bottom: 1px solid var(--rule); }
  .slot:last-child { border-bottom: 0; }
  .slot time {
    align-self: stretch; display: flex; align-items: center; padding-left: 18px;
    font-family: var(--f-display); font-weight: 600; font-size: 0.9375rem; color: var(--graphite-2);
    font-variant-numeric: tabular-nums;
    border-right: 1.5px solid color-mix(in srgb, var(--stamp) 45%, transparent);
  }
  .slot-body { padding: 8px 14px; min-width: 0; }
  .hand { font-family: var(--f-hand); font-size: 1.1875rem; line-height: 1.2; color: #3F4049; }
  .entry { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .entry-text { font-family: var(--f-display); font-weight: 600; color: var(--ink-deep); line-height: 1.25; }
  .stamp {
    display: inline-block; font-family: var(--f-display); font-weight: 700; font-size: 0.75rem;
    color: var(--stamp); background: var(--stamp-soft); border: 1.5px solid var(--stamp); border-radius: 4px;
    padding: 2px 7px; transform: rotate(-2deg); white-space: nowrap;
  }
  @media (prefers-reduced-motion: no-preference) {
    .slot--auto .entry-text { animation: write 900ms var(--ease) both; animation-delay: calc(500ms + var(--i, 0) * 700ms); }
    .slot--auto .stamp      { animation: stamp 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both; animation-delay: calc(1150ms + var(--i, 0) * 700ms); }
  }
  @keyframes write { from { clip-path: inset(0 100% 0 0); opacity: 0.4; } to { clip-path: inset(0 0 0 0); opacity: 1; } }
  @keyframes stamp { from { opacity: 0; transform: rotate(-2deg) scale(1.6); } to { opacity: 1; transform: rotate(-2deg) scale(1); } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

module.exports = { authHead, LOGO };
