/**
 * Run this ONCE to build the local Israel card database.
 * Usage: node build-cards.js
 *
 * Downloads gameset_database.json from Hitster/Jumbo,
 * filters for the Israel edition (aaaj0001),
 * and saves cards-il.json next to this file.
 */

const https = require('https');
const fs    = require('fs');

const URL     = 'https://hitster.jumboplay.com/hitster-assets/gameset_database.json';
const EDITION = 'aaaj0001';
const OUTPUT  = 'cards-il.json';

console.log('Downloading', URL, '...');

https.get(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
  let raw = '';
  res.on('data', c => raw += c);
  res.on('end', () => {
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      console.error('Failed to parse JSON:', e.message);
      console.log('Raw response (first 500 chars):', raw.slice(0, 500));
      process.exit(1);
    }

    // Show top-level structure so we can understand the format
    console.log('\n--- JSON structure ---');
    console.log('Type:', Array.isArray(data) ? 'array' : typeof data);
    if (Array.isArray(data)) {
      console.log('Total entries:', data.length);
      console.log('First entry keys:', Object.keys(data[0] || {}));
      console.log('First entry sample:', JSON.stringify(data[0], null, 2).slice(0, 500));
    } else {
      console.log('Top-level keys:', Object.keys(data).slice(0, 10));
    }

    // Try to find Israel / aaaj0001 entries
    const entries = Array.isArray(data) ? data : Object.values(data).flat();
    const il = entries.filter(e =>
      JSON.stringify(e).toLowerCase().includes(EDITION.toLowerCase())
    );

    console.log(`\n--- Found ${il.length} entries matching "${EDITION}" ---`);
    if (il.length > 0) {
      console.log('Sample entry:', JSON.stringify(il[0], null, 2));
    }

    // Save filtered data
    fs.writeFileSync(OUTPUT, JSON.stringify(il, null, 2));
    console.log(`\nSaved ${il.length} cards to ${OUTPUT}`);
  });
}).on('error', e => {
  console.error('Download failed:', e.message);
});
