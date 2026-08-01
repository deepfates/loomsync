# Lync 0.4.3 release candidate

Lync 0.4.3 is prepared but not yet published. npm still serves 0.3.0; do not
tag 0.4.3 or describe it as registry-available until the owner-authorized
publication step succeeds.

The durable format contract did not change. Both 0.3 and 0.4 read and write the
same v1 event envelope, and unknown event kinds remain carried rather than
dropped. The 0.4 package adds typed presence awareness, clearer runtime floors,
the normative `FORMAT.md` and pacts in the tarball, structured public error
diagnostics, a loss-free trial artifact, and the additive Behold inhabitant v2
presentation profile. `prepack` rebuilds `dist`, and the package check extracts
and executes the physical tarball rather than trusting workspace resolution.
The v2 profile also presents Behold's safe focused attack/dig evidence and
ordinary failure, suspension, cancellation, and visible-block-change events.
The browser-safe indexed-union path adds re-readable streaming source scans and
lazy authenticated event reads without retaining raw corpus bytes or payload
graphs; existing eager APIs remain unchanged.

Runtime boundaries:

- Browser-safe parsing, stores, views, looms, indexes, and clients support
  Node.js 19 or newer.
- The built-in WebSocket sync transport and `lync sync` require Node.js 21 or
  newer unless the caller supplies a WebSocket implementation.
- The relay loads its optional `ws` server dependency only when constructed.

Before publication, run `pnpm verify`, inspect `npm pack --dry-run --json`, and
install the physical tarball into a clean temporary consumer. Publication and
tagging then proceed through the workshop's canonical corpus release runbook.
