// Stub all external service env vars so modules load without crashing
process.env.SUPABASE_URL          = 'https://test.supabase.co';
process.env.SUPABASE_KEY          = 'test-key';
process.env.JWT_SECRET            = 'test-jwt-secret-32-chars-minimum!!';
process.env.TWILIO_ACCOUNT_SID    = 'ACtest';
process.env.TWILIO_AUTH_TOKEN     = 'test-token';
process.env.SENDGRID_API_KEY      = 'SG.test';
process.env.STRIPE_SECRET_KEY     = 'sk_test_placeholder';
process.env.GOOGLE_CLIENT_ID      = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET  = 'test-client-secret';
process.env.NODE_ENV              = 'test';
process.env.ADMIN_SECRET          = 'test-admin-secret';
process.env.INTEL_USERNAME        = 'admin';
process.env.INTEL_PASSWORD        = 'test-password';
process.env.RENDER_EXTERNAL_URL   = 'http://localhost:3000';
