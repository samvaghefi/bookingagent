const { generateSlug } = require('../server/signupService');
const assert = require('assert');

assert.strictEqual(generateSlug("Sam's Barbershop"), 'sams-barbershop');
assert.strictEqual(generateSlug("The Hair Lounge"),   'the-hair-lounge');
assert.strictEqual(generateSlug("Cuts & More!"),      'cuts-more');
assert.strictEqual(generateSlug("  Studio 7  "),      'studio-7');
assert.strictEqual(generateSlug("Nail + Spa Studio"), 'nail--spa-studio');
console.log('✅ All slug tests passed');
