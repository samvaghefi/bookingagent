const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Signup flow:
// 1. Business created with is_active: false, subscription_status: 'pending'
// 2. Stripe webhook (checkout.session.completed) sets is_active: true, subscription_status: 'trial'
// 3. Users cannot log in until is_active is true
async function createBusiness(data) {
  const { businessName, ownerName, email, phone, businessType, plan = 'solo' } = data;
  const validPlan = ['solo', 'starter', 'pro'].includes(plan) ? plan : 'solo';

  // Check for existing business with this email
  const { data: existing } = await supabase
    .from('businesses')
    .select('id, is_active, subscription_status')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    if (!existing.is_active && existing.subscription_status === 'pending') {
      // Abandoned checkout — delete the stale pending record and let them retry
      await supabase.from('businesses').delete().eq('id', existing.id);
      console.log(`🗑️ Deleted abandoned pending business ${existing.id} for ${email}`);
    } else {
      // Active or non-pending account — don't overwrite it
      const friendly = new Error('An account with this email already exists. Please sign in instead.');
      friendly.isUserFacing = true;
      throw friendly;
    }
  }

  const { data: business, error } = await supabase
    .from('businesses')
    .insert({
      name: businessName,
      owner_name: ownerName,
      email,
      phone,
      billing_email: email,
      business_type: businessType,
      plan: validPlan,
      ai_name: 'Sarah',
      subscription_status: 'pending',
      is_active: false
    })
    .select('id, name, owner_name, email, phone, business_type, plan')
    .single();

  if (error) throw error;

  console.log(`🏪 New business created: ${business.name} ${business.id}`);
  return business;
}

module.exports = { createBusiness };
