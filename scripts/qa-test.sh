#!/bin/bash
# bimblyai QA Test Runner
# Usage: ./scripts/qa-test.sh [base_url] [admin_secret]
#
# Examples:
#   ./scripts/qa-test.sh                                          # uses production URL + $ADMIN_SECRET env var
#   ./scripts/qa-test.sh http://localhost:3000 my-admin-secret   # local dev
#   ADMIN_SECRET=abc123 ./scripts/qa-test.sh http://localhost:3000

BASE_URL=${1:-"https://bookingagent-gmo2.onrender.com"}
ADMIN_SECRET=${2:-$ADMIN_SECRET}
TIMESTAMP=$(date +%s)

echo "🧪 bimblyai QA Test Runner"
echo "Target: $BASE_URL"
echo "Timestamp: $TIMESTAMP"
echo "---"

PASS=0
FAIL=0

check() {
  local label="$1"
  local response="$2"
  local expect="$3"
  if echo "$response" | grep -q "$expect"; then
    echo "  ✅ $label"
    PASS=$((PASS+1))
  else
    echo "  ❌ $label"
    echo "     Expected to find: $expect"
    echo "     Got: $response"
    FAIL=$((FAIL+1))
  fi
}

# ── Test 1: Health check ──────────────────────────────────────────────────────
echo "Test 1: Health check"
HEALTH=$(curl -s "$BASE_URL/health")
echo "Response: $HEALTH"
check "status ok" "$HEALTH" '"status":"ok"'
check "timestamp present" "$HEALTH" '"timestamp"'
check "testMode present" "$HEALTH" '"testMode"'
echo ""

# ── Test 2: Admin auth — missing key returns 403 ─────────────────────────────
echo "Test 2: /admin/test-provisioning rejects missing x-admin-key"
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/admin/test-provisioning" \
  -H "Content-Type: application/json" \
  -d '{"businessName":"Auth Test","plan":"solo"}')
echo "HTTP status: $NOAUTH"
check "returns 403" "$NOAUTH" "403"
echo ""

# ── Test 3: Admin auth — wrong key returns 403 ───────────────────────────────
echo "Test 3: /admin/test-provisioning rejects wrong x-admin-key"
WRONGAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/admin/test-provisioning" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: wrong-key-12345" \
  -d '{"businessName":"Auth Test","plan":"solo"}')
echo "HTTP status: $WRONGAUTH"
check "returns 403" "$WRONGAUTH" "403"
echo ""

# ── Test 4: Full provisioning chain (with cleanup) ───────────────────────────
echo "Test 4: Full provisioning chain (cleanup=true)"
if [ -z "$ADMIN_SECRET" ]; then
  echo "  ⚠️  ADMIN_SECRET not set — skipping provisioning test"
  echo "     Set ADMIN_SECRET env var or pass as second argument"
else
  RESULT=$(curl -s -X POST "$BASE_URL/admin/test-provisioning" \
    -H "Content-Type: application/json" \
    -H "x-admin-key: $ADMIN_SECRET" \
    -d "{
      \"businessName\": \"QA Test Shop $TIMESTAMP\",
      \"ownerName\": \"QA Tester\",
      \"email\": \"test+$TIMESTAMP@test.bimblyai.com\",
      \"phone\": \"+14165550001\",
      \"businessType\": \"barbershop\",
      \"plan\": \"solo\",
      \"cleanup\": true
    }")
  echo "Response: $RESULT"
  check "success true" "$RESULT" '"success":true'
  check "business created" "$RESULT" '"businessCreated"'
  check "twilio provisioned" "$RESULT" '"twilioProvisioned"'
  check "vapi created" "$RESULT" '"vapiCreated"'
  check "cleanup scheduled" "$RESULT" '"cleanupScheduled":true'
fi
echo ""

# ── Test 5: Duplicate email rejection ────────────────────────────────────────
echo "Test 5: Duplicate email rejection"
DUP=$(curl -s -X POST "$BASE_URL/signup" \
  -H "Content-Type: application/json" \
  -d "{
    \"businessName\": \"Duplicate Shop\",
    \"ownerName\": \"Duplicate Owner\",
    \"email\": \"samsbarbershoptoronto@gmail.com\",
    \"phone\": \"+14165550002\",
    \"businessType\": \"barbershop\",
    \"plan\": \"solo\"
  }")
echo "Response: $DUP"
check "returns error" "$DUP" '"error"'
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "---"
echo "Results: $PASS passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  echo "✅ All QA tests passed"
  exit 0
else
  echo "❌ $FAIL test(s) failed"
  exit 1
fi
