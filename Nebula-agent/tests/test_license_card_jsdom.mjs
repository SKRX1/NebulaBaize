// AGPL "license-card" three-links gate (jsdom), public-clean daily push line.
//
// What this locks: the About page license-card has exactly three rows and the
// owner-pinned state established on branch public-clean (commits e9e20e8 / 758c2e9):
//   License  -> <a href=".../blob/main/LICENSE">AGPL-3.0</a>  (real repo LICENSE link)
//   Source   -> <a href="https://github.com/SKRX1/NebulaBaize">GitHub</a>
//   Support  -> <a href="#donate">Local QR codes</a>          (GitHub Sponsors REMOVED;
//               the SKRX1 sponsors account is not open yet, so a sponsors link = drift)
//
// The gate asserts:
//   S1 has_sponsors = false (no anchor href containing "/sponsors/" inside the card)
//   S2 license  href == https://github.com/SKRX1/NebulaBaize/blob/main/LICENSE  (exact)
//   S3 source   href == https://github.com/SKRX1/NebulaBaize                    (exact)
//   S4 donate   href == #donate and it is the ONLY anchor in that row           (exact)
//   S5 the card exists (scoping anchor: first dt = about.license.license)
//
// DECOY (load-bearing proof): the same checker run on a mutated fixture where a
// sponsors link is re-added and the LICENSE href is repointed must report failures.
// Without S6, a gate weakened to "always pass" would also satisfy S1-S5.
//
// ASCII-only console output (Windows code pages). Run: node Nebula-agent/tests/test_license_card_jsdom.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'serve', 'web', 'index.html');

const LICENSE_HREF = 'https://github.com/SKRX1/NebulaBaize/blob/main/LICENSE';
const SOURCE_HREF = 'https://github.com/SKRX1/NebulaBaize';
const DONATE_HREF = '#donate';

const FAILS = [];
const ck = (name, ok, detail = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' ' + detail);
  if (!ok) FAILS.push(name);
};

// Returns the array of failures for the license-card in a parsed document.
function checkLicenseCard(doc) {
  const fails = [];
  // Scope: the dl.facts whose FIRST dt is the license row.
  const cards = Array.from(doc.querySelectorAll('dl.facts')).filter((dl) => {
    const first = dl.querySelector('dt');
    return first && first.getAttribute('data-i18n') === 'about.license.license';
  });
  if (cards.length !== 1) {
    fails.push('S5 card-scope expected 1 dl.facts[about.license.license], got ' + cards.length);
    return fails;
  }
  const card = cards[0];

  // S1 has_sponsors = false: no anchor inside the card points at /sponsors/
  const sponsors = Array.from(card.querySelectorAll('a')).filter((a) =>
    (a.getAttribute('href') || '').includes('/sponsors/'));
  if (sponsors.length !== 0) {
    fails.push('S1 has_sponsors expected false, found ' + sponsors.length + ' sponsor link(s)');
  }

  // Pull each row's anchors by the dt that precedes its dd.
  const anchorsFor = (key) => {
    const dt = card.querySelector('dt[data-i18n="' + key + '"]');
    if (!dt) return null;
    const dd = dt.nextElementSibling;
    if (!dd) return null;
    return Array.from(dd.querySelectorAll('a'));
  };

  // S2 license href exact
  const lic = anchorsFor('about.license.license');
  const licHref = lic && lic[0] ? lic[0].getAttribute('href') : null;
  if (!(lic && lic.length >= 1 && licHref === LICENSE_HREF)) {
    fails.push('S2 license href expected "' + LICENSE_HREF + '", got "' + licHref + '"');
  }

  // S3 source href exact
  const src = anchorsFor('about.license.source');
  const srcHref = src && src[0] ? src[0].getAttribute('href') : null;
  if (!(src && src.length === 1 && srcHref === SOURCE_HREF)) {
    fails.push('S3 source href expected "' + SOURCE_HREF + '", got "' + srcHref +
      '" anchors=' + (src ? src.length : 0));
  }

  // S4 donate href exact, single anchor
  const don = anchorsFor('about.license.donate');
  const donHref = don && don[0] ? don[0].getAttribute('href') : null;
  if (!(don && don.length === 1 && donHref === DONATE_HREF)) {
    fails.push('S4 donate href expected "' + DONATE_HREF + '" single, got "' + donHref +
      '" anchors=' + (don ? don.length : 0));
  }

  return fails;
}

// ---- real file ----
if (!fs.existsSync(INDEX)) {
  console.log('FAIL  index-not-found ' + INDEX);
  process.exit(1);
}
const html = fs.readFileSync(INDEX, 'utf8');
const dom = new JSDOM(html);
const realFails = checkLicenseCard(dom.window.document);
realFails.forEach((f) => console.log('   | ' + f));

ck('S5-S4 real license-card passes every lock', realFails.length === 0,
   'fails=' + realFails.length);

// ---- DECOY: re-add a sponsors link + repoint LICENSE href, same checker must go RED ----
const decoy = html
  .replace(
    '<dd><a href="#donate" data-i18n="about.license.donate.local">Local QR codes</a></dd>',
    '<dd><a href="https://github.com/sponsors/SKRX1" target="_blank" rel="noopener noreferrer">GitHub Sponsors</a> \u00b7 <a href="#donate" data-i18n="about.license.donate.local">Local QR codes</a></dd>')
  .replace(LICENSE_HREF, 'https://example.com/NOT-LICENSE');
const decoyFails = checkLicenseCard(new JSDOM(decoy).window.document);
decoyFails.forEach((f) => console.log('   D ' + f));

ck('S6 DECOY sponsors-re-added + href-repointed is caught (gate is load-bearing)',
   decoyFails.length >= 2, 'decoy-fails=' + decoyFails.length +
   ' (must flag S1 sponsors + S2 href)');

console.log('\nLICENSE-CARD: ' + (FAILS.length ? 'RED (' + FAILS.length + ')' : 'ALL GREEN'));
process.exit(FAILS.length ? 1 : 0);
