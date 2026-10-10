// The AnalyticsTag shim in a DOM, with the network stubbed — what each provider is sent, and when nothing may be.
//
//   npm test            (node --test; the DOM is happy-dom, which neither fetches nor runs the GA4 tag)
//
// The kit's Osy# tests and the store's UI tests drive the control through the platform; this is the half they cannot
// reach — GA4 (whose tag must never load in a test) and the exact bodies Plausible receives.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

let calls;
let mount;

/** A fresh page in the same browser: a new document, the same localStorage — what a reload is. */
function openPage(carry = {}) {
  const window = new Window({ url: 'https://shop.example.com/', settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  for (const [k, v] of Object.entries(carry)) window.localStorage.setItem(k, v);
  for (const k of ['window', 'document', 'localStorage']) globalThis[k] = k === 'window' ? window : window[k];
}

function reload() {
  const carry = {};
  for (let i = 0; i < localStorage.length; i++) carry[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
  openPage(carry);
}

beforeEach(async () => {
  openPage();
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  ({ mount } = await import(`../analytics.js?${Math.random()}`));
});

function host() {
  const emitted = [];
  return { emitted, contractVersion: '1.1', emit: (...a) => emitted.push(a), tokens: { cssVar: () => '', get: () => '' } };
}

const item = { Id: 'KIAMBU-250', Name: 'Kiambu AA', Variant: '250 g', Price: '165.00', Quantity: 1 };
const plausible = { provider: 'plausible', domain: 'shop.example.org', host: 'https://plausible.io', currency: 'SEK' };

test('plausible: a page view, then an event true of the page, each once', () => {
  const h = host();
  const c = mount(document.createElement('div'), { ...plausible, path: '/p/kiambu-aa',
    events: [{ Name: 'view_item', Key: 'KIAMBU-250', Currency: 'SEK', Value: '165.00', Items: [item] }] }, h);
  c.update({ ...plausible, path: '/p/kiambu-aa', events: [{ Name: 'view_item', Key: 'KIAMBU-250', Items: [item] }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://plausible.io/api/event');
  assert.deepEqual(calls[0].body, { name: 'pageview', url: 'https://shop.example.com/p/kiambu-aa', domain: 'shop.example.org' });
  assert.equal(calls[1].body.name, 'View Item');
  assert.deepEqual(calls[1].body.props, { item: 'Kiambu AA (250 g)', item_id: 'KIAMBU-250' });
  assert.equal(c.probe().lastViewItem, 'Kiambu AA (250 g)');
  assert.deepEqual(h.emitted, [['sent', 'KIAMBU-250']]);
});

test('plausible: a purchase carries its revenue, and a reload does not send it again', () => {
  const purchase = { Name: 'purchase', Key: 'GG-1042', TransactionId: 'GG-1042', Currency: 'SEK', Value: '330', Items: [item, item] };
  const c = mount(document.createElement('div'), { ...plausible, path: '/checkout', events: [purchase] }, host());
  const sentPurchase = calls.find(x => x.body.name === 'Purchase');
  assert.deepEqual(sentPurchase.body.revenue, { currency: 'SEK', amount: '330.00' });
  assert.equal(sentPurchase.body.props.order, 'GG-1042');
  assert.equal(c.probe().lastPurchase, 'GG-1042 · 330.00 SEK');
  // The page is reloaded: a new document, the same event still offered.
  calls = [];
  reload();
  const again = mount(document.createElement('div'), { ...plausible, path: '/checkout', events: [purchase] }, host());
  assert.equal(calls.filter(x => x.body.name === 'Purchase').length, 0);
  assert.equal(again.probe().purchases, 0);
});

test('plausible: what grows in the bag is an add-to-cart; a reload and a bag still loading are not', () => {
  const c = mount(document.createElement('div'), { ...plausible, path: '/', cart: [] }, host());
  c.update({ ...plausible, path: '/', cart: [{ ...item, Quantity: 1 }] });
  c.update({ ...plausible, path: '/', cart: [{ ...item, Quantity: 3 }] });
  const adds = calls.filter(x => x.body.name === 'Add to Cart');
  assert.equal(adds.length, 2);
  assert.equal(c.probe().lastAddToCart, '2 × Kiambu AA (250 g)');
  calls = [];
  // Reloaded: the bag loads empty first, then as it was — nothing was added.
  reload();
  const r = mount(document.createElement('div'), { ...plausible, path: '/', cart: [] }, host());
  r.update({ ...plausible, path: '/', cart: [{ ...item, Quantity: 3 }] });
  assert.equal(calls.filter(x => x.body.name === 'Add to Cart').length, 0);
});

test('plausible with a reserved domain records and never sends', () => {
  const c = mount(document.createElement('div'), { ...plausible, domain: 'groundsandgrapes.example', path: '/' }, host());
  assert.equal(calls.length, 0);
  assert.equal(c.probe().dryRun, true);
  assert.equal(c.probe().lastPageView, '/');
});

test('ga4: nothing of Google is loaded, and nothing sent, before consent', () => {
  const h = host();
  const ga = { provider: 'ga4', measurementId: 'G-TEST123', currency: 'SEK', path: '/p/kiambu-aa',
    events: [{ Name: 'view_item', Key: 'KIAMBU-250', Items: [item] }] };
  const c = mount(document.createElement('div'), ga, h);
  assert.deepEqual(h.emitted, [['consentKnown', 'unknown']]);
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.equal(window.dataLayer, undefined);
  assert.equal(c.probe().sent, 0);
  assert.equal(c.probe().loaded, false);

  // Accepted on this page: the tag loads, and this page's view and its event are reported.
  c.update({ ...ga, consent: 'granted' });
  const script = document.querySelector('script');
  assert.equal(script.src, 'https://www.googletagmanager.com/gtag/js?id=G-TEST123');
  const layer = window.dataLayer.map(a => Array.from(a));
  assert.deepEqual(layer[0], ['consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
  assert.deepEqual(layer.find(a => a[0] === 'config'), ['config', 'G-TEST123', { send_page_view: false }]);
  assert.equal(layer.find(a => a[1] === 'page_view')[2].page_location, 'https://shop.example.com/p/kiambu-aa');
  const view = layer.find(a => a[1] === 'view_item')[2];
  assert.deepEqual(view.items, [{ item_id: 'KIAMBU-250', item_name: 'Kiambu AA', item_variant: '250 g', price: 165, quantity: 1 }]);
  assert.equal(view.currency, 'SEK');
  assert.equal(localStorage.getItem('osy-analytics-consent'), 'granted');
  assert.equal(c.probe().loaded, true);
});

test('ga4: a refusal is kept, and nothing is ever loaded', () => {
  const h = host();
  const ga = { provider: 'ga4', measurementId: 'G-TEST123', path: '/' };
  const c = mount(document.createElement('div'), ga, h);
  c.update({ ...ga, consent: 'denied', path: '/checkout',
    events: [{ Name: 'purchase', Key: 'GG-1', TransactionId: 'GG-1', Value: '10', Items: [item] }] });
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.equal(window.dataLayer, undefined);
  assert.equal(c.probe().consent, 'denied');
  // The purchase is let go (so the shop stops offering it) without being sent.
  assert.deepEqual(h.emitted.at(-1), ['sent', 'GG-1']);
  const again = host();
  mount(document.createElement('div'), ga, again);
  assert.deepEqual(again.emitted, [['consentKnown', 'denied']]);
});

test('ga4: a purchase carries GA4 purchase parameters', () => {
  localStorage.setItem('osy-analytics-consent', 'granted');
  mount(document.createElement('div'), { provider: 'ga4', measurementId: 'G-TEST123', path: '/paid',
    events: [{ Name: 'purchase', Key: 'GG-2', TransactionId: 'GG-2', Currency: 'SEK', Value: '375', Tax: '40.18', Shipping: '45', Items: [item] }] }, host());
  const p = window.dataLayer.map(a => Array.from(a)).find(a => a[1] === 'purchase')[2];
  assert.equal(p.transaction_id, 'GG-2');
  assert.equal(p.value, 375);
  assert.equal(p.tax, 40.18);
  assert.equal(p.shipping, 45);
  assert.equal(p.currency, 'SEK');
});

test('a remount on the same page is not a new page view, and keeps what the page reported', () => {
  const purchase = { Name: 'purchase', Key: 'GG-7', TransactionId: 'GG-7', Currency: 'SEK', Value: '99', Items: [item] };
  const first = mount(document.createElement('div'), { ...plausible, path: '/checkout', events: [purchase] }, host());
  first.destroy();
  calls = [];
  const second = mount(document.createElement('div'), { ...plausible, path: '/checkout', events: [purchase] }, host());
  assert.equal(calls.length, 0);                                  // no second page view, no second purchase
  assert.equal(second.probe().lastPurchase, 'GG-7 · 99.00 SEK');  // and the page still says what it reported
  assert.equal(second.probe().purchases, 1);
});
