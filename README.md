# Osysharp.WebAnalytics

Web analytics for an Osy# app: **Plausible** or **Google Analytics 4**, page views on every route change, the
e-commerce events both understand (`view_item`, `add_to_cart`, `begin_checkout`, `purchase` — GA4's names), and the
consent GA4 needs in the EU before it may track.

```osy
// app.osy — grant the provider's hosts
use Osysharp.WebAnalytics@0 { egress browser "plausible.io"; }

// config — which provider
app.Analytics = new AnalyticsSetup { Provider = AnalyticsProvider.Plausible, Domain = "shop.example.com" };

// the layout — once
Analytics(events: [], cart: [], currency: "SEK", onSent: Heard);
```

A shop built on `Osysharp.Shop` writes `ShopAnalytics()` in its layout instead, and gets every e-commerce event from
its own rows.

- **Plausible** is spoken to through its Events API from the kit's own control — no third-party script on the page.
  It sets no cookie and needs no consent. A self-hosted instance: set `Host` and grant its host instead.
- **GA4** loads Google's tag from the host the app granted (`egress browser script "*.googletagmanager.com";` plus
  `egress browser "*.google-analytics.com"; egress browser "*.analytics.google.com";`), and only after the visitor
  accepts the consent bar. Before that nothing of Google's is fetched.
- A **purchase** is reported once per order in a browser, whatever reloads.

Its tests: `tests/` (the kit in a real app) and `npm test` (the shim in a DOM, with the network stubbed — GA4 and the
exact bodies Plausible receives).

## Examples

Taken from this package's own tests, which compile and run on every release.

```osy
using Osysharp.WebAnalytics;

[Test]
void the_setup_reaches_the_page_as_the_browser_needs_it() {
  var config = AnalyticsConfiguration();
  Assert.Equal("plausible", config.Provider);
  Assert.Equal("kettles.example", config.Domain);
  Assert.Equal("https://plausible.io", config.Host);
  Assert.False(config.NeedsConsent);                          // Plausible is cookieless: it asks nothing
}
```

From [`tests/analytics.test.osy`](tests/analytics.test.osy).

```osy
using Osysharp.WebAnalytics;

[Test]
void the_granted_host_and_only_it_is_on_the_pages_policy() {
  var page = Api.Get("/");
  var policy = page.Headers.Single(h => h.Name == "Content-Security-Policy").Value;
  Assert.Contains("https://plausible.io", policy);                     // `egress browser "plausible.io"` in app.osy
  Assert.DoesNotContain("googletagmanager", policy);                   // GA4 was not granted, so its tag cannot load
}
```

From [`tests/analytics.test.osy`](tests/analytics.test.osy).

## Learn more

- [The Osysharp.WebAnalytics reference](https://osysharp.com/reference/ui/analytics-kit/)
- [Osysharp.WebAnalytics in the package catalogue](https://osysharp.com/packages/#osysharp-webanalytics)
- [The Osy# reference](https://osysharp.com/reference/) — the language, the runtime and every kit
- [`llms-full.txt`](https://osysharp.com/llms-full.txt) — the whole reference and specification as one Markdown file, for a coding agent

## Licence

MIT — see [`LICENSE`](LICENSE).
