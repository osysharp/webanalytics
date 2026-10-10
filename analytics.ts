// The AnalyticsTag control — reports page views and e-commerce events to Plausible or Google Analytics 4.
//
// Type-check with `npm run typecheck`; test with `npm test` (test/analytics.test.mjs, in a DOM, with the network stubbed).
//
// ⚑ PLAUSIBLE IS SPOKEN TO DIRECTLY, NOT THROUGH ITS SCRIPT. Plausible's tracker is a thin wrapper over one POST —
//   its Events API (https://plausible.io/docs/events-api): `{ name, url, domain, referrer, props, revenue }` to
//   `<host>/api/event`. Sending that from here means no third-party code runs on the app's page at all, and the only
//   grant the app gives is `egress browser "plausible.io"` (data), not a script grant. Revenue follows
//   https://plausible.io/docs/ecommerce-revenue-tracking: `revenue: { currency, amount }` on the purchase goal.
//
// ⚑ GA4 IS GOOGLE'S TAG, LOADED ONLY AFTER CONSENT. There is no GA4 client a page may call without `gtag.js`
//   (the Measurement Protocol is for servers and needs a secret), so the tag is loaded — from the host the app granted
//   as `egress browser script` — and only once the visitor has accepted. Before that nothing of Google's is fetched and
//   events are dropped, not queued: an event from before consent is exactly what consent exists to prevent. Event names
//   and parameters are GA4's recommended e-commerce ones
//   (https://developers.google.com/analytics/devguides/collection/ga4/ecommerce). Consent mode is set explicitly
//   (https://developers.google.com/tag-platform/security/guides/consent): analytics storage as the visitor answered,
//   advertising storage always denied — the visitor was asked about counting visits, not about ads.
//
// ⚑ A PURCHASE IS REPORTED ONCE PER ORDER in this browser, whatever reloads: its key is remembered in localStorage
//   before it is sent. (The shop also stops offering it once reported — see the shop kit's ShopAnalytics — so the two
//   together hold even across browsers of one visit.)

import type { AnalyticsTagHandle, AnalyticsTagHost, AnalyticsTagProps } from './analytics.control';

type Props = Partial<AnalyticsTagProps>;
type Host = AnalyticsTagHost;

interface Item { Id?: string; Name?: string; Brand?: string | null; Category?: string | null; Variant?: string | null; Price?: unknown; Quantity?: number }
interface Event { Name?: string; Key?: string; Currency?: string; Value?: unknown; TransactionId?: string | null; Tax?: unknown; Shipping?: unknown; Items?: Item[] }

const CONSENT_KEY = 'osy-analytics-consent';
const SENT_KEY = 'osy-analytics-purchases';
const CART_KEY = 'osy-analytics-cart';

/** Plausible's goal names for the GA4 vocabulary — what an owner sets up as goals in Plausible. */
const PLAUSIBLE_NAMES: Readonly<Record<string, string>> = {
  view_item: 'View Item',
  add_to_cart: 'Add to Cart',
  remove_from_cart: 'Remove from Cart',
  begin_checkout: 'Begin Checkout',
  purchase: 'Purchase',
  refund: 'Refund',
};

/** A name no Plausible site can have (RFC 2606 / RFC 6761) — events are recorded and never sent. */
function reservedDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return d === 'localhost' || /\.(example|test|invalid|localhost)$/.test(d) || d === 'example.com' || d.endsWith('.example.com');
}

/** A decimal arrives as an exact decimal OBJECT (read through its `toString()`), a number, or a string. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v == null ? 0 : String(v));
  return Number.isFinite(n) ? n : 0;
}

function money(v: unknown): string { return num(v).toFixed(2); }

function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* a private window: the answer lasts this page */ }
}

function itemLabel(i: Item): string {
  return i.Variant ? `${i.Name ?? ''} (${i.Variant})` : `${i.Name ?? ''}`;
}

/** GA4's item shape. */
function gaItem(i: Item): Record<string, unknown> {
  const out: Record<string, unknown> = { item_id: i.Id ?? '', item_name: i.Name ?? '', price: num(i.Price), quantity: i.Quantity ?? 1 };
  if (i.Brand) out.item_brand = i.Brand;
  if (i.Category) out.item_category = i.Category;
  if (i.Variant) out.item_variant = i.Variant;
  return out;
}

/** What one PAGE (one document) has reported — shared by every mount of the control in it.
 *
 *  ⚑ PAGE STATE, NOT INSTANCE STATE. The renderer may unmount and remount a control while the page stays (a parent that
 *  re-renders, a frame rebuilt around it), and a remount is not a new page view: it must not report the page again,
 *  forget a purchase it already reported, or load GA4's tag a second time — and a purchase reported by one mount must
 *  still read as reported to the next. Keyed by the document, so a real navigation (a new document) starts clean. */
interface PageState {
  sent: number;
  purchases: number;
  lastPageView: string | null;
  lastViewItem: string | null;
  lastAddToCart: string | null;
  lastBeginCheckout: string | null;
  lastPurchase: string | null;
  gaLoaded: boolean;
  /** The events already reported in THIS page view — cleared when the path changes. */
  viewPath: string | null;
  fired: Set<string>;
  firstView: boolean;
  /** What the visitor's bag held when it was last seen, persisted so a reload is not "everything was just added". */
  cartSeen: boolean;
  cart: Record<string, number>;
}

const pages = new WeakMap<Document, PageState>();

function pageState(doc: Document): PageState {
  let st = pages.get(doc);
  if (st) return st;
  let cart: Record<string, number> = {};
  try { cart = JSON.parse(storageGet(CART_KEY) ?? '{}') as Record<string, number>; } catch { cart = {}; }
  st = { sent: 0, purchases: 0, lastPageView: null, lastViewItem: null, lastAddToCart: null, lastBeginCheckout: null,
         lastPurchase: null, gaLoaded: false, viewPath: null, fired: new Set(), firstView: true, cartSeen: false, cart };
  pages.set(doc, st);
  return st;
}

export function mount(el: HTMLElement, props: Props, host: Host): AnalyticsTagHandle {
  el.style.display = 'none';
  let current: Props = { ...props };
  let destroyed = false;
  const st = pageState(el.ownerDocument ?? document);
  const referrer = typeof document !== 'undefined' ? document.referrer : '';

  const provider = () => current.provider ?? 'none';
  const needsConsent = () => provider() === 'ga4';
  const storedConsent = storageGet(CONSENT_KEY);
  let consent: string = storedConsent === 'granted' || storedConsent === 'denied' ? storedConsent : 'unknown';
  const dryRun = () => provider() === 'plausible' && reservedDomain(current.domain ?? '');
  const mayTrack = () => provider() === 'plausible' || (provider() === 'ga4' && consent === 'granted');

  function purchasesSent(): string[] {
    try { return JSON.parse(storageGet(SENT_KEY) ?? '[]') as string[]; } catch { return []; }
  }

  // ── transports ──────────────────────────────────────────────────────────────────────────────────────────────────

  function plausible(name: string, props?: Record<string, string>, revenue?: { currency: string; amount: string }): void {
    if (dryRun()) return;
    const hostUrl = (current.host && current.host !== '' ? current.host : 'https://plausible.io').replace(/\/+$/, '');
    const body: Record<string, unknown> = { name, url: window.location.origin + (st.viewPath ?? '/'), domain: current.domain };
    if (name === 'pageview' && st.firstView && referrer) body.referrer = referrer;
    if (props && Object.keys(props).length > 0) body.props = props;
    if (revenue) body.revenue = revenue;
    // text/plain keeps it a "simple" request — no preflight, which a self-hosted instance may not answer.
    void fetch(`${hostUrl}/api/event`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' }, keepalive: true })
      .catch(() => { /* an analytics outage never fails a page */ });
  }

  type Gtag = (...args: unknown[]) => void;
  function gtag(): Gtag {
    const w = window as unknown as { dataLayer?: unknown[]; gtag?: Gtag };
    w.dataLayer = w.dataLayer ?? [];
    // gtag.js reads the ARGUMENTS object off the data layer, exactly as Google's own snippet pushes it.
    // eslint-disable-next-line prefer-rest-params
    w.gtag = w.gtag ?? function gtag() { (w.dataLayer as unknown[]).push(arguments); };
    return w.gtag;
  }

  function loadGa(): void {
    if (st.gaLoaded || destroyed) return;
    const id = (current.measurementId ?? '').trim();
    if (!/^G-[A-Z0-9]+$/i.test(id)) return;
    const g = gtag();
    g('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    g('js', new Date());
    // Page views are sent by this control, on the app's own route changes — not guessed by the tag.
    g('config', id, { send_page_view: false });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);
    st.gaLoaded = true;
  }

  // ── reporting ───────────────────────────────────────────────────────────────────────────────────────────────────

  function pageView(path: string): void {
    if (!mayTrack()) return;
    if (provider() === 'plausible') plausible('pageview');
    else gtag()('event', 'page_view', { page_location: window.location.origin + path, page_title: document.title });
    st.firstView = false;
    st.lastPageView = path;
    st.sent++;
  }

  function report(e: Event): boolean {
    if (!mayTrack()) return false;
    const name = e.Name ?? '';
    const items = e.Items ?? [];
    const currency = e.Currency || current.currency || '';
    if (provider() === 'plausible') {
      const goal = PLAUSIBLE_NAMES[name] ?? name;
      const props: Record<string, string> = {};
      if (items.length === 1) { props.item = itemLabel(items[0]!); props.item_id = items[0]!.Id ?? ''; }
      else if (items.length > 1) props.items = String(items.length);
      if (e.TransactionId) props.order = e.TransactionId;
      plausible(goal, props, name === 'purchase' ? { currency, amount: money(e.Value) } : undefined);
    } else {
      const params: Record<string, unknown> = { currency, value: num(e.Value), items: items.map(gaItem) };
      if (e.TransactionId) params.transaction_id = e.TransactionId;
      if (name === 'purchase') { params.tax = num(e.Tax); params.shipping = num(e.Shipping); }
      gtag()('event', name, params);
    }
    st.sent++;
    const value = `${money(e.Value)} ${currency}`;
    if (name === 'view_item') st.lastViewItem = items.length > 0 ? itemLabel(items[0]!) : '';
    else if (name === 'add_to_cart') st.lastAddToCart = items.map(i => `${i.Quantity ?? 1} × ${itemLabel(i)}`).join(', ');
    else if (name === 'begin_checkout') st.lastBeginCheckout = `${items.reduce((n, i) => n + (i.Quantity ?? 1), 0)} items · ${value}`;
    else if (name === 'purchase') { st.lastPurchase = `${e.TransactionId ?? ''} · ${value}`; st.purchases++; }
    return true;
  }

  /** Report whatever this page view has not reported yet: the page view itself, then each event. */
  function sync(): void {
    if (destroyed) return;
    const p = current.provider ?? 'none';
    if (p === 'none') return;
    if (p === 'ga4' && consent === 'granted') loadGa();

    const path = current.path ?? '';
    if (path !== '' && path !== st.viewPath) {
      st.viewPath = path;
      st.fired = new Set();
      pageView(path);
    }
    if (st.viewPath === null) return;

    for (const e of current.events ?? []) {
      const key = e.Key || `${e.Name}`;
      if (st.fired.has(key)) continue;
      const once = e.Name === 'purchase';
      if (once && purchasesSent().includes(key)) { st.fired.add(key); host.emit('sent', key); continue; }
      if (!mayTrack()) {
        // No consent yet: nothing goes, and nothing is marked — the visitor may still accept on this page. A refusal
        // is final for the page, and a purchase is let go so the shop stops offering it.
        if (needsConsent() && consent === 'denied') { st.fired.add(key); if (once) host.emit('sent', key); }
        continue;
      }
      // Remembered BEFORE it is sent: a reload racing the send must find it already reported.
      if (once) storageSet(SENT_KEY, JSON.stringify([...purchasesSent(), key].slice(-50)));
      st.fired.add(key);
      report(e);
      host.emit('sent', key);
    }

    syncCart();
  }

  /** What grew in the bag since it was last seen is an `add_to_cart`. An EMPTY bag seen before any full one is a bag
   *  still loading, and says nothing — a reload must not report the whole bag as just added. */
  function syncCart(): void {
    const lines = current.cart ?? [];
    if (lines.length === 0) {
      if (st.cartSeen && Object.keys(st.cart).length > 0) { st.cart = {}; storageSet(CART_KEY, '{}'); }
      return;
    }
    const now: Record<string, number> = {};
    const byId: Record<string, Item> = {};
    for (const l of lines) { const id = l.Id ?? ''; now[id] = (now[id] ?? 0) + (l.Quantity ?? 1); byId[id] = l; }
    const grown: Item[] = [];
    for (const id of Object.keys(now)) {
      const more = now[id]! - (st.cart[id] ?? 0);
      if (more > 0) grown.push({ ...byId[id]!, Quantity: more });
    }
    st.cart = now;
    st.cartSeen = true;
    storageSet(CART_KEY, JSON.stringify(now));
    if (grown.length === 0 || !mayTrack()) return;
    const value = grown.reduce((n, i) => n + num(i.Price) * (i.Quantity ?? 1), 0);
    report({ Name: 'add_to_cart', Currency: current.currency ?? '', Value: value, Items: grown });
  }

  function applyConsent(next: string | undefined): void {
    if (next !== 'granted' && next !== 'denied') return;
    if (next === consent) return;
    consent = next;
    storageSet(CONSENT_KEY, next);
    if (st.gaLoaded && next === 'denied') gtag()('consent', 'update', { analytics_storage: 'denied' });
    if (next === 'granted') {
      // Accepting on a page counts THAT page: it was viewed, and nothing was sent for it.
      const path = st.viewPath;
      st.viewPath = null;
      if (path) current = { ...current, path: current.path || path };
    }
  }

  // The visitor's earlier answer, told to the app so it does not ask again.
  if (needsConsent()) host.emit('consentKnown', consent);
  applyConsent(current.consent);
  sync();

  return {
    update(next: Props) {
      current = { ...next };
      applyConsent(current.consent);
      sync();
    },
    destroy() { destroyed = true; },
    probe() {
      return {
        sent: st.sent,
        lastPageView: st.lastPageView,
        lastViewItem: st.lastViewItem,
        lastAddToCart: st.lastAddToCart,
        lastBeginCheckout: st.lastBeginCheckout,
        lastPurchase: st.lastPurchase,
        purchases: st.purchases,
        loaded: provider() === 'plausible' ? true : st.gaLoaded,
        consent: needsConsent() ? consent : 'granted',
        dryRun: dryRun(),
      };
    },
  };
}
