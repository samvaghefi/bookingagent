const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function createBusiness(data) {
  const { businessName, ownerName, email, phone, businessType } = data;

  const { data: business, error } = await supabase
    .from('businesses')
    .insert({
      name: businessName,
      owner_name: ownerName,
      email,
      phone,
      billing_email: email,
      business_type: businessType,
      ai_name: 'Sarah',
      subscription_status: 'trial',
      is_active: false
    })
    .select('id, name, owner_name, email, phone, business_type')
    .single();

  if (error) throw error;

  console.log(`🏪 New business created: ${business.name} ${business.id}`);
  return business;
}

module.exports = { createBusiness };
