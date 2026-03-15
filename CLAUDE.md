# BookingAgent — Claude Code Guide

## What This Is
Multi-tenant AI voice receptionist SaaS. Small businesses get an AI agent that answers calls and books appointments 24/7. Built under the Bimbly brand (bimblyai.com).

## First Customer
Sam's Barbershop, Toronto
- Business ID: a09fdd0b-421e-479a-b4d7-120f6a72a043
- Vapi Assistant ID: 3f7183f9-4796-4104-8b08-015a4d675792
- Email: samsbarbershoptoronto@gmail.com
- Phone: +16475845925

## Tech Stack
- Backend: Node.js + Express 5
- Database: Supabase (Postgres)
- Voice AI: Vapi (Custom Tools for structured data extraction)
- SMS: Twilio
- Email: SendGrid
- Calendar: Google Calendar API
- Payments: Stripe (Checkout Sessions, two-tier pricing)
- Hosting: Render (https://bookingagent-gmo2.onrender.com)
- Frontend: React 18 + Babel standalone (no bundler), served from /dashboard

## Key Files
- server/index.js — webhook handler, signup routes, billing routes, CORS, dashboard static serving
- server/bookingService.js — extractFromToolCall(), saveBooking(), findBusiness()
- server/calendarService.js — Google Calendar event creation, OAuth flow
- server/notificationService.js — SMS, email, welcome (mentions plan), internal notification, payment failure
- server/billingService.js — createCheckoutSession(businessId, email, plan), cancel, retrieve
- server/signupService.js — createBusiness() with plan support and duplicate email handling
- server/authMiddleware.js — JWT auth; accepts Authorization: Bearer header OR bimbly_session cookie
- server/authRoutes.js — Google OAuth for dashboard login/logout; split-screen login page
- server/dashboardRoutes.js — protected /api/* endpoints for dashboard
- dashboard/index.html — React SPA entry point (loads React 18 + Babel from CDN)
- dashboard/app.jsx — all dashboard screens: Home, Bookings, Settings, Billing, Onboarding
- dashboard/style.css — dashboard design system
- vapi-system-prompt.txt — AI assistant prompt (paste into Vapi manually)

## CORS
- Configured in server/index.js using the `cors` npm package
- Allowed origins: https://bimblyai.com, https://www.bimblyai.com, http://localhost:3000, http://localhost:8080
- credentials: true, methods: GET/POST/PUT/DELETE/OPTIONS, allowedHeaders: Content-Type + Authorization
- Preflight: app.options(/(.*)/, cors(corsOptions)) — regex required for Express 5

## Webhook Flow
1. Vapi calls POST /webhook/booking
2. If message.type === "tool-calls" → use extractFromToolCall() (structured, reliable)
3. If message.type === "end-of-call-report" → use extractBookingInfo() (regex fallback)
4. findBusiness() looks up business by phone or assistant ID
5. saveBooking() saves to Supabase bookings table
6. Send SMS to customer, email to owner, create Google Calendar event

## Vapi Custom Tool
- Tool ID: 97f86d72-3fc7-44bd-82f1-9b76b270023e
- Tool name: bookAppointment
- Server URL: https://bookingagent-gmo2.onrender.com/webhook/booking
- 10 properties: customerName, service, appointmentDate, appointmentTime, specialRequests, customerPhone, callbackNumber, serviceCount, preferredBarber, isNewCustomer

## Database Tables
- businesses — one row per customer business; includes Google OAuth tokens, Stripe IDs, plan, barbers
- bookings — all appointments, 16+ columns: is_new_customer, preferred_barber, service_count, callback_number, service_ids (array)
- services — service menu per business (name, price, duration_minutes, description)

## Environment Variables (set in Render)
SUPABASE_URL, SUPABASE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NODE_ENV, STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_STARTER_PRICE_ID, STRIPE_PRO_PRICE_ID, STRIPE_PRICE_ID (legacy fallback), STRIPE_WEBHOOK_SECRET, JWT_SECRET, RENDER_EXTERNAL_URL

## Pricing Tiers
- Starter: CA$79/mo — STRIPE_STARTER_PRICE_ID=price_1TBNPdLxC6AbeQxJ94QT68W8
- Pro:     CA$149/mo — STRIPE_PRO_PRICE_ID=price_1TBNRFLxC6AbeQxJPjyyMZZx
- plan field stored on businesses table ('starter' | 'pro', default 'starter')
- createCheckoutSession(businessId, email, plan) selects the correct Stripe price ID
- plan is stored in Stripe session metadata as a fallback

## Google Calendar
- OAuth flow: GET /auth/google?businessId=xxx → Google login → /auth/google/callback
- Tokens stored per business in businesses table
- To reconnect: https://bookingagent-gmo2.onrender.com/auth/google?businessId=a09fdd0b-421e-479a-b4d7-120f6a72a043

## Dashboard Auth
- Login page: GET /auth/dashboard/login — split-screen branded page (60% form, 40% social proof)
  - no_account error: coral banner "Did you mean to sign up?" with link to bimblyai.com/signup
  - auth_failed error: plain red banner
  - Google OAuth sign-in button + "Start your free trial" link
- Flow: GET /auth/dashboard/google → Google OAuth → /auth/dashboard/callback
- Callback looks up business by email, creates JWT (7d), redirects to dashboard?token=JWT
- React app reads ?token= from URL, stores in localStorage as `bimbly_token`, strips from URL
- If no matching business: redirect to /auth/dashboard/login?error=no_account
- Logout: GET /auth/logout → clears token, redirects to /auth/dashboard/login
- All /api/* routes: JWT accepted via Authorization: Bearer header (React) OR bimbly_session cookie (legacy)
- JWT payload: { businessId, email } — signed with JWT_SECRET
- Google OAuth app is published to production (no test-user allowlist required)
- Authorized redirect URI in Google Cloud Console: https://bookingagent-gmo2.onrender.com/auth/dashboard/callback

## Dashboard SPA
- Served at GET /dashboard → dashboard/index.html
- Static assets at /dashboard/style.css and /dashboard/app.jsx
- Token handling: reads ?token= on load, strips from URL, redirects to /auth/dashboard/google if missing
- Screens: Home (stats + charts + recent bookings), Bookings (filtered table), Settings (business info + hours + services + team), Billing (status + cancel), Onboarding (4-step wizard)
- Sidebar logo links to https://bimblyai.com
- Business name rendered from GET /api/business → data.business.name

## Dashboard API Endpoints (all require auth)
- GET  /api/business — business details (no tokens/secrets)
- PUT  /api/business — update name, phone, address, business_hours, ai_name, barbers
- GET  /api/bookings — bookings with optional ?date=, ?from=&to=, ?limit= (default: last 30 days)
- GET  /api/analytics — totalBookingsThisMonth/LastMonth, todayBookings (array), upcomingBookings (array), revenueEstimateThisMonth, busiestDays, popularServices, peakHours, bookingsByWeek
- GET  /api/services — all services for the business
- POST /api/services — create service { name, price, duration_minutes, description }
- PUT  /api/services/:id — update service (ownership verified)
- DELETE /api/services/:id — delete service (ownership verified)
- GET  /api/billing — { subscription_status, trial_end (unix), current_period_end (unix), amount, currency, cancel_at_period_end }
- POST /api/billing/cancel — cancel subscription at period end

## Self-Serve Signup Flow
- GET /signup — split-screen branded signup form (name, business name, email, phone, business type, plan)
- POST /signup — accepts plan field ('starter'|'pro', default 'starter'), calls createBusiness(), creates Stripe Checkout Session, returns { checkoutUrl }
- On checkout complete (Stripe webhook): sets is_active=true, subscription_status='trial', sends welcome email (mentions plan) + internal notification to hello@bimblyai.com
- signupService.js: duplicate email → friendly isUserFacing error with 409

## Stripe Billing
- GET /billing/checkout?businessId=xxx — creates Checkout Session, redirects to Stripe
- POST /billing/webhook — handles Stripe events (raw body required for sig verification)
- GET /billing/success — post-checkout success page
- GET /billing/cancel — post-checkout cancel page
- Webhook handles: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated, invoice.payment_failed
- STRIPE_WEBHOOK_SECRET: Stripe Dashboard → Developers → Webhooks → endpoint https://bookingagent-gmo2.onrender.com/billing/webhook

## Supabase — businesses table (run in SQL editor if not yet applied)
```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_email text,
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS business_type text,
  ADD COLUMN IF NOT EXISTS plan text DEFAULT 'starter';
```

## Deploy Workflow
After EVERY change:
1. git add .
2. git commit -m "description"
3. git push origin main
Pushing to main auto-deploys to Render.

## Next Priorities
1. Fix Vapi system prompt to use {{currentDateTime}} for accurate date handling
2. Verify hello@bimblyai.com as a verified sender in SendGrid
3. Set STRIPE_WEBHOOK_SECRET in Render after creating the webhook endpoint in Stripe Dashboard

## Known Issues
- System prompt has hardcoded date — needs {{currentDateTime}} variable
- Preferred barber sometimes not captured correctly
