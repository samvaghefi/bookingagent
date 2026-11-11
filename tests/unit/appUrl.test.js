'use strict';

const request = require('supertest');
const express = require('express');

function load(appUrl) {
  jest.resetModules();
  if (appUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = appUrl;
  return require('../../server/appUrl');
}

afterAll(() => { delete process.env.APP_URL; });

describe('links', () => {
  test('without APP_URL nothing changes (Render address)', () => {
    const { dashboardUrl, loginUrl } = load(undefined);
    expect(dashboardUrl()).toBe('https://bookingagent-gmo2.onrender.com/dashboard/');
    expect(dashboardUrl({ token: 'abc' })).toBe('https://bookingagent-gmo2.onrender.com/dashboard/?token=abc');
    expect(loginUrl({ error: 'no_account' })).toBe('https://bookingagent-gmo2.onrender.com/auth/dashboard/login?error=no_account');
  });

  test('with APP_URL=https://dashboard.bimblyai.com the dashboard is at the root and sign-in at /login', () => {
    const { dashboardUrl, loginUrl } = load('https://dashboard.bimblyai.com/');
    expect(dashboardUrl()).toBe('https://dashboard.bimblyai.com/');
    expect(dashboardUrl({ token: 'abc' })).toBe('https://dashboard.bimblyai.com/?token=abc');
    expect(dashboardUrl({ calendar: 'connected' })).toBe('https://dashboard.bimblyai.com/?calendar=connected');
    expect(loginUrl()).toBe('https://dashboard.bimblyai.com/login');
    expect(loginUrl({ error: 'auth_failed' })).toBe('https://dashboard.bimblyai.com/login?error=auth_failed');
  });
});

describe('hostRouting', () => {
  // Stand-ins for the real routes the middleware forwards to
  function app(appUrl) {
    const { hostRouting } = load(appUrl);
    const a = express();
    a.use(hostRouting());
    a.get('/', (req, res) => res.send('health'));
    a.get('/dashboard/', (req, res) => res.send(`dashboard page ${req.url}`));
    a.get('/auth/dashboard/login', (req, res) => res.send(`login page ${req.url}`));
    a.get('/auth/logout', (req, res) => res.send('logged out'));
    a.get('/api/business', (req, res) => res.send('api'));
    a.post('/webhook/booking', (req, res) => res.send('webhook'));
    return a;
  }
  const NEW = 'dashboard.bimblyai.com';
  const OLD = 'bookingagent-gmo2.onrender.com';

  test('without APP_URL, routes are untouched', async () => {
    const a = app(undefined);
    expect((await request(a).get('/').set('Host', OLD)).text).toBe('health');
    expect((await request(a).get('/dashboard/').set('Host', OLD)).text).toContain('dashboard page');
  });

  test('new domain: / is the dashboard, /login and /logout work', async () => {
    const a = app('https://dashboard.bimblyai.com');
    expect((await request(a).get('/').set('Host', NEW)).text).toBe('dashboard page /dashboard/');
    expect((await request(a).get('/?token=abc').set('Host', NEW)).text).toBe('dashboard page /dashboard/?token=abc');
    expect((await request(a).get('/login?error=no_account').set('Host', NEW)).text).toBe('login page /auth/dashboard/login?error=no_account');
    expect((await request(a).get('/logout').set('Host', NEW)).text).toBe('logged out');
  });

  test('new domain: long paths forward to the short ones', async () => {
    const a = app('https://dashboard.bimblyai.com');
    const login = await request(a).get('/auth/dashboard/login?error=x').set('Host', NEW);
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/login?error=x');
    const dash = await request(a).get('/dashboard/').set('Host', NEW);
    expect(dash.status).toBe(301);
    expect(dash.headers.location).toBe('/');
  });

  test('old Render address: pages forward to the new domain, API and webhooks still work', async () => {
    const a = app('https://dashboard.bimblyai.com');
    const dash = await request(a).get('/dashboard/?token=abc').set('Host', OLD);
    expect(dash.status).toBe(301);
    expect(dash.headers.location).toBe('https://dashboard.bimblyai.com/?token=abc');
    const login = await request(a).get('/auth/dashboard/login').set('Host', OLD);
    expect(login.headers.location).toBe('https://dashboard.bimblyai.com/login');
    expect((await request(a).get('/').set('Host', OLD)).text).toBe('health'); // Render health check unchanged
    expect((await request(a).get('/api/business').set('Host', OLD)).text).toBe('api');
    expect((await request(a).post('/webhook/booking').set('Host', OLD)).text).toBe('webhook');
  });
});
