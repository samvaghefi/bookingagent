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

## Availability (calls, booking page, dashboard calendar)
- server/availabilityService.js is the single source of truth for "is this time free?": opening hours (Settings → Hours; a day with nothing saved uses 09:00–18:00, same as DEFAULT_HOURS in the dashboard), not in the past, calendar_blocks (blocked time), Google Calendar busy (primary via events.list, skipping events Bimbly created; team members' calendarId via freebusy), and per-team-member bookings ("anyone" bookings still need a free member). computeDay() is pure and unit-tested; Google errors fail open
- Primary Google calendar = owner (team member #1) if any member has their own calendarId; otherwise it blocks the whole shop
- server/callTools.js: replies for the Vapi tools. checkAvailability (args: date YYYY-MM-DD/today/tomorrow, time HH:MM?, service?, preferredBarber?) returns a sentence starting with today's date; bookAppointment re-checks the slot and replies "NOT BOOKED. … closest times …" instead of saving when it's taken (fails open on errors)
- Booking page GET /api/book/:id/availability and POST /api/book/:id (409 if just taken) use the same engine

## Webhook Flow
1. Vapi calls POST /webhook/booking
2. If message.type === "tool-calls" → checkAvailability calls answered from availabilityService; bookAppointment re-checked, then extractFromToolCall() + saveBooking (now stores duration_minutes from the service)
3. If message.type === "end-of-call-report" → regex fallback extractBookingInfo(), skipped when the call used bookAppointment or a booking with that vapi_call_id exists
4. findBusiness() looks up business by phone or assistant ID
5. saveBooking() saves to Supabase bookings table
6. Send SMS to customer, email to owner, create Google Calendar event

## Phone numbers
- Signup (handleCheckoutCompleted): provisionPhoneNumber() buys a Twilio number with voiceUrl https://api.vapi.ai/twilio/inbound_call, createVapiAssistant(), then attachPhoneNumber() registers the number in Vapi (provider twilio) linked to the assistant. Without that last step calls get Twilio error 11200 (HTTP 401) and the caller hears busy
- Fix an existing shop: node scripts/attach-vapi-number.js --business <id> [--dry-run] (or --all)

## Vapi Custom Tools
- checkAvailability: created/found by name via ensureAvailabilityTool() (vapiService.js) and added to every assistant's model.toolIds by createVapiAssistant() and rebuildAndPatchVapiPrompt(). Server URL /webhook/booking
- Roll prompt/tool changes out to existing assistants: node scripts/sync-vapi-assistants.js [--dry-run] [--business <id>]
- {{currentDateTime}} in vapi-system-prompt.txt is replaced by buildSystemPrompt() with Vapi's {{"now" | date: "...", "<tz>"}} (Vapi has no currentDateTime variable; it rendered blank)
- Tool ID: 97f86d72-3fc7-44bd-82f1-9b76b270023e
- Tool name: bookAppointment
- Server URL: https://bookingagent-gmo2.onrender.com/webhook/booking
- 10 properties: customerName, service, appointmentDate, appointmentTime, specialRequests, customerPhone, callbackNumber, serviceCount, preferredBarber, isNewCustomer

## Clients (CRM)
- server/clientService.js: ensureClient(businessId, {name, phone}) adds the customer to `clients` unless one with the same phone digits exists (never overwrites, never throws). Called for phone-call bookings (bookingService.upsertClient), booking page, manual dashboard bookings and walk-ins
- Phones come in many formats (+16475551234, 16475551234, 6475551234, typed). Always match with phoneKey()/phoneVariants(), never raw string equality. New clients/manual bookings store toE164() (+1XXXXXXXXXX)
- Client stats (/api/clients, export) are keyed by phoneKey; client history queries bookings with .in('customer_phone', phoneVariants(phone))
- Backfill past customers: node scripts/backfill-clients.js [--dry-run] [--business <id>]

## Database Tables
- businesses — one row per customer business; includes Google OAuth tokens, Stripe IDs, plan, barbers
- bookings — all appointments, 16+ columns: is_new_customer, preferred_barber, service_count, callback_number, service_ids (array)
- services — service menu per business (name, price, duration_minutes, description)

## Environment Variables (set in Render)
SUPABASE_URL, SUPABASE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NODE_ENV, STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_STARTER_PRICE_ID, STRIPE_PRO_PRICE_ID, STRIPE_PRICE_ID (legacy fallback), STRIPE_WEBHOOK_SECRET, JWT_SECRET, RENDER_EXTERNAL_URL

## Pricing Tiers
- Solo:    CA$39/mo  — STRIPE_SOLO_PRICE_ID (set in Render env vars)
- Starter: CA$99/mo  — STRIPE_STARTER_PRICE_ID (set in Render env vars)
- Pro:     CA$199/mo — STRIPE_PRO_PRICE_ID (set in Render env vars)
- plan field stored on businesses table ('solo' | 'starter' | 'pro', default 'solo')
- createCheckoutSession(businessId, email, plan) selects the correct Stripe price ID
- plan is stored in Stripe session metadata as a fallback

## Google Calendar
- Dashboard: Settings → Calendar → "Connect Google Calendar" → POST /api/calendar/connect returns the consent URL with state 'cal.' + JWT {businessId, purpose:'calendar-connect'} (15 min) → /auth/google/callback verifies it, stores tokens + google_calendar_email, redirects to /dashboard/?calendar=connected|cancelled|expired|failed#/settings/calendar
- server/calendarRoutes.js: GET /api/calendar/status, POST /api/calendar/connect, DELETE /api/calendar/connection (revokes at Google), GET/POST/PUT/DELETE /api/calendar/blocks, GET /api/calendar/week?start=YYYY-MM-DD
- calendar_blocks table (scripts/migrations/add-calendar-blocks.sql): repeat 'none'|'weekly', start_date, end_date (null = weekly with no end), weekdays 1=Mon..7=Sun, start_time/end_time (null = all day), team_member (null = whole shop), note. Routes/loaders tolerate the table not existing yet
- Calendar events are created in the shop's time zone with extendedProperties.private.bimblyBookingId
- Legacy admin link: GET /auth/google?businessId=xxx → Google login → /auth/google/callback (state = business id)
- Tokens stored per business in businesses table
- To reconnect: https://bookingagent-gmo2.onrender.com/auth/google?businessId=a09fdd0b-421e-479a-b4d7-120f6a72a043

## Dashboard Auth
- Login page: GET /auth/dashboard/login — matches bimblyai.com design ("the book fills itself"); form left, example appointment book right (hidden on mobile)
  - Shared styles/fonts/logo for login, forgot-password and reset-password pages: server/authPageStyles.js (authHead(), LOGO)
  - Logo/favicon files served from dashboard/brand/ (copies of the website's assets)
  - Error banners: no_account, no_email, auth_failed
  - Google sign-in, email/password form, "Start your free trial" link. No testimonials or stats (none are real yet)
- Emails are stored and matched lowercase everywhere (normalizeEmail() in signupValidation.js)
- Password rules (8+, capital, number, special) apply to signup, reset-password and /api/auth/change-password
- Flow: GET /auth/dashboard/google → Google OAuth → /auth/dashboard/callback
- Callback looks up business by email, creates JWT (7d), redirects to dashboard?token=JWT
- React app reads ?token= from URL, stores in localStorage as `bimbly_token`, strips from URL
- If no matching business: redirect to /auth/dashboard/login?error=no_account
- Logout: GET /auth/logout → clears token, redirects to /auth/dashboard/login
- All /api/* routes: JWT accepted via Authorization: Bearer header (React) OR bimbly_session cookie (legacy)
- JWT payload: { businessId, email } — signed with JWT_SECRET
- Google OAuth app is published to production (no test-user allowlist required)
- Authorized redirect URI in Google Cloud Console: https://bookingagent-gmo2.onrender.com/auth/dashboard/callback

## Dashboard address (APP_URL)
- server/appUrl.js: dashboardUrl(query), loginUrl(query), hostRouting(). Use these for every user-facing link/redirect (sign-in, emails, calendar return); never hardcode the Render address
- APP_URL unset → Render address (/dashboard/, /auth/dashboard/login). APP_URL=https://dashboard.bimblyai.com → dashboard at "/", sign-in at "/login", "/logout"; GET pages on the Render host 301 to the new domain. API, webhooks (Vapi, Stripe) and Google OAuth callbacks (RENDER_EXTERNAL_URL) keep working on both hosts
- Setup: Render custom domain dashboard.bimblyai.com + GoDaddy CNAME dashboard → bookingagent-gmo2.onrender.com, then set APP_URL in Render. Sign-in sessions are per address, so users sign in once after the switch

## Dashboard SPA
- Served at GET /dashboard → dashboard/index.html
- Static assets at /dashboard/style.css and /dashboard/app.jsx; API_BASE is window.location.origin (same server)
- Design matches bimblyai.com and the login page (same tokens, fonts, logo). style.css is the design system: use .btn (--primary/--secondary/--ghost/--danger/--danger-outline, --sm), .field + .input/.select/.textarea, .card (Card component with card-head/body/foot), .switch, .badge, .notice. No inline styles for controls
- Every settings form saves from the card footer (SaveFooter, bottom right, status message on the left). Use api() so server errors are shown; never report success without res.ok. No alert()/confirm(): use toasts (useToast) and ConfirmDialog
- Token handling: reads ?token= on load, strips from URL, redirects to /auth/dashboard/login if missing (or on 401)
- Hash routing: #/home, #/bookings, #/queue, #/clients[/search], #/client/<id>, #/settings/<tab>, #/billing, #/onboarding (refresh and back button work)
- Screens: Home (greeting, stats, today's book, walk-ins, charts, recent bookings), Bookings (Upcoming/Today/7/30 days + search), Walk-ins, Clients + profile, Settings tabs (Business, Hours, Calendar, Services, Team, Booking page, Deposits, Walk-ins, Account), Billing, Setup wizard
- Settings → Calendar: Google Calendar connect/disconnect, week view (hours, bookings, blocked time, Google busy; click an empty time to block it), blocked time list + add/edit dialog (one time or every week, all day or times, whole shop or one team member)
- Mobile (<768px): sidebar becomes a slide-out menu from the top bar button
- Sidebar logo goes to the dashboard home (#/home), not bimblyai.com
- Billing page: current plan card, then all three plans (Solo/Starter/Pro, wording copied from bimblyai.com pricing) with Upgrade/Switch buttons on every non-current plan; plan changes are disabled when cancelling/cancelled (shop emails hello@bimblyai.com)
- Business name rendered from GET /api/business → data.business.name

## Dashboard API Endpoints (all require auth)
- GET  /api/business — business details (no tokens/secrets)
- PUT  /api/business — update name, phone, address, business_hours, ai_name, barbers
- GET  /api/bookings — bookings with optional ?date=, ?from=&to=, ?limit= (default: last 30 days)
- GET  /api/analytics — dates computed in the business timezone (luxon); revenue estimate priced from the business's services table. Walk-ins (walk_in_queue, except no_show/removed) count too, dated by check-in time in the shop's time zone, with source 'walk_in' and status 'walk-in'. Returns totalBookingsThisMonth/LastMonth, todayBookings (array), upcomingBookings (array), revenueEstimateThisMonth, busiestDays, popularServices, peakHours, bookingsByWeek
- POST /api/bookings — owner/team member adds a booking by hand (AddBookingDialog on Home and Bookings). Body: customerName, customerPhone?, customerEmail?, service, date YYYY-MM-DD, time HH:MM, teamMember?, notes?, bookedBy (must be a team member or owner_name), textCustomer, force. Saved with source 'manual' + booked_by (scripts/migrations/add-booked-by.sql). Same availability check as calls; not free → 409 { error, reason, alternatives } unless force. Creates the Google Calendar event; texts the customer only if textCustomer
- Booking source labels (bookedByLabel/BookedBy in app.jsx, "Booked by" column): voice/null → "Bimbly · call", online → "Bimbly · online", walk_in → "Walk-in", manual → booked_by name
- GET  /api/services — all services for the business
- POST /api/services — create service { name, price, duration_minutes, description }
- PUT  /api/services/:id — update service (ownership verified)
- DELETE /api/services/:id — delete service (ownership verified)
- GET  /api/billing — { subscription_status, trial_end (unix), current_period_end (unix), amount, currency, cancel_at_period_end }
- POST /api/billing/cancel — cancel subscription at period end
- POST /api/billing/change-plan { plan } — upgrade/downgrade by swapping the price on the EXISTING subscription (changeSubscriptionPlan in billingService.js, prorated) and setting businesses.plan. Never use a new Checkout for an existing shop: handleCheckoutCompleted re-provisions (new Twilio number + Vapi assistant) and a second subscription would bill twice

## Self-Serve Signup Flow
- The signup form lives on the website (bimblyai.com/signup). GET /signup here 302-redirects there, keeping ?plan=
- POST /signup — body: businessName, ownerName, email, password, confirmPassword, phone, businessType, city, province, plan ('solo'|'starter'|'pro', default 'solo')
  - All fields required; checked by server/signupValidation.js (same rules as the website's signup.js)
  - Password: 8+ chars, a capital, a number, a special character (max 72 bytes, bcrypt limit). Same rule on POST /auth/reset-password
  - Phone stored as E.164 (+1XXXXXXXXXX); province must be a 2-letter code; businessType barbershop|hair-salon|nail-salon|other
  - Invalid → 400 { error, fields: { field: message } }
  - Valid → bcrypt hash stored as password_hash (with city, province) via createBusiness(), creates Stripe Checkout Session, returns { checkoutUrl }
- Sign up with Google: website form-POSTs plan + shop fields (no name/email/password) to POST /signup/google
  - Validated with validateSignup(body, { method: 'google' }); bad input → 303 to bimblyai.com/signup?error=invalid
  - Shop data travels through Google in a signed JWT `state` ('signup.' + jwt, 15 min), bound to the browser by httpOnly cookie bimbly_gsu (nonce)
  - Reuses the existing redirect URI /auth/dashboard/callback (branches on state prefix 'signup.'), so no Google Console change needed
  - Callback: requires verified Google email, createBusiness() with Google name/email and no password_hash, then 303 to Stripe checkout
  - Errors bounce to bimblyai.com/signup?error=exists|google_cancelled|google_expired|google_no_email|google_failed (website shows message and restores the form)
- On checkout complete (Stripe webhook): sets is_active=true, subscription_status='trial', sends welcome email (mentions plan) + internal notification to hello@bimblyai.com
- signupService.js: duplicate email → friendly isUserFacing error with 409

## Stripe Billing
- GET /billing/checkout?businessId=xxx — creates Checkout Session, redirects to Stripe. Only for shops with no stripe_subscription_id; others are redirected to /dashboard/#/billing
- POST /billing/webhook — handles Stripe events (raw body required for sig verification)
- GET /billing/success — post-checkout success page
- GET /billing/cancel — post-checkout cancel page
- Webhook handles: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated (also syncs plan from the price ID via planForPriceId), invoice.payment_failed
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
1. Verify hello@bimblyai.com as a verified sender in SendGrid
3. Set STRIPE_WEBHOOK_SECRET in Render after creating the webhook endpoint in Stripe Dashboard

## Known Issues
- Preferred barber sometimes not captured correctly
