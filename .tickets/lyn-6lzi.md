---
id: lyn-6lzi
status: closed
deps: []
links: []
created: 2026-08-01T13:07:14Z
type: feature
priority: 1
assignee: deepfates
tags: [parser, scale, browser, behold, textile]
---
# Index large Lync unions from re-readable streaming sources

Add the smallest browser-safe Lync seam that preserves canonical union semantics while avoiding retention of every physical source line and parsed payload. This is required by Behold multi-day resident histories and Textile's ordinary local reader; current parseLyncFiles/LyncUnion necessarily retain the complete corpus, so a Textile worker or chunk wrapper would only move the same materialization.

## Design

Consume ordered re-readable async byte sources. Frame and authenticate lines incrementally, retaining compact source/offset/line locators plus envelope topology, classification, digests, richness, conflicts, pending parents, graph obstacles, and critical suppression. Re-read exact body bytes lazily only when duplicate-ID adjudication requires them; expose an async iterator that parses one held view-eligible event at a time and a lazy exact-line read for source-preserving export. Keep existing eager parser APIs unchanged. Do not implement Lync union semantics independently in Textile.

## Acceptance Criteria

All v0 conformance vectors and existing eager parser tests produce the same accepted/nonconforming/garbage/damaged/conflict classes, union ids, pending parents, graph diagnostics, richness selection, and critical suppression through the indexed path. Eager-versus-indexed equality holds for representative multi-source Behold histories, including duplicate ids and source-order changes. A representative retained six-hour two-resident source set can be scanned and presented with raw working memory bounded by declared chunk size plus largest admitted line, no retained corpus-sized Uint8Array/string or parsed payload graph, and instrumentation proving payload-byte growth does not determine retained heap. Exact carried/source lines remain lazily readable by locator; damaged/truncated/reordered sources fail closed; browser and Node builds pass; no publication.

## Resolution

Implemented `@deepfates/lync/indexed-union` as the single re-readable-source
seam. The indexing pass uses the reference physical-line parser, authenticates
optional whole-source SHA-256 incrementally, and retains only exact locators,
envelope topology, line/body digests, union classifications, richness,
conflicts, finalized first-parent gaps, graph diagnostics, profile inheritance,
and critical suppression. Parsed payloads and raw line bytes are discarded
after each line. Lazy event and carried-line reads verify source identity,
range length, exact line SHA-256, LF state, id, and body digest before yielding.

All thirteen v0 vector sets now run through the indexed path, including exact
lazy carried-byte reconstruction. Reordered/duplicated multi-source Behold v1
and v2 fixtures match eager union selection, inherited profiles, and readable
presentation. Mutation, truncation, digest mismatch, chunk/line admission, and
payload-size-independent retained-shape checks fail closed as required. The
scale gate scans and then presents 7,488 generated resident events totaling at
least 468 MiB with 64 KiB chunks and sub-128 KiB lines; ownership reports 7,488
compact locators/envelopes and zero retained raw bytes or payload objects.

The retained index remains O(events + parent edges), and consumers can still
defeat the intended working-set bound by collecting every lazily yielded event.
The re-readable source (for example a browser `File`) remains the canonical
backing object and is deliberately outside index-owned memory. Textile must
adapt its ordered-prefix path to retain presented/navigation projections and
locators rather than exact source strings; Behold can use the same scanner for
streaming replay/range consumers, but its live file store needs a separate
disk-backed cursor before controller RAM is bounded.
